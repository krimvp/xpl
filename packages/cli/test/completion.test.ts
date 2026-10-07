import { execFileSync, spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { COMMANDS } from "../src/cli.js";
import { GLOBAL_OPTIONS } from "../src/args.js";
import { invoke, makeTempDir, writeFile } from "./helpers.js";

function bashComplete(script: string, cwd: string, ...words: string[]): string[] {
  const file = writeFile(cwd, "completion.bash", script);
  const code = [
    'source "$1"',
    "shift",
    'COMP_WORDS=( "$@" )',
    "COMP_CWORD=$(( ${#COMP_WORDS[@]} - 1 ))",
    "_xpl_completion",
    'printf "%s\\n" "${COMPREPLY[@]}"',
  ].join("\n");
  return execFileSync("bash", ["-c", code, "bash", file, ...words], { cwd, encoding: "utf8" })
    .trim()
    .split("\n")
    .filter(Boolean);
}

function zshComplete(script: string, cwd: string, ...words: string[]): string[] {
  const file = writeFile(cwd, "completion.zsh", script);
  const code = [
    "function compdef { :; }",
    'function compadd { shift; print -rl -- "$@"; }',
    'source "$1"',
    "shift",
    'words=( "$@" )',
    "CURRENT=$#words",
    "_xpl_completion",
  ].join("\n");
  return execFileSync("zsh", ["-f", "-c", code, "zsh", file, ...words], {
    cwd,
    encoding: "utf8",
  })
    .trim()
    .split("\n")
    .filter(Boolean);
}

function fishComplete(script: string, cwd: string, line: string): string[] {
  const file = writeFile(cwd, "completion.fish", script);
  return execFileSync("fish", ["-c", 'source $argv[1]; complete -C "$argv[2]"', "--", file, line], {
    cwd,
    encoding: "utf8",
  })
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((candidate) => candidate.split("\t")[0]!);
}

describe("xpl completion", () => {
  it("uses the CLI command and option tables", async () => {
    const { code, out } = await invoke(["completion", "bash"]);
    expect(code).toBe(0);
    const dir = makeTempDir();
    expect(bashComplete(out, dir, "xpl", "")).toEqual(COMMANDS.map((c) => c.name));
    for (const command of COMMANDS) {
      const expected = [...Object.keys(GLOBAL_OPTIONS), ...Object.keys(command.options)]
        .map((name) => `--${name}`)
        .sort();
      expect(bashComplete(out, dir, "xpl", command.name, "--").sort()).toEqual(expected);
    }
  });

  it("completes guide names from the current repository and rejects an unknown shell", async () => {
    const { out } = await invoke(["completion", "bash"]);
    const dir = makeTempDir();
    writeFile(dir, ".explainer/alpha.explainer.json", "{}");
    writeFile(dir, ".explainer/beta.explainer.json", "{}");
    writeFile(dir, ".explainer/index-test.json", "{}");
    expect(bashComplete(out, dir, "xpl", "view", "")).toEqual(["alpha", "beta"]);
    expect(bashComplete(out, dir, "xpl", "view", "a")).toEqual(["alpha"]);
    expect((await invoke(["completion", "powershell"])).code).toBe(2);
  });

  it("zsh offers guide names after value options and only at guide positions", async () => {
    const { out } = await invoke(["completion", "zsh"]);
    const dir = makeTempDir();
    writeFile(dir, ".explainer/alpha.explainer.json", "{}");
    writeFile(dir, ".explainer/my guide.explainer.json", "{}");
    expect(zshComplete(out, dir, "xpl", "view", "--port", "4747", "")).toEqual([
      "alpha",
      "my guide",
    ]);
    expect(zshComplete(out, dir, "xpl", "service", "start", "")).toEqual(["alpha", "my guide"]);
    expect(zshComplete(out, dir, "xpl", "apply", "alpha", "")).toEqual([]);
  });

  const fishIt = spawnSync("fish", ["--version"]).status === 0 ? it : it.skip;
  fishIt("fish offers guide names only at guide positions", async () => {
    const { out } = await invoke(["completion", "fish"]);
    const dir = makeTempDir();
    writeFile(dir, ".explainer/alpha.explainer.json", "{}");
    writeFile(dir, ".explainer/my guide.explainer.json", "{}");
    expect(fishComplete(out, dir, "xpl view --port 4747 ")).toEqual(["alpha", "my guide"]);
    expect(fishComplete(out, dir, "xpl service start ")).toEqual(["alpha", "my guide"]);
    expect(fishComplete(out, dir, "xpl apply alpha ")).toEqual([]);
  });
});
