/**
 * make-bundle: turns a repo (a fixture) plus explainer patches into everything the viewer needs.
 *
 *   npx tsx scripts/make-bundle.ts <root> --patch <patch.json> [--user-patch <patch.json>] [options]
 *
 * 1. `buildIndex` (@xpl/indexer, `precise: "off"`) indexes <root>.
 * 2. `createExplainer` + `applyPatch` build the explainer, exactly like `xpl new` + `xpl apply`:
 *    a. --patch       applied as actor `llm`: what Claude writes (groups, overlays with summaries, llm
 *                     edges with evidence at both ends, views, tours).
 *    b. --user-patch  applied afterwards as actor `user`: what the person adds on top. An llm patch cannot
 *                     create user-authored elements, and only a user patch makes core record
 *                     `provenance.userFields` (the fields of an llm element the user edited), so the
 *                     provenance of docs/handoff.md Appendix B (a concept with `origin: "user"`, a
 *                     `Runner.dispatch` overlay with `userFields: ["summary"]`) needs both.
 *                     Default: the sibling of --patch named `<x>.user.patch.json` when it exists
 *                     (scripts/ts-example.patch.json -> scripts/ts-example.user.patch.json), so
 *                     `--patch scripts/<lang>-example.patch.json` alone builds the whole example.
 *                     (The example's tour is in both: the llm tour cannot focus a concept that does not
 *                     exist yet, so its second stop focuses the step only, and the user patch resends
 *                     the tour with the concept added; tours are replaced wholesale.)
 *    A patch that does not apply cleanly fails the script (exit code 1).
 * 3. Outputs:
 *    a. <root>/.explainer/<name>.explainer.json        the explainer (skipped with --no-explainer)
 *    b. <out>                                          the built viewer (dist/index.html) with the
 *                                                      bundle injected: a self-contained HTML file
 *    c. <dev-json>                                     the same bundle as plain JSON, which the Vite
 *                                                      dev server injects (see vite.config.ts)
 *
 * The defaults for b and c live in packages/viewer/dist/bundles/ (git- and prettier-ignored because
 * `dist` is; `emptyOutDir` is off in vite.config.ts so a viewer build does not delete them).
 * Run `npm run build -w @xpl/viewer` first: the viewer HTML is read from dist/index.html.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import {
  applyPatch,
  BUNDLE_SCHEMA,
  createExplainer,
  injectBundle,
  type Explainer,
  type ExplainerPatch,
  type Issue,
  type SymbolIndex,
  type ViewerBundle,
} from "@xpl/core";
import { buildIndex } from "@xpl/indexer";

const viewerDir = resolve(import.meta.dirname, "..");

const USAGE = `usage: tsx scripts/make-bundle.ts <root> --patch <patch.json> [--user-patch <patch.json>] [options]

  --patch <file>       explainer patch (ExplainerPatch JSON), applied as actor "llm"
  --user-patch <file>  second patch, applied as actor "user" after --patch (default: <x>.user.patch.json
                       next to <x>.patch.json, when that file exists)
  --no-user-patch      do not look for that sibling file
  --name <name>        explainer name; file is <root>/.explainer/<name>.explainer.json (default: root's basename)
  --title <text>       explainer title (default: the name)
  --repo <name>        repo name recorded in the explainer (default: the name)
  --out <file>         bundle HTML (default: dist/bundles/<root basename>.html in the viewer package)
  --dev-json <file>    bundle as JSON for the Vite dev server (default: dist/bundles/<root basename>.bundle.json)
  --viewer <file>      built viewer to inject into (default: dist/index.html in the viewer package)
  --commit <id>        commit id override for the index
  --no-explainer       do not write <root>/.explainer/<name>.explainer.json
  --mode <mode>        initial viewer mode recorded in the bundle: explore (default) or present
`;

/** `scripts/x-example.patch.json` -> `scripts/x-example.user.patch.json` (undefined for other names). */
function siblingUserPatch(patchFile: string): string | undefined {
  return /\.patch\.json$/.test(patchFile) && !/\.user\.patch\.json$/.test(patchFile)
    ? patchFile.replace(/\.patch\.json$/, ".user.patch.json")
    : undefined;
}

function fail(message: string): never {
  console.error(`make-bundle: ${message}`);
  process.exit(1);
}

/** Writes through a temp file so a reader never sees a half-written file; skips identical content. */
function writeAtomic(path: string, content: string): boolean {
  if (existsSync(path) && readFileSync(path, "utf8") === content) return false;
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, content);
  renameSync(tmp, path);
  return true;
}

function printIssues(issues: readonly Issue[]): void {
  for (const issue of issues) {
    const where = issue.elementId ? ` ${issue.elementId}` : issue.path ? ` ${issue.path}` : "";
    console.error(`  ${issue.severity}${where}: ${issue.message}`);
  }
}

