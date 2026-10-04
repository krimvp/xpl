/** Bounded experiment driver; no production provider or schema changes. */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { hashText } from "../../packages/core/src/index.js";
import type { SymbolIndex } from "../../packages/core/src/index.js";
import {
  buildIndex,
  discoverFiles,
  indexProviders,
  readSource,
  scipArtifactProvider,
} from "../../packages/indexer/src/index.js";
import { decodeIndex, SymbolRole } from "../../packages/indexer/src/scip/proto.js";
import type { ScipIndex } from "../../packages/indexer/src/scip/proto.js";

const [command, ...args] = process.argv.slice(2);
function json(path: string) {
  return JSON.parse(readFileSync(path, "utf8"));
}
function save(path: string, value: unknown) {
  writeFileSync(path, JSON.stringify(value, null, 2) + "\n");
}
function run(bin: string, argv: string[], cwd: string) {
  const result = spawnSync(bin, argv, {
    cwd,
    encoding: "utf8",
    timeout: 600_000,
    maxBuffer: 32 * 1024 * 1024,
  });
  process.stdout.write(result.stdout ?? "");
  process.stderr.write(result.stderr ?? "");
  if (result.error || result.status !== 0)
    throw new Error(`${bin}: ${result.error?.message ?? `exit ${result.status}`}`);
}
async function snapshot(root: string) {
  const found = await discoverFiles(root);
  assert.deepEqual(found.warnings, []);
  return Object.fromEntries(
    await Promise.all(found.files.map(async (f) => [f.path, hashText(await readSource(f))])),
  );
}
function rawSummary(raw: ScipIndex, files: string[]) {
  const occurrences = raw.documents.flatMap((d) => d.occurrences);
  const definitions = occurrences.filter((o) => o.symbolRoles & SymbolRole.Definition);
  const globals = raw.documents
    .flatMap((d) => d.symbols)
    .filter((s) => !s.symbol.startsWith("local "))
    .map((s) => s.symbol);
  const counts = new Map<string, number>();
  for (const id of globals) counts.set(id, (counts.get(id) ?? 0) + 1);
  return {
    metadata: raw.metadata,
    documents: raw.documents.length,
    symbolInformation: raw.documents.reduce((n, d) => n + d.symbols.length, 0),
    occurrences: occurrences.length,
    definitions: definitions.length,
    definitionsWithFullRange: definitions.filter((o) => o.enclosingRange.length).length,
    roles: [...new Set(occurrences.map((o) => o.symbolRoles))].sort((a, b) => a - b),
    encodings: [...new Set(raw.documents.map((d) => d.positionEncoding))],
    duplicateGlobalInformation: [...counts].filter(([, n]) => n > 1).map(([id, n]) => ({ id, n })),
    symbolRelationships: raw.documents.reduce(
      (n, d) => n + d.symbols.reduce((m, s) => m + s.relationships.length, 0),
      0,
    ),
    missingSourceDocuments: files.filter((f) => !raw.documents.some((d) => d.relativePath === f)),
    outsideSourceDocuments: raw.documents
      .map((d) => d.relativePath)
      .filter((f) => !files.includes(f)),
  };
}

