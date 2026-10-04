/**
 * `xpl draft path` on the shapes the real runs tripped over: recursion, a conversion to a type, a one-line helper,
 * a method a class inherits (and the overrides its method order picks), a question with two halves (two entries,
 * one tour), and too many calls (what the cap keeps). Every draft applies as it is and passes the self-check.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { ExplainerPatch, SequenceView } from "@xpl/core";
import { makeTempDir, writeFile, xpl, xplJson } from "./helpers.js";

interface DraftJson {
  notes: string[];
  patch: ExplainerPatch;
}

async function repo(files: Record<string, string>): Promise<string> {
  const dir = makeTempDir("xpl-draft-path-");
  for (const [path, text] of Object.entries(files)) writeFile(dir, path, text);
  expect((await xpl(dir, "index", "--precise", "off")).code).toBe(0);
  expect((await xpl(dir, "new", "d")).code).toBe(0);
  return dir;
}

/** Drafts, applies and validates; returns the patch and the notes. */
async function drafted(dir: string, ...entries: string[]): Promise<DraftJson> {
  const out = join(makeTempDir("xpl-draft-path-out-"), "draft.json");
  const r = await xpl(dir, "draft", "path", "d", ...entries, "-o", out);
  expect(r.code, r.err + r.out).toBe(0);
  const json = await xplJson<DraftJson>(dir, "draft", "path", "d", ...entries);
  expect(JSON.parse(readFileSync(out, "utf8"))).toEqual(json.json.patch);
  const applied = await xpl(dir, "apply", "d", out);
  expect(applied.code, applied.out).toBe(0);
  expect((await xpl(dir, "validate", "d")).out).toMatch(/no errors, no warnings$/);
  return json.json;
}

const sequence = (patch: ExplainerPatch, i = 0) => patch.views![i] as SequenceView;

describe("xpl draft path: an algorithm that recurses", () => {
  it("draws the recursion as a call to itself, and leaves out a type conversion and a one-line helper", async () => {
    const dir = await repo({
      "go.mod": "module example.com/tree\n\ngo 1.22\n",
      "tree.go": [
        "package tree",
        "",
        "type kind uint8",
        "",
        "type node struct {",
        "\tkids []*node",
        "\tend  bool",
        "}",
        "",
        "func (n *node) leaf() bool {",
        "\treturn n.end",
        "}",
        "",
        "func (n *node) find(path string) *node {",
        "\tk := kind(len(path))",
        "\tif k == 0 || n.leaf() {",
        "\t\treturn n",
        "\t}",
        "\tif r := n.find(path[1:]); r != nil {",
        "\t\treturn r",
        "\t}",
        "\treturn edge(n.kids, path)",
        "}",
        "",
        "func edge(kids []*node, path string) *node {",
        "\tfor _, k := range kids {",
        "\t\tif k.end {",
        "\t\t\treturn k",
        "\t\t}",
        "\t}",
        "\treturn nil",
        "}",
        "",
      ].join("\n"),
    });
    // the index has the recursion: xpl refs lists it
    const refs = await xpl(dir, "refs", "sym:tree.go#node.find", "--out", "--kind", "call");
    expect(refs.out).toContain("sym:tree.go#node.find  (tree.go:19");
    const { patch, notes } = await drafted(dir, "sym:tree.go#node.find");
    const view = sequence(patch);
    expect(view.participants).toEqual(["sym:tree.go#node.find", "sym:tree.go#edge"]);
    expect(view.steps!.map((s) => `${s.to} ${s.label}`)).toEqual([
      "sym:tree.go#node.find find(path[1:])",
      "sym:tree.go#edge edge(n.kids, path)",
    ]);
    // the recursion is the only self-call; its anchor is the call site
    expect(view.steps![0]!.from).toBe(view.steps![0]!.to);
    expect(view.steps![0]!.summary).toContain("call into itself");
    // (the tree-sitter index has no reference for the conversion `kind(len(path))`; scip-go has one, a `type`)
    expect(notes.join("\n")).toContain("one-line helpers that call nothing: node.leaf");
  });

  it("leaves out data built from a class with no constructor", async () => {
    const dir = await repo({
      "shapes.py": [
        "class Point:",
        "    x = 0",
        "",
        "",
        "def measure(p):",
        "    total = p.x * 2",
        "    return total + 1",
        "",
        "",
        "def area():",
        "    p = Point()",
        "    return measure(p)",
        "",
      ].join("\n"),
    });
    const { patch, notes } = await drafted(dir, "sym:shapes.py#area");
    expect(sequence(patch).participants).toEqual(["sym:shapes.py#area", "sym:shapes.py#measure"]);
    expect(notes.join("\n")).toContain("data built from it (no code of it runs): Point");
  });
});

