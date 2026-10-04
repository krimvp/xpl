/** Generate with the pinned scip-java workflow; attest source only after a successful stable build. */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { hashText } from "@xpl/core";
import { discoverFiles, readSource } from "@xpl/indexer";

const [rootArg, outputArg, ...mavenArgs] = process.argv.slice(2);
try {
  if (!rootArg || !outputArg || (mavenArgs.length && mavenArgs[0] !== "--"))
    throw new Error("Usage: tsx scripts/java-scip.ts ROOT FRESH_OUTPUT_DIR [-- MAVEN_ARGS...]");
  const root = realpathSync(rootArg);
  const output = join(realpathSync(dirname(resolve(outputArg))), basename(outputArg));
  const rel = relative(root, output);
  if (!rel || (!isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${sep}`)))
    throw new Error("Keep the output directory outside the indexed root");
  if (existsSync(output))
    throw new Error("Use a fresh output directory; never reuse a previous artifact");

  const javaHome = process.env.JAVA_HOME;
  const java =
    javaHome && existsSync(join(javaHome, "bin/java")) ? join(javaHome, "bin/java") : "java";
  for (const [tool, label] of [
    [java, "JDK"],
    ["mvn", "Maven"],
    ["scip-java", "scip-java"],
  ] as const) {
    const probe = spawnSync(tool, ["--version"], { cwd: root, encoding: "utf8", timeout: 30_000 });
    if (probe.error || probe.status !== 0)
      throw new Error(
        `${label} unavailable: ${probe.error?.message ?? probe.stderr ?? probe.stdout}`,
      );
  }
  async function snapshot() {
    const found = await discoverFiles(root);
    if (found.warnings.length) throw new Error(found.warnings.join("\n"));
    const hashes: Record<string, string> = {};
    for (const file of found.files) hashes[file.path] = hashText(await readSource(file));
    return hashes;
  }
  const sourceHashes = await snapshot();
  mkdirSync(output);
  const artifact = join(output, "index.scip");
  // Producer output goes to stderr; stdout names only a successful manifest.
  const run = spawnSync(
    "scip-java",
    [
      "index",
      `--output=${artifact}`,
      "--",
      ...(mavenArgs.length > 1 ? mavenArgs.slice(1) : ["--batch-mode", "clean", "test-compile"]),
    ],
    { cwd: root, stdio: ["ignore", 2, 2], timeout: 10 * 60_000 },
  );
  if (run.error || run.status !== 0)
    throw new Error(
      `Java indexing/build failed (${run.error?.message ?? `exit ${run.status}, signal ${run.signal}`}); no manifest written`,
    );
  if (JSON.stringify(sourceHashes) !== JSON.stringify(await snapshot()))
    throw new Error("Sources/configuration changed during generation; regenerate in a stable tree");
  if (!existsSync(artifact) || !readFileSync(artifact).length)
    throw new Error("scip-java did not produce a nonempty artifact; no manifest written");
  const artifactSha256 = createHash("sha256").update(readFileSync(artifact)).digest("hex");
  const manifest = join(output, "manifest.json");
  // Verified for the v0.13.1 launcher: unspecified positions are UTF-16, not metadata's UTF-8.
  writeFileSync(
    manifest,
    JSON.stringify(
      { artifact: "index.scip", artifactSha256, sourceHashes, defaultEncoding: "utf16" },
      null,
      2,
    ) + "\n",
    { flag: "wx" },
  );
  console.log(manifest);
} catch (error) {
  console.error((error as Error).message);
  console.error(
    "Java semantic analysis unavailable. Run xpl index --precise off for file anchors and config symbols; Java symbols/references are unsupported in that fallback.",
  );
  process.exitCode = 1;
}
