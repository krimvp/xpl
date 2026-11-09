/**
 * `xpl draft data <guide> [scope]`: what data the code keeps and how its types relate, from the index. One data
 * map (`boxText: "members"`): a table per type, a row per field, arrows from a field to the type it holds. It
 * starts at the most used type that links to another (or at a type entry) and grows along the links.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { ExplainerPatch, GraphView } from "@xpl/core";
import { indexedFixture, makeTempDir, writeFile, xpl, xplJson } from "./helpers.js";

async function draft(fixture: string, ...args: string[]) {
  const dir = await indexedFixture(fixture);
  expect((await xpl(dir, "new", "jobrunner")).code).toBe(0);
  const out = join(makeTempDir("xpl-data-out-"), "data.json");
  const r = await xpl(dir, "draft", "data", "jobrunner", ...args, "-o", out);
  expect(r.code, r.err + r.out).toBe(0);
  const patch = JSON.parse(readFileSync(out, "utf8")) as ExplainerPatch;
  return { dir, out, r, patch, view: patch.views?.[0] as GraphView };
}

/** The type boxes of a data map: the included ids whose parent is not included. */
const types = (view: GraphView) =>
  view.include.filter((id) => !view.include.includes(id.slice(0, id.lastIndexOf("."))));

describe("xpl draft data", () => {
  it("maps the types of a TypeScript repo from the most used one, a row per field, and applies as it is", async () => {
    const { dir, out, r, patch, view } = await draft("ts-jobrunner");
    expect([view.id, view.boxText, view.edgeKinds, view.stubs]).toEqual([
      "view:data",
      "members",
      ["references", "extends", "implements"],
      { mode: "none" },
    ]);
    // Job is the most used; DeadJob (it links to Job and to Queue) joins before Runner (one link)
    expect(types(view)).toEqual([
      "sym:src/queue.ts#Job",
      "sym:src/queue.ts#Queue",
      "sym:src/queue.ts#DeadJob",
      "sym:src/runner.ts#Runner",
      "sym:src/worker.ts#WorkerPool",
      "sym:src/worker.ts#Worker",
      "sym:src/bus.ts#EventBus",
      "sym:src/worker.ts#Handler",
    ]);
    // a table's rows follow it, in the order the code declares them
    const dead = view.include.indexOf("sym:src/queue.ts#DeadJob");
    expect(view.include.slice(dead, dead + 4)).toEqual([
      "sym:src/queue.ts#DeadJob",
      "sym:src/queue.ts#DeadJob.job",
      "sym:src/queue.ts#DeadJob.error",
      "sym:src/queue.ts#DeadJob.deadAt",
    ]);
    expect(patch.nodes?.find((n) => n.id === "sym:src/queue.ts#DeadJob")?.summary).toBe(
      "TODO: one plain sentence: what it holds and what for (interface, 3 fields; holds `Job`; held by `Queue`).",
    );
    // the tour: the first type, the next three as they joined (with the field that links them), then the rest
    const steps = patch.tours?.[0]?.steps ?? [];
    expect(steps.map((s) => s.focus)).toEqual([
      ["sym:src/queue.ts#Job"],
      ["sym:src/queue.ts#Queue"],
      ["sym:src/queue.ts#DeadJob"],
      ["sym:src/runner.ts#Runner"],
      [
        "sym:src/worker.ts#WorkerPool",
        "sym:src/worker.ts#Worker",
        "sym:src/bus.ts#EventBus",
        "sym:src/worker.ts#Handler",
      ],
    ]);
    expect(steps[2]?.code).toEqual([
      // the type down to its last row (its closing brace is left out), and the field of Queue that holds it
      { file: "src/queue.ts", symbol: "DeadJob", span: { from: 0, to: 3 }, role: "definition" },
      { file: "src/queue.ts", symbol: "DeadJob.job", role: "usage" },
    ]);
    expect(r.out).toContain("draft data for jobrunner: a data map of 8 types with 30 field rows,");
    expect(r.out).toMatch(/note: 6 more linked types left off the map \(at most 8 boxes\)/);

    const applied = await xpl(dir, "apply", "jobrunner", out);
    expect(applied.code, applied.out).toBe(0);
    const lint = await xplJson<{ counts: Record<string, number> }>(dir, "lint", "jobrunner");
    expect(lint.json.counts).toEqual({ "todo-left": expect.any(Number) });
  });

  it("keeps to a Python file given as the scope", async () => {
    const { view } = await draft("py-jobrunner", "file:jobrunner/config.py");
    expect(view.id).toBe("view:config-data");
    expect(view.scope?.root).toBe("file:jobrunner/config.py");
    expect(view.include.every((id) => id.startsWith("sym:jobrunner/config.py#"))).toBe(true);
    // Config holds the four section types in its fields: each field is a row
    expect(view.include).toEqual(
      expect.arrayContaining([
        "sym:jobrunner/config.py#Config.queue",
        "sym:jobrunner/config.py#Config.retry",
        "sym:jobrunner/config.py#QueueConfig",
        "sym:jobrunner/config.py#MetricsConfig",
      ]),
    );
  });

  it("starts at a Go type entry and takes the types two links from it", async () => {
    const { view, r } = await draft("go-jobrunner", "sym:internal/queue/queue.go#Queue");
    expect(view.id).toBe("view:queue-data");
    expect(types(view)).toEqual([
      "sym:internal/queue/queue.go#Queue",
      "sym:internal/queue/queue.go#Job",
      "sym:internal/queue/deadletter.go#DeadJob",
      "sym:internal/runner/runner.go#JobQueue",
      "sym:internal/runner/runner.go#Runner",
    ]);
    // an interface has no fields: its box has no rows, and the notes say so
    expect(r.out).toContain("note: JobQueue: no fields the index knows, so its box has no rows");
  });

  it("a field of a type's own type draws no arrow, so the type's summary TODO names it", async () => {
    const dir = makeTempDir("xpl-data-self-");
    writeFile(
      dir,
      "list.ts",
      [
        "export interface Item {",
        "  name: string;",
        "}",
        "",
        "export class Node {",
        "  item: Item;",
        "  next: Node | null;",
        "}",
        "",
      ].join("\n"),
    );
    expect((await xpl(dir, "index", "--precise", "off")).code).toBe(0);
    expect((await xpl(dir, "new", "jobrunner")).code).toBe(0);
    const out = join(makeTempDir("xpl-data-out-"), "data.json");
    const r = await xpl(dir, "draft", "data", "jobrunner", "-o", out);
    expect(r.code, r.err + r.out).toBe(0);
    const patch = JSON.parse(readFileSync(out, "utf8")) as ExplainerPatch;
    expect(patch.nodes?.find((n) => n.id === "sym:list.ts#Node")?.summary).toContain(
      "holds its own type in `next`",
    );
  });

  it("refuses an entry that is not a type, and a scope with no linked types", async () => {
    const dir = await indexedFixture("ts-jobrunner");
    expect((await xpl(dir, "new", "jobrunner")).code).toBe(0);
    const fn = await xpl(dir, "draft", "data", "jobrunner", "sym:src/runner.ts#backoffDelay");
    expect(fn.code).toBe(1);
    expect(fn.err).toContain("is a function: a data map starts at a type");
    const none = await xpl(dir, "draft", "data", "jobrunner", "file:src/metrics.ts");
    expect(none.code).toBe(1);
    expect(none.err).toContain("no type in file:src/metrics.ts holds another one in a field");
  });
});
