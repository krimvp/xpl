import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { INDEX_SCHEMA } from "@xpl/core";
import { copyFixture, git, readFile, readJson, writeFile, xpl, xplJson } from "./helpers.js";

describe("xpl index", () => {
  it("writes .explainer/index-<commit>.json and prints path, commit and per-language summary", async () => {
    const dir = copyFixture();
    const { code, out, err } = await xpl(dir, "index", "--precise", "off");
    expect(err).toBe("");
    expect(code).toBe(0);

    const file = /index written: (\S+)/.exec(out)?.[1];
    expect(file).toMatch(/^\.explainer\/index-wt-[0-9a-f]{10}\.json$/);
    expect(existsSync(join(dir, file!))).toBe(true);

    const index = readJson(dir, file!);
    expect(index.schema).toBe(INDEX_SCHEMA);
    expect(out).toContain(`commit: ${index.commit}`);
    expect(out).toContain(`files: ${index.files.length}`);
    expect(out).toMatch(/typescript\s+8 files\s+\d+ symbols\s+refs: heuristic/);
    expect(out).toMatch(/yaml\s+1 file\s+16 symbols\s+refs: none/);
    expect(index.languages.typescript.refs).toBe("heuristic");
    expect(index.symbols.some((s: any) => s.id === "src/runner.ts#Runner.dispatch")).toBe(true);
  });

  it("writes .explainer/.gitignore for the generated indexes", async () => {
    const dir = copyFixture();
    await xpl(dir, "index", "--precise", "off");
    expect(readFile(dir, ".explainer/.gitignore")).toContain("index-*.json");
  });

  it("--json prints the summary as data", async () => {
    const dir = copyFixture();
    const { code, json } = await xplJson(dir, "index", "--precise", "off");
    expect(code).toBe(0);
    expect(json.ok).toBe(true);
    expect(json.path).toBe(`.explainer/index-${json.commit}.json`);
    expect(json.files).toBe(12);
    expect(json.symbols).toBeGreaterThan(100);
    expect(json.languages.typescript).toMatchObject({ files: 8, refs: "heuristic" });
    expect(readdirSync(join(dir, ".explainer"))).toContain(`index-${json.commit}.json`);
  });

  it("--commit names the index file and the commit", async () => {
    const dir = copyFixture();
    const { code, out } = await xpl(dir, "index", "--precise", "off", "--commit", "v1.0");
    expect(code).toBe(0);
    expect(out).toContain("index written: .explainer/index-v1.0.json");
    expect(readJson(dir, ".explainer/index-v1.0.json").commit).toBe("v1.0");
  });

  it("rejects a bad commit id and a bad --precise value", async () => {
    const dir = copyFixture();
    const commit = await xpl(dir, "index", "--precise", "off", "--commit", "no spaces/allowed");
    expect(commit.code).toBe(1);
    expect(commit.err).toContain("invalid commit id");
    const precise = await xpl(dir, "index", "--precise", "maybe");
    expect(precise.code).toBe(2);
    expect(precise.err).toContain("--precise must be one of auto, off, require");
  });

  it("uses the short HEAD as commit id for a clean top-level git tree", async () => {
    const dir = copyFixture();
    git(dir, "init", "-q", "-b", "main");
    git(dir, "add", "-A");
    git(dir, "commit", "-q", "-m", "init");
    const head = git(dir, "rev-parse", "HEAD").slice(0, 7);
    const { code, json } = await xplJson(dir, "index", "--precise", "off");
    expect(code).toBe(0);
    expect(json.commit).toBe(head);
    // .explainer/ does not make the tree dirty: indexing again gives the same id
    const again = await xplJson(dir, "index", "--precise", "off");
    expect(again.json.commit).toBe(head);
  });

  it("prints the indexer's warnings (stderr, or in --json) and still succeeds", async () => {
    const dir = copyFixture();
    writeFile(dir, "src/broken.ts", "export function (((\n");
    const { code, out, err } = await xpl(dir, "index", "--precise", "off");
    expect(code).toBe(0);
    expect(err).toMatch(/^warning: 1 file\(s\) have syntax errors.*src\/broken\.ts/);
    expect(out).toContain("index written:");
    const json = await xplJson<{ warnings: string[] }>(dir, "index", "--precise", "off");
    expect(json.err).toBe("");
    expect(json.json.warnings[0]).toContain("src/broken.ts");
  });

  it("hints which explainers must move to the new index", async () => {
    const dir = copyFixture();
    await xpl(dir, "index", "--precise", "off");
    expect((await xpl(dir, "new", "demo")).code).toBe(0);
    writeFile(dir, "src/extra.ts", "export const extra = 1;\n");
    const { out } = await xpl(dir, "index", "--precise", "off");
    expect(out).toContain("hint: 1 explainer (demo) is bound to another index");
    expect(out).toContain("xpl resolve <name> --write");
    const json = (await xplJson(dir, "index", "--precise", "off")).json;
    expect(json.explainersToResolve).toEqual(["demo"]);
  });
});
