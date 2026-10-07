import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { copyFixture, readJson, xpl, xplJson } from "./helpers.js";

describe("xpl start", () => {
  it("creates an index-backed first guide and an editable draft for its reader and question", async () => {
    const dir = copyFixture();
    const result = await xpl(
      dir,
      "start",
      "job-retries",
      "--question",
      "How does a failed job get retried?",
      "--audience",
      "Maintainers",
      "--precise",
      "off",
    );
    expect(result.code, result.err).toBe(0);
    expect(result.out).toContain("next: complete the TODOs");
    expect(result.out).toContain("xpl view job-retries");
    const draftPath = /draft patch: (.+)/.exec(result.out)?.[1];
    expect(draftPath).toBeDefined();
    expect(existsSync(draftPath!)).toBe(true);
    expect(draftPath!.startsWith(dir)).toBe(false);

    const guide = readJson(dir, ".explainer/job-retries.explainer.json");
    const patch = JSON.parse(readFileSync(draftPath!, "utf8"));
    expect(guide.index.path).toMatch(/^\.explainer\/index-/);
    expect(existsSync(join(dir, guide.index.path))).toBe(true);
    expect(guide.scope.audience).toBe("Maintainers");
    expect(guide.views[0].scope.question).toBe("How does a failed job get retried?");
    expect(patch.scope.audience).toBe("Maintainers");
    expect((await xpl(dir, "validate", "job-retries")).code).toBe(0);
  });

  it("starts a path draft at a named source symbol", async () => {
    const dir = copyFixture();
    const result = await xpl(
      dir,
      "start",
      "dispatch",
      "--question",
      "What happens after dispatch?",
      "--audience",
      "New maintainers",
      "--entry",
      "src/runner.ts#Runner.dispatch",
      "--precise",
      "off",
    );
    expect(result.code, result.err).toBe(0);
    const guide = readJson(dir, ".explainer/dispatch.explainer.json");
    expect(guide.views[0].type).toBe("sequence");
    expect(guide.views[0].scope.question).toBe("What happens after dispatch?");
    expect((await xpl(dir, "validate", "dispatch")).code).toBe(0);
  });

  it("requires a question and reader before creating files", async () => {
    const dir = copyFixture();
    const result = await xpl(dir, "start", "first");
    expect(result.code).toBe(2);
    expect(result.err).toContain("--question <question>");
    expect(existsSync(join(dir, ".explainer"))).toBe(false);

    const json = await xplJson(
      dir,
      "start",
      "first",
      "--question",
      "What runs?",
      "--audience",
      "Maintainers",
      "--precise",
      "off",
    );
    expect(json.code).toBe(0);
    expect(json.json).toMatchObject({
      ok: true,
      name: "first",
      path: ".explainer/first.explainer.json",
    });
    expect(existsSync(json.json.draft)).toBe(true);
  });
});
