import { beforeAll, describe, expect, it } from "vitest";
import { indexedFixture, makeTempDir, writeFile, xpl, xplJson } from "./helpers.js";

/** Put together from pieces, so this file holds no string a scanner takes for a real key. */
const AWS = ["AKIA", "Q3EGT5RL7NB2XW4Y"].join("");
const PASSWORD = ["Wq9", "zR4tLp2x!"].join("");

describe("xpl health", () => {
  let dir: string;
  beforeAll(async () => {
    dir = makeTempDir("xpl-health-");
    writeFile(dir, "src/index.ts", 'import { push } from "./queue";\npush();\n');
    writeFile(dir, "src/queue.ts", "export function push(): void {}\n");
    writeFile(dir, "src/orphan.ts", `export const region = "eu";\nexport const key = "${AWS}";\n`);
    writeFile(dir, ".env", `PORT=3000\nDB_PASSWORD=${PASSWORD}\n`);
    const indexed = await xpl(dir, "index", "--precise", "off");
    expect(indexed.code, indexed.err).toBe(0);
  });

  it("prints findings by severity with file, line, masked hint, why and fix, and exits 0", async () => {
    const { code, out, err } = await xpl(dir, "health");
    expect(code, err).toBe(0);
    expect(out.split("\n")).toEqual([
      "Health of 4 files: a quick check, not a security audit.",
      "2 high, 0 medium, 1 low",
      "",
      "High (2)",
      "  .env:2           Committed .env file with secrets",
      "    Why: .env files hold local settings and secrets, and are meant to stay on one machine. This one is in the project's files, so its values are shared with everyone who gets the code.",
      "    Fix: Add .env files to .gitignore, remove this one from the repository, change the secrets in it, and commit a .env.example with empty values instead.",
      "  src/orphan.ts:2  AWS access key (AKIA…)",
      "    Why: A key written into the code works for anyone who can read the code or its history, and code gets copied, shared and published.",
      "    Fix: Revoke the key and make a new one, then read it from an environment variable or a secret store, never from the code.",
      "",
      "Low (1)",
      "  src/orphan.ts:1  Possibly unused file",
      "    Why: Nothing else in the project refers to this file, so it may be left over. This is a guess from the index: code loaded by name, by a framework or from outside the project is not seen.",
      "    Fix: Check whether anything still uses it, and delete it if nothing does.",
    ]);
  });

  it("--json gives the same findings in the ok envelope", async () => {
    const { code, json } = await xplJson(dir, "health");
    expect(code).toBe(0);
    expect(json.ok).toBe(true);
    expect(json.note).toBe("a quick check, not a security audit");
    expect(json.counts).toEqual({ high: 2, medium: 0, low: 1 });
    expect(
      json.findings.map((f: any) => [f.check, f.severity, `${f.file}:${f.line}`, f.hint ?? null]),
    ).toEqual([
      ["env-file", "high", ".env:2", null],
      ["secret", "high", "src/orphan.ts:2", "AKIA…"],
      ["unused-file", "low", "src/orphan.ts:1", null],
    ]);
  });

  it("never prints a secret value", async () => {
    for (const result of [await xpl(dir, "health"), await xpl(dir, "health", "--json")]) {
      expect(result.out).toContain("AKIA…");
      for (const value of [AWS, PASSWORD]) {
        expect(result.out).not.toContain(value);
        expect(result.err).not.toContain(value);
      }
    }
  });
});

describe("xpl health on Rust", () => {
  it("counts `mod` declarations and crate imports as uses, so no used module reads as unused", async () => {
    const dir = makeTempDir("xpl-health-rs-");
    writeFile(dir, "Cargo.toml", '[package]\nname = "job-runner"\nversion = "0.1.0"\n');
    writeFile(dir, "src/lib.rs", "pub mod config;\npub mod runner;\n");
    writeFile(dir, "src/main.rs", "use job_runner::runner::Runner;\n\nfn main() {}\n");
    // config.rs is reached only through `pub mod config;` in lib.rs
    writeFile(dir, "src/runner.rs", "pub struct Runner;\n");
    writeFile(dir, "src/config.rs", "pub struct Settings;\n");
    writeFile(dir, "src/orphan.rs", "pub struct Left;\n");
    const indexed = await xpl(dir, "index", "--precise", "off");
    expect(indexed.code, indexed.err).toBe(0);
    const { code, json } = await xplJson(dir, "health");
    expect(code).toBe(0);
    expect(json.findings.map((f: any) => `${f.check} ${f.file}`)).toEqual([
      "unused-file src/orphan.rs",
    ]);
    expect(json.notes).toEqual([]);
  });
});

describe("xpl health on Java", () => {
  it("does not call Main.java, the program's entry point, unused", async () => {
    const dir = await indexedFixture("java-jobrunner");
    const { code, json } = await xplJson(dir, "health");
    expect(code).toBe(0);
    expect(json.findings.map((f: any) => `${f.check} ${f.file}`)).toEqual([]);
    expect(json.notes).toEqual([]);
  });
});
