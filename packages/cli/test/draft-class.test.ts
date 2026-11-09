/**
 * `xpl draft class <guide> <type>`: the type hierarchy around one class or interface, from the index. The types
 * it extends or implements (all the way up), the types that extend or implement it (two levels down), on one map
 * of `extends` and `implements` arrows, each box with a summary to write, and a short tour.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { ExplainerPatch, GraphView } from "@xpl/core";
import { makeTempDir, writeFile, xpl, xplJson } from "./helpers.js";

function shapes(): string {
  const dir = makeTempDir("xpl-class-");
  writeFile(dir, "package.json", '{ "name": "shapes" }\n');
  writeFile(dir, "src/shape.ts", "export interface Shape {\n  area(): number;\n}\n");
  writeFile(
    dir,
    "src/base.ts",
    'import { Shape } from "./shape";\n\nexport abstract class Base implements Shape {\n  area(): number {\n    return 0;\n  }\n}\n',
  );
  writeFile(
    dir,
    "src/circle.ts",
    'import { Base } from "./base";\n\nexport class Circle extends Base {}\n',
  );
  writeFile(
    dir,
    "src/square.ts",
    'import { Base } from "./base";\n\nexport class Square extends Base {}\n',
  );
  writeFile(
    dir,
    "src/fancy.ts",
    'import { Circle } from "./circle";\n\nexport class FancyCircle extends Circle {}\n',
  );
  return dir;
}

describe("xpl draft class", () => {
  it("maps what a type extends and implements and what extends it, and applies as it is", async () => {
    const dir = shapes();
    expect((await xpl(dir, "index", "--precise", "off")).code).toBe(0);
    expect((await xpl(dir, "new", "shapes")).code).toBe(0);
    const out = join(makeTempDir("xpl-class-out-"), "class.json");
    const r = await xpl(dir, "draft", "class", "shapes", "sym:src/base.ts#Base", "-o", out);
    expect(r.code, r.err + r.out).toBe(0);
    const patch = JSON.parse(readFileSync(out, "utf8")) as ExplainerPatch;

    const view = patch.views?.[0] as GraphView;
    expect([view.id, view.include, view.edgeKinds, view.stubs]).toEqual([
      "view:base-types",
      [
        "sym:src/shape.ts#Shape",
        "sym:src/base.ts#Base",
        "sym:src/circle.ts#Circle",
        "sym:src/square.ts#Square",
        "sym:src/fancy.ts#FancyCircle",
      ],
      ["extends", "implements"],
      { mode: "none" },
    ]);
    expect(patch.nodes?.find((n) => n.id === "sym:src/base.ts#Base")?.summary).toBe(
      "TODO: one plain sentence: what this type is for (abstract class; implements `Shape`; extended by `Circle` and `Square`; methods: `area`).",
    );
    expect(patch.tours?.[0]?.steps?.map((s) => s.focus)).toEqual([
      ["sym:src/base.ts#Base"],
      ["sym:src/shape.ts#Shape"],
      ["sym:src/circle.ts#Circle"],
      ["sym:src/square.ts#Square"],
      [],
    ]);
    expect(patch.tours?.[0]?.steps?.at(-1)?.note).toBe(
      "### Where to go next\n\nTODO: which type to use when, and what to read next, one short sentence each.",
    );
    expect(r.out).toContain("a tour of 5 steps");

    const applied = await xpl(dir, "apply", "shapes", out);
    expect(applied.code, applied.out).toBe(0);
    const lint = await xplJson<{ counts: Record<string, number> }>(dir, "lint", "shapes");
    expect(Object.keys(lint.json.counts)).toEqual(["todo-left"]);
  });

  it("names each method once, without constructors", async () => {
    const dir = makeTempDir("xpl-class-java-");
    writeFile(dir, "src/Handler.java", "interface Handler {\n  void handle(String job);\n}\n");
    writeFile(
      dir,
      "src/Base.java",
      'abstract class Base implements Handler {\n  Base() {}\n  String name() { return "a"; }\n  String name(int n) { return "b"; }\n  public void handle(String job) {}\n}\n',
    );
    expect((await xpl(dir, "index", "--precise", "off")).code).toBe(0);
    expect((await xpl(dir, "new", "h")).code).toBe(0);
    const draft = await xplJson<{ patch: ExplainerPatch }>(
      dir,
      "draft",
      "class",
      "h",
      "sym:src/Base.java#Base",
    );
    expect(draft.json.patch.nodes?.find((n) => n.id === "sym:src/Base.java#Base")?.summary).toBe(
      "TODO: one plain sentence: what this type is for (abstract class; implements `Handler`; methods: `name` and `handle`).",
    );
  });

  it("on Go, says 'embeds' for an embedded type and leaves test types off the map, with a note", async () => {
    const dir = makeTempDir("xpl-class-go-");
    writeFile(dir, "go.mod", "module example.com/jobs\n\ngo 1.22\n");
    writeFile(
      dir,
      "queue/queue.go",
      "package queue\n\ntype Queue struct{}\n\nfunc (q *Queue) Pop() int { return 0 }\n",
    );
    writeFile(
      dir,
      "runner/runner.go",
      'package runner\n\nimport "example.com/jobs/queue"\n\ntype JobQueue interface {\n\tPop() int\n}\n\ntype Logged struct {\n\t*queue.Queue\n}\n',
    );
    writeFile(
      dir,
      "runner/runner_test.go",
      'package runner\n\nimport "example.com/jobs/queue"\n\ntype recording struct {\n\t*queue.Queue\n}\n',
    );
    expect((await xpl(dir, "index", "--precise", "off")).code).toBe(0);
    expect((await xpl(dir, "new", "jobs")).code).toBe(0);
    const draft = await xplJson<{ patch: ExplainerPatch; notes: string[] }>(
      dir,
      "draft",
      "class",
      "jobs",
      "sym:queue/queue.go#Queue",
    );
    const view = draft.json.patch.views?.[0] as GraphView;
    expect(view.include).toEqual([
      "sym:runner/runner.go#JobQueue",
      "sym:queue/queue.go#Queue",
      "sym:runner/runner.go#Logged",
    ]);
    expect(draft.json.patch.nodes?.map((n) => n.summary)).toEqual([
      "TODO: one plain sentence: what this type is for (interface; implemented by `Queue` and `Logged`; methods: `Pop`).",
      "TODO: one plain sentence: what this type is for (struct; implements `JobQueue`; embedded by `Logged`; methods: `Pop`).",
      "TODO: one plain sentence: what this type is for (struct; embeds `Queue`; implements `JobQueue`).",
    ]);
    expect(draft.json.notes).toContain("left off the map: `recording` (a type in a test file)");
  });

  it("refuses an entry that is not a class or an interface", async () => {
    const dir = shapes();
    expect((await xpl(dir, "index", "--precise", "off")).code).toBe(0);
    expect((await xpl(dir, "new", "shapes")).code).toBe(0);
    const r = await xpl(dir, "draft", "class", "shapes", "sym:src/base.ts#Base.area");
    expect(r.code).toBe(1);
    expect(r.err).toContain(
      "the entry must be a class or an interface, not sym:src/base.ts#Base.area (a method)",
    );
  });
});
