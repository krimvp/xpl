import { chmodSync, existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { run } from "../src/cli.js";
import { INDEX_SCHEMA } from "@xpl/core";
import {
  copyFixture,
  git,
  invoke,
  readFile,
  readJson,
  writeFile,
  xpl,
  xplJson,
} from "./helpers.js";

describe("xpl index", () => {
  it("qualifies text's absent references in help because an artifact can provide them", async () => {
    const help = await invoke(["index", "--help"]);
    expect(help.code).toBe(0);
    expect(help.out).toContain(
      "`refs: none` (rust, yaml, json, toml, text without an artifact provider)",
    );
  });
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
    expect(out).toContain("Analysis coverage: 12 files; some analysis is limited or unavailable.");
    expect(out).toContain(
      "text (text): named symbols, full declaration ranges, nesting, calls, imports, inheritance, implementations, type references, reads, writes unsupported (0/1 files analyzed).",
    );
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
    expect(json.analysis.find((r: any) => r.provider === "files").capabilities).toEqual({
      fileAnchors: "supported",
    });
    expect(readdirSync(join(dir, ".explainer"))).toContain(`index-${json.commit}.json`);
  });

  it("reports bounded exclusions from enumerated source candidates", async () => {
    const dir = copyFixture();
    writeFile(dir, "large.txt", "x".repeat(1024 * 1024 + 1));
    writeFile(dir, "binary.dat", "a\0b");
    writeFile(dir, "binary2.dat", "a\0b");
    writeFile(dir, "binary3.dat", "a\0b");
    writeFile(dir, "binary4.dat", "a\0b");
    writeFile(dir, "go.sum", "ignored dependency lock\n");
    writeFile(dir, "draft.patch.json", "{}\n");
    const human = await xpl(dir, "index", "--precise", "off");
    expect(human.code).toBe(0);
    expect(human.out).toContain("Excluded from walked files:");
    expect(human.out).toContain("4 binary (binary.dat, binary2.dat, binary3.dat, …)");
    expect(human.out).toContain("1 oversized (large.txt)");
    expect(human.out).toContain("1 lockfile (go.sum)");
    expect(human.out).toContain("1 generated (draft.patch.json)");
    expect(human.out).toContain("Directories skipped by the walk are not counted.");
    const result = await xplJson(dir, "index", "--precise", "off");
    expect(result.json.exclusions).toEqual({
      scope: "walked files",
      reasons: [
        { reason: "generated", count: 1, examples: ["draft.patch.json"] },
        { reason: "lockfile", count: 1, examples: ["go.sum"] },
        { reason: "oversized", count: 1, examples: ["large.txt"] },
        { reason: "binary", count: 4, examples: ["binary.dat", "binary2.dat", "binary3.dat"] },
      ],
    });
  });

  it("reports scoped cache work and --no-cache performs extraction without touching cached facts", async () => {
    const dir = copyFixture();
    const first = await xplJson(dir, "index", "--precise", "off");
    expect(first.code).toBe(0);
    expect(first.json.extraction).toMatchObject({ enabled: true, hits: 0, misses: 11 });
    const warm = await xplJson(dir, "index", "--precise", "off");
    expect(warm.json.extraction).toMatchObject({ enabled: true, hits: 11, misses: 0 });
    expect(warm.json.extraction.scope).toBe(
      "file-local tree-sitter and tags; excludes resolution and semantic tools",
    );
    expect(warm.json.work.semanticRuns).toBe(0);
    const clean = await xplJson(dir, "index", "--precise", "off", "--no-cache");
    expect(clean.code).toBe(0);
    expect(clean.json.extraction).toMatchObject({ enabled: false, hits: 0, misses: 11 });
    const human = await xpl(dir, "index", "--precise", "off");
    expect(human.out).toMatch(
      /Extraction \(cache enabled\): 11 hits, 0 misses, [\d.]+ ms wall; file-local tree-sitter and tags only\./,
    );
    expect(human.out).toContain("semantic providers 0 runs");
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

describe("index progress and cancellation", () => {
  it("reports bounded phase and file progress only for interactive human output", async () => {
    const dir = copyFixture();
    for (const json of [false, true]) {
      const out: string[] = [],
        err: string[] = [];
      const code = await run(["index", "--precise", "off", ...(json ? ["--json"] : [])], {
        cwd: dir,
        isTTY: true,
        out: (text) => out.push(text),
        err: (text) => err.push(text),
      });
      expect(code).toBe(0);
      if (json) {
        expect(err).toEqual([]);
        expect(JSON.parse(out.join("\n")).ok).toBe(true);
      } else {
        expect(err).toContain("index: Extracting 12/12 files");
        expect(err).toContain("index: Writing index");
        expect(err.length).toBeLessThanOrEqual(10);
      }
    }
  });

  it.skipIf(process.platform === "win32")(
    "cancels a running semantic tool without publishing an index",
    async () => {
      const dir = copyFixture();
      const marker = join(dir, "provider-started");
      writeFile(
        dir,
        "npx",
        `#!${process.execPath}
import('node:fs').then(fs => fs.writeFileSync(${JSON.stringify(marker)}, 'started'));
setInterval(() => {}, 1000);
`,
      );
      chmodSync(join(dir, "npx"), 0o755);
      const abort = new AbortController();
      const err: string[] = [];
      vi.stubEnv("PATH", dir);
      vi.stubEnv("XPL_SCIP_TIMEOUT_MS", "3000");
      const running = run(["index", "--precise", "require", "--commit", "cancelled"], {
        cwd: dir,
        isTTY: false,
        signal: abort.signal,
        out: () => {},
        err: (text) => err.push(text),
      });
      let cancelledAt = 0;
      try {
        await expect.poll(() => existsSync(marker)).toBe(true);
      } finally {
        cancelledAt = Date.now();
        abort.abort();
        vi.unstubAllEnvs();
      }
      expect(await running).toBe(130);
      expect(Date.now() - cancelledAt).toBeLessThan(1500);
      expect(err.join("\n")).toContain("Indexing cancelled");
      expect(err.some((text) => text.startsWith("index: "))).toBe(false);
      expect(existsSync(join(dir, ".explainer/index-cancelled.json"))).toBe(false);
    },
  );

  it.each([
    [false, "Extracting"],
    [true, "Extracting"],
    [false, "Writing index"],
    [true, "Writing index"],
  ] as const)(
    "cancellation preserves the last complete index (previous=%s, phase=%s)",
    async (previous, phase) => {
      const dir = copyFixture();
      const path = ".explainer/index-stable.json";
      if (previous) await xpl(dir, "index", "--precise", "off", "--commit", "stable");
      const before = previous ? readFile(dir, path) : undefined;
      writeFile(dir, "new.ts", "export const newSymbol = 1;\n");
      const abort = new AbortController();
      const err: string[] = [];
      const code = await run(["index", "--precise", "off", "--commit", "stable"], {
        cwd: dir,
        isTTY: true,
        signal: abort.signal,
        out: () => {},
        err: (text) => {
          err.push(text);
          if (text.startsWith(`index: ${phase}`)) abort.abort();
        },
      });
      expect(code).toBe(130);
      expect(err.join("\n")).toContain("Indexing cancelled");
      if (previous) expect(readFile(dir, path)).toBe(before);
      else expect(existsSync(join(dir, path))).toBe(false);
      expect(
        (existsSync(join(dir, ".explainer")) ? readdirSync(join(dir, ".explainer")) : []).filter(
          (name) => name.endsWith(".tmp"),
        ),
      ).toEqual([]);
    },
  );
});
