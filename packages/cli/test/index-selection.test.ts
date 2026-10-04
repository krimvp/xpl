import { readdirSync, rmSync, utimesSync } from "node:fs";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import {
  cloneDir,
  copyFixture,
  editFile,
  git,
  indexedFixture,
  invoke,
  PATCH_PATH,
  readFile,
  writeFile,
  xpl,
  xplJson,
  readJson,
} from "./helpers.js";

let base: string;
let baseCommit: string;

beforeAll(async () => {
  base = await indexedFixture();
  baseCommit = (await xplJson<{ commit: string }>(base, "outline", "--depth", "0")).json.commit;
});

function indexFiles(dir: string): string[] {
  return readdirSync(join(dir, ".explainer"))
    .filter((f) => f.startsWith("index-"))
    .sort();
}

/** Puts `runner.ts` in a new state, and indexes it. Returns the new commit id. */
async function reindexWith(dir: string, marker: string): Promise<string> {
  editFile(dir, "src/runner.ts", (text) =>
    text.replace("export type Logger", `// ${marker}\nexport type Logger`),
  );
  return (await xplJson<{ commit: string }>(dir, "index", "--precise", "off")).json.commit;
}

describe("index selection", () => {
  it("rejects freshness after blank lines move symbols, even with the same index commit label", async () => {
    const dir = cloneDir(base);
    editFile(dir, "src/runner.ts", (text) => "\n\n" + text);
    const { json } = await xplJson(
      dir,
      "outline",
      "--depth",
      "0",
      "--index",
      `.explainer/index-${baseCommit}.json`,
    );
    expect(json.warnings?.join("\n")).toContain("1 changed (src/runner.ts)");
    const rebuilt = await xplJson(dir, "index", "--precise", "off");
    expect(rebuilt.json.commit).not.toBe(baseCommit);
    // Reusing a commit label (or a legacy wt-id collision) cannot bypass source verification.
    const oldPath = `.explainer/index-${baseCommit}.json`;
    const old = readJson(dir, oldPath);
    old.commit = rebuilt.json.commit;
    writeFile(dir, oldPath, JSON.stringify(old));
    const relabeled = await xplJson(dir, "outline", "--depth", "0", "--index", oldPath);
    expect(relabeled.json.warnings?.join("\n")).toContain("1 changed (src/runner.ts)");
  });

  it("uses the index of the current commit id, even when another one is newer", async () => {
    const dir = cloneDir(base);
    const original = readFile(dir, "src/runner.ts");
    const other = await reindexWith(dir, "state B");
    expect(other).not.toBe(baseCommit);
    expect(indexFiles(dir)).toHaveLength(2);
    // back to the original text: the tree is state A again, and index B is the newer file
    writeFile(dir, "src/runner.ts", original);
    const later = new Date(Date.now() + 60_000);
    utimesSync(join(dir, ".explainer", `index-${other}.json`), later, later);

    const { json, err } = await xplJson<{ commit: string }>(dir, "outline", "--depth", "0");
    expect(json.commit).toBe(baseCommit);
    expect(err).toBe(""); // no stale warning: the index matches the tree
  });

  it("falls back to the newest index and warns when none matches the tree", async () => {
    const dir = cloneDir(base);
    const b = await reindexWith(dir, "state B");
    editFile(dir, "src/runner.ts", (text) => text.replace("state B", "state C"));
    const later = new Date(Date.now() + 60_000);
    utimesSync(join(dir, ".explainer", `index-${b}.json`), later, later);
    const { json, err } = await xplJson<{ commit: string }>(dir, "outline", "--depth", "0");
    expect(json.commit).toBe(b);
    expect(err).toBe("");
    const human = await xpl(dir, "outline", "--depth", "0");
    expect(human.err).toContain(`warning: index ${b}`);
    expect(human.err).toContain("1 changed (src/runner.ts)");
    expect(human.err).toContain("run `xpl index`");
  });

  it("--index picks a specific file (relative to the cwd or to --root) and still checks it", async () => {
    const dir = cloneDir(base);
    const b = await reindexWith(dir, "state B"); // the tree now matches B
    const a = join(".explainer", `index-${baseCommit}.json`);

    const viaCwd = await xplJson<{ commit: string }>(dir, "outline", "--depth", "0", "--index", a);
    expect(viaCwd.json.commit).toBe(baseCommit);
    expect(viaCwd.json.warnings?.[0]).toContain("does not match the working tree");
    expect(viaCwd.json.warnings?.[0]).toContain("1 changed (src/runner.ts)");

    const viaRoot = await xplJson<{ commit: string }>(
      "/",
      "outline",
      "--depth",
      "0",
      "--root",
      dir,
      "--index",
      a,
    );
    expect(viaRoot.json.commit).toBe(baseCommit);

    const explicitB = await xpl(
      dir,
      "outline",
      "--depth",
      "0",
      "--index",
      `.explainer/index-${b}.json`,
    );
    expect(explicitB.err).toBe("");
  });

  it("--index errors: missing file, not an index", async () => {
    const dir = cloneDir(base);
    const missing = await xpl(dir, "outline", "--index", "nope.json");
    expect(missing.code).toBe(1);
    expect(missing.err).toContain('index file "nope.json" not found');
    writeFile(dir, "other.json", '{"schema": "something-else"}');
    const wrong = await xpl(dir, "outline", "--index", "other.json");
    expect(wrong.code).toBe(1);
    expect(wrong.err).toContain("is not an xpl symbol index");
    writeFile(dir, "broken.json", "{ nope");
    const broken = await xpl(dir, "outline", "--index", "broken.json");
    expect(broken.code).toBe(1);
    expect(broken.err).toContain("is not valid JSON");
  });

  it("explainer commands use the explainer's own index; resolve moves to the newest", async () => {
    const dir = cloneDir(base);
    expect((await xpl(dir, "new", "demo")).code).toBe(0);
    expect((await xpl(dir, "apply", "demo", PATCH_PATH)).code).toBe(0);
    const b = await reindexWith(dir, "state B");

    // validate / status / apply keep using the explainer's index (A), and say what to do about it
    const validate = await xplJson<{ index: string; issues: { message: string }[] }>(
      dir,
      "validate",
      "demo",
    );
    expect(validate.json.index).toBe(`.explainer/index-${baseCommit}.json`);
    expect(validate.code).toBe(1);
    expect(validate.json.issues.length).toBeGreaterThanOrEqual(1);
    expect(validate.json.issues[0]!.message).toContain("xpl resolve demo --write");
    expect(validate.json.issues[0]!.message).toContain(
      `an index for the current tree exists: .explainer/index-${b}.json`,
    );

    // resolve looks at the code as it is now: the newest / current index
    const resolve = await xplJson<{ index: { path: string; commit: string }; moved: number }>(
      dir,
      "resolve",
      "demo",
    );
    expect(resolve.json.index).toEqual({ path: `.explainer/index-${b}.json`, commit: b });
    expect(resolve.json.warnings).toBeUndefined();
    expect(resolve.json.moved).toBeGreaterThan(0);

    // --index overrides the explainer's index for every command
    const forced = await xplJson<{ index: string }>(
      dir,
      "validate",
      "demo",
      "--index",
      `.explainer/index-${b}.json`,
      "--lenient",
    );
    expect(forced.json.index).toBe(`.explainer/index-${b}.json`);
  });

  it("falls back to selection when the explainer's index file is gone", async () => {
    const dir = cloneDir(base);
    expect((await xpl(dir, "new", "demo")).code).toBe(0);
    const b = await reindexWith(dir, "state B");
    rmSync(join(dir, ".explainer", `index-${baseCommit}.json`));
    const { json } = await xplJson<{ index: string }>(dir, "validate", "demo", "--lenient");
    expect(json.index).toBe(`.explainer/index-${b}.json`);
  });
});

