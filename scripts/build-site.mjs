import { execFileSync } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, posix, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = resolve(import.meta.dirname, "..");
const output = join(root, "_site");
const cli = join(root, "packages/cli/dist/xpl.mjs");

execFileSync("npm", ["run", "build"], { cwd: root, stdio: "inherit" });
await rm(output, { recursive: true, force: true });
await cp(join(root, "site"), output, { recursive: true });
await mkdir(join(output, "demo"), { recursive: true });

const fixture = await mkdtemp(join(tmpdir(), "xpl-site-"));
try {
  await cp(join(root, "fixtures/ts-jobrunner"), fixture, { recursive: true });
  execFileSync(process.execPath, [cli, "index", "--precise", "off"], {
    cwd: fixture,
    stdio: "inherit",
  });
  // The committed example predates required summaries. Add only reader text to its temporary copy.
  execFileSync(
    process.execPath,
    [cli, "apply", "jobrunner", join(root, "scripts/site-demo.patch.json")],
    {
      cwd: fixture,
      stdio: "inherit",
    },
  );
  execFileSync(
    process.execPath,
    [cli, "bundle", "jobrunner", "-o", join(output, "demo/index.html")],
    {
      cwd: fixture,
      stdio: "inherit",
    },
  );
  // A static viewer never reads the index's disk root. Do not publish the build machine's path.
  const demoPath = join(output, "demo/index.html");
  const html = await readFile(demoPath, "utf8");
  await writeFile(demoPath, html.replace(JSON.stringify(fixture), JSON.stringify(".")));
} finally {
  await rm(fixture, { recursive: true, force: true });
}

await buildDocs();

// The pages use quoted URLs and one URL per srcset. Check CSS assets too. The docs' 404 page uses
// absolute /xpl/docs/ URLs that only resolve on Pages.
const docsPages = (await readdir(join(output, "docs"), { recursive: true }))
  .filter((name) => name.endsWith(".html") && name !== "404.html")
  .map((name) => `docs/${name}`);
