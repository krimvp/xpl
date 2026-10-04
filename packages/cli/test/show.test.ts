import { readdirSync } from "node:fs";
import { beforeAll, describe, expect, it } from "vitest";
import {
  cloneDir,
  editFile,
  indexedFixture,
  readJson,
  writeFile,
  xpl,
  xplJson,
} from "./helpers.js";

let dir: string;
beforeAll(async () => {
  dir = await indexedFixture();
});

const base = () => dir;

const DISPATCH = "sym:src/runner.ts#Runner.dispatch";

describe("xpl show", () => {
  it("prints the header and every line with its absolute line and 0-based offset", async () => {
    const { code, out, err } = await xpl(dir, "show", DISPATCH);
    expect(err).toBe("");
    expect(code).toBe(0);
    const lines = out.split("\n");
    expect(lines[0]).toMatch(
      /^sym:src\/runner\.ts#Runner\.dispatch \(method\) src\/runner\.ts:42-88 sha256-v2:[0-9a-f]{12}$/,
    );
    // 47 lines, 42..88
    expect(lines).toHaveLength(1 + 47);
    expect(lines[1]).toMatch(/^42 {2}0│ {3}async dispatch\(\): Promise<void> \{$/);
    // offset 4 = the pop() call, 18-19 = run(job), 34-36 = requeue(...)
    expect(out).toMatch(/^46 {2}4│ +const job = await this\.queue\.pop\(\);$/m);
    expect(out).toMatch(/^60 18│ +result = await worker\.run\($/m);
    expect(out).toMatch(/^61 19│ +job, \{ timeoutMs: this\.config\.timeoutMs \}\);$/m);
    expect(out).toMatch(/^76 34│ +await this\.queue\.requeue\($/m);
    expect(out).toMatch(/^78 36│ +backoff\);$/m);
    expect(lines.at(-1)).toMatch(/^88 46│ {3}\}$/);
  });

  it("the header hash is the symbol hash in the index", async () => {
    const { json } = await xplJson<{ hash: string; range: unknown }>(dir, "show", DISPATCH);
    const indexFile = readdirSync(`${dir}/.explainer`).find((f) => f.startsWith("index-"))!;
    const index = readJson(dir, `.explainer/${indexFile}`);
    expect(json.hash).toBe(
      index.symbols.find((s: any) => s.id === "src/runner.ts#Runner.dispatch").hash,
    );
    expect(json.range).toEqual({ startLine: 42, endLine: 88 });
  });

  it("a file: offsets are line - 1, the trailing newline is not a line", async () => {
    const { code, out, err } = await xpl(dir, "show", "src/queue.ts");
    expect(code).toBe(0);
    // right after `xpl index` the file is unchanged: no "changed since it was indexed" warning (the hash covers
    // the empty line after the final newline, as the index's does, though the display leaves it out)
    expect(err).toBe("");
    const lines = out.split("\n");
    expect(lines[0]).toMatch(/^file:src\/queue\.ts \(typescript\) src\/queue\.ts:1-104 sha256-v2:/);
    expect(lines[1]).toMatch(/^ {2}1 {3}0│ export interface Job \{$/);
    expect(out).toMatch(
      /^ 87 {2}86│ {3}async requeue\(job: Job, delayMs: number\): Promise<void> \{$/m,
    );
    expect(lines.at(-1)).toMatch(/^103 102│ \}$/);
  });

  it("--context adds surrounding lines without offsets", async () => {
    const { out } = await xpl(dir, "show", "sym:src/queue.ts#Queue.requeue", "--context", "2");
    const lines = out.split("\n");
    expect(lines[0]).toContain("src/queue.ts:87-90");
    // two lines before (85, 86) and two after (91, 92), marked with ┆ and no offset
    expect(lines[1]).toMatch(/^85 {2}┆ /);
    expect(lines[2]).toMatch(/^86 {2}┆ /);
    expect(lines[3]).toMatch(/^87 0│ {3}async requeue/);
    expect(lines[6]).toMatch(/^90 3│ {3}\}$/);
    expect(lines[7]).toMatch(/^91 {2}┆$/);
    expect(out).toContain("┆ marks context lines outside the symbol");
  });

  it("--lines selects part of a symbol, --max-lines cuts long ones and says how to continue", async () => {
    const part = await xpl(dir, "show", DISPATCH, "--lines", "74-78");
    expect(part.out.split("\n")).toHaveLength(1 + 5);
    expect(part.out).toMatch(/^74 32│ /m);
    expect(part.out).not.toContain("more lines");

    const cut = await xpl(dir, "show", DISPATCH, "--max-lines", "10");
    const lines = cut.out.split("\n");
    expect(lines).toHaveLength(1 + 10 + 1);
    expect(lines.at(-1)).toContain("... 37 more lines (52-88); use --lines 52-61");
    const rest = await xpl(dir, "show", DISPATCH, "--lines", "52-53");
    expect(rest.out).toMatch(/^52 10│ /m);

    const outside = await xpl(dir, "show", DISPATCH, "--lines", "1-10");
    expect(outside.code).toBe(1);
    expect(outside.err).toContain("outside");
    expect((await xpl(dir, "show", DISPATCH, "--lines", "abc")).code).toBe(2);
  });

  it("--refs appends outgoing and incoming references grouped by kind, with anchor-ready offsets", async () => {
    const { out } = await xpl(dir, "show", DISPATCH, "--refs");
    // (the counts follow the heuristic resolver, which learns to see more: what matters is the kinds)
    expect(out).toMatch(
      /^outgoing refs: \d+ \(call \d+, (?:read \d+, )?type-ref \d+(?:, read \d+)?, write \d+\)$/m,
    );
    // the requeue call: lines 76-78, offsets 34..36 from the start of Runner.dispatch
    expect(out).toMatch(
      /^ {2}call {2}sym:src\/queue\.ts#Queue\.requeue {2}\(src\/runner\.ts:76-78, heuristic\) {2}\+34\.\.36$/m,
    );
    expect(out).toMatch(
      /^ {2}call {2}sym:src\/queue\.ts#Queue\.pop {2}\(src\/runner\.ts:46, heuristic\) {2}\+4$/m,
    );
    expect(out).toMatch(/^ {2}type-ref {2}sym:src\/worker\.ts#RunResult /m);
    expect(out).toMatch(/^incoming refs: 1 \(call 1\)$/m);
    expect(out).toMatch(
      /^ {2}call {2}sym:src\/runner\.ts#Runner\.start {2}\(src\/runner\.ts:32, heuristic\) {2}\+2$/m,
    );
    // grouped by kind: every call before the type-ref before the write
    expect(out.indexOf("  call ")).toBeLessThan(out.indexOf("  type-ref"));
    expect(out.indexOf("  type-ref")).toBeLessThan(out.indexOf("  write "));
  });

  it("lists the children of a directory and of the repo", async () => {
    const src = await xpl(dir, "show", "dir:src");
    expect(src.code).toBe(0);
    expect(src.out.split("\n")[0]).toBe("dir:src (dir) 7 files");
    expect(src.out).toMatch(/^ {2}file:src\/runner\.ts {2}typescript {2}1-111 /m);
    const repo = await xpl(dir, "show", "repo");
    expect(repo.out.split("\n")[0]).toMatch(/^repo \(repo\) 12 files, \d+ symbols$/);
    expect(repo.out).toContain("  dir:src  dir  7 files");
    const withRefs = await xpl(dir, "show", "dir:test", "--refs");
    expect(withRefs.out).toMatch(/^outgoing refs: \d+ \(/m);
    expect(withRefs.out).toContain("sym:src/runner.ts#backoffDelay");
  });

  it("a config key shows its lines; a single-line symbol works", async () => {
    const retry = await xpl(dir, "show", "config/default.yaml#retry");
    expect(retry.out.split("\n")[0]).toMatch(
      /^sym:config\/default\.yaml#retry \(key\) config\/default\.yaml:13-16 /,
    );
    expect(retry.out).toMatch(/^14 1│ {3}maxRetries: 3$/m);
    const one = await xpl(dir, "show", "sym:src/runner.ts#Logger");
    expect(one.out.split("\n")).toHaveLength(2);
    expect(one.out).toMatch(/^6 0│ export type Logger = /m);
  });

  it("handles CRLF files, a BOM, empty files and a missing final newline", async () => {
    const dir = cloneDir(base());
    writeFile(
      dir,
      "src/crlf.ts",
      'export function a() {\r\n  return 1;\r\n}\r\n\r\nexport function b() {\r\n  return "\u00e9";\r\n}\r\n',
    );
    writeFile(dir, "src/bom.ts", "\ufeffexport const bom = 1;\n");
    writeFile(dir, "src/empty.ts", "");
    writeFile(dir, "notes.txt", "no trailing newline");
    expect((await xpl(dir, "index", "--precise", "off")).code).toBe(0);

    const crlf = await xpl(dir, "show", "src/crlf.ts#b");
    expect(crlf.out).not.toContain("\r");
    expect(crlf.out.split("\n")).toEqual([
      expect.stringMatching(/^sym:src\/crlf\.ts#b \(function\) src\/crlf\.ts:5-7 sha256-v2:/),
      "5 0│ export function b() {",
      '6 1│   return "\u00e9";',
      "7 2│ }",
    ]);
    const bom = await xpl(dir, "show", "file:src/bom.ts");
    expect(bom.out.split("\n")[1]).toBe("1 0│ \ufeffexport const bom = 1;");
    const empty = await xpl(dir, "show", "file:src/empty.ts");
    expect(empty.code).toBe(0);
    expect(empty.out.split("\n")).toHaveLength(2);
    const noNewline = await xpl(dir, "show", "file:notes.txt");
    expect(noNewline.out.split("\n")[1]).toBe("1 0│ no trailing newline");
    // none of these files changed since `xpl index`: no warning for any of them, whole or by symbol
    for (const result of [crlf, bom, empty, noNewline]) expect(result.err).toBe("");
    expect((await xpl(dir, "show", "file:src/crlf.ts")).err).toBe("");
    // and the text is searchable with the same offsets
    const search = await xpl(dir, "search", "return");
    expect(search.out).toContain("src/crlf.ts:6  sym:src/crlf.ts#b +1  ");
  });

  it("cuts very long lines in the text output but not in --json", async () => {
    const dir = cloneDir(base());
    writeFile(dir, "src/minified.ts", `export const blob = "${"x".repeat(1000)}";\n`);
    expect((await xpl(dir, "index", "--precise", "off")).code).toBe(0);
    const { out } = await xpl(dir, "show", "file:src/minified.ts");
    const line = out.split("\n")[1]!;
    expect(line.length).toBeLessThan(500);
    expect(line).toMatch(/…\[\+\d+ chars\]$/);
    const { json } = await xplJson<any>(dir, "show", "file:src/minified.ts");
    expect(json.lines[0].text.length).toBeGreaterThan(1000);
  });

  it("caps long directory listings with --max-lines", async () => {
    const { out } = await xpl(dir, "show", "dir:src", "--max-lines", "2");
    const lines = out.split("\n");
    expect(lines).toHaveLength(1 + 2 + 1);
    expect(lines[3]).toBe("  ... 5 more; use --max-lines 0");
  });

  it("--json returns the lines as data", async () => {
    const { json } = await xplJson<any>(dir, "show", DISPATCH, "--refs");
    expect(json.id).toBe(DISPATCH);
    expect(json.kind).toBe("method");
    expect(json.lines).toHaveLength(47);
    expect(json.lines[34]).toEqual({
      line: 76,
      offset: 34,
      text: "        await this.queue.requeue(",
    });
    const requeue = json.refs.out.find((r: any) => r.id === "sym:src/queue.ts#Queue.requeue");
    expect(requeue).toMatchObject({
      kind: "call",
      file: "src/runner.ts",
      offset: { from: 34, to: 36 },
    });
  });

  it("unknown ids fail with core's suggestions, not-symbol ids are refused", async () => {
    const typo = await xpl(dir, "show", "src/runner.ts#Runner.dispach");
    expect(typo.code).toBe(1);
    expect(typo.err).toContain("Did you mean: sym:src/runner.ts#Runner.dispatch?");
    const dirAsFile = await xpl(dir, "show", "file:src");
    expect(dirAsFile.err).toContain("is a directory; use dir:src");
    const group = await xpl(dir, "show", "grp:scheduling");
    expect(group.code).toBe(1);
    expect(group.err).toContain("only exist inside an explainer");
  });

  it("warns when the code changed since indexing, and still prints", async () => {
    const copy = cloneDir(dir);
    editFile(copy, "src/runner.ts", (text) =>
      text.replace("backoffDelay(attempts", "backoffDelay(attempts + 0"),
    );
    const { code, out, err } = await xpl(copy, "show", DISPATCH);
    expect(code).toBe(0);
    expect(out).toContain("backoffDelay(attempts + 0");
    expect(err).toContain("does not match the working tree");
    expect(err).toContain("src/runner.ts");
    expect(err).toContain(
      "the text of sym:src/runner.ts#Runner.dispatch changed since it was indexed",
    );
    const json = await xplJson<{ warnings: string[] }>(copy, "show", DISPATCH);
    expect(json.json.warnings).toHaveLength(2);
    expect(json.err).toBe("");
    // the whole file warns too, also when only its final newline went away
    const file = await xpl(copy, "show", "file:src/runner.ts");
    expect(file.err).toContain("the text of file:src/runner.ts changed since it was indexed");
    const trimmed = cloneDir(dir);
    editFile(trimmed, "src/queue.ts", (text) => text.replace(/\n$/, ""));
    expect((await xpl(trimmed, "show", "file:src/queue.ts")).err).toContain(
      "the text of file:src/queue.ts changed since it was indexed",
    );
  });
});