/** `xpl apply <explainer> <patchFile> --actor <actor>`: exits with the issues when the patch is rejected. */
function applyPatchFile(
  explainer: Explainer,
  patchFile: string,
  actor: "llm" | "user",
  index: SymbolIndex,
  getText: (file: string) => string | undefined,
): Explainer {
  if (!existsSync(patchFile)) fail(`no such patch file: ${patchFile}`);
  const patch = JSON.parse(readFileSync(patchFile, "utf8")) as ExplainerPatch;
  const result = applyPatch(explainer, patch, index, getText, { actor });
  if (!result.ok) {
    console.error(`make-bundle: the ${actor} patch ${basename(patchFile)} did not apply:`);
    printIssues(result.issues);
    process.exit(1);
  }
  if (result.issues.length > 0) {
    console.warn(
      `make-bundle: the ${actor} patch ${basename(patchFile)} applied with ` +
        `${result.issues.length} note(s):`,
    );
    printIssues(result.issues);
  }
  return result.explainer;
}

async function main(): Promise<void> {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      patch: { type: "string" },
      "user-patch": { type: "string" },
      "no-user-patch": { type: "boolean", default: false },
      name: { type: "string" },
      title: { type: "string" },
      repo: { type: "string" },
      out: { type: "string" },
      "dev-json": { type: "string" },
      viewer: { type: "string" },
      commit: { type: "string" },
      mode: { type: "string" },
      "no-explainer": { type: "boolean", default: false },
      help: { type: "boolean", short: "h", default: false },
    },
  });
  if (values.help || positionals.length !== 1) {
    console.log(USAGE);
    process.exit(values.help ? 0 : 1);
  }
  const root = resolve(positionals[0]!);
  if (!existsSync(root)) fail(`no such directory: ${root}`);
  const rootName = basename(root);
  const name = values.name ?? rootName;
  const mode = values.mode ?? "explore";
  if (mode !== "explore" && mode !== "present") fail(`--mode must be explore or present`);

  const viewerHtml = resolve(values.viewer ?? join(viewerDir, "dist", "index.html"));
  if (!existsSync(viewerHtml)) {
    fail(`${viewerHtml} does not exist; run "npm run build -w @xpl/viewer" first`);
  }
  const out = resolve(values.out ?? join(viewerDir, "dist", "bundles", `${rootName}.html`));
  const devJson = resolve(
    values["dev-json"] ?? join(viewerDir, "dist", "bundles", `${rootName}.bundle.json`),
  );

  // 1. index
  const { index, warnings } = await buildIndex({
    root,
    precise: "off",
    ...(values.commit ? { commit: values.commit } : {}),
  });
  for (const warning of warnings) console.warn(`warning: ${warning}`);

  const files: Record<string, string> = {};
  for (const file of index.files) files[file.path] = readFileSync(join(root, file.path), "utf8");
  const getText = (file: string): string | undefined => files[file];

  // 2. explainer
  let explainer = createExplainer({
    title: values.title ?? name,
    repoName: values.repo ?? name,
    index,
    indexPath: `.explainer/index-${index.commit}.json`,
  });
  const llmPatch = values.patch ? resolve(values.patch) : undefined;
  if (llmPatch) explainer = applyPatchFile(explainer, llmPatch, "llm", index, getText);
  let userPatch = values["user-patch"] ? resolve(values["user-patch"]) : undefined;
  if (!userPatch && llmPatch && !values["no-user-patch"]) {
    const sibling = siblingUserPatch(llmPatch);
    if (sibling && existsSync(sibling)) userPatch = sibling;
  }
  if (userPatch) explainer = applyPatchFile(explainer, userPatch, "user", index, getText);

  // 3. outputs
  const written: string[] = [];
  if (!values["no-explainer"]) {
    const explainerFile = join(root, ".explainer", `${name}.explainer.json`);
    if (writeAtomic(explainerFile, JSON.stringify(explainer, null, 2) + "\n")) {
      written.push(explainerFile);
    }
  }

  const bundle: ViewerBundle = {
    schema: BUNDLE_SCHEMA,
    explainer,
    index,
    files,
    mode: mode,
  };
  const html = injectBundle(readFileSync(viewerHtml, "utf8"), bundle);
  writeAtomic(out, html);
  written.push(out);
  writeAtomic(devJson, JSON.stringify(bundle));
  written.push(devJson);

  const kb = (n: number) => `${(n / 1024).toFixed(0)} KB`;
  console.log(
    `index ${index.commit}: ${index.files.length} files, ${index.symbols.length} symbols, ` +
      `${index.refs.length} refs; explainer "${explainer.title}": ${explainer.nodes.length} nodes, ` +
      `${explainer.edges.length} edges, ${explainer.concepts.length} concepts, ` +
      `${explainer.views.length} views, ${explainer.tours.length} tours`,
  );
  const applied = [
    llmPatch && `${basename(llmPatch)} (llm)`,
    userPatch && `${basename(userPatch)} (user)`,
  ].filter(Boolean);
  if (applied.length > 0) console.log(`patches: ${applied.join(", ")}`);
  console.log(`bundle html ${kb(Buffer.byteLength(html))}`);
  for (const path of written) console.log(`wrote ${path}`);
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
