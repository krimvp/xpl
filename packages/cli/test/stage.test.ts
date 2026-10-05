import {
  chmodSync,
  existsSync,
  readFileSync,
  readlinkSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
} from "node:fs";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { run } from "../src/cli.js";
import {
  bundleOf,
  invoke,
  makeTempDir,
  readJson,
  writeFile,
  writeViewerStub,
  xpl,
} from "./helpers.js";

const destinations: string[] = [];
afterEach(() => {
  for (const dir of destinations.splice(0))
    if (existsSync(dir))
      for (const entry of readdirSync(dir))
        if (entry.startsWith("version-")) chmodSync(join(dir, entry), 0o700);
});

async function guide() {
  const root = makeTempDir();
  writeFile(root, "app.ts", "export function app() { return 1; }\n");
  writeFile(root, "other.ts", "export const other = 2;\n");
  expect((await xpl(root, "index", "--precise", "off")).code).toBe(0);
  expect((await xpl(root, "new", "demo", "--title", "Application")).code).toBe(0);
  const applied = await invoke(["apply", "demo", "-"], {
    cwd: root,
    stdin: JSON.stringify({
      nodes: [
        {
          id: "file:app.ts",
          summary: "Exports a function that returns one.",
          anchors: [{ file: "app.ts", symbol: "app", role: "definition" }],
        },
      ],
      views: [
        {
          id: "view:app",
          type: "graph",
          title: "Application",
          include: ["file:app.ts"],
          stubs: { mode: "none" },
        },
      ],
    }),
  });
  expect(applied.code, applied.err).toBe(0);
  const dir = join(makeTempDir(), "staged");
  destinations.push(dir);
  return { root, dir, env: { XPL_VIEWER_HTML: writeViewerStub() } };
}

it("previews the included source without creating storage, then stages an immutable ready version", async () => {
  const f = await guide();
  const preview = await invoke(["stage", "demo", "--dir", f.dir, "--preview", "--json"], {
    cwd: f.root,
    env: f.env,
  });
  expect(preview.code, preview.out).toBe(0);
  expect(JSON.parse(preview.out).includedSource).toEqual({ head: ["app.ts"], base: [] });
  expect(existsSync(f.dir)).toBe(false);
  const staged = await invoke(["stage", "demo", "--dir", f.dir, "--json"], {
    cwd: f.root,
    env: f.env,
  });
  expect(staged.code, staged.out).toBe(0);
  const output = JSON.parse(staged.out);
  expect(readlinkSync(join(f.dir, "current"))).toBe(output.version);
  const manifest = readJson(f.dir, "current/manifest.json");
  const bundle = bundleOf(readFileSync(join(f.dir, "current/index.html"), "utf8"));
  expect(manifest.readiness.ready).toBe(true);
  expect(manifest.identity).toEqual(bundle.exportInfo?.report.identity);
  expect(manifest.includedSource).toEqual({ head: ["app.ts"], base: [] });
  expect(manifest.review.status).toBe("unchecked");
  expect(bundle.server).toBeUndefined();
  expect(bundle.publication?.current.version).toBe(output.version);
  expect(bundle.publication?.current.identity).toEqual(manifest.identity);
  expect(bundle.publication?.previous).toEqual([]);
  expect(bundle.files).toEqual({ "app.ts": "export function app() { return 1; }\n" });
  expect(statSync(join(f.dir, output.version, "manifest.json")).mode & 0o222).toBe(0);
});