describe("staleness warning", () => {
  it("names changed, new and deleted files", async () => {
    const dir = cloneDir(base);
    editFile(dir, "src/queue.ts", (text) => `${text}// changed\n`);
    writeFile(dir, "src/extra.ts", "export const extra = 1;\n");
    rmSync(join(dir, "src", "bus.ts"));
    const { code, err } = await xpl(dir, "outline", "--depth", "0");
    expect(code).toBe(0);
    expect(err).toContain(`warning: index ${baseCommit}`);
    expect(err).toContain("1 changed (src/queue.ts)");
    expect(err).toContain("1 new (src/extra.ts)");
    expect(err).toContain("1 deleted (src/bus.ts)");
    expect(err).toContain("Line numbers and offsets may be off; run `xpl index`");
  });

  it("is silent when the tree matches, and ignores changes to .explainer/", async () => {
    const dir = cloneDir(base);
    writeFile(dir, ".explainer/notes.explainer.json", "{}");
    const { err } = await xpl(dir, "outline", "--depth", "0");
    expect(err).toBe("");
  });

  it("XPL_SKIP_STALE_CHECK=1 skips the comparison", async () => {
    const dir = cloneDir(base);
    editFile(dir, "src/queue.ts", (text) => `${text}// changed\n`);
    const skipped = await invoke(["outline", "--depth", "0", "--root", dir], {
      cwd: dir,
      env: { XPL_SKIP_STALE_CHECK: "1" },
    });
    expect(skipped.code).toBe(0);
    expect(skipped.err).toBe("");
    expect((await xpl(dir, "outline", "--depth", "0")).err).toContain("does not match");
  });

  it("goes into the --json result instead of stderr", async () => {
    const dir = cloneDir(base);
    editFile(dir, "src/queue.ts", (text) => `${text}// changed\n`);
    const { json, err } = await xplJson<{ warnings: string[] }>(dir, "outline", "--depth", "0");
    expect(err).toBe("");
    expect(json.warnings).toHaveLength(1);
    expect(json.warnings[0]).toContain("src/queue.ts");
  });

  it("clean git tree: no warning at HEAD, a warning once a file changes", async () => {
    const dir = copyFixture();
    git(dir, "init", "-q", "-b", "main");
    git(dir, "add", "-A");
    git(dir, "commit", "-q", "-m", "init");
    const head = git(dir, "rev-parse", "HEAD").slice(0, 7);
    expect((await xpl(dir, "index", "--precise", "off")).code).toBe(0);

    const clean = await xplJson<{ commit: string }>(dir, "outline", "--depth", "0");
    expect(clean.json.commit).toBe(head);
    expect(clean.err).toBe("");
    expect(clean.json.warnings).toBeUndefined();

    editFile(dir, "src/queue.ts", (text) => `${text}// dirty\n`);
    const dirty = await xpl(dir, "outline", "--depth", "0");
    expect(dirty.err).toContain(`warning: index ${head}`);
    expect(dirty.err).toContain("1 changed (src/queue.ts)");

    // indexing the dirty tree gives a wt- id that matches it
    const fresh = await xplJson<{ commit: string }>(dir, "index", "--precise", "off");
    expect(fresh.json.commit).toMatch(/^wt-/);
    const after = await xpl(dir, "outline", "--depth", "0");
    expect(after.err).toBe("");
  });

  it("an index with a custom --commit label is fresh as long as the files match", async () => {
    const dir = copyFixture();
    git(dir, "init", "-q", "-b", "main");
    git(dir, "add", "-A");
    git(dir, "commit", "-q", "-m", "init");
    expect((await xpl(dir, "index", "--precise", "off", "--commit", "release-1")).code).toBe(0);
    const { json, err } = await xplJson<{ commit: string }>(dir, "outline", "--depth", "0");
    expect(json.commit).toBe("release-1");
    expect(err).toBe("");
    expect(json.warnings).toBeUndefined();
  });
});
