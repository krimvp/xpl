import { describe, expect, it } from "vitest";
import { indexedFixture, invoke, makeTempDir, xpl } from "./helpers.js";

describe("xpl cli", () => {
  it("--help describes commands and global options", async () => {
    const { code, out } = await invoke(["--help"]);
    expect(code).toBe(0);
    expect(out).toContain("Usage: xpl <command> [options]");
    expect(out).toContain("Docs: https://krimvp.github.io/xpl/docs/reference/");
    expect(out).not.toContain("docs/ARCHITECTURE.md");
    expect(out).toMatch(/feedback\s+Import, inspect or export durable reader feedback/);
    expect(out).toContain("--root");
    expect(out).toContain("--json");
    expect(out).toContain("--index");
    expect(out).not.toContain("__smoke");
    expect(out).not.toContain("not implemented");
  });

  it("no command prints the help on stderr and exits 2", async () => {
    const { code, out, err } = await invoke([]);
    expect(code).toBe(2);
    expect(out).toBe("");
    expect(err).toContain("Usage: xpl <command>");
  });

  it("--version prints the version", async () => {
    const { code, out } = await invoke(["--version"]);
    expect(code).toBe(0);
    expect(out).toMatch(/^\d+\.\d+\.\d+/);
  });

  it("<command> --help and `help <command>` print that command's options", async () => {
    const viaFlag = await invoke(["show", "--help"]);
    expect(viaFlag.code).toBe(0);
    expect(viaFlag.out).toContain("Usage: xpl show <id> [--refs] [--context n]");
    expect(viaFlag.out).toContain("--context <n>");
    expect(viaFlag.out).toContain("--root <dir>");
    expect(viaFlag.out).toContain("Docs: https://krimvp.github.io/xpl/docs/reference/");
    expect(viaFlag.out).not.toContain("docs/ARCHITECTURE.md");
    const viaHelp = await invoke(["help", "apply"]);
    expect(viaHelp.out).toContain("--dry-run");
    expect(viaHelp.out).toContain("--actor llm|user");
    expect((await invoke(["help", "nope"])).code).toBe(2);
  });

  it("an unknown command is a usage error that suggests the closest one", async () => {
    const { code, err } = await invoke(["frobnicate"]);
    expect(code).toBe(2);
    expect(err).toContain('unknown command "frobnicate"');
    const typo = await invoke(["serch", "x"]);
    expect(typo.code).toBe(2);
    expect(typo.err).toContain("Did you mean: search");
  });

  it("usage errors: missing argument, unknown option, bad value, extra argument", async () => {
    const missing = await invoke(["show"]);
    expect(missing.code).toBe(2);
    expect(missing.err).toContain("missing <id>");
    expect(missing.err).toContain("usage: xpl show <id>");

    const unknown = await invoke(["outline", "--frobnicate"]);
    expect(unknown.code).toBe(2);
    expect(unknown.err).toContain("unknown option --frobnicate");

    const bad = await invoke(["outline", "--depth", "abc"]);
    expect(bad.code).toBe(2);
    expect(bad.err).toContain('--depth must be a non-negative integer (got "abc")');

    const extra = await invoke(["validate", "a", "b"]);
    expect(extra.code).toBe(2);
    expect(extra.err).toContain('unexpected argument "b"');

    const root = await invoke(["outline", "--root", "/definitely/not/a/dir"]);
    expect(root.code).toBe(2);
    expect(root.err).toContain("not a directory");
  });

  it("usage errors are JSON with --json", async () => {
    const { code, out, err } = await invoke(["show", "--json"]);
    expect(code).toBe(2);
    expect(err).toBe("");
    const json = JSON.parse(out);
    expect(json.ok).toBe(false);
    expect(json.error).toContain("missing <id>");
    expect(json.usage).toContain("xpl show");
  });

  it("commands without an index say how to build one", async () => {
    const empty = makeTempDir();
    const { code, err } = await xpl(empty, "outline");
    expect(code).toBe(1);
    expect(err).toContain("no symbol index found");
    expect(err).toContain("xpl index");
  });

  it("global options work before and after the command", async () => {
    const dir = await indexedFixture();
    const before = await invoke(["--root", dir, "--json", "outline", "--depth", "1"], {
      cwd: "/",
    });
    const after = await invoke(["outline", "--depth", "1", "--json", "--root", dir], { cwd: "/" });
    expect(before.code).toBe(0);
    expect(JSON.parse(before.out)).toEqual(JSON.parse(after.out));
    // --root=<dir> spelling
    const equals = await invoke(["outline", `--root=${dir}`, "--depth=1", "--json"], { cwd: "/" });
    expect(JSON.parse(equals.out)).toEqual(JSON.parse(after.out));
  });

  it("the hidden __smoke command parses a snippet with every grammar", async () => {
    const { code, out } = await xpl("/", "__smoke");
    expect(out).toMatch(/ok\s+typescript/);
    expect(out).toMatch(/ok\s+json/);
    expect(code).toBe(0);
  });
});
