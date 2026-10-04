/** Runnable #17 experiment. Uses source copies; no edits, cache removal or checkout in the input root. */
import { deepStrictEqual } from "node:assert";
import { execFileSync } from "node:child_process";
import {
  cpSync,
  realpathSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { arch, cpus, platform } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { buildIndex, type BuildIndexOptions } from "../packages/indexer/src/index.js";
import { TypeScriptResolutionExperiment } from "../packages/indexer/src/resolve/typescript-experiment.js";
import { diskCost, measuredBuild } from "./index-benchmark-metrics.js";
import {
  checkedSnapshot,
  mutationScenarios,
  runMutationSequence,
} from "./semantic-invalidation-scenarios.js";

const HISTORY_HEAD = "e5acc6dca615d4b0cd0e771038ac8ea63174f5e8";
const tsLanguages = ["typescript", "tsx", "javascript", "json"];
const script = fileURLToPath(import.meta.url);

function physicalPath(path: string): string {
  const missing: string[] = [];
  while (!existsSync(path)) {
    missing.unshift(basename(path));
    path = dirname(path);
  }
  return join(realpathSync(path), ...missing);
}

function options(root: string, mode: string, scope: string): BuildIndexOptions {
  return {
    root,
    precise: "off",
    cache: mode !== "clean",
    languages: scope === "typescript" ? tsLanguages : undefined,
    experimentalResolution:
      mode === "incremental" ? new TypeScriptResolutionExperiment() : undefined,
  };
}

function run(args: string[]) {
  return JSON.parse(
    execFileSync(process.execPath, [...process.execArgv, script, ...args], {
      encoding: "utf8",
      maxBuffer: 1024 * 1024,
    }),
  );
}

if (process.argv[2] === "--worker") {
  const [, , , root, artifact, mode, scope, edit] = process.argv;
  const opts = options(root!, mode!, scope!);
  const cachePath = join(root!, ".explainer/cache/extraction-v1");
  rmSync(cachePath, { recursive: true, force: true });
  // State reuse requires a prior build in the same process. All modes get the same untimed warm-up.
  await buildIndex(opts);
  const target = edit ? join(root!, edit) : undefined;
  const original = target ? readFileSync(target, "utf8") : undefined;
  try {
    if (target) writeFileSync(target, `${original}\n// issue-17 repeatable source mutation\n`);
    const { result, metrics } = await measuredBuild(opts);
    writeFileSync(artifact!, JSON.stringify(checkedSnapshot(result)));
    process.stdout.write(
      JSON.stringify({
        mode,
        scope,
        edit: edit || null,
        ...metrics,
        invalidation: opts.experimentalResolution?.report,
        disk: existsSync(cachePath) ? diskCost(cachePath) : undefined,
      }),
    );
  } finally {
    if (target) writeFileSync(target, original!);
  }
} else if (process.argv[2] === "--history-worker") {
  const [, , , gitRoot, root, output, mode, scope] = process.argv;
  const scratchPath = relative(resolve(output!), resolve(root!));
  if (!scratchPath || scratchPath.startsWith("..") || isAbsolute(scratchPath))
    throw new Error("history worker sources must be inside its scratch output directory");
  const revisions: string[] = execFileSync(
    "git",
    ["rev-list", "--first-parent", "--max-count=12", HISTORY_HEAD],
    { cwd: gitRoot, encoding: "utf8" },
  )
    .trim()
    .split("\n")
    .reverse();
  const opts = options(root!, mode!, scope!);
  rmSync(root!, { recursive: true, force: true });
  mkdirSync(root!, { recursive: true });
  const rows = [];
  for (const revision of revisions) {
    for (const path of readdirSync(root!))
      if (path !== ".explainer") rmSync(join(root!, path), { recursive: true, force: true });
    const archive = execFileSync("git", ["archive", revision], {
      cwd: gitRoot,
      maxBuffer: 64 * 1024 * 1024,
    });
    execFileSync("tar", ["-xf", "-", "-C", root!, "--exclude=.explainer"], { input: archive });
    const { result, metrics } = await measuredBuild(opts);
    writeFileSync(
      join(output!, `${mode}-${scope}-${revision}.json`),
      JSON.stringify(checkedSnapshot(result)),
    );
    rows.push({
      revision,
      mode,
      scope,
      ...metrics,
      invalidation: opts.experimentalResolution?.report,
    });
  }
  process.stdout.write(JSON.stringify(rows));
} else {
  const [, , rootArg, outputArg, roundsArg = "3", historyArg] = process.argv;
  if (!rootArg || !outputArg)
    throw new Error(
      "usage: npx tsx scripts/semantic-invalidation-benchmark.ts <repo-root> <output-outside-repo> [rounds=3] [--history]",
    );
  const root = physicalPath(resolve(rootArg)),
    output = physicalPath(resolve(outputArg));
  const fromRoot = relative(root, output);
  const toRoot = relative(output, root);
  const contains = (path: string) => path !== ".." && !path.startsWith("../") && !isAbsolute(path);
  if (contains(fromRoot) || contains(toRoot))
    throw new Error("input and output directories must not contain one another");
  const rounds = Number(roundsArg);
  if (!Number.isInteger(rounds) || rounds < 1) throw new Error("rounds must be a positive integer");
  if (historyArg && historyArg !== "--history") throw new Error("expected --history");
  mkdirSync(output, { recursive: true });
  const runOutput = mkdtempSync(join(output, "run-"));
  const copy = join(runOutput, "source");
  cpSync(root, copy, {
    recursive: true,
    filter: (path) =>
      ![".git", ".explainer", "node_modules", "dist", "build", "out"].includes(basename(path)),
  });
  const mutationRows = [];
  for (const scenario of mutationScenarios) {
    const scenarioRoot = join(runOutput, scenario.name);
    mkdirSync(scenarioRoot);
    mutationRows.push(...(await runMutationSequence(scenarioRoot, scenario)));
  }
  const baseline = await buildIndex({ root: copy, precise: "off", languages: tsLanguages });
  const edit = existsSync(join(copy, "packages/indexer/src/ast.ts"))
    ? "packages/indexer/src/ast.ts"
    : baseline.index.files.find((f) => f.language === "typescript")?.path;
  if (!edit) throw new Error("the benchmark needs at least one TypeScript file");
  const rows = [];
  for (let round = 1; round <= rounds; round++) {
    for (const scope of ["typescript", "all"]) {
      for (const mutation of ["", edit]) {
        let clean: unknown;
        for (const mode of ["clean", "full", "incremental"]) {
          const artifact = join(
            runOutput,
            `${round}-${scope}-${mutation ? "edit" : "unchanged"}-${mode}.json`,
          );
          const row = run(["--worker", copy, artifact, mode, scope, mutation]);
          if (mode !== "clean" && row.extraction.misses !== (mutation ? 1 : 0))
            throw new Error(
              "warm extraction missed unexpectedly; inspect before claiming semantic reuse",
            );
          const snapshot: unknown = JSON.parse(readFileSync(artifact, "utf8"));
          if (mode === "clean") clean = snapshot;
          else
            deepStrictEqual(snapshot, clean, `${scope}/${mode}/${mutation}: whole index/warnings`);
          rows.push({ round, ...row });
          process.stdout.write(
            `${JSON.stringify({ round, scope, mode, edit: mutation, wallMs: row.wallMs, resolved: row.invalidation?.resolvedFiles.length, reused: row.invalidation?.reusedFiles.length, fallback: row.invalidation?.fallback })}\n`,
          );
        }
      }
    }
  }
  const historyRows = [];
  if (historyArg) {
    for (const scope of ["typescript", "all"]) {
      let cleanRows: { revision: string }[] = [];
      for (const mode of ["clean", "full", "incremental"]) {
        const measured = run([
          "--history-worker",
          root,
          join(runOutput, "history-source"),
          runOutput,
          mode,
          scope,
        ]);
        if (mode === "clean") cleanRows = measured;
        else
          for (const row of cleanRows)
            deepStrictEqual(
              JSON.parse(
                readFileSync(join(runOutput, `${mode}-${scope}-${row.revision}.json`), "utf8"),
              ),
              JSON.parse(
                readFileSync(join(runOutput, `clean-${scope}-${row.revision}.json`), "utf8"),
              ),
              `${scope}/${mode}/${row.revision}: whole history snapshot`,
            );
        historyRows.push(...measured);
        process.stdout.write(
          `${JSON.stringify({ history: scope, mode, snapshots: measured.length })}\n`,
        );
      }
    }
  }
  const report = {
    input: root,
    output: runOutput,
    node: process.version,
    platform: platform(),
    arch: arch(),
    cpu: cpus()[0]?.model,
    scope:
      "precise off; #16 build-only wall/CPU and OS peak RSS before serialization; same-process untimed warm-up per benchmark worker; peak RSS is cumulative in history workers; heapUsed is sampled without forcing GC; no OS cache flush",
    wholeIndexAndWarningsEquivalent: true,
    historyHead: historyArg ? HISTORY_HEAD : undefined,
    mutationRows,
    rows,
    historyRows,
  };
  writeFileSync(join(output, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
  process.stdout.write(`report: ${join(output, "report.json")}\n`);
}
