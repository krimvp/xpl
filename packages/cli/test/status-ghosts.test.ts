/**
 * `xpl status`: where a graph view stops (ghosts and stubs, what a folded ghost stands for, a warning for a crowded
 * view) and the tours of the explainer (steps that point at something that is gone).
 */
import { beforeAll, describe, expect, it } from "vitest";
import {
  cloneDir,
  indexedFixture,
  invoke,
  makeTempDir,
  PATCH_PATH,
  readJson,
  writeFile,
  xpl,
  xplJson,
} from "./helpers.js";

const EXPLAINER = ".explainer/crowd.explainer.json";
const LEAVES = 14;
const pad = (n: number) => String(n).padStart(2, "0");

/**
 * A tiny repo: `src/main.ts#run` calls a function in each of 14 leaf files, `leaf07.ts` seven times (so the
 * ranking has something to rank), and `src/hub.ts` has two methods, `a` calling `b`.
 */
function crowdedRepo(): string {
  const dir = makeTempDir("xpl-cli-crowd-");
  for (let i = 0; i < LEAVES; i++) {
    writeFile(
      dir,
      `src/leaf${pad(i)}.ts`,
      `export function leaf${pad(i)}(): number {\n  return ${i};\n}\n`,
    );
  }
  writeFile(
    dir,
    "src/hub.ts",
    "export class Hub {\n  a(): number {\n    return this.b();\n  }\n  b(): number {\n    return 1;\n  }\n}\n",
  );
  const imports = Array.from(
    { length: LEAVES },
    (_, i) => `import { leaf${pad(i)} } from "./leaf${pad(i)}";`,
  );
  const calls = Array.from({ length: LEAVES }, (_, i) => `  leaf${pad(i)}();`);
  calls.push(...Array.from({ length: 6 }, () => "  leaf07();"));
  writeFile(
    dir,
    "src/main.ts",
    `${imports.join("\n")}\nimport { Hub } from "./hub";\n\nexport function run(): void {\n${calls.join("\n")}\n  new Hub().a();\n}\n`,
  );
  writeFile(dir, "package.json", '{ "name": "crowd", "version": "0.0.0" }\n');
  return dir;
}

let crowd: string;
let demo: string;

async function ok(dir: string, ...argv: string[]) {
  const result = await xpl(dir, ...argv);
  expect(result.code, result.out + result.err).toBe(0);
  return result;
}

/** Puts `fields` on the graph view of the crowded explainer (a hand edit: `apply` does not know them). */
function editView(dir: string, fields: Record<string, unknown>): void {
  const explainer = readJson(dir, EXPLAINER);
  Object.assign(
    explainer.views.find((v: any) => v.id === "view:crowd"),
    fields,
  );
  writeFile(dir, EXPLAINER, JSON.stringify(explainer, null, 2));
}

beforeAll(async () => {
  crowd = crowdedRepo();
  await ok(crowd, "index", "--precise", "off");
  await ok(crowd, "new", "crowd", "--title", "Crowd");
  const patch = {
    views: [
      {
        id: "view:crowd",
        type: "graph",
        title: "Around run",
        include: ["sym:src/main.ts#run", "sym:src/hub.ts#Hub.a"],
      },
    ],
  };
  const applied = await invoke(["apply", "crowd", "-"], {
    cwd: crowd,
    stdin: JSON.stringify(patch),
  });
  expect(applied.code, applied.out).toBe(0);

  // the job runner of the other status tests: two views (one graph, one sequence) and one tour
  demo = cloneDir(await indexedFixture());
  await ok(demo, "new", "demo", "--title", "Job runner");
  await ok(demo, "apply", "demo", PATCH_PATH);
});

