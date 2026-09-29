import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  buildIndex,
  resolveCommitId,
  validateCommitId,
  workingTreeId,
  writeIndex,
} from "../src/index.js";
import { git, makeDir, makeRepo, writeFiles } from "./helpers.js";

const sourceFiles = { "src/a.ts": "export const a = 1;\n", "README.md": "hello\n" };

describe("workingTreeId", () => {
  it("is wt- plus 10 hex chars, independent of input order", () => {
    const a = workingTreeId([
      { path: "b.ts", hash: "sha256:bbbbbbbbbbbb" },
      { path: "a.ts", hash: "sha256:aaaaaaaaaaaa" },
    ]);
    const b = workingTreeId([
      { path: "a.ts", hash: "sha256:aaaaaaaaaaaa" },
      { path: "b.ts", hash: "sha256:bbbbbbbbbbbb" },
    ]);
    expect(a).toMatch(/^wt-[0-9a-f]{10}$/);
    expect(a).toBe(b);
  });

  it("changes with a path or a hash", () => {
    const base = [{ path: "a.ts", hash: "sha256:aaaaaaaaaaaa" }];
    expect(workingTreeId(base)).not.toBe(
      workingTreeId([{ path: "b.ts", hash: "sha256:aaaaaaaaaaaa" }]),
    );
    expect(workingTreeId(base)).not.toBe(
      workingTreeId([{ path: "a.ts", hash: "sha256:bbbbbbbbbbbb" }]),
    );
  });

  it("hashes the sorted `path\\0hash\\n` list (documented format)", async () => {
    const { createHash } = await import("node:crypto");
    const expected = createHash("sha256")
      .update("a.ts\0sha256:1\nb.ts\0sha256:2\n")
      .digest("hex")
      .slice(0, 10);
    expect(
      workingTreeId([
        { path: "b.ts", hash: "sha256:2" },
        { path: "a.ts", hash: "sha256:1" },
      ]),
    ).toBe(`wt-${expected}`);
  });
});

describe("validateCommitId", () => {
  it.each(["a1b2c3d", "wt-3f1a9c2e4b", "v1.0.0", "feature_x"])("accepts %s", (id) => {
    expect(validateCommitId(id)).toBe(id);
  });
  it.each(["", "../evil", "a/b", "a b", "-x", ".hidden"])("rejects %j", (id) => {
    expect(() => validateCommitId(id)).toThrow(/invalid commit id/);
  });
});