for (const name of ["index.html", "style.css", ...docsPages]) {
  const path = join(output, name);
  const source = await readFile(path, "utf8");
  const references = source.matchAll(
    /(?:\b(?:href|src|srcset)=["']([^"']+)["']|url\(["']?([^\s)'"]+)["']?\))/g,
  );
  for (const match of references) {
    const reference = match[1] ?? match[2];
    if (/^(?:https?:|mailto:|data:)/.test(reference)) continue;
    const target = new URL(reference, pathToFileURL(path));
    let targetPath = fileURLToPath(target);
    if (targetPath.endsWith("/")) targetPath = join(targetPath, "index.html");
    if (!(await stat(targetPath)).isFile()) throw new Error(`Missing site asset: ${reference}`);
    if (target.hash && targetPath === join(output, "index.html")) {
      const id = decodeURIComponent(target.hash.slice(1));
      if (!source.includes(`id="${id}"`)) throw new Error(`Missing site section: ${reference}`);
    }
  }
}
const demo = await readFile(join(output, "demo/index.html"), "utf8");
if (!demo.includes('id="xpl-data"')) throw new Error("Demo bundle has no embedded explainer");
console.log("Built _site: page, assets, self-contained demo and docs checked.");

/**
 * The user docs (docs-site/) go to _site/docs. A line `<!-- include path -->` takes a whole file and
 * `<!-- include path "## Heading" -->` the text under one heading, so README.md and the product skill stay the
 * single source. Links in that text are rewritten for the page: to the page that includes the target file, to a
 * copied image, or to the file on GitHub. The CLI's help text becomes reference/commands.md, and the build fails
 * when cli.md has no section for a command. Zensical's --strict fails on a missing page or anchor.
 */
async function buildDocs() {
  const work = await mkdtemp(join(tmpdir(), "xpl-docs-"));
  try {
    await cp(join(root, "docs-site"), work, { recursive: true });
    const pagesDir = join(work, "pages");
    const pages = (await readdir(pagesDir, { recursive: true })).filter((p) => p.endsWith(".md"));
    const include = /^<!-- include (\S+)(?: "(#+ .+)")? -->$/gm;
    const published = new Map();
    for (const page of pages) {
      for (const [, source, heading] of (await readFile(join(pagesDir, page), "utf8")).matchAll(
        include,
      )) {
        if (!heading) published.set(source, page);
      }
    }
    const links = { published, pagesDir };
    for (const page of pages) {
      const text = await readFile(join(pagesDir, page), "utf8");
      const parts = [];
      let last = 0;
      for (const match of text.matchAll(include)) {
        parts.push(
          await rewriteLinks(text.slice(last, match.index), `docs-site/pages/${page}`, page, links),
        );
        const [, source, heading] = match;
        const body = await readFile(join(root, source), "utf8");
        parts.push(
          await rewriteLinks(heading ? section(body, heading, source) : body, source, page, links),
        );
        last = match.index + match[0].length;
      }
      parts.push(await rewriteLinks(text.slice(last), `docs-site/pages/${page}`, page, links));
      await writeFile(join(pagesDir, page), parts.join(""));
    }
    await writeFile(join(pagesDir, "reference/commands.md"), await commandHelp());
    execFileSync(
      "uv",
      [
        "run",
        "--no-project",
        "--python",
        "3.13",
        "--with-requirements",
        "requirements.txt",
        "--",
        "zensical",
        "build",
        "--strict",
      ],
      { cwd: work, stdio: "inherit" },
    );
    await cp(join(work, "site"), join(output, "docs"), { recursive: true });
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}

/** The lines under `heading` up to the next heading of the same or a higher level, outside code fences. */
function section(text, heading, source) {
  const level = heading.indexOf(" ");
  const lines = text.split("\n");
  const fenced = fencedLines(lines);
  let start = -1;
  for (const [i, line] of lines.entries()) {
    if (fenced[i]) continue;
    if (start < 0 && line === heading) start = i + 1;
    else if (start >= 0 && /^#+ /.test(line) && line.indexOf(" ") <= level) {
      return lines.slice(start, i).join("\n").trim() + "\n";
    }
  }
  if (start < 0) throw new Error(`docs: ${source} has no heading "${heading}"`);
  return lines.slice(start).join("\n").trim() + "\n";
}

/** Which lines belong to a code fence; a fence closes on a run of its own character at least as long. */
function fencedLines(lines) {
  let open;
  return lines.map((line) => {
    const fence = /^\s*(`{3,}|~{3,})/.exec(line)?.[1];
    if (!open) {
      if (fence) open = fence;
      return Boolean(fence);
    }
    if (fence && fence[0] === open[0] && fence.length >= open.length && line.trim() === fence)
      open = undefined;
    return true;
  });
}

/** Rewrites relative Markdown links of `text` (from repository file `from`) for the docs page `page`. */
async function rewriteLinks(text, from, page, { published, pagesDir }) {
  const lines = text.split("\n");
  const fenced = fencedLines(lines);
  const out = [];
  for (const [i, line] of lines.entries()) {
    if (fenced[i]) {
      out.push(line);
      continue;
    }
    // Only inline links are rewritten; other forms would keep a repository path, so they fail here.
    if (/^\s*\[[^\]]+\]:\s|<(?:a|img)\s|\]\([^)\s]+\s+"/.test(line.replace(/`+[^`]*?`+/g, ""))) {
      throw new Error(
        `docs: ${from} has a link form the docs build does not rewrite: ${line.trim()}`,
      );
    }
    const spans = [];
    for (const span of line.split(/(`+[^`]*?`+)/)) {
      if (span.startsWith("`")) {
        spans.push(span);
        continue;
      }
      let rewritten = span;
      for (const [whole, opening, target] of span.matchAll(/(!?\[[^\]]*\]\()([^)\s]+)\)/g)) {
        const next = await rewriteTarget(target, from, page, published, pagesDir);
        if (next !== target) rewritten = rewritten.replace(whole, () => `${opening}${next})`);
      }
      spans.push(rewritten);
    }
    out.push(spans.join(""));
  }
  return out.join("\n");
}

async function rewriteTarget(target, from, page, published, pagesDir) {
  if (/^(?:[a-z]+:|#)/i.test(target)) return target;
  const [path, hash = ""] = target.split(/(?=#)/);
  const repoPath = posix.normalize(posix.join(posix.dirname(from), path)).replace(/\/$/, "");
  const fromPage = (to) => posix.relative(posix.dirname(page), to) + hash;
  if (published.has(repoPath)) return fromPage(published.get(repoPath));
  if (repoPath.startsWith("docs-site/pages/"))
    return fromPage(repoPath.slice("docs-site/pages/".length));
  const info = await stat(join(root, repoPath)).catch(() => undefined);
  if (!info) throw new Error(`docs: ${from} links to ${target}, which does not exist`);
  if (/\.(?:png|jpe?g|gif|svg|webp)$/i.test(repoPath)) {
    const copy = `assets/repo/${repoPath}`;
    await mkdir(dirname(join(pagesDir, copy)), { recursive: true });
    await cp(join(root, repoPath), join(pagesDir, copy));
    return fromPage(copy);
  }
  // Contributor material and unpublished files stay in the repository: link to them there.
  return `https://github.com/krimvp/xpl/${info.isDirectory() ? "tree" : "blob"}/main/${repoPath}${hash}`;
}

/** `xpl --help` and each command's `--help`, as built from this commit. */
async function commandHelp() {
  const help = (...args) =>
    execFileSync(process.execPath, [cli, ...args], { encoding: "utf8" }).trimEnd();
  const top = help("--help");
  const names = [
    ...top
      .split("Commands:\n")[1]
      .split("\n\n")[0]
      .matchAll(/^ {2}(\S+)/gm),
  ].map((m) => m[1]);
  const reference = await readFile(join(root, "skill/code-explainer/reference/cli.md"), "utf8");
  const missing = names.filter(
    (name) => !new RegExp(`^#+ .*\`xpl ${name}\\b`, "m").test(reference),
  );
  if (missing.length > 0) {
    throw new Error(
      `docs: skill/code-explainer/reference/cli.md has no section for: xpl ${missing.join(", xpl ")}`,
    );
  }
  const fence = (text) => ["```text", text, "```", ""].join("\n");
  return [
    "# Command help",
    "",
    "This page is generated by `npm run site` from the help text of the CLI built from the same commit, so it",
    "matches the code. The [CLI reference](index.md) explains each command with sample output.",
    "",
    fence(top),
    ...names.flatMap((name) => [`## \`xpl ${name}\``, "", fence(help(name, "--help"))]),
  ].join("\n");
}