const SERIALIZER = [
  "class Signer:",
  "    def sign(self, value):",
  "        return value + '.sig'",
  "",
  "",
  "class Serializer:",
  "    def dumps(self, obj):",
  "        payload = self.dump_payload(obj)",
  "        signer = self.make_signer()",
  "        return signer.sign(payload)",
  "",
  "    def loads(self, s):",
  "        value = self.make_signer().unsign(s)",
  "        return self.load_payload(value)",
  "",
  "    def dump_payload(self, obj):",
  "        text = str(obj)",
  "        return text.encode()",
  "",
  "    def load_payload(self, value):",
  "        text = value.decode()",
  "        return text",
  "",
  "    def make_signer(self):",
  "        signer = Signer()",
  "        return signer",
  "",
  "",
  "class SafeMixin:",
  "    def dump_payload(self, obj):",
  "        raw = super().dump_payload(obj)",
  "        return raw.replace(b'+', b'-')",
  "",
  "",
  "class SafeSerializer(SafeMixin, Serializer):",
  "    pass",
  "",
].join("\n");

describe("xpl draft path: nested calls of the same function", () => {
  it("labels the outer call with its own arguments, brackets balanced", async () => {
    const dir = await repo({
      "a.ts": [
        "export class Box {",
        "  constructor(readonly kids: Box[]) {",
        "    for (const k of kids) console.log(k);",
        "    console.log(kids.length);",
        "  }",
        "}",
        "export function wrap(n: number): number {",
        "  if (n <= 0) return 0;",
        "  console.log(n);",
        "  return wrap(wrap(n - 1) - 1);",
        "}",
        "export function build(): Box {",
        "  wrap(2);",
        "  return new Box([new Box([])]);",
        "}",
        "",
      ].join("\n"),
    });
    const labels = sequence((await drafted(dir, "a.ts#build", "a.ts#wrap")).patch, 0).steps.map(
      (s) => s.label,
    );
    expect(labels).toEqual(["wrap(2)", "Box([new Box([])])"]);
    const rec = sequence((await drafted(dir, "a.ts#wrap")).patch).steps.map((s) => s.label);
    expect(rec).toEqual(["wrap(wrap(n - 1) - 1)", "wrap(n - 1)"]);
  });

  it("says which calls it left out when none is worth drawing", async () => {
    const dir = await repo({
      "a.ts": [
        "export abstract class Node {",
        "  abstract visit(): void;",
        "  walk(): void {",
        "    this.visit();",
        "  }",
        "}",
        "",
      ].join("\n"),
    });
    const r = await xpl(dir, "draft", "path", "d", "a.ts#Node.walk");
    expect(r.code).toBe(1);
    expect(r.err).toMatch(
      /every call it makes is left out .*one-line helpers that call nothing: Node\.visit/,
    );
  });
});