it("retains prior version bytes when promoting another ready version", async () => {
  const f = await guide();
  const first = await invoke(["stage", "demo", "--dir", f.dir, "--json"], {
    cwd: f.root,
    env: f.env,
  });
  expect(first.code, first.out).toBe(0);
  const old = JSON.parse(first.out);
  const html = readFileSync(join(old.directory, "index.html"));
  const manifest = readFileSync(join(old.directory, "manifest.json"));
  expect(
    (
      await invoke(["apply", "demo", "-"], {
        cwd: f.root,
        stdin: JSON.stringify({ title: "A revised application" }),
      })
    ).code,
  ).toBe(0);
  const next = await invoke(["stage", "demo", "--dir", f.dir, "--files", "all", "--json"], {
    cwd: f.root,
    env: f.env,
  });
  expect(next.code, next.out).toBe(0);
  const output = JSON.parse(next.out);
  expect(output.version).not.toBe(old.version);
  const published = bundleOf(readFileSync(join(f.dir, "current/index.html"), "utf8")).publication;
  expect(published?.previous.map((entry) => entry.version)).toEqual([old.version]);
  expect(published?.previous[0]?.includedSource).toEqual({ head: ["app.ts"], base: [] });
  expect(published?.previous[0]?.review?.status).toBe("unchecked");
  expect(readlinkSync(join(f.dir, "current"))).toBe(output.version);
  expect(output.includedSource).toEqual({ head: ["app.ts", "other.ts"], base: [] });
  expect(bundleOf(readFileSync(join(f.dir, "current/index.html"), "utf8")).explainer.title).toBe(
    "A revised application",
  );
  expect(readFileSync(join(old.directory, "index.html"))).toEqual(html);
  expect(readFileSync(join(old.directory, "manifest.json"))).toEqual(manifest);
});

it.each(["changed", "added", "deleted", "guide"] as const)(
  "refuses %s inputs at the final readiness check and keeps current untouched",
  async (change) => {
    const f = await guide();
    const first = await invoke(["stage", "demo", "--dir", f.dir], { cwd: f.root, env: f.env });
    expect(first.code, first.err).toBe(0);
    const old = readlinkSync(join(f.dir, "current"));
    const html = readFileSync(join(f.dir, "current/index.html"));
    let sawStaged = false;
    let heldLock = false;
    const errors: string[] = [];
    const code = await run(["stage", "demo", "--dir", f.dir], {
      cwd: f.root,
      env: { ...process.env, ...f.env, XPL_SKIP_STALE_CHECK: "1" },
      err: (text) => errors.push(text),
      out: (text) => {
        if (!text.startsWith("Staged ")) return;
        sawStaged = true;
        heldLock = existsSync(join(f.dir, "current.lock"));
        const directory = text.split(" ")[1]!.replace(";", "");
        expect(existsSync(join(f.dir, directory, "index.html"))).toBe(true);
        if (change === "changed")
          writeFile(f.root, "app.ts", "export function app() { return 99; }\n");
        else if (change === "added") writeFile(f.root, "added.ts", "export const added = 3;\n");
        else if (change === "deleted") rmSync(join(f.root, "other.ts"));
        else {
          const guide = readJson(f.root, ".explainer/demo.explainer.json");
          guide.title = "A concurrent author save";
          writeFile(f.root, ".explainer/demo.explainer.json", JSON.stringify(guide));
        }
      },
    });
    expect(sawStaged).toBe(true);
    expect(heldLock).toBe(true);
    expect(code, errors.join("\n")).toBe(1);
    expect(errors.join("\n")).toContain("previous current version retained");
    expect(errors.join("\n")).toContain(
      change === "guide" ? "changed during staging" : "stale-index",
    );
    expect(readlinkSync(join(f.dir, "current"))).toBe(old);
    expect(readFileSync(join(f.dir, "current/index.html"))).toEqual(html);
    expect(readdirSync(f.dir).sort()).toEqual(["current", old].sort());
  },
);

it("refuses unfinished content and optional review policy before creating storage", async () => {
  const f = await guide();
  const review = await invoke(["stage", "demo", "--dir", f.dir, "--require-review", "--json"], {
    cwd: f.root,
    env: f.env,
  });
  expect(review.code, review.out).toBe(1);
  expect(
    JSON.parse(review.out).readiness.findings.map((finding: { code: string }) => finding.code),
  ).toContain("review-required");
  expect(existsSync(f.dir)).toBe(false);
  const applied = await invoke(["apply", "demo", "-"], {
    cwd: f.root,
    stdin: JSON.stringify({
      nodes: [{ id: "file:app.ts", summary: "TODO: explain this function" }],
    }),
  });
  expect(applied.code, applied.err).toBe(0);
  const unfinished = await invoke(["stage", "demo", "--dir", f.dir, "--json"], {
    cwd: f.root,
    env: f.env,
  });
  expect(unfinished.code, unfinished.out).toBe(1);
  expect(
    JSON.parse(unfinished.out).readiness.findings.map((finding: { code: string }) => finding.code),
  ).toContain("todo-left");
  expect(existsSync(f.dir)).toBe(false);
});

