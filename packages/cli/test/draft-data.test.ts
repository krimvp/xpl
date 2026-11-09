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
  it("maps the types of a TypeScript repo from the one that holds the most, a row per field, and applies as it is", async () => {
    const { dir, out, r, patch, view } = await draft("ts-jobrunner");
    expect([view.id, view.boxText, view.edgeKinds, view.stubs]).toEqual([
      "view:data",
      "members",
      ["references", "extends", "implements"],
      { mode: "none" },
    ]);
    // Runner reaches the most types through its fields; then what a box holds, the most used first (Job before
    // WorkerPool), at most 6 boxes. Handler (a function type) holds no fields: no table, a note.
    expect(types(view)).toEqual([
      "sym:src/runner.ts#Runner",
      "sym:src/queue.ts#Queue",
      "sym:src/queue.ts#Job",
      "sym:src/worker.ts#WorkerPool",
      "sym:src/worker.ts#Worker",
      "sym:src/bus.ts#EventBus",
    ]);
    // a table's rows follow it, in the order the code declares them
    const pool = view.include.indexOf("sym:src/worker.ts#WorkerPool");
    expect(view.include.slice(pool, pool + 3)).toEqual([
      "sym:src/worker.ts#WorkerPool",
      "sym:src/worker.ts#WorkerPool.idle",
      "sym:src/worker.ts#WorkerPool.waiting",
    ]);
    expect(patch.nodes?.find((n) => n.id === "sym:src/queue.ts#Queue")?.summary).toBe(
      "TODO: one plain sentence: what it holds and what for (class, 6 fields; holds `Job`; held by `Runner`).",
    );
    // field rows get no text to write: only the types have nodes
    expect(patch.nodes?.map((n) => n.id)).toEqual(types(view));
    // the tour: the first type, the next three as they joined (with the field that links them), the rest, then
    // where to go next with the types left off
    const steps = patch.tours?.[0]?.steps ?? [];
    expect(steps.map((s) => s.focus)).toEqual([
      ["sym:src/runner.ts#Runner"],
      ["sym:src/queue.ts#Queue"],
      ["sym:src/queue.ts#Job"],
      ["sym:src/worker.ts#WorkerPool"],
      ["sym:src/worker.ts#Worker", "sym:src/bus.ts#EventBus"],
      [],
    ]);
    expect(steps[2]?.code).toEqual([
      // the type down to its last row (its closing brace is left out), and the field of Queue that holds it
      { file: "src/queue.ts", symbol: "Job", span: { from: 0, to: 10 }, role: "definition" },
      { file: "src/queue.ts", symbol: "Queue.ready", role: "usage" },
    ]);
    expect(steps.at(-1)?.note).toMatch(
      /^### Where to go next\n\nTODO: the types left off the map .* Left off: Config, /,
    );
    // a cut list ends in "…", with no stop after it
    expect(steps.at(-1)?.note).toMatch(/, …$/);
    expect(r.out).toContain(
      "draft data for jobrunner: a data map of 6 types (a table each) with 27 field rows (a row needs no text),",
    );
    expect(r.out).toContain("note: 5 more linked types left off the map (at most 6 boxes): ");
    expect(r.out).toContain(
      "note: Listener, Logger, Handler: no fields, so they are not on the map (a type alias holds fields only when it is an object type `{ ... }`)",
    );
    expect(r.out).not.toContain("Python");

    const applied = await xpl(dir, "apply", "jobrunner", out);
    expect(applied.code, applied.out).toBe(0);
    const lint = await xplJson<{ counts: Record<string, number> }>(dir, "lint", "jobrunner");
    expect(lint.json.counts).toEqual({ "todo-left": expect.any(Number) });
  });

  // the attributes `__init__` sets are fields, so the classes that keep the state are tables
  it("maps a Python repo with the classes whose `__init__` sets their fields: Queue holds Job, Runner holds Queue", async () => {
    const { patch, view, r } = await draft("py-jobrunner");
    expect(types(view)).toEqual([
      "sym:jobrunner/runner.py#Runner",
      "sym:jobrunner/config.py#RunnerConfig",
      "sym:jobrunner/queue.py#Queue",
      "sym:jobrunner/queue.py#Job",
      "sym:jobrunner/worker.py#WorkerPool",
      "sym:jobrunner/worker.py#Worker",
    ]);
    // a table's rows follow it, in the order `__init__` sets them
    const table = (type: string, rows: number) =>
      view.include.slice(view.include.indexOf(type), view.include.indexOf(type) + rows + 1);
    expect(table("sym:jobrunner/queue.py#Queue", 6)).toEqual([
      "sym:jobrunner/queue.py#Queue",
      "sym:jobrunner/queue.py#Queue.dead",
      "sym:jobrunner/queue.py#Queue.acked",
      "sym:jobrunner/queue.py#Queue._ready",
      "sym:jobrunner/queue.py#Queue._inflight",
      "sym:jobrunner/queue.py#Queue._max_pending",
      "sym:jobrunner/queue.py#Queue._next_id",
    ]);
    expect(table("sym:jobrunner/runner.py#Runner", 7)).toEqual([
      "sym:jobrunner/runner.py#Runner",
      "sym:jobrunner/runner.py#Runner.stats",
      "sym:jobrunner/runner.py#Runner._queue",
      "sym:jobrunner/runner.py#Runner._pool",
      "sym:jobrunner/runner.py#Runner._config",
      "sym:jobrunner/runner.py#Runner._logger",
      "sym:jobrunner/runner.py#Runner._running",
      "sym:jobrunner/runner.py#Runner._task",
    ]);
    const steps = patch.tours?.[0]?.steps ?? [];
    expect(steps.map((s) => s.note).join("\n")).toContain("(Runner holds it in `_queue`)");
    expect(r.out).not.toContain("no fields the index knows");
  });

  it("keeps to a Python file given as the scope", async () => {
    const { view } = await draft("py-jobrunner", "file:jobrunner/config.py");
    expect(view.id).toBe("view:config-data");
    expect(view.scope?.root).toBe("file:jobrunner/config.py");
    expect(view.include.every((id) => id.startsWith("sym:jobrunner/config.py#"))).toBe(true);
    // Config holds the four section types in its fields: each field is a row
    expect(types(view)).toEqual([
      "sym:jobrunner/config.py#Config",
      "sym:jobrunner/config.py#RetryConfig",
      "sym:jobrunner/config.py#QueueConfig",
      "sym:jobrunner/config.py#WorkersConfig",
      "sym:jobrunner/config.py#MetricsConfig",
      "sym:jobrunner/config.py#RunnerConfig",
    ]);
    expect(view.include.slice(0, 5)).toEqual([
      "sym:jobrunner/config.py#Config",
      "sym:jobrunner/config.py#Config.queue",
      "sym:jobrunner/config.py#Config.workers",
      "sym:jobrunner/config.py#Config.retry",
      "sym:jobrunner/config.py#Config.metrics",
    ]);
  });

  it("starts at a Go type entry, takes the types two links from it, and says struct and why an interface has no rows", async () => {
    const { view, r, patch } = await draft("go-jobrunner", "sym:internal/queue/queue.go#Queue");
    expect(view.id).toBe("view:queue-data");
    expect(types(view)).toEqual([
      "sym:internal/queue/queue.go#Queue",
      "sym:internal/queue/queue.go#Job",
      "sym:internal/queue/deadletter.go#DeadJob",
      "sym:internal/runner/runner.go#JobQueue",
      "sym:internal/runner/runner.go#Runner",
    ]);
    // an interface has no fields: its box has no rows, and the notes say why, in Go's words
    expect(r.out).toContain(
      "note: JobQueue: no fields the index knows, so its box has no rows (an interface has methods, not fields)",
    );
    expect(r.out).not.toContain("Python");
    // a function type a box holds is named (Runner's `Logf`); those only types off the map hold are not
    expect(r.out).toContain("note: Logf: no fields, so it is not on the map");
    expect(r.out).not.toContain("Handler");
    const summary = (id: string) => patch.nodes?.find((n) => n.id === id)?.summary;
    expect(summary("sym:internal/queue/queue.go#Job")).toMatch(/\(struct, \d+ fields; /);
    expect(summary("sym:internal/runner/runner.go#JobQueue")).toMatch(
      /^TODO: one plain sentence: what it promises \(its methods\) and what for \(interface; .*implemented by `Queue`/,
    );
  });

  // two types of one name are told apart by their package
  it("qualifies a Go type name that another type the draft names shares, in its label and the hints", async () => {
    const { patch } = await draft("go-jobrunner");
    const node = (id: string) => patch.nodes?.find((n) => n.id === id);
    expect(node("sym:internal/runner/runner.go#Config")?.label).toBe("runner.Config");
    expect(node("sym:internal/runner/runner.go#Runner")?.summary).toContain("`runner.Config`");
    expect(node("sym:internal/runner/runner.go#Runner")?.label).toBeUndefined();
  });

  it("gives a second group of types not linked to the first its own boxes, a step, and says so", async () => {
    const dir = makeTempDir("xpl-data-groups-");
    writeFile(
      dir,
      "models.ts",
      [
        "export interface Job {",
        "  id: string;",
        "}",
        "export class Queue {",
        "  ready: Job[] = [];",
        "}",
        "export class Store {",
        "  queue: Queue = new Queue();",
        "}",
        "export interface Retry {",
        "  max: number;",
        "}",
        "export interface Config {",
        "  retry: Retry;",
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
    expect(types(patch.views![0] as GraphView)).toEqual([
      "sym:models.ts#Store",
      "sym:models.ts#Queue",
      "sym:models.ts#Job",
      "sym:models.ts#Config",
      "sym:models.ts#Retry",
    ]);
    const steps = patch.tours![0]!.steps!;
    const config = steps.find((s) => s.focus?.[0] === "sym:models.ts#Config");
    expect(config?.note).toContain(
      "(a separate group: no field or hierarchy links it to the types before it)",
    );
    expect(r.out).not.toContain("left off");
  });

  it("object type aliases are tables with rows, linked by their fields (ky's options types)", async () => {
    const dir = makeTempDir("xpl-data-alias-");
    writeFile(
      dir,
      "options.ts",
      [
        "export type RetryOptions = {",
        "  limit?: number;",
        "};",
        "export type Hooks = {",
        "  beforeRequest?: BeforeRequestHook[];",
        "};",
        "export type BeforeRequestHook = (request: Request) => void;",
        "export type KyOptions = {",
        "  retry?: RetryOptions | number;",
        "  hooks?: Hooks;",
        "};",
        // ky's NormalizedOptions: a field typed as a member of another type does not hold that type
        "export type NormalizedOptions = {",
        "  limit: RetryOptions['limit'];",
        "  next: NonNullable<RetryOptions [ 'limit' ]>;",
        "};",
        "",
      ].join("\n"),
    );
    expect((await xpl(dir, "index", "--precise", "off")).code).toBe(0);
    expect((await xpl(dir, "new", "ky")).code).toBe(0);
    const out = join(makeTempDir("xpl-data-out-"), "data.json");
    const r = await xpl(dir, "draft", "data", "ky", "-o", out);
    expect(r.code, r.err + r.out).toBe(0);
    const patch = JSON.parse(readFileSync(out, "utf8")) as ExplainerPatch;
    expect(types(patch.views![0] as GraphView)).toEqual([
      "sym:options.ts#KyOptions",
      "sym:options.ts#RetryOptions",
      "sym:options.ts#Hooks",
    ]);
    // NormalizedOptions links to nothing: it is not on the map
    expect(r.out).toContain("a data map of 3 types (a table each) with 4 field rows");
    expect(r.out).not.toContain("no fields the index knows");
  });

  it("`type X = Base & { ... }` extends Base, as an interface does: Base gets a table; a short tour is not padded", async () => {
    const dir = makeTempDir("xpl-data-and-");
    writeFile(
      dir,
      "options.ts",
      [
        "export type Base = {",
        "  timeout: number;",
        "};",
        "export type Options = Base & {",
        "  baseUrl: string;",
        "};",
        "",
      ].join("\n"),
    );
    expect((await xpl(dir, "index", "--precise", "off")).code).toBe(0);
    expect((await xpl(dir, "new", "ky")).code).toBe(0);
    const out = join(makeTempDir("xpl-data-out-"), "data.json");
    const r = await xpl(dir, "draft", "data", "ky", "sym:options.ts#Options", "-o", out);
    expect(r.code, r.err + r.out).toBe(0);
    const patch = JSON.parse(readFileSync(out, "utf8")) as ExplainerPatch;
    expect(types(patch.views![0] as GraphView)).toEqual([
      "sym:options.ts#Options",
      "sym:options.ts#Base",
    ]);
    const summary = (id: string) => patch.nodes!.find((n) => n.id === id)!.summary;
    expect(summary("sym:options.ts#Options")).toContain("(type, 1 field; extends `Base`)");
    expect(r.out).toMatch(
      /a tour of [1-4] steps? \(short is right for a small subject: do not pad it\)/,
    );
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
