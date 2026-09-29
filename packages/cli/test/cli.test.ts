import { describe, expect, it } from "vitest";
import { COMMANDS, run } from "../src/cli.js";

async function invoke(...argv: string[]) {
  const out: string[] = [];
  const err: string[] = [];
  const code = await run(argv, { out: (text) => out.push(text), err: (text) => err.push(text) });
  return { code, out: out.join("\n"), err: err.join("\n") };
}

describe("xpl cli skeleton", () => {
  it("--help lists every command of ARCHITECTURE.md section 5", async () => {
    const { code, out } = await invoke("--help");
    expect(code).toBe(0);
    expect(COMMANDS.map((command) => command.name)).toEqual([
      "index",
      "outline",
      "show",
      "refs",
      "search",
      "new",
      "apply",
      "validate",
      "resolve",
      "status",
      "view",
      "bundle",
    ]);
    for (const command of COMMANDS) expect(out).toContain(command.name);
    expect(out).not.toContain("__smoke");
  });

  it("a known command says it is not implemented yet", async () => {
    const { code, err } = await invoke("index", "--precise", "off");
    expect(code).toBe(1);
    expect(err).toContain("not implemented yet");
  });

  it("an unknown command is a usage error", async () => {
    const { code, err } = await invoke("frobnicate");
    expect(code).toBe(2);
    expect(err).toContain("unknown command");
  });

  it("the hidden __smoke command parses a snippet with every grammar", async () => {
    const { code, out } = await invoke("__smoke");
    expect(out).toMatch(/ok\s+typescript/);
    expect(out).toMatch(/ok\s+json/);
    expect(code).toBe(0);
  });
});
