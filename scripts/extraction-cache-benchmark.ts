/** Separate processes measure clean/cold/warm builds; whole indexes and warnings must match each round. */
import { deepStrictEqual } from "node:assert";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { arch, cpus, platform } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { diskCost, measuredBuild } from "./index-benchmark-metrics.js";

if (process.argv[2] === "--worker") {
  const [, , , root, output, phase] = process.argv;
  const { result, metrics } = await measuredBuild({
    root: root!,
    precise: "off",
    cache: phase !== "clean",
  });
  writeFileSync(output!, JSON.stringify({ index: result.index, warnings: result.warnings }));
  process.stdout.write(
    JSON.stringify({
      phase,
      ...metrics,
    }),
  );
} else {
  const [, , rootArg, outputArg, roundsArg = "3"] = process.argv;
  if (!rootArg || !outputArg)
    throw new Error(
      "usage: npx tsx scripts/extraction-cache-benchmark.ts <repo-root> <output-directory-outside-repo> [rounds=3]",
    );
  const root = resolve(rootArg),
    output = resolve(outputArg);
  const fromRoot = relative(root, output);
  if (fromRoot !== ".." && !fromRoot.startsWith("../") && !isAbsolute(fromRoot))
    throw new Error("benchmark output must be outside the indexed repository");
  const rounds = Number(roundsArg);
  if (!Number.isInteger(rounds) || rounds < 1) throw new Error("rounds must be a positive integer");
  mkdirSync(output, { recursive: true });
  const rows: unknown[] = [];
  for (let round = 1; round <= rounds; round++) {
    rmSync(join(root, ".explainer/cache/extraction-v1"), { recursive: true, force: true });
    let clean: unknown;
    for (const phase of ["clean", "cold", "warm"]) {
      const artifact = join(output, `${round}-${phase}.json`);
      const row = JSON.parse(
        execFileSync(
          process.execPath,
          [...process.execArgv, fileURLToPath(import.meta.url), "--worker", root, artifact, phase],
          { encoding: "utf8", maxBuffer: 1024 * 1024 },
        ),
      );
      const snapshot: unknown = JSON.parse(readFileSync(artifact, "utf8"));
      if (phase === "clean") clean = snapshot;
      else
        deepStrictEqual(
          snapshot,
          clean,
          `${phase} whole index/warnings differ from clean (round ${round})`,
        );
      if (phase === "warm" && row.extraction.misses !== 0)
        throw new Error(
          "warm extraction unexpectedly missed; inspect failures before claiming reuse",
        );
      const record = {
        round,
        ...row,
        ...(phase !== "clean"
          ? { disk: diskCost(join(root, ".explainer/cache/extraction-v1")) }
          : {}),
      };
      rows.push(record);
      process.stdout.write(`${JSON.stringify(record)}\n`);
    }
  }
  const report = {
    root,
    node: process.version,
    platform: platform(),
    arch: arch(),
    cpu: cpus()[0]?.model,
    scope:
      "precise off; wall/CPU cover buildIndex only; peak RSS includes process startup; cache disk excludes indexes and benchmark output; separate process per build",
    wholeIndexAndWarningsEquivalent: true,
    rows,
  };
  writeFileSync(join(output, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
}