describe("xpl status: ghosts and stubs", () => {
  it("says how many ghosts and stubs each graph view draws, and names the most referenced", async () => {
    const { out } = await ok(crowd, "status", "crowd");
    // 14 leaf files and the rest of hub.ts; the default policy keeps 8 and folds the others into one ghost
    expect(out).toContain("view:crowd (graph): Around run");
    const line = out.split("\n").find((l) => l.startsWith("  ghosts:"))!;
    expect(line).toMatch(/^  ghosts: 9 \(\d+ stubs?; stubs: top 8\), most referenced: /);
    // by references, the most referenced first: leaf07 is called 7 times
    expect(line).toContain("most referenced: ghost:file:src/leaf07.ts ×7, ");
    expect(line).toContain("... +4 more (--json lists all, and the stub ids)");
    expect(out).not.toContain("warning: 9 ghosts");
  });

  it("--json lists every ghost id with its count, and every stub id", async () => {
    const { json } = await xplJson<any>(crowd, "status", "crowd");
    const view = json.views.find((v: any) => v.id === "view:crowd");
    expect(view.ghosts).toMatchObject({ mode: "top", max: 8, total: 9, crowded: false });
    expect(view.ghosts.list).toHaveLength(9);
    expect(view.ghosts.list[0]).toEqual({
      id: "ghost:file:src/leaf07.ts",
      kind: "target",
      label: "leaf07.ts",
      count: 7,
      direction: "out",
      targets: [{ id: "file:src/leaf07.ts", count: 7 }],
    });
    // sorted by count, then id; the overflow ghost is in the list too
    const counts = view.ghosts.list.map((g: any) => g.count);
    expect([...counts].sort((a, b) => b - a)).toEqual(counts);
    expect(view.ghosts.list.map((g: any) => g.id)).toContain("ghost:more:out");
    expect(view.ghosts.stubs).toBe(view.ghosts.stubIds.length);
    expect(view.ghosts.stubIds.every((id: string) => id.startsWith("stub:"))).toBe(true);
    expect(view.ghosts.stubIds).toContain("stub:out:sym:src/main.ts#run->ghost:file:src/leaf07.ts");
    // a stub id goes into `hidden` as it is: the same numbers as `deriveGraph` gives
    const overflow = view.ghosts.list.find((g: any) => g.id === "ghost:more:out");
    expect(overflow.label).toBe("+7 more");
  });

  it("--json says what each ghost stands for: its targets, most referenced first, with their counts", async () => {
    const { json } = await xplJson<any>(crowd, "status", "crowd");
    const list = json.views.find((v: any) => v.id === "view:crowd").ghosts.list;
    const ghost = (id: string) => list.find((g: any) => g.id === id);
    // "rest of hub.ts": the outside elements of a file the view shows in part (run constructs Hub, Hub.a calls b)
    expect(ghost("ghost:rest:file:src/hub.ts")).toMatchObject({
      kind: "rest",
      count: 2,
      targets: [
        { id: "sym:src/hub.ts#Hub", count: 1 },
        { id: "sym:src/hub.ts#Hub.b", count: 1 },
      ],
    });
    // "+7 more": every element it folds, not only the first few
    const more = ghost("ghost:more:out");
    expect(more.targets.map((t: any) => t.id)).toEqual(
      ["06", "08", "09", "10", "11", "12", "13"].map((n) => `file:src/leaf${n}.ts`),
    );
    // a ghost that is an element itself stands for just that
    expect(ghost("ghost:file:src/leaf07.ts").targets).toEqual([
      { id: "file:src/leaf07.ts", count: 7 },
    ]);
    for (const g of list) {
      expect(
        g.targets.reduce((n: number, t: any) => n + t.count, 0),
        g.id,
      ).toBe(g.count);
    }
    // a target is what `includeAdd` takes: adding one expands the view, and the ghost no longer stands for it
    const dir = cloneDir(crowd);
    const patch = {
      views: [{ id: "view:crowd", type: "graph", includeAdd: [more.targets[0].id] }],
    };
    const applied = await invoke(["apply", "crowd", "-"], {
      cwd: dir,
      stdin: JSON.stringify(patch),
    });
    expect(applied.code, applied.out).toBe(0);
    const after = (await xplJson<any>(dir, "status", "crowd")).json.views[0].ghosts.list;
    const rest = after.find((g: any) => g.id === "ghost:more:out").targets.map((t: any) => t.id);
    expect(rest).toHaveLength(6);
    expect(rest).not.toContain(more.targets[0].id);
  });

  it("names up to 3 targets of each folded ghost in the text, and none for a ghost that is an element", async () => {
    const { out } = await ok(crowd, "status", "crowd");
    const lines = out.split("\n");
    expect(lines).toContain(
      "    ghost:more:out ×7 → file:src/leaf06.ts ×1, file:src/leaf08.ts ×1, file:src/leaf09.ts ×1, ... +4 more",
    );
    // three or fewer: all of them
    expect(lines).toContain(
      "    ghost:rest:file:src/hub.ts ×2 → sym:src/hub.ts#Hub ×1, sym:src/hub.ts#Hub.b ×1",
    );
    expect(out).not.toContain("ghost:file:src/leaf07.ts ×7 →");
    expect(out.match(/ → /g)).toHaveLength(2);
    // stubs: all folds nothing
    const dir = cloneDir(crowd);
    editView(dir, { stubs: { mode: "all" } });
    expect((await ok(dir, "status", "crowd")).out).not.toContain(" → ");
  });

  it("warns when a view draws more than 12 ghosts, and says how to fix it", async () => {
    const dir = cloneDir(crowd);
    editView(dir, { stubs: { mode: "all" } });
    const { out } = await ok(dir, "status", "crowd");
    const line = out.split("\n").find((l) => l.startsWith("  ghosts:"))!;
    expect(line).toMatch(/^  ghosts: 16 \(\d+ stubs; stubs: all\), most referenced: /);
    expect(out).toContain(
      "warning: 16 ghosts: this view stops in too many places to read (more than 12)",
    );
    expect(out).toContain('Set "stubs": {"mode": "top"}');
    expect(out).toContain('put ghost ids in "hidden"');
    const { json } = await xplJson<any>(dir, "status", "crowd");
    const view = json.views.find((v: any) => v.id === "view:crowd");
    expect(view.ghosts).toMatchObject({ mode: "all", total: 16, crowded: true });
    expect(view.ghosts.list).toHaveLength(16);
    // too many even with a top that is not small
    editView(dir, { stubs: { mode: "top", max: 14 } });
    const big = await ok(dir, "status", "crowd");
    expect(big.out).toContain('Lower "stubs": {"max": 14} to 8 or fewer');
  });

  it("hiding what the status names makes the warning go away", async () => {
    const dir = cloneDir(crowd);
    editView(dir, { stubs: { mode: "all" } });
    const all = (await xplJson<any>(dir, "status", "crowd")).json.views[0].ghosts;
    expect(all).toMatchObject({ total: 16, crowded: true });
    // the ids in `list` are what `hidden` takes: four of them bring the view down to 12
    editView(dir, { hidden: all.list.slice(0, 4).map((g: any) => g.id) });
    const after = (await xplJson<any>(dir, "status", "crowd")).json.views[0].ghosts;
    expect(after).toMatchObject({ total: 12, crowded: false });
    expect((await ok(dir, "status", "crowd")).out).not.toContain("too many places to read");
  });

  it("stubs: none draws no ghosts, and a view that stops nowhere says so", async () => {
    const dir = cloneDir(crowd);
    editView(dir, { stubs: { mode: "none" } });
    const { out } = await ok(dir, "status", "crowd");
    expect(out).toContain("  ghosts: none drawn (stubs: none)");
    const { json } = await xplJson<any>(dir, "status", "crowd");
    expect(json.views.find((v: any) => v.id === "view:crowd").ghosts).toMatchObject({
      mode: "none",
      total: 0,
      stubs: 0,
      list: [],
      stubIds: [],
    });
    // everything of the repo is in the view: nothing leaves it
    editView(dir, { stubs: undefined, include: ["dir:src"] });
    const whole = await ok(dir, "status", "crowd");
    expect(whole.out).toContain("  ghosts: none (nothing leaves the view)");
  });

  it("sequence views carry no ghosts", async () => {
    const { json } = await xplJson<any>(demo, "status", "demo");
    const sequence = json.views.find((v: any) => v.type === "sequence");
    expect(sequence.ghosts).toBeUndefined();
    const graph = json.views.find((v: any) => v.id === "view:overview");
    expect(graph.ghosts.total).toBe(graph.ghosts.list.length);
    const { out } = await ok(demo, "status", "demo");
    expect(out.match(/^  ghosts: /gm)).toHaveLength(1);
  });
});

