import { readFileSync, rmSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";
import { indexedFixture, makeTempDir, writeFile, xpl, xplJson } from "./helpers.js";

it("lists local guides by recorded title, audience, question and snapshot without requiring an index or service", async () => {
  const dir = await indexedFixture();
  expect(
    (await xpl(dir, "new", "unhelpful-name", "--title", "How do failed jobs retry?")).code,
  ).toBe(0);
  const patch = writeFile(
    makeTempDir(),
    "guide-patch.json",
    JSON.stringify({
      scope: { audience: "Queue maintainers" },
      views: [
        {
          id: "view:retry",
          type: "graph",
          title: "Retry",
          include: [],
          scope: { root: "repo", depth: 3, question: "When do jobs return to the queue?" },
        },
      ],
    }),
  );
  const applied = await xpl(dir, "apply", "unhelpful-name", patch);
  expect(applied.code, applied.err + applied.out).toBe(0);
  const stored = JSON.parse(
    readFileSync(join(dir, ".explainer/unhelpful-name.explainer.json"), "utf8"),
  );
  rmSync(join(dir, stored.index.path));
  const result = await xplJson<{ guides: Record<string, unknown>[]; errors: unknown[] }>(
    dir,
    "guides",
  );
  expect(result.code).toBe(0);
  expect(result.json.errors).toEqual([]);
  expect(result.json.guides).toEqual([
    {
      id: "unhelpful-name",
      path: ".explainer/unhelpful-name.explainer.json",
      title: "How do failed jobs retry?",
      audience: "Queue maintainers",
      kind: "question",
      roots: ["repo"],
      questions: ["When do jobs return to the queue?"],
      commit: stored.repo.commit,
      indexCommit: stored.index.commit,
    },
  ]);
  const text = await xpl(dir, "guides");
  expect(text.out).toContain("How do failed jobs retry?");
  expect(text.out).toContain("Queue maintainers");
  expect(text.out).toContain("When do jobs return to the queue?");
});

it("reports unreadable/malformed and escaping guides separately from an empty library", async () => {
  const dir = makeTempDir();
  expect((await xpl(dir, "guides")).out).toBe("no local guides; create one with xpl new");
  const outside = makeTempDir();
  const secret = writeFile(outside, "private.json", '{"title":"outside content"}');
  writeFile(dir, ".explainer/broken.explainer.json", "not json");
  writeFile(dir, ".explainer/wrong.explainer.json", '{"schema":"other","title":42}');
  symlinkSync(secret, join(dir, ".explainer/escape.explainer.json"));
  const result = await xplJson<{ guides: unknown[]; errors: { id: string; error: string }[] }>(
    dir,
    "guides",
  );
  expect(result.code).toBe(1);
  expect(result.json.guides).toEqual([]);
  expect(result.json.errors.map((e) => e.id)).toEqual(["broken", "escape", "wrong"]);
  expect(result.json.errors[1]!.error).toContain("guide path leaves its repository");
  expect(JSON.stringify(result.json)).not.toContain("outside content");
});

it("reports a failed inventory read instead of claiming the library is empty", async () => {
  const dir = makeTempDir();
  writeFile(dir, ".explainer", "not a directory");
  const result = await xpl(dir, "guides");
  expect(result.code).toBe(1);
  expect(result.err).toContain("cannot list repository guides");
  expect(result.out).toBe("");
});

it("does not enumerate an escaping or dangling guide directory", async () => {
  const outside = makeTempDir();
  writeFile(outside, "outside-title.explainer.json", "{}");
  for (const target of [outside, join(outside, "missing")]) {
    const dir = makeTempDir();
    symlinkSync(target, join(dir, ".explainer"));
    const result = await xpl(dir, "guides");
    expect(result.code).toBe(1);
    expect(result.err).toContain("cannot list repository guides");
    expect(result.out).toBe("");
    expect(result.err).not.toContain("outside-title");
  }
});