describe("commit id of a git repository", () => {
  it("is the first 7 characters of HEAD when root is the top level and the tree is clean", async () => {
    const dir = makeRepo(sourceFiles);
    const head = git(dir, "rev-parse", "HEAD");
    const { index } = await buildIndex({ root: dir, precise: "off" });
    expect(index.commit).toBe(head.slice(0, 7));
    expect(index.commit).toHaveLength(7);
  });

  it("becomes wt-<hash> when a tracked file is modified, and is deterministic", async () => {
    const dir = makeRepo(sourceFiles);
    writeFileSync(join(dir, "src/a.ts"), "export const a = 2;\n");
    const first = (await buildIndex({ root: dir, precise: "off" })).index.commit;
    const second = (await buildIndex({ root: dir, precise: "off" })).index.commit;
    expect(first).toMatch(/^wt-[0-9a-f]{10}$/);
    expect(second).toBe(first);
  });

  it("becomes wt-<hash> for untracked files, and depends on file content", async () => {
    const dir = makeRepo(sourceFiles);
    writeFileSync(join(dir, "new.ts"), "export const n = 1;\n");
    const a = (await buildIndex({ root: dir, precise: "off" })).index.commit;
    writeFileSync(join(dir, "new.ts"), "export const n = 2;\n");
    const b = (await buildIndex({ root: dir, precise: "off" })).index.commit;
    expect(a).toMatch(/^wt-/);
    expect(b).toMatch(/^wt-/);
    expect(a).not.toBe(b);
  });

  it("ignores whitespace-only edits (the hash normalises lines), like anchors do", async () => {
    const dir = makeRepo({ "a.ts": "const x = 1;\nconst y = 2;\n" });
    writeFileSync(join(dir, "a.ts"), "  const x = 1;\n\n\tconst y = 2;   \n");
    const dirty = (await buildIndex({ root: dir, precise: "off" })).index.commit;
    writeFileSync(join(dir, "a.ts"), "const x = 1;\nconst y = 2;\n\n");
    const other = (await buildIndex({ root: dir, precise: "off" })).index.commit;
    expect(dirty).toBe(other);
  });

  it("is not changed by writing the index, .explainer/.gitignore or explainers", async () => {
    const dir = makeRepo(sourceFiles);
    const head = git(dir, "rev-parse", "HEAD").slice(0, 7);
    const first = await buildIndex({ root: dir, precise: "off" });
    expect(first.index.commit).toBe(head);
    await writeIndex(dir, first.index);
    writeFiles(dir, { ".explainer/x.explainer.json": "{}\n" });
    const second = await buildIndex({ root: dir, precise: "off" });
    expect(second.index.commit).toBe(head);
  });

  it("is wt-<hash> for a repository without commits", async () => {
    const dir = makeRepo(sourceFiles, false);
    const { index } = await buildIndex({ root: dir, precise: "off" });
    expect(index.commit).toMatch(/^wt-[0-9a-f]{10}$/);
  });

  it("is wt-<hash> when root is a subdirectory of the work tree, even if clean", async () => {
    const dir = makeRepo({ "pkg/a.ts": "export const a = 1;\n", "top.ts": "export {};\n" });
    const sub = join(dir, "pkg");
    const a = (await buildIndex({ root: sub, precise: "off" })).index.commit;
    expect(a).toMatch(/^wt-[0-9a-f]{10}$/);
    // Deterministic: it only depends on the indexed files (paths are relative to the root).
    const copy = makeDir({ "a.ts": "export const a = 1;\n" });
    expect((await buildIndex({ root: copy, precise: "off" })).index.commit).toBe(a);
  });

  it("an explicit commit wins over everything", async () => {
    const dir = makeRepo(sourceFiles);
    const { index } = await buildIndex({ root: dir, commit: "release-1", precise: "off" });
    expect(index.commit).toBe("release-1");
    await expect(buildIndex({ root: dir, commit: "../x", precise: "off" })).rejects.toThrow(
      /invalid commit id/,
    );
  });
});

describe("commit id without git", () => {
  it("is wt-<hash> of the files, deterministic and content sensitive", async () => {
    const dir = makeDir(sourceFiles);
    const a = (await buildIndex({ root: dir, precise: "off" })).index.commit;
    const b = (await buildIndex({ root: dir, precise: "off" })).index.commit;
    expect(a).toMatch(/^wt-[0-9a-f]{10}$/);
    expect(b).toBe(a);
    writeFileSync(join(dir, "README.md"), "changed\n");
    expect((await buildIndex({ root: dir, precise: "off" })).index.commit).not.toBe(a);
  });

  it("does not depend on the directory it lives in", async () => {
    const one = (await buildIndex({ root: makeDir(sourceFiles), precise: "off" })).index.commit;
    const two = (await buildIndex({ root: makeDir(sourceFiles), precise: "off" })).index.commit;
    expect(one).toBe(two);
  });

  it("resolveCommitId works on plain file lists", async () => {
    const files = [{ path: "a.ts", hash: "sha256:aaaaaaaaaaaa" }];
    const dir = makeDir();
    mkdirSync(join(dir, "x"));
    expect(await resolveCommitId({ root: dir, files })).toBe(workingTreeId(files));
    expect(await resolveCommitId({ root: dir, files, commit: "abc" })).toBe("abc");
  });
});