describe("xpl status --view: what one view draws", () => {
  it("lists a graph view's edges (kind, ends, references, stored or derived) and what its hidden takes out", async () => {
    const dir = cloneDir(crowd);
    const before = (await xplJson<any>(dir, "status", "crowd", "--view", "view:crowd")).json;
    expect(before.view.id).toBe("view:crowd");
    const drawn = before.view.edges.drawn;
    expect(drawn.length).toBe(1);
    expect(drawn[0]).toMatchObject({ kind: "calls", origin: "derived", summary: false, count: 1 });
    expect(before.view.edges.hidden).toEqual([]);

    const first = drawn[0].id;
    const explainer = readJson(dir, EXPLAINER);
    explainer.views.find((v: any) => v.id === "view:crowd").hidden = [first, "edge:gone"];
    writeFile(dir, EXPLAINER, JSON.stringify(explainer, null, 2));
    const after = (await xplJson<any>(dir, "status", "crowd", "--view", "view:crowd")).json;
    expect(after.view.edges.drawn.map((e: any) => e.id)).not.toContain(first);
    expect(after.view.edges.hidden).toEqual([
      { id: first, edge: drawn[0] },
      { id: "edge:gone", is: "unknown" },
    ]);
    const { out } = await ok(dir, "status", "crowd", "--view", "view:crowd");
    expect(out).toContain("view:crowd (graph): Around run");
    expect(out).toMatch(/edges drawn \(\d+: 0 stored, \d+ derived\), most references first:/);
    expect(out).toContain(`hidden (2):\n    ${first}  calls  `);
    expect(out).toContain(
      "edge:gone  (matches nothing this view would draw now: remove it from hidden)",
    );
    // only that view
    expect(out).not.toContain("tours (");
  });

  it("lists a sequence view's messages, and names the views when the id is unknown", async () => {
    const { json } = await xplJson<any>(demo, "status", "demo");
    const sequence = json.views.find((v: any) => v.type === "sequence");
    const { out } = await ok(demo, "status", "demo", "--view", sequence.id);
    expect(out).toContain(`links (${sequence.steps.total}):`);
    const wrong = await xpl(demo, "status", "demo", "--view", "view:nope");
    expect(wrong.code).toBe(1);
    expect(wrong.err).toContain("no view view:nope");
    expect(wrong.err).toContain("view:overview");
  });
});