if (command === "generate-rust") {
  const [rootArg, outArg] = args;
  assert(rootArg && outArg);
  const root = resolve(rootArg),
    out = resolve(outArg);
  assert(!existsSync(out), "use fresh output");
  mkdirSync(out);
  const before = await snapshot(root);
  save(join(out, "config.json"), {
    cargo: {
      offline: process.env.OFFLINE !== "0",
      buildScripts: { enable: false, overrideCommand: ["/bin/true"] },
    },
    procMacro: { enable: false },
  });
  run(
    "rust-analyzer",
    ["scip", root, "--config-path", join(out, "config.json"), "--output", join(out, "index.scip")],
    root,
  );
  assert.deepEqual(await snapshot(root), before, "source/configuration changed during generation");
  const artifact = readFileSync(join(out, "index.scip"));
  assert(artifact.length > 0);
  const raw = decodeIndex(artifact);
  // This producer declares UTF-8 columns on each document; no guessed default is needed.
  assert(raw.documents.length > 0, "producer returned no documents");
  assert(raw.documents.every((d) => d.positionEncoding === 1));
  save(join(out, "manifest.json"), {
    artifact: "index.scip",
    artifactSha256: createHash("sha256").update(artifact).digest("hex"),
    sourceHashes: before,
  });
} else if (command === "index") {
  const [root, language, mode, prefix, artifactDir] = args;
  assert(root && prefix && (language === "rust" || language === "text"));
  assert(mode === "tags" || mode === "scip-only" || mode === "combined");
  const syntax = indexProviders().filter((p) => p.mode === "syntax");
  const artifact = artifactDir ? readFileSync(join(artifactDir, "index.scip")) : undefined;
  const providers =
    mode === "tags"
      ? syntax
      : [
          ...(mode === "combined" ? syntax : []),
          scipArtifactProvider({
            artifact: artifact!,
            manifest: json(join(artifactDir!, "manifest.json")),
            languages: [language],
          }),
        ];
  const started = performance.now();
  const { index, warnings } = await buildIndex({
    root,
    languages: [language],
    precise: mode === "tags" ? "off" : "auto",
    providers,
  });
  const buildMs = performance.now() - started;
  save(prefix + ".index.json", index);
  const extension = language === "rust" ? ".rs" : ".java";
  const sourceFiles = index.files.filter((f) => f.path.endsWith(extension));
  const texts = sourceFiles.map((f) => readFileSync(join(root, f.path), "utf8"));
  const diagnostics = (index.analysis ?? []).flatMap((r) => r.diagnostics ?? []);
  writeFileSync(prefix + ".diagnostics.txt", diagnostics.join("\n") + "\n");
  save(prefix + ".summary.json", {
    mode,
    language,
    buildMs,
    indexedFiles: index.files.length,
    sourceFiles: sourceFiles.length,
    physicalLines: texts.reduce((n, t) => n + t.split("\n").length - Number(t.endsWith("\n")), 0),
    snapshotBytes: texts.reduce((n, t) => n + Buffer.byteLength(t), 0),
    symbols: index.symbols.length,
    refs: index.refs.length,
    symbolProviders: Object.fromEntries(
      (index.providers ?? []).map((p, i) => [
        p.id,
        index.symbols.filter((s) => s.provider === i).length,
      ]),
    ),
    referenceKinds: Object.fromEntries(
      [...new Set(index.refs.map((r) => r.kind))].map((k) => [
        k,
        index.refs.filter((r) => r.kind === k).length,
      ]),
    ),
    diagnostics: diagnostics.length,
    warnings,
    analysis: (index.analysis ?? []).map(({ diagnostics: ignored, ...report }) => report),
    ...(artifact
      ? {
          artifactBytes: artifact.length,
          raw: rawSummary(
            decodeIndex(artifact),
            sourceFiles.map((f) => f.path),
          ),
        }
      : {}),
  });
} else if (command === "facts") {
  const [dir] = args;
  assert(dir);
  const indexed = (label: string): SymbolIndex => json(join(dir, label + ".index.json"));
  const raw = (label: string) => decodeIndex(readFileSync(join(dir, label + "-scip/index.scip")));
  function symbol(index: SymbolIndex, id: string, start: number, end: number, parent?: string) {
    const found = index.symbols.find((s) => s.id === id);
    assert(found, id);
    assert.deepEqual(
      [found.range.startLine, found.range.endLine, found.parent],
      [start, end, parent],
      id,
    );
  }
  function occurrence(
    index: ScipIndex,
    file: string,
    range: number[],
    suffix: string,
    definition: boolean,
  ) {
    const doc = index.documents.find((d) => d.relativePath === file);
    assert(doc, file);
    const found = doc.occurrences.find(
      (o) =>
        JSON.stringify(o.range) === JSON.stringify(range) &&
        o.symbol.endsWith(suffix) &&
        !!(o.symbolRoles & SymbolRole.Definition) === definition,
    );
    assert(found, `${file}:${range} -> ${suffix}`);
  }
  // Expectations come from reading the pinned source, not from another producer's output.
  const rust = indexed("rs-fixture-tags");
  symbol(rust, "src/queue.rs#JobQueue", 21, 27);
  symbol(rust, "src/queue.rs#JobQueue.pop", 22, 22, "src/queue.rs#JobQueue");
  symbol(
    rust,
    "src/queue.rs#impl JobQueue for Queue.pop",
    71,
    87,
    "src/queue.rs#impl JobQueue for Queue",
  );
  symbol(rust, "src/runner.rs#impl Runner<Q>.dispatch", 65, 101, "src/runner.rs#impl Runner<Q>");
  symbol(rust, "src/worker.rs#demo.handlers.echo", 106, 108, "src/worker.rs#demo.handlers");
  symbol(rust, "src/main.rs#demo.echo", 13, 15, "src/main.rs#demo");
  symbol(rust, "src/bus.rs#JOB_COMPLETED", 5, 5);
  symbol(rust, "src/config.rs#DEFAULT_CONFIG", 6, 6);
  assert.deepEqual(
    rust.symbols.filter((s) => s.id === "src/runner.rs#RunnerStats"),
    [],
  );
  const rs = raw("rs-fixture");
  occurrence(rs, "src/queue.rs", [21, 7, 10], "JobQueue#pop().", true);
  occurrence(rs, "src/worker.rs", [105, 15, 19], "worker/demo/handlers/echo().", true);
  occurrence(rs, "src/main.rs", [12, 11, 15], "demo/echo().", true);
  occurrence(rs, "src/runner.rs", [21, 10, 21], "RunnerStats#", true);
  for (const label of ["rs-fixture", "bat"]) {
    assert.equal(
      raw(label)
        .documents.flatMap((d) => d.occurrences)
        .filter((o) => o.enclosingRange.length).length,
      0,
    );
    assert.equal(indexed(label + "-scip-only").symbols.length, 0);
    assert.equal(indexed(label + "-combined").refs.length, 0);
  }
  // Preserve this observed loss as evidence for a follow-up, not as desired production behavior.
  assert.equal(indexed("rs-fixture-combined").symbols.length, 0, "observed empty replacement");
  symbol(
    indexed("bat-tags"),
    "src/controller.rs#impl Controller<'b>.run",
    38,
    44,
    "src/controller.rs#impl Controller<'b>",
  );
  assert.deepEqual(
    raw("bat").documents.filter((d) => d.relativePath === "src/lessopen.rs"),
    [],
  );

  const java = indexed("java-fixture-import");
  const j = "src/main/java/jobrunner/";
  symbol(java, j + "Handler.java#Handler", 3, 6);
  symbol(java, j + "Handler.java#Handler.handle", 5, 5, j + "Handler.java#Handler");
  symbol(java, j + "Queue.java#Queue.Job", 10, 25, j + "Queue.java#Queue");
  symbol(java, j + "Queue.java#Queue.push", 37, 37, j + "Queue.java#Queue");
  symbol(java, j + "Queue.java#Queue.push~2", 38, 43, j + "Queue.java#Queue");
  symbol(java, j + "Runner.java#Runner.Stats", 8, 15, j + "Runner.java#Runner");
  const js = raw("java-fixture");
  occurrence(js, j + "Runner.java", [43, 34, 37], "Queue#pop().", false);
  occurrence(js, j + "Runner.java", [50, 32, 35], "Worker#run().", false);
  occurrence(js, j + "Metrics.java", [16, 78, 92], "Metrics#onJobCompleted().", false);
  assert.deepEqual(
    java.refs
      .filter((r) => r.from === j + "EchoHandler.java#EchoHandler" && r.kind === "type-ref")
      .map((r) => [r.to, r.site.startLine, r.site.startCol, r.site.endCol]),
    [
      [j + "BaseHandler.java#BaseHandler", 3, 40, 50],
      [j + "Handler.java#Handler", 3, 63, 69],
    ],
  );
  assert.deepEqual(
    [...new Set(java.refs.map((r) => [r.kind, r.resolution].join(":")))],
    ["type-ref:precise"],
  );
  symbol(
    indexed("gson-import"),
    "gson/src/main/java/com/google/gson/Gson.java#Gson.toJson",
    821,
    826,
    "gson/src/main/java/com/google/gson/Gson.java#Gson",
  );
  symbol(
    indexed("gson-import"),
    "gson/src/main/java/com/google/gson/Gson.java#Gson.toJson~2",
    846,
    850,
    "gson/src/main/java/com/google/gson/Gson.java#Gson",
  );
  assert.deepEqual(
    indexed("gson-import").symbols.filter((s) => s.file.includes("target/")),
    [],
  );
  console.log(
    "Pinned literal source facts and observed mapping losses passed; no repository-wide recall is claimed.",
  );
} else if (command === "workflow") {
  const [dir, cli] = args;
  assert(dir && cli);
  const xpl = (root: string, ...argv: string[]) =>
    run(process.execPath, [cli, ...argv, "--root", root], root);
  for (const [label, scip, symbolPath, file] of [
    ["rs-fixture", false, "impl Runner<Q>.dispatch", "src/runner.rs"],
    ["java-fixture", true, "Queue.push~2", "src/main/java/jobrunner/Queue.java"],
  ] as const) {
    const root = join(dir, label);
    xpl(
      root,
      "index",
      "--precise",
      scip ? "require" : "off",
      ...(scip ? ["--scip", join(dir, label + "-scip/manifest.json")] : []),
    );
    xpl(root, "outline", "--under", file, "--depth", "3");
    xpl(root, "show", file + "#" + symbolPath);
    xpl(root, "refs", file + "#" + symbolPath, "--out");
    xpl(root, "new", "assessment");
    const patch = join(dir, label + ".patch.json");
    save(patch, {
      concepts: [
        {
          id: "concept:checked",
          label: "Checked declaration",
          summary: scip
            ? "Adds a job with its payload and priority to the queue."
            : "Runs queued jobs and retries failed attempts.",
          anchors: [{ file, symbol: symbolPath, role: "definition" }],
        },
      ],
      views: [
        {
          id: "view:checked",
          type: "graph",
          title: "Checked declaration",
          include: ["sym:" + file + "#" + symbolPath],
        },
      ],
    });
    xpl(root, "apply", "assessment", patch);
    xpl(root, "anchors", "assessment", "concept:checked");
    xpl(root, "validate", "assessment");
    xpl(root, "bundle", "assessment", "-o", join(dir, label + ".html"));
  }
  const result = spawnSync(
    process.execPath,
    [
      cli,
      "index",
      "--root",
      join(dir, "rs-fixture"),
      "--scip",
      join(dir, "rs-fixture-scip/manifest.json"),
      "--precise",
      "require",
    ],
    { encoding: "utf8" },
  );
  writeFileSync(join(dir, "rust-require.log"), (result.stdout ?? "") + (result.stderr ?? ""));
  // Observed bug: described files count as usable type analysis despite no imported targets.
  assert.equal(result.status, 0);
  assert.match(result.stdout, /rust\s+9 files\s+0 symbols\s+refs: precise/);
  // Recover actual usable Rust anchors after the measured combined-import loss.
  xpl(join(dir, "rs-fixture"), "index", "--precise", "off");
  xpl(join(dir, "rs-fixture"), "validate", "assessment");
  const repo = fileURLToPath(new URL("../../", import.meta.url));
  for (const [label, helper, helperArgs] of [
    [
      "rust",
      fileURLToPath(import.meta.url),
      ["generate-rust", join(dir, "rs-fixture"), join(dir, "rust-missing-output")],
    ],
    [
      "java",
      join(repo, "scripts/java-scip.ts"),
      [join(dir, "java-fixture"), join(dir, "java-missing-output")],
    ],
  ] as const) {
    const failed = spawnSync(process.execPath, ["--import", "tsx", helper, ...helperArgs], {
      cwd: repo,
      encoding: "utf8",
      env: { ...process.env, PATH: "", JAVA_HOME: process.env.JDK21 },
    });
    writeFileSync(
      join(dir, label + "-missing-tool.log"),
      (failed.stdout ?? "") + (failed.stderr ?? ""),
    );
    assert.equal(failed.status, 1);
    assert.match(
      failed.stderr,
      label === "rust" ? /rust-analyzer.*ENOENT/ : /Maven unavailable.*ENOENT/,
    );
    assert.equal(existsSync(join(dir, label + "-missing-output/manifest.json")), false);
  }
  xpl(join(dir, "java-fixture"), "index", "--precise", "off");
  const fallback = spawnSync(
    process.execPath,
    [cli, "index", "--root", join(dir, "java-fixture"), "--precise", "off", "--json"],
    { encoding: "utf8" },
  );
  assert.equal(fallback.status, 0);
  const fallbackIndex: SymbolIndex = json(JSON.parse(fallback.stdout).absolutePath);
  assert.equal(fallbackIndex.files.filter((f) => f.path.endsWith(".java")).length, 13);
  assert.deepEqual(
    fallbackIndex.symbols.filter((s) => s.file.endsWith(".java")),
    [],
  );
  assert.deepEqual(fallbackIndex.refs, []);
  xpl(
    join(dir, "java-fixture"),
    "index",
    "--scip",
    join(dir, "java-fixture-scip/manifest.json"),
    "--precise",
    "require",
  );
  xpl(join(dir, "java-fixture"), "validate", "assessment");
} else if (command === "results") {
  const [dir] = args;
  assert(dir);
  function timing(label: string) {
    const text = readFileSync(join(dir, label + ".time"), "utf8");
    const elapsed = text.match(/Elapsed.*\): (\S+)/)![1]!;
    const seconds = elapsed.split(":").reduce((n, s) => 60 * n + Number(s), 0);
    return {
      seconds,
      peakRssKiB: Number(text.match(/Maximum resident set size \(kbytes\): (\d+)/)![1]),
    };
  }
  const generation = ["rs-fixture", "bat", "java-fixture", "gson"].map((corpus) => ({
    corpus,
    ...timing(corpus + "-generate"),
  }));
  const imports = [
    "rs-fixture-tags",
    "rs-fixture-scip-only",
    "rs-fixture-combined",
    "bat-tags",
    "bat-scip-only",
    "bat-combined",
    "java-fixture-import",
    "gson-import",
  ].map((label) => {
    const { analysis, raw, ...summary } = json(join(dir, label + ".summary.json"));
    const { metadata, duplicateGlobalInformation, missingSourceDocuments, ...counts } = raw ?? {};
    return {
      label,
      ...timing(label),
      ...summary,
      ...(raw
        ? {
            raw: {
              ...counts,
              duplicateGlobalIdentities: duplicateGlobalInformation.length,
              missingSourceDocuments: missingSourceDocuments.length,
              producer: metadata.toolName + "@" + metadata.toolVersion,
            },
          }
        : {}),
    };
  });
  const dependencyMode =
    process.env.OFFLINE === "0" ? "online/cache-warming" : "cached dependencies; offline";
  save(join(dir, "result.json"), {
    implementationPin: readFileSync(join(dir, "xpl.commit"), "utf8").trim(),
    node: readFileSync(join(dir, "node.version"), "utf8").trim(),
    rustMode: `${dependencyMode}; buildScripts override /bin/true; procMacro disabled; fresh target`,
    javaMode: `${dependencyMode}; clean test-compile; fresh target`,
    generation,
    imports,
  });
} else {
  throw new Error(
    "Usage: measure.mts generate-rust|index|facts|workflow|results ... (see reproduce.sh)",
  );
}