describe("xpl draft path: a method a class inherits", () => {
  it("starts at the base that defines it, says so, and sends self calls where the method order finds them", async () => {
    const dir = await repo({ "ser.py": SERIALIZER });
    const { patch, notes } = await drafted(dir, "sym:ser.py#SafeSerializer.dumps");
    expect(notes.join("\n")).toContain(
      "SafeSerializer.dumps is inherited: it resolves to sym:ser.py#Serializer.dumps",
    );
    const view = sequence(patch);
    expect(view.id).toBe("view:safe-serializer-dumps");
    expect(view.participants![0]).toBe("sym:ser.py#Serializer.dumps");
    const dump = view.steps!.find((s) => s.label.startsWith("dump_payload"))!;
    // the mixin's override runs for a SafeSerializer: its lifeline, its definition, and a hint saying why
    expect(dump.to).toBe("sym:ser.py#SafeMixin");
    expect(dump.anchors![1]).toMatchObject({ file: "ser.py", symbol: "SafeMixin.dump_payload" });
    expect(dump.summary).toContain("SafeSerializer runs `SafeMixin.dump_payload`");
    // a method of the entry's own class goes to the class's lifeline, never to the entry's
    const signer = view.steps!.find((s) => s.label.startsWith("make_signer"))!;
    expect(signer.to).toBe("sym:ser.py#Serializer");
    expect(view.steps!.filter((s) => s.from === s.to)).toEqual([]);
  });

  it("an unknown method of a class fails and says how to list the symbols of the file", async () => {
    const dir = await repo({ "ser.py": SERIALIZER });
    const r = await xpl(dir, "draft", "path", "d", "sym:ser.py#SafeSerializer.nothing");
    expect(r.code).toBe(1);
    expect(r.err).toBe(
      'error: symbol "SafeSerializer.nothing" not found in ser.py. List the symbols of the file with `xpl outline --under file:ser.py`.',
    );
  });
});

describe("xpl draft path: a question with two halves", () => {
  it("draws one sequence per entry and walks them in one tour", async () => {
    const dir = await repo({ "ser.py": SERIALIZER });
    const r = await xpl(
      dir,
      "draft",
      "path",
      "d",
      "sym:ser.py#SafeSerializer.dumps",
      "sym:ser.py#Serializer.loads",
    );
    expect(r.code, r.err).toBe(0);
    expect(r.err).toMatch(/draft path for d: 2 sequences of \d+ calls in all/);
    const { patch } = await drafted(
      dir,
      "sym:ser.py#SafeSerializer.dumps",
      "sym:ser.py#Serializer.loads",
    );
    expect(patch.views!.map((v) => v.id)).toEqual([
      "view:safe-serializer-dumps",
      "view:serializer-loads",
    ]);
    expect(patch.tours).toHaveLength(1);
    const steps = patch.tours![0]!.steps!;
    // the big picture of each half, then its calls
    expect(steps[0]).toMatchObject({
      view: "view:safe-serializer-dumps",
      focus: ["sym:ser.py#Serializer.dumps"],
    });
    const second = steps.findIndex((s) => s.view === "view:serializer-loads");
    expect(steps[second]!.focus).toEqual(["sym:ser.py#Serializer.loads"]);
    expect(steps[second]!.note).toContain("the next part of the answer");
    expect(steps.length).toBeLessThanOrEqual(9);
    // a participant of both halves has one summary
    const ids = patch.nodes!.map((n) => n.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe("xpl draft path: too many calls", () => {
  it("keeps the calls that reach the most code, and lists what it left out", async () => {
    const helpers = Array.from({ length: 13 }, (_, i) =>
      [
        `    def step${i}(self, x):`,
        `        y = x + ${i}`,
        "        z = y * 2",
        "        return z",
        "",
      ].join("\n"),
    );
    const dir = await repo({
      "store.py": [
        "def encode(x):",
        "    return str(x)",
        "",
        "",
        "def write(x):",
        "    return encode(x)",
        "",
        "",
        "class Store:",
        "    def save(self, x):",
        "        text = write(x)",
        "        return text",
        "",
      ].join("\n"),
      "job.py": [
        "from store import Store",
        "",
        "",
        "class Job:",
        "    def run(self, x):",
        ...Array.from({ length: 13 }, (_, i) => `        x = self.step${i}(x)`),
        "        return Store().save(x)",
        "",
        ...helpers,
      ].join("\n"),
    });
    const { patch, notes } = await drafted(dir, "sym:job.py#Job.run");
    const view = sequence(patch);
    expect(view.steps).toHaveLength(12);
    // the call into the store reaches the most code: it stays, though it comes last
    expect(view.steps!.at(-1)!.label).toBe("save(x)");
    expect(view.participants).toContain("sym:store.py#Store");
    const left = notes.find((n) => n.startsWith("calls left out of the sequence"))!;
    expect(left).toContain("the ones that reach the least code");
    expect(left.match(/sym:job\.py#Job\.step\d+/g)).toHaveLength(2);
  });
});
