/**
 * The skill's documentation is executable: every block of `reference/patch-format.md` marked `json patch`
 * applies, in order, to a fresh explainer on the TypeScript fixture and leaves a valid explainer, and each
 * worked example patch applies and validates on a fresh copy of the fixture it was written for.
 */
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { indexedFixture, invoke, readJson, xpl } from "./helpers.js";

const here = dirname(fileURLToPath(import.meta.url));
const SKILL = resolve(here, "..", "..", "..", "skill", "code-explainer");
const PATCH_FORMAT = join(SKILL, "reference", "patch-format.md");
const PATCH_KEYS = ["title", "nodes", "edges", "concepts", "views", "tours", "remove"];

/** The fenced blocks whose info string starts with `json`, with the info string and their line in the file. */
function jsonBlocks(markdown: string): { line: number; info: string; text: string }[] {
  const blocks: { line: number; info: string; text: string }[] = [];
  const lines = markdown.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const open = /^```(json.*?)\s*$/.exec(lines[i]!);
    if (!open) continue;
    const start = i + 1;
    const body: string[] = [];
    for (i = start; i < lines.length && !/^```\s*$/.test(lines[i]!); i++) body.push(lines[i]!);
    blocks.push({ line: start, info: open[1]!, text: body.join("\n") });
  }
  return blocks;
}

/** The blocks marked `json patch`: real patches. */
function patchBlocks(markdown: string): { line: number; text: string }[] {
  return jsonBlocks(markdown).filter((block) => block.info === "json patch");
}

describe("reference/patch-format.md", () => {
  const blocks = patchBlocks(readFileSync(PATCH_FORMAT, "utf8"));

  it("has a runnable block for every element type and for the newer patch fields", () => {
    expect(blocks.length).toBeGreaterThanOrEqual(10);
    const all = blocks.map((b) => b.text).join("\n");
    for (const needle of [
      '"grp:scheduling"',
      '"edge:job-completed"',
      '"edge:calls:file:src/runner.ts->file:src/worker.ts"',
      '"concept:retry-policy"',
      '"view:overview"',
      '"view:dispatch"',
      '"tour:retries"',
      '"includeAdd"',
      '"includeRemove"',
      '"excludeFiles"',
      '"stepsUpdate"',
    ]) {
      expect(all, needle).toContain(needle);
    }
  });

  it("every `json patch` block applies in order to a fresh explainer, which then validates strictly", async () => {
    const dir = await indexedFixture("ts-jobrunner");
    expect((await xpl(dir, "new", "doc", "--title", "Doc")).code).toBe(0);
    for (const block of blocks) {
      expect(() => JSON.parse(block.text), `line ${block.line}: valid JSON`).not.toThrow();
      const applied = await invoke(["apply", "doc", "-"], { cwd: dir, stdin: block.text });
      expect(
        applied.code,
        `patch-format.md line ${block.line}\n${applied.out}\n${applied.err}`,
      ).toBe(0);
      expect(applied.out, `line ${block.line}`).toMatch(/^applied to /);
      expect(applied.out, `line ${block.line}: no warnings`).not.toContain("warning");
    }
    const validated = await xpl(dir, "validate", "doc");
    expect(validated.code, validated.out).toBe(0);
    expect(validated.out).toMatch(/^ok: .*no errors, no warnings$/);
    // and every anchor the patches made resolves
    const anchors = await xpl(dir, "anchors", "doc");
    expect(anchors.code).toBe(0);
    expect(anchors.out).toMatch(/drifted 0, missing 0$/);
  });

  it("the base-anchor example (`json base`, it needs a change record) is a base anchor", () => {
    const base = jsonBlocks(readFileSync(PATCH_FORMAT, "utf8")).filter(
      (b) => b.info === "json base",
    );
    expect(base).toHaveLength(1);
    const anchor = JSON.parse(base[0]!.text) as Record<string, unknown>;
    expect(anchor).toMatchObject({ at: "base", role: expect.any(String) });
    expect("symbol" in anchor).toBe(false);
    expect("find" in anchor || "span" in anchor).toBe(true);
  });

  it("the other `json` blocks are valid too: the shape template applies, the anchor example anchors", async () => {
    const plain = jsonBlocks(readFileSync(PATCH_FORMAT, "utf8")).filter((b) => b.info === "json");
    expect(plain.length).toBeGreaterThanOrEqual(2);
    const dir = await indexedFixture("ts-jobrunner");
    expect((await xpl(dir, "new", "doc")).code).toBe(0);
    for (const block of plain) {
      const value = JSON.parse(block.text) as Record<string, unknown>;
      let patch: unknown;
      if ("file" in value && "role" in value) {
        // an anchor: put it on a concept
        patch = { concepts: [{ id: "concept:anchor-doc", label: "Anchor", anchors: [value] }] };
      } else if (Object.keys(value).every((k) => PATCH_KEYS.includes(k))) {
        patch = value; // the top-level shape
      } else {
        throw new Error(
          `patch-format.md line ${block.line}: a \`json\` block that is neither a patch nor an anchor; mark it \`json patch\` or extend this test`,
        );
      }
      const applied = await invoke(["apply", "doc", "-"], {
        cwd: dir,
        stdin: JSON.stringify(patch),
      });
      expect(applied.code, `patch-format.md line ${block.line}\n${applied.out}`).toBe(0);
      expect(applied.out).not.toMatch(/^error/m);
    }
  });

  it("the whole sequence is idempotent: applying it a second time changes nothing", async () => {
    const dir = await indexedFixture("ts-jobrunner");
    await xpl(dir, "new", "doc");
    for (const block of blocks)
      await invoke(["apply", "doc", "-"], { cwd: dir, stdin: block.text });
    const before = JSON.stringify(readJson(dir, ".explainer/doc.explainer.json"));
    for (const block of blocks) {
      const again = await invoke(["apply", "doc", "-"], { cwd: dir, stdin: block.text });
      expect(again.code, `line ${block.line}`).toBe(0);
    }
    expect(JSON.stringify(readJson(dir, ".explainer/doc.explainer.json"))).toBe(before);
  });
});

describe("reference/examples", () => {
  const cases: [string, string, string][] = [
    [
      "go-retry.patch.json",
      "go-jobrunner",
      "a question (sequence + graph views, groups, edges, tour)",
    ],
    [
      "py-overview.patch.json",
      "py-jobrunner",
      "a repo overview (groups, summaries, startup sequence)",
    ],
  ];
  for (const [file, fixture, what] of cases) {
    it(`${file} applies to a fresh ${fixture} and validates strictly (${what})`, async () => {
      const dir = await indexedFixture(fixture);
      expect((await xpl(dir, "new", "example")).code).toBe(0);
      const patch = join(SKILL, "reference", "examples", file);
      const applied = await xpl(dir, "apply", "example", patch);
      expect(applied.code, `${applied.out}\n${applied.err}`).toBe(0);
      expect(applied.out).toMatch(/^applied to /);
      expect(applied.out).not.toMatch(/^error/m);
      const validated = await xpl(dir, "validate", "example");
      expect(validated.code, validated.out).toBe(0);
      expect(validated.out).toMatch(/^ok: .*no errors, no warnings$/);
      // it is complete: nothing the views show is left without a summary
      const status = await xpl(dir, "status", "example");
      expect(status.out).toMatch(
        /^to do: 0 unexplained, 0 drifted, 0 missing anchors, 0 requests$/m,
      );
      // applying it again is a no-op
      const again = await xpl(dir, "apply", "example", patch);
      expect(again.code).toBe(0);
      expect(again.out).toContain("no changes");
    });
  }
});