it("keeps current when rendering fails after a ready preview", async () => {
  const f = await guide();
  const first = await invoke(["stage", "demo", "--dir", f.dir], { cwd: f.root, env: f.env });
  expect(first.code, first.err).toBe(0);
  const old = readlinkSync(join(f.dir, "current"));
  const html = readFileSync(join(f.dir, "current/index.html"));
  const failed = await invoke(["stage", "demo", "--dir", f.dir, "--json"], {
    cwd: f.root,
    env: { XPL_VIEWER_HTML: join(f.root, "missing-viewer.html") },
  });
  expect(failed.code, failed.out).toBe(1);
  expect(JSON.parse(failed.out).error).toContain("previous current version retained");
  expect(JSON.parse(failed.out).error).toContain("XPL_VIEWER_HTML");
  expect(readlinkSync(join(f.dir, "current"))).toBe(old);
  expect(readFileSync(join(f.dir, "current/index.html"))).toEqual(html);
  expect(readdirSync(f.dir).sort()).toEqual(["current", old].sort());
});

it("reports a completed promotion with a warning if releasing its lock fails", async () => {
  const f = await guide();
  const first = await invoke(["stage", "demo", "--dir", f.dir], { cwd: f.root, env: f.env });
  expect(first.code, first.err).toBe(0);
  const old = readlinkSync(join(f.dir, "current"));
  const warnings: string[] = [];
  const code = await run(["stage", "demo", "--dir", f.dir], {
    cwd: f.root,
    env: { ...process.env, ...f.env },
    err: (text) => warnings.push(text),
    out: (text) => {
      if (text.startsWith("Staged "))
        writeFile(join(f.dir, "current.lock"), "unexpected", "blocks directory removal");
    },
  });
  expect(code, warnings.join("\n")).toBe(0);
  expect(readlinkSync(join(f.dir, "current"))).not.toBe(old);
  expect(readJson(f.dir, "current/manifest.json").readiness.ready).toBe(true);
  expect(warnings.join("\n")).toContain("promoted, but could not release");
  rmSync(join(f.dir, "current.lock"), { recursive: true });
});

it("refuses direct and symlinked storage inside the source checkout before writing", async () => {
  const f = await guide();
  const alias = join(makeTempDir(), "alias");
  symlinkSync(f.root, alias, "dir");
  for (const dir of [join(f.root, "staged"), join(alias, "staged")]) {
    const result = await invoke(["stage", "demo", "--dir", dir, "--json"], {
      cwd: f.root,
      env: f.env,
    });
    expect(result.code, result.out).toBe(1);
    expect(JSON.parse(result.out).error).toContain("inside the developer checkout");
    expect(existsSync(dir)).toBe(false);
  }
});

it("serializes concurrent staging and exposes complete retained versions", async () => {
  const f = await guide();
  const results = await Promise.all(
    ["referenced", "all"].map((files) =>
      invoke(["stage", "demo", "--dir", f.dir, "--files", files, "--json"], {
        cwd: f.root,
        env: f.env,
      }),
    ),
  );
  for (const result of results) expect(result.code, result.out).toBe(0);
  const versions = results.map((result) => JSON.parse(result.out).version);
  expect(new Set(versions).size).toBe(2);
  expect(versions).toContain(readlinkSync(join(f.dir, "current")));
  expect(readdirSync(f.dir).sort()).toEqual(["current", ...versions].sort());
  for (const version of versions) {
    const manifest = readJson(f.dir, `${version}/manifest.json`);
    expect(manifest.version).toBe(version);
    expect(manifest.readiness.ready).toBe(true);
    const html = bundleOf(readFileSync(join(f.dir, version, "index.html"), "utf8"));
    expect(Object.keys(html.files).sort()).toEqual(manifest.includedSource.head);
  }
});
