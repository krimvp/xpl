import { spawnSync } from "node:child_process";
import { chmodSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { expect, it } from "vitest";
import { makeTempDir, readJson, writeFile } from "./helpers.js";

const source = "class A {}\n";
function setup(mode = "success") {
  const root = makeTempDir();
  writeFile(root, "A.java", source);
  writeFile(root, "pom.xml", "<project/>\n");
  const bin = makeTempDir();
  for (const tool of ["java", "mvn", "scip-java"]) {
    if (mode === `missing-${tool}`) continue;
    const file = writeFile(
      bin,
      tool,
      `#!${process.execPath}\n
      const fs = require("node:fs");
      if (process.argv.includes("index")) {
        const output = process.argv.find(a => a.startsWith("--output=")).slice(9);
        fs.writeFileSync(output, "fresh artifact");
        if (${JSON.stringify(mode)} === "broken") { console.error("compilation failed"); process.exit(1); }
        if (${JSON.stringify(mode)} === "changed") fs.appendFileSync("A.java", "// changed\\n");
        if (${JSON.stringify(mode)} === "config-changed") fs.appendFileSync("pom.xml", "<!-- changed -->\\n");
        if (${JSON.stringify(mode)} === "added") fs.writeFileSync("B.java", "class B {}\\n");
        if (${JSON.stringify(mode)} === "missing-artifact") fs.unlinkSync(output);
        fs.writeFileSync(output + ".args", JSON.stringify(process.argv.slice(2)));
      }
    `,
    );
    chmodSync(file, 0o755);
  }
  const output = join(makeTempDir(), "run");
  const generate = (dir = output, args: string[] = []) =>
    spawnSync(
      process.execPath,
      [
        resolve("node_modules/tsx/dist/cli.mjs"),
        resolve("scripts/java-scip.ts"),
        root,
        dir,
        ...args,
      ],
      { encoding: "utf8", env: { ...process.env, PATH: bin, JAVA_HOME: "" } },
    );
  return { root, output, generate };
}

it("binds a fresh successful Java generation to source/config hashes and forwards Maven arguments", () => {
  const { output, generate } = setup();
  const result = generate(output, ["--", "--offline", "-pl", "gson", "clean", "test-compile"]);
  expect(result.status, result.stderr).toBe(0);
  expect(result.stdout.trim()).toBe(join(output, "manifest.json"));
  expect(readJson(output, "manifest.json")).toMatchObject({
    artifact: "index.scip",
    artifactSha256: "fba70a783cecd8de271f147d7afabee99f3ee796d97a080293f0adc2fbfff0af",
    sourceHashes: { "A.java": "sha256-v2:f119fc42a923", "pom.xml": "sha256-v2:23c641491ed3" },
    defaultEncoding: "utf16",
  });
  expect(readJson(output, "index.scip.args")).toEqual([
    "index",
    `--output=${join(output, "index.scip")}`,
    "--",
    "--offline",
    "-pl",
    "gson",
    "clean",
    "test-compile",
  ]);
  const rerun = generate();
  expect(rerun.status).toBe(1);
  expect(rerun.stderr).toContain("fresh output directory");
});

it.each([
  ["missing-java", "JDK"],
  ["missing-mvn", "Maven"],
  ["missing-scip-java", "scip-java"],
  ["broken", "Java indexing/build failed"],
  ["changed", "Sources/configuration changed"],
  ["config-changed", "Sources/configuration changed"],
  ["added", "Sources/configuration changed"],
  ["missing-artifact", "did not produce a nonempty artifact"],
])("does not attest %s and explains the file-anchor fallback", (mode, diagnostic) => {
  const { output, generate } = setup(mode);
  const result = generate();
  expect(result.status).toBe(1);
  expect(result.stderr).toContain(diagnostic);
  expect(result.stderr).toContain("xpl index --precise off");
  expect(existsSync(join(output, "manifest.json"))).toBe(false);
});

it("refuses to generate artifacts inside the indexed sources", () => {
  const { root, generate } = setup();
  const result = generate(join(root, "artifact"));
  expect(result.status).toBe(1);
  expect(result.stderr).toContain("outside the indexed root");
  expect(existsSync(join(root, "artifact"))).toBe(false);
});