describe("xpl status: tours", () => {
  const EDITED = ".explainer/demo.explainer.json";

  it("lists each tour with its step count", async () => {
    const { out } = await ok(demo, "status", "demo");
    expect(out).toContain("tours (1):");
    expect(out).toContain("  tour:intro (2 steps): every focus id resolves");
    const { json } = await xplJson<any>(demo, "status", "demo");
    expect(json.tours).toEqual([
      { id: "tour:intro", title: "Intro talk", steps: 2, unresolved: [] },
    ]);
    // no tours, no section
    const bare = await ok(crowd, "status", "crowd");
    expect(bare.out).not.toContain("tours (");
    expect((await xplJson<any>(crowd, "status", "crowd")).json.tours).toEqual([]);
  });

  it("names the steps whose focus no longer resolves, and the ones whose view is gone", async () => {
    const dir = cloneDir(demo);
    const explainer = readJson(dir, EDITED);
    const tour = explainer.tours.find((t: any) => t.id === "tour:intro");
    tour.steps[0].focus = [
      "grp:scheduling",
      "file:src/gone.ts",
      "sym:src/runner.ts#Runner.vanished",
    ];
    tour.steps[1].view = "view:retired";
    tour.steps.push({
      id: "t3",
      view: "view:overview",
      focus: ["concept:retry-policy"],
      note: "fine",
    });
    writeFile(dir, EDITED, JSON.stringify(explainer, null, 2));
    const { out } = await ok(dir, "status", "demo");
    expect(out).toContain(
      "  tour:intro (3 steps): 2 steps point at something that is gone: " +
        "t1 (focus: file:src/gone.ts, sym:src/runner.ts#Runner.vanished), t2 (view view:retired is gone)",
    );
    const { json } = await xplJson<any>(dir, "status", "demo");
    expect(json.tours[0]).toEqual({
      id: "tour:intro",
      title: "Intro talk",
      steps: 3,
      unresolved: [
        { step: "t1", focus: ["file:src/gone.ts", "sym:src/runner.ts#Runner.vanished"] },
        { step: "t2", focus: [], missingView: "view:retired" },
      ],
    });
    // one broken step reads in the singular
    tour.steps[1].view = "view:dispatch";
    writeFile(dir, EDITED, JSON.stringify(explainer, null, 2));
    const one = await ok(dir, "status", "demo");
    expect(one.out).toContain("1 step points at something that is gone: t1 (focus: ");
  });

  it("render-only ids in a step do not resolve either: stubs and ghosts are never stored", async () => {
    const dir = cloneDir(demo);
    const explainer = readJson(dir, EDITED);
    explainer.tours[0].steps[0].focus = ["ghost:file:src/bus.ts"];
    writeFile(dir, EDITED, JSON.stringify(explainer, null, 2));
    const { json } = await xplJson<any>(dir, "status", "demo");
    expect(json.tours[0].unresolved).toEqual([{ step: "t1", focus: ["ghost:file:src/bus.ts"] }]);
  });
});
