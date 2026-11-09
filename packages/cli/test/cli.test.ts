import { describe, expect, it } from "vitest";
import { COMMANDS } from "../src/cli.js";
import { indexedFixture, invoke, makeTempDir, xpl } from "./helpers.js";

describe("xpl cli", () => {
  it("--help describes commands and global options", async () => {
    const { code, out } = await invoke(["--help"]);
    expect(code).toBe(0);
    expect(out).toContain("Usage: xpl <command> [options]");
    expect(out).toContain("Docs: https://krimvp.github.io/xpl/docs/reference/");
    expect(out).not.toContain("docs/ARCHITECTURE.md");
    expect(out).toMatch(/feedback\s+Import, list or export reader requests/);
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
    expect(viaFlag.out).toContain("Usage: xpl show <id> [--refs] [--context <n>]");
    expect(viaFlag.out).toContain("--context <n>");
    expect(viaFlag.out).toContain("--root <dir>");
    expect(viaFlag.out).toMatch(
      /\nMore: the skill's reference\/cli\.md \("xpl show"\), or https:\/\/krimvp\.github\.io\/xpl\/docs\/reference\/$/,
    );
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
    const typo = await invoke(["indx"]);
    expect(typo.code).toBe(2);
    expect(typo.err.trim()).toBe(
      'error: unknown command "indx". Did you mean: index? Run "xpl --help" for the list of commands.',
    );
  });

  it("an unknown option names the closest option of the command", async () => {
    const typo = await invoke(["outline", "--depht", "3"]);
    expect(typo.code).toBe(2);
    expect(typo.err).toContain("unknown option --depht. Did you mean: --depth?");
    expect(typo.err).not.toContain("goes after");
  });

  it("every help page wraps at 110 columns, names every option in its usage line, and orders --precise one way", async () => {
    const pages = [(await invoke(["--help"])).out];
    for (const command of COMMANDS) {
      const help = (await invoke([command.name, "--help"])).out;
      pages.push(help);
      const usage = help.split("\n\n")[0]!;
      for (const [name, def] of Object.entries(command.options)) {
        const named = new RegExp(`--${name}\\b`).test(usage);
        const short =
          def.short !== undefined && new RegExp(`(^|[\\s[|])-${def.short}\\b`).test(usage);
        expect.soft(named || short, `xpl ${command.name}: usage omits --${name}`).toBe(true);
      }
    }
    for (const page of pages) {
      const lines = page.split("\n");
      for (const [i, line] of lines.entries()) {
        expect.soft(line.length, line).toBeLessThanOrEqual(110);
        // a paragraph wraps as a whole: no short line that stops inside a sentence before more of it
        const next = lines[i + 1] ?? "";
        const indent = (text: string) => /^ */.exec(text)![0].length;
        const prose = (text: string) =>
          /^ *[a-z(`]/.test(text) &&
          !/^ *\S(?:\S| (?! ))* {2,}/.test(text) &&
          !/^ *(xpl|\$) /.test(text);
        if (
          line.length < 70 &&
          /[a-z,]$/.test(line) &&
          prose(line) &&
          prose(next) &&
          indent(next) === indent(line)
        )
          expect.soft(`${line}\n${next}`, "ragged help paragraph").toBe("");
      }
      expect.soft(page).not.toMatch(/off\|auto\|require/);
    }
  });

  it("every command's help is short: usage, at most 8 lines of prose, one line per option, then where to read more", async () => {
    for (const command of COMMANDS) {
      const help = (await invoke([command.name, "--help"])).out;
      const lines = help.split("\n");
      const name = `xpl ${command.name}`;
      expect
        .soft(lines.at(-1), name)
        .toMatch(/^More: the skill's reference\/cli\.md \("xpl \S+"\), or https:/);
      const options = lines.indexOf("Options:");
      const global = lines.indexOf("Global options:");
      const optionLines = options === -1 ? [] : lines.slice(options + 1, global - 1);
      expect
        .soft(optionLines.length, `${name}: one line per option`)
        .toBe(Object.keys(command.options).length);
      // the prose: after the usage and the summary, before the options; a row of a choice table (`  path  ...`)
      // is one line of its own and does not count
      const choices = command.positionals[0]?.name.split("|") ?? [];
      const start = lines.findIndex((line, i) => i > 0 && lines[i - 1] === "" && line !== "") + 2;
      const prose = lines
        .slice(start, options === -1 ? global : options)
        .filter((line) => line !== "")
        .filter((line) => !choices.some((c) => choices.length > 1 && line.startsWith(`  ${c} `)));
      expect
        .soft(prose.length, `${name}: lines of prose\n${prose.join("\n")}`)
        .toBeLessThanOrEqual(8);
      const descs = Object.values(command.options).map((def) => def.desc);
      // a sentence ends at . ! ? or :, and each row of a table (an indented line) is one
      const text = [command.summary, (command.details ?? []).join("\n"), ...descs]
        .join(". ")
        .replace(/`[^`]*`/g, "x");
      for (const sentence of text.split(/(?<=[.!?:])\s+|\n(?= {2})|(?<=(?:^|\n) {2}[^\n]*)\n/)) {
        const words = sentence.split(/\s+/).filter((w) => /\w/.test(w)).length;
        expect.soft(words, `${name}: ${sentence}`).toBeLessThanOrEqual(25);
      }
    }
  });

  it("`xpl draft <kind> --help` shows the row of that kind, not the other kinds", async () => {
    const help = (await invoke(["draft", "path", "--help"])).out;
    expect(help).toContain("  path [explainer] <entry>");
    expect(help).not.toMatch(/^ {2}(?:change|repo|map|class|states) \[/m);
    expect(help).toContain("Exit codes:");
    expect((await invoke(["draft", "--help"])).out).toMatch(/^ {2}states \[/m);
    // the usage and the sentences are those of the kind asked for
    const repo = (await invoke(["draft", "repo", "--help"])).out;
    expect(repo.split("\n")[0]).toBe(
      "Usage: xpl draft repo [explainer] [--audience <reader>] [--question <question>] [-o <file>]",
    );
    expect(repo.split("\n")[2]).toBe(
      "Print a patch skeleton with TODOs to write: a system map, a map of each service's parts, a tour of at most 7",
    );
    expect(repo).not.toContain("Several path entries");
    expect(repo).toContain("Exit codes: 0 ok, 1 nothing to draft, 2 usage error.");
    expect(help).toContain("Several path entries make one tour.");
  });

  it("usage errors: missing argument, unknown option, bad value, extra argument", async () => {
    const missing = await invoke(["show"]);
    expect(missing.code).toBe(2);
    expect(missing.err).toContain("missing <id>");
    expect(missing.err).toContain("usage: xpl show <id>");

    const unknown = await invoke(["outline", "--frobnicate"]);
    expect(unknown.code).toBe(2);
    expect(unknown.err).toContain("unknown option --frobnicate");

    expect(unknown.err.split("\n")[0]).toBe("error: unknown option --frobnicate");

    // a negative number for a number option: xpl's words, not Node's, and no hint to a form that fails too
    const dashed = await invoke(["outline", "--limit", "-1"]);
    expect(dashed.code).toBe(2);
    expect(dashed.err.split("\n")[0]).toBe(
      'error: --limit must be a non-negative integer (got "-1")',
    );
    // a value that starts with "-" for a text option
    const text = await invoke(["new", "demo", "--title", "-x"]);
    expect(text.err.split("\n")[0]).toBe(
      'error: --title needs a value (got "-x"; a value that starts with "-" is written --title=-x)',
    );

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
