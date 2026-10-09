import { expect, it, vi } from "vitest";
import fs from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import {
  copyFileSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { buildIndex } from "../src/index.js";
import { ExtractionCache, type ExtractionProfile } from "../src/extraction-cache.js";
import { allWasmSources, resolveWasmFile, setWasmDir } from "../src/wasm-files.js";
import { makeDir, makeRepo, providerFacts, writeFiles } from "./helpers.js";
import type { IndexProvider, ProviderSource } from "../src/providers.js";
import { TypeScriptResolutionExperiment } from "../src/resolve/typescript-experiment.js";

it.each(
  [".explainer/cache", ".explainer", ".explainer/cache/extraction-v1"].flatMap((path) =>
    [false, true].map((git) => ({ path, git })),
  ),
)("bypasses redirected cache at $path with git discovery $git", async ({ path, git }) => {
  const sources = {
    "a.ts": "export function run() {}",
    "shared-cache/source.ts": "export const source = 1;",
  };
  const root = git ? makeRepo(sources) : makeDir(sources);
  const link = join(root, path);
  mkdirSync(dirname(link), { recursive: true });
  symlinkSync(relative(dirname(link), join(root, "shared-cache")), link, "dir");
  const first = await buildIndex({ root, precise: "off" });
  const second = await buildIndex({ root, precise: "off" });
  // The symlink target is ordinary source. It stays discoverable, but receives no generated output.
  expect(second.index.files.map((file) => file.path)).toEqual(["a.ts", "shared-cache/source.ts"]);
  expect(second.index.symbols.map((symbol) => symbol.id)).toEqual([
    "a.ts#run",
    "shared-cache/source.ts#source",
  ]);
  expect(readdirSync(join(root, "shared-cache"))).toEqual(["source.ts"]);
  expect(second.extraction).toMatchObject({
    enabled: false,
    hits: 0,
    misses: 2,
    bypassReason: `${path} aliases repository directory shared-cache`,
  });
  expect(JSON.stringify(second.index)).toBe(JSON.stringify(first.index));
  const clean = await buildIndex({ root, precise: "off", cache: false });
  expect(JSON.stringify(second.index)).toBe(JSON.stringify(clean.index));
  expect(second.warnings).toEqual(clean.warnings);
});

it.each([
  ...[".explainer/cache", ".explainer", ".explainer/cache/extraction-v1"].flatMap((path) =>
    [false, true].flatMap((git) =>
      (path === ".explainer/cache" ? [false, true] : [false]).map((empty) => ({
        path,
        git,
        empty,
        target: "shared-cache",
      })),
    ),
  ),
  { path: ".explainer/cache", git: true, empty: true, target: "node_modules" },
])(
  "bypasses a bind alias at $path to $target with git $git and empty target $empty",
  async ({ path, git, empty, target }) => {
    const sources = {
      "a.ts": "export function run() {}",
      ...(empty ? {} : { "shared-cache/source.ts": "export const source = 1;" }),
    };
    const root = git ? makeRepo(sources) : makeDir(sources);
    const shared = join(root, target);
    const mounted = join(root, path);
    mkdirSync(shared, { recursive: true });
    mkdirSync(mounted, { recursive: true });
    // Keep the regression portable: match a bind mount's stat identity without changing path shape.
    const realStat = fs.stat.bind(fs);
    const spy = vi
      .spyOn(fs, "stat")
      .mockImplementation((file, options) =>
        realStat(String(file) === mounted ? shared : file, options),
      );
    syncBuiltinESMExports();
    try {
      const first = await buildIndex({ root, precise: "off" });
      const second = await buildIndex({ root, precise: "off" });
      expect(second.index.files.map((file) => file.path)).toEqual(
        empty ? ["a.ts"] : ["a.ts", "shared-cache/source.ts"],
      );
      expect(second.extraction).toMatchObject({
        enabled: false,
        hits: 0,
        misses: empty ? 1 : 2,
        bypassReason: `${path} aliases repository directory ${target}`,
      });
      expect(readdirSync(mounted)).toEqual([]);
      expect(JSON.stringify(second.index)).toBe(JSON.stringify(first.index));
      const clean = await buildIndex({ root, precise: "off", cache: false });
      expect(JSON.stringify(second.index)).toBe(JSON.stringify(clean.index));
      expect(second.warnings).toEqual(clean.warnings);
    } finally {
      spy.mockRestore();
      syncBuiltinESMExports();
    }
  },
);

it("bypasses a cache reached through a tracked directory symlink", async () => {
  const root = makeRepo({
    "a.ts": "export function run() {}",
    "shared-cache/source.ts": "export const source = 1;",
  });
  const cache = join(root, ".explainer/cache");
  const shared = join(root, "shared-cache");
  mkdirSync(dirname(cache));
  renameSync(shared, cache);
  symlinkSync(".explainer/cache", shared, "dir");
  const first = await buildIndex({ root, precise: "off" });
  const second = await buildIndex({ root, precise: "off" });
  expect(second.index.files.map((file) => file.path)).toEqual(["a.ts", "shared-cache/source.ts"]);
  expect(second.extraction).toMatchObject({
    enabled: false,
    hits: 0,
    misses: 2,
    bypassReason: ".explainer/cache aliases repository directory shared-cache",
  });
  expect(readdirSync(cache)).toEqual(["source.ts"]);
  expect(JSON.stringify(second.index)).toBe(JSON.stringify(first.index));
  const clean = await buildIndex({ root, precise: "off", cache: false });
  expect(JSON.stringify(second.index)).toBe(JSON.stringify(clean.index));
});

it("keeps reuse when directories share an inode number on different devices", async () => {
  const root = makeDir({ "a.ts": "export function run() {}" });
  const shared = join(root, "shared-cache");
  const mounted = join(root, ".explainer/cache");
  mkdirSync(shared);
  mkdirSync(mounted, { recursive: true });
  const realStat = fs.stat.bind(fs);
  const spy = vi.spyOn(fs, "stat").mockImplementation(async (file, options) => {
    const info = await realStat(String(file) === mounted ? shared : file, options);
    if (String(file) === mounted) {
      if (info === undefined)
        throw new Error("expected fs.stat to find the shared cache directory");
      Object.defineProperty(info, "dev", {
        value: typeof info.dev === "bigint" ? info.dev + 1n : info.dev + 1,
      });
    }
    return info;
  });
  syncBuiltinESMExports();
  try {
    const first = await buildIndex({ root, precise: "off" });
    const second = await buildIndex({ root, precise: "off" });
    expect(second.extraction).toMatchObject({ enabled: true, hits: 1, misses: 0 });
    expect(second.extraction.bypassReason).toBeUndefined();
    expect(JSON.stringify(second.index)).toBe(JSON.stringify(first.index));
  } finally {
    spy.mockRestore();
    syncBuiltinESMExports();
  }
});

it("reuses existing cache entries isolated outside the source tree", async () => {
  const root = makeDir({ "a.ts": "export function run() {}" });
  const cold = await buildIndex({ root, precise: "off" });
  expect(cold.extraction).toMatchObject({ enabled: true, hits: 0, misses: 1 });
  const redirected = join(makeDir(), "cache");
  const cache = join(root, ".explainer", "cache");
  renameSync(cache, redirected);
  symlinkSync(redirected, cache, "dir");
  const entries = readdirSync(join(redirected, "extraction-v1"));
  expect(entries).toHaveLength(1);
  const reused = await buildIndex({ root, precise: "off" });
  expect(reused.extraction).toMatchObject({ enabled: true, hits: 1, misses: 0 });
  expect(JSON.stringify(reused.index)).toBe(JSON.stringify(cold.index));
  expect(readdirSync(join(redirected, "extraction-v1"))).toEqual(entries);
});

const equivalenceRoots = [
  resolve("."),
  ...(process.env.XPL_CACHE_EQUIVALENCE_ROOT
    ? [resolve(process.env.XPL_CACHE_EQUIVALENCE_ROOT)]
    : []),
];

it.each(equivalenceRoots)(
  "the whole cached index and warnings match a clean build on %s",
  async (root) => {
    for (const languages of [undefined, ["typescript", "tsx", "javascript", "json"]]) {
      const experiment = new TypeScriptResolutionExperiment();
      const options = { root, precise: "off" as const, languages };
      await buildIndex({ ...options, experimentalResolution: experiment });
      const warm = await buildIndex({ ...options, experimentalResolution: experiment });
      expect(warm.extraction.misses).toBe(0);
      const clean = await buildIndex({ ...options, cache: false });
      expect(JSON.stringify(warm.index)).toBe(JSON.stringify(clean.index));
      expect(warm.warnings).toEqual(clean.warnings);
      if (languages) {
        expect(experiment.report.fallback).toBe("");
        expect(experiment.report.resolvedFiles).toEqual([]);
        expect(experiment.report.reusedFiles).toEqual(
          warm.index.files.filter((f) => f.language !== "json").map((f) => f.path),
        );
      }
    }
  },
  360_000,
);

it("reuses extraction while publishing the whole clean index, including inference and diagnostics", async () => {
  const root = makeDir({
    "a.ts":
      'import { readFileSync } from "node:fs"; export function run() { readFileSync("./config.json"); }',
    "a.py": "class Runner:\n    def run(self): pass\n",
    "a.go":
      "package a\ntype Work interface { Run() }\ntype Runner struct{}\nfunc (Runner) Run() {}\n",
    "a.rs": "trait Work { fn run(&self); }\nfn broken(\n",
    "config.json": '{ "limit": 3 }',
    "config.yaml": "limit: 3\n",
    "config.toml": "limit = 3\n",
    "broken.ts": "export function valid() {}\nfunction broken(\n",
    "README.md": "A runner.",
  });
  const cold = await buildIndex({ root, precise: "off" });
  expect(cold.extraction).toMatchObject({ enabled: true, hits: 0, misses: 8 });
  const warm = await buildIndex({ root, precise: "off" });
  expect(warm.extraction).toMatchObject({ enabled: true, hits: 8, misses: 0 });
  const clean = await buildIndex({ root, precise: "off", cache: false });
  expect(JSON.stringify(warm.index)).toBe(JSON.stringify(clean.index));
  expect(warm.warnings).toEqual(clean.warnings);
  expect(warm.index.refs.filter((r) => r.kind === "implements").map((r) => [r.from, r.to])).toEqual(
    [["a.go#Runner", "a.go#Work"]],
  );
  expect(warm.index.resources?.map((r) => r.files)).toEqual([["config.json"]]);
  expect(warm.warnings).toHaveLength(2);
});

it("resolves unchanged callers again after declaration, re-export and project configuration changes", async () => {
  const root = makeDir({
    "a.ts": "export function Alpha() {}",
    "b.ts": "export function Beta() {}",
    "barrel.ts": 'export { Alpha as run } from "./a";',
    "caller.ts": 'import { run } from "@entry"; export function caller() { run(); }',
    "tsconfig.json": '{"compilerOptions":{"paths":{"@entry":["./barrel.ts"]}}}',
  });
  const calls = (index: Awaited<ReturnType<typeof buildIndex>>["index"]) =>
    index.refs.filter((r) => r.kind === "call").map((r) => [r.from, r.to]);
  const first = await buildIndex({ root, precise: "off" });
  expect(calls(first.index)).toEqual([["caller.ts#caller", "a.ts#Alpha"]]);
  const changes: {
    files: Record<string, string>;
    hits: number;
    misses: number;
    target: string | undefined;
  }[] = [
    { files: { "a.ts": "export function Removed() {}" }, hits: 4, misses: 1, target: undefined },
    {
      files: { "barrel.ts": 'export { Beta as run } from "./b";' },
      hits: 4,
      misses: 1,
      target: "b.ts#Beta",
    },
    {
      files: {
        "tsconfig.json": '{"compilerOptions":{"paths":{"@entry":["./a.ts"]}}}',
        "a.ts": "export function run() {}",
      },
      hits: 3,
      misses: 2,
      target: "a.ts#run",
    },
  ];
  for (const change of changes) {
    writeFiles(root, change.files);
    const cached = await buildIndex({ root, precise: "off" });
    expect(cached.extraction).toMatchObject({ hits: change.hits, misses: change.misses });
    expect(calls(cached.index)).toEqual(change.target ? [["caller.ts#caller", change.target]] : []);
    const clean = await buildIndex({ root, precise: "off", cache: false });
    expect(JSON.stringify(cached.index)).toBe(JSON.stringify(clean.index));
    expect(cached.warnings).toEqual(clean.warnings);
  }
});

it("uses current discovery after additions, deletions, renames, language and filter changes", async () => {
  const root = makeDir({ "a.ts": "export function run() {}", "gone.ts": "export const gone = 1;" });
  await buildIndex({ root, precise: "off" });
  writeFiles(root, { "new.py": "def run(): pass\n" });
  renameSync(join(root, "a.ts"), join(root, "renamed.js"));
  rmSync(join(root, "gone.ts"));
  const cached = await buildIndex({ root, precise: "off" });
  expect(cached.extraction).toMatchObject({ hits: 0, misses: 2 });
  expect(cached.index.symbols.map((s) => s.id)).toEqual(["new.py#run", "renamed.js#run"]);
  expect(cached.index.files.map((f) => [f.path, f.language])).toEqual([
    ["new.py", "python"],
    ["renamed.js", "javascript"],
  ]);
  expect(JSON.stringify(cached.index)).toBe(
    JSON.stringify((await buildIndex({ root, precise: "off", cache: false })).index),
  );
  const filtered = await buildIndex({ root, precise: "off", languages: ["python"] });
  expect(filtered.extraction).toMatchObject({ hits: 1, misses: 0 });
  expect(filtered.index.symbols.map((s) => s.id)).toEqual(["new.py#run"]);
});

it("reruns semantic providers even when all file-local extractions hit", async () => {
  const root = makeDir({ "a.ts": "export function a() {}" });
  let runs = 0;
  const provider: IndexProvider = {
    id: "semantic",
    languages: ["typescript"],
    capabilities: { call: "supported" },
    async analyze(input) {
      runs++;
      return providerFacts(input, { tool: "semantic@1", refs: [], describedFiles: ["a.ts"] }, this);
    },
  };
  const experiment = new TypeScriptResolutionExperiment();
  await buildIndex({ root, providers: [provider], experimentalResolution: experiment });
  const warm = await buildIndex({
    root,
    providers: [provider],
    experimentalResolution: experiment,
  });
  expect(warm.extraction).toMatchObject({ hits: 1, misses: 0 });
  expect(experiment.report.reusedFiles).toEqual(["a.ts"]);
  expect(runs).toBe(2);
  expect(warm.work.semanticRuns).toBe(1);
  const clean = await buildIndex({ root, cache: false, providers: [provider] });
  expect(JSON.stringify(warm.index)).toBe(JSON.stringify(clean.index));
});

it("falls back from missing, damaged, wrong-key and interrupted entries without changing snapshot identity", async () => {
  const root = makeRepo({ "a.ts": "export function run() {}" });
  const first = await buildIndex({ root, precise: "off" });
  const dir = join(root, ".explainer/cache/extraction-v1");
  const target = join(dir, readdirSync(dir)[0]!);
  const original = readFileSync(target, "utf8");
  writeFileSync(join(dir, "interrupted.json.tmp"), "{");
  const interrupted = await buildIndex({ root, precise: "off" });
  expect(interrupted.extraction).toMatchObject({ hits: 1, misses: 0 });
  expect(JSON.stringify(interrupted.index)).toBe(JSON.stringify(first.index));
  const damaged = JSON.parse(original);
  damaged.payload = damaged.payload.replace("run", "bad");
  const wrongKey = JSON.parse(original);
  const wrongInput = JSON.parse(wrongKey.input);
  wrongInput.revision++;
  wrongKey.input = JSON.stringify(wrongInput);
  wrongKey.checksum = createHash("sha256")
    .update(`${wrongKey.input}\0${wrongKey.payload}`)
    .digest("hex");
  for (const bad of ["{", "{}", JSON.stringify(damaged), JSON.stringify(wrongKey), undefined]) {
    if (bad === undefined) rmSync(target);
    else writeFileSync(target, bad);
    const built = await buildIndex({ root, precise: "off" });
    expect(built.extraction).toMatchObject({ hits: 0, misses: 1 });
    expect(JSON.stringify(built.index)).toBe(JSON.stringify(first.index));
    expect(built.warnings).toEqual([]);
  }
  const before = readdirSync(dir).map((file) => [file, readFileSync(join(dir, file), "utf8")]);
  const clean = await buildIndex({ root, precise: "off", cache: false });
  expect(clean.extraction).toMatchObject({ enabled: false, hits: 0, misses: 1 });
  expect(readdirSync(dir).map((file) => [file, readFileSync(join(dir, file), "utf8")])).toEqual(
    before,
  );
  expect(JSON.stringify(clean.index)).toBe(JSON.stringify(first.index));
});

it("builds correctly when the cache directory cannot be written", async () => {
  const root = makeDir({
    "a.ts": "export const a = 1;",
    ".explainer/cache": "a file blocks mkdir",
  });
  const cached = await buildIndex({ root, precise: "off" });
  expect(cached.extraction).toMatchObject({ hits: 0, misses: 1, writeFailures: 1 });
  const clean = await buildIndex({ root, precise: "off", cache: false });
  expect(JSON.stringify(cached.index)).toBe(JSON.stringify(clean.index));
  expect(cached.warnings).toEqual([]);
});

it("keys exact source content even when anchor hashes normalize the edit", async () => {
  const root = makeDir({ "a.ts": "export function run() {}\n" });
  const first = await buildIndex({ root, precise: "off" });
  writeFiles(root, { "a.ts": "export function run() {}\r\n" });
  const edited = await buildIndex({ root, precise: "off" });
  expect(edited.index.files[0]!.hash).toBe(first.index.files[0]!.hash);
  expect(edited.extraction).toMatchObject({ hits: 0, misses: 1 });
  expect(JSON.stringify(edited.index)).toBe(
    JSON.stringify((await buildIndex({ root, precise: "off", cache: false })).index),
  );
});

it("invalidates file facts for provider revisions, options, language, source and changed grammar bytes", async () => {
  const root = makeDir();
  const wasm = makeDir();
  for (const file of allWasmSources()) copyFileSync(resolveWasmFile(file), join(wasm, file.file));
  const source: ProviderSource = { path: "a.ts", language: "typescript", text: "const a = 1;" };
  const profile: ExtractionProfile = {
    provider: "test",
    version: "1",
    grammar: "typescript",
    configuration: "default",
  };
  let runs = 0;
  const extract = async () => ({ value: ++runs });
  const read = (s = source, p = profile) => new ExtractionCache(root).extract(s, p, extract);
  // Populate the process's resident grammar independently of test ordering.
  writeFiles(root, { "a.ts": source.text });
  await buildIndex({ root, precise: "off", cache: false });
  try {
    setWasmDir(wasm);
    expect(await read()).toEqual({ value: 1 });
    expect(await read()).toEqual({ value: 1 });
    expect(await read(source, { ...profile, version: "2" })).toEqual({ value: 2 });
    expect(await read(source, { ...profile, configuration: "different-options" })).toEqual({
      value: 3,
    });
    expect(await read({ ...source, language: "tsx" })).toEqual({ value: 4 });
    expect(await read({ ...source, path: "renamed.ts" })).toEqual({ value: 5 });
    expect(await read({ ...source, text: "const a = 2;" })).toEqual({ value: 6 });
    const grammar = join(wasm, "tree-sitter-typescript.wasm");
    // A valid WASM custom section leaves semantics unchanged while changing the actual grammar identity.
    writeFileSync(grammar, Buffer.concat([readFileSync(grammar), Buffer.from([0, 2, 1, 120])]));
    expect(await read()).toEqual({ value: 7 });
    expect(await read()).toEqual({ value: 8 }); // Loaded grammar differs: never write under new bytes.
    rmSync(grammar);
    expect(await read()).toEqual({ value: 9 });
    expect(await read()).toEqual({ value: 10 });
  } finally {
    setWasmDir(undefined);
  }
});

it("a fresh process misses after a grammar upgrade, then reuses the new grammar's facts", () => {
  const root = makeDir({ "a.ts": "export function run() {}" });
  const wasm = makeDir();
  for (const file of allWasmSources()) copyFileSync(resolveWasmFile(file), join(wasm, file.file));
  const output = join(makeDir(), "snapshot.json");
  const build = (phase: string) =>
    JSON.parse(
      execFileSync(
        process.execPath,
        [
          "--import",
          "tsx",
          resolve("scripts/extraction-cache-benchmark.ts"),
          "--worker",
          root,
          output,
          phase,
        ],
        { encoding: "utf8", env: { ...process.env, XPL_WASM_DIR: wasm } },
      ),
    );
  expect(build("cold").extraction).toMatchObject({ hits: 0, misses: 1 });
  expect(build("warm").extraction).toMatchObject({ hits: 1, misses: 0 });
  const original = readFileSync(output, "utf8");
  const grammar = join(wasm, "tree-sitter-typescript.wasm");
  writeFileSync(grammar, Buffer.concat([readFileSync(grammar), Buffer.from([0, 2, 1, 120])]));
  expect(build("warm").extraction).toMatchObject({ hits: 0, misses: 1 });
  expect(build("warm").extraction).toMatchObject({ hits: 1, misses: 0 });
  expect(readFileSync(output, "utf8")).toBe(original);
}, 90_000);

it("never persists live objects or failed extractions", async () => {
  const root = makeDir({ "a.ts": "export function a() {}" });
  const cache = new ExtractionCache(root);
  const source: ProviderSource = {
    path: "a.ts",
    language: "typescript",
    text: "export function a() {}",
  };
  const profile: ExtractionProfile = {
    provider: "test",
    version: "1",
    grammar: "typescript",
    configuration: "default",
  };
  class LiveNode {
    text = "a";
  }
  await cache.extract(source, profile, async () => ({ node: new LiveNode() }));
  expect(cache.report.writeFailures).toBe(1);
  await expect(
    cache.extract(source, profile, async () => {
      throw new Error("transient failure");
    }),
  ).rejects.toThrow("transient failure");
  const result = await cache.extract(source, profile, async () => ({ value: "recovered" }));
  expect(result).toEqual({ value: "recovered" });
  expect(await cache.extract(source, profile, async () => ({ value: "incorrect" }))).toEqual({
    value: "recovered",
  });
});
