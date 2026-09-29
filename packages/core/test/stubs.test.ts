import { describe, expect, it } from "vitest";
import {
  DEFAULT_STUB_MAX,
  deriveGraph,
  drillIn,
  expandStub,
  ExplainerModel,
  isFoldedGhostKey,
  moreGhostKey,
  parseGhostKey,
  parseId,
  resolveStubPolicy,
  restGhostKey,
  type DerivedGraph,
  type Explainer,
  type GraphView,
} from "../src/index.js";
import {
  edge,
  emptyExplainer,
  graphView,
  group,
  makeWorld,
  type RefDecl,
  type World,
} from "./helpers.js";

const pad = (n: number) => String(n).padStart(2, "0");
const FILES = 12;

/**
 * A crowded neighbourhood. `hub.ts` (a class with `run` and ten other methods) is shown in part: only
 * `Hub.run`. It calls its ten siblings once each. `app.ts#main` calls a function in each of twelve files
 * `f00.ts` .. `f11.ts`, `fNN` NN+1 times, and `fn00` calls `Hub.run` back.
 */
function crowded(extra: RefDecl[] = []): World {
  return makeWorld({
    files: [
      { path: "hub.ts", lines: 300 },
      { path: "app.ts", lines: 40 },
      ...Array.from({ length: FILES }, (_, i) => ({ path: `f${pad(i)}.ts`, lines: 10 })),
    ],
    symbols: [
      { id: "hub.ts#Hub", kind: "class", start: 1, end: 290 },
      { id: "hub.ts#Hub.run", start: 5, end: 20 },
      ...Array.from({ length: 10 }, (_, i) => ({
        id: `hub.ts#Hub.m${i}`,
        start: 21 + i * 20,
        end: 40 + i * 20,
      })),
      { id: "app.ts#main", kind: "function" as const, start: 1, end: 30 },
      ...Array.from({ length: FILES }, (_, i) => ({
        id: `f${pad(i)}.ts#fn${pad(i)}`,
        kind: "function" as const,
        start: 1,
        end: 9,
      })),
    ],
    refs: [
      ...Array.from({ length: 10 }, (_, i) => ({
        from: "hub.ts#Hub.run",
        to: `hub.ts#Hub.m${i}`,
        line: 6 + i,
      })),
      ...Array.from({ length: FILES }, (_, i) =>
        Array.from({ length: i + 1 }, (_, k) => ({
          from: "app.ts#main",
          to: `f${pad(i)}.ts#fn${pad(i)}`,
          line: 2 + k,
        })),
      ).flat(),
      { from: "f00.ts#fn00", to: "hub.ts#Hub.run", line: 3 },
      ...extra,
    ],
  });
}

const world = crowded();
const RUN = "sym:hub.ts#Hub.run";
const MAIN = "sym:app.ts#main";

function derive(
  over: Partial<GraphView> = {},
  ex: Partial<Explainer> = {},
  include = [RUN, MAIN],
  w = world,
): DerivedGraph {
  const view = graphView("view:v", include, over);
  return deriveGraph(view, new ExplainerModel(emptyExplainer({ views: [view], ...ex }), w.model));
}
const ids = (xs: { id: string }[]) => xs.map((x) => x.id);

describe("stub policy: defaults and ids", () => {
  it("resolveStubPolicy fills in top / 8 and ignores what is not a mode or a count", () => {
    expect(resolveStubPolicy(undefined)).toEqual({ mode: "top", max: 8 });
    expect(resolveStubPolicy({})).toEqual({ mode: "top", max: DEFAULT_STUB_MAX });
    expect(resolveStubPolicy({ mode: "all" })).toEqual({ mode: "all", max: 8 });
    expect(resolveStubPolicy({ mode: "none", max: 3 })).toEqual({ mode: "none", max: 3 });
    expect(resolveStubPolicy({ max: 0 })).toEqual({ mode: "top", max: 0 });
    expect(resolveStubPolicy({ max: 2.9 })).toEqual({ mode: "top", max: 2 });
    for (const bad of [
      { mode: "some" },
      { mode: 1 },
      { max: -1 },
      { max: NaN },
      { max: "3" },
      5,
      "top",
      null,
      [],
    ]) {
      expect(resolveStubPolicy(bad), JSON.stringify(bad)).toEqual({ mode: "top", max: 8 });
    }
  });

  it("names folded ghosts ghost:rest:file:<path> and ghost:more:in|out, and parses them back", () => {
    expect(restGhostKey("src/a.ts")).toBe("rest:file:src/a.ts");
    expect(moreGhostKey("in")).toBe("more:in");
    expect(moreGhostKey("out")).toBe("more:out");
    expect(parseGhostKey("rest:file:src/a.ts")).toEqual({
      kind: "rest",
      path: "src/a.ts",
      file: "file:src/a.ts",
    });
    expect(parseGhostKey("more:in")).toEqual({ kind: "more", direction: "in" });
    expect(parseGhostKey("more:out")).toEqual({ kind: "more", direction: "out" });
    expect(parseGhostKey("file:src/a.ts")).toEqual({ kind: "target", target: "file:src/a.ts" });
    expect(parseGhostKey("grp:g")).toEqual({ kind: "target", target: "grp:g" });
    expect(parseGhostKey("rest:file:")).toEqual({ kind: "target", target: "rest:file:" });
    expect(isFoldedGhostKey("rest:file:src/a.ts")).toBe(true);
    expect(isFoldedGhostKey("more:out")).toBe(true);
    expect(isFoldedGhostKey("dir:src")).toBe(false);
    // render ids parse as ghost / stub ids whose target / ghost is the key
    expect(parseId("ghost:rest:file:src/a.ts")).toEqual({
      type: "ghost",
      target: "rest:file:src/a.ts",
    });
    expect(parseId("stub:out:sym:hub.ts#Hub.run->ghost:more:out")).toEqual({
      type: "stub",
      direction: "out",
      inside: "sym:hub.ts#Hub.run",
      ghost: "more:out",
    });
  });
});

describe("stub policy: rest of a partly shown file", () => {
  it("folds the outside symbols of a file that is shown in part into one ghost, with the pick-list", () => {
    const g = derive();
    const rest = g.ghosts.find((x) => x.id === "ghost:rest:file:hub.ts")!;
    expect(rest).toMatchObject({
      key: "rest:file:hub.ts",
      kind: "rest",
      label: "rest of hub.ts",
      kinds: ["calls"],
      count: 10,
      direction: "out",
    });
    expect(rest.target).toBeUndefined();
    // every folded symbol, one reference each (ties by label)
    expect(rest.targets).toHaveLength(10);
    expect(rest.targets[0]).toEqual({
      target: "sym:hub.ts#Hub.m0",
      label: "Hub.m0",
      kind: "symbol",
      symbolKind: "method",
      count: 1,
      kinds: ["calls"],
    });
    expect(rest.targets.map((t) => t.target)).toEqual(
      Array.from({ length: 10 }, (_, i) => `sym:hub.ts#Hub.m${i}`),
    );
    const stub = g.stubs.find((s) => s.ghost === "rest:file:hub.ts")!;
    expect(stub).toMatchObject({
      id: `stub:out:${RUN}->ghost:rest:file:hub.ts`,
      direction: "out",
      inside: RUN,
      ghostLabel: "rest of hub.ts",
      kinds: ["calls"],
      count: 10,
    });
    expect(stub.targets).toEqual(rest.targets);
    // ten outside symbols, one ghost
    expect(g.ghosts.filter((x) => x.kind === "rest")).toHaveLength(1);
  });

  it("mode all keeps one ghost per outside element, as before", () => {
    const g = derive({ stubs: { mode: "all" } });
    expect(
      g.ghosts.filter((x) => x.kind === "target" && x.key.startsWith("sym:hub.ts#")),
    ).toHaveLength(10);
    expect(g.ghosts.some((x) => x.kind !== "target")).toBe(false);
    expect(g.ghosts).toHaveLength(10 + FILES);
    const one = g.ghosts.find((x) => x.id === "ghost:sym:hub.ts#Hub.m3")!;
    expect(one).toMatchObject({ target: "sym:hub.ts#Hub.m3", label: "Hub.m3", count: 1 });
    expect(one.targets).toHaveLength(1);
    expect(g.stubs.find((s) => s.ghost === "sym:hub.ts#Hub.m3")).toMatchObject({
      id: `stub:out:${RUN}->ghost:sym:hub.ts#Hub.m3`,
      targets: [{ target: "sym:hub.ts#Hub.m3" }],
    });
  });

  it("a partly shown file with several shown symbols still has one rest ghost, fed by every inside node", () => {
    const w = crowded([{ from: "hub.ts#Hub.m1", to: "hub.ts#Hub.m2", line: 30 }]);
    const g = derive({}, {}, [RUN, "sym:hub.ts#Hub.m1", MAIN], w);
    const rest = g.ghosts.filter((x) => x.kind === "rest");
    expect(rest.map((x) => x.id)).toEqual(["ghost:rest:file:hub.ts"]);
    // run -> m0, m2..m9 (m1 is shown), and m1 -> m2 which is also outside
    expect(
      g.stubs.filter((s) => s.ghost === "rest:file:hub.ts").map((s) => [s.inside, s.count]),
    ).toEqual([
      ["sym:hub.ts#Hub.m1", 1],
      [RUN, 9],
    ]);
    // the edge between the two shown methods is an ordinary edge
    expect(g.edges.map((e) => e.id)).toContain(`edge:calls:${RUN}->sym:hub.ts#Hub.m1`);
  });

  it("does not fold a file that is not shown at all: its ghost is the file, or a directory above it", () => {
    const g = derive();
    expect(g.ghosts.find((x) => x.id === "ghost:file:f05.ts")).toMatchObject({
      kind: "target",
      target: "file:f05.ts",
      label: "f05.ts",
    });
    expect(g.ghosts.some((x) => x.key === "rest:file:f05.ts")).toBe(false);
  });

  it("folds a whole-file outside end (a module import) of a partly shown file into its rest ghost, with the file as a target", () => {
    const w = crowded([{ from: "f03.ts#fn03", to: "hub.ts#", kind: "import", line: 2 }]);
    const g = derive({ edgeKinds: ["calls", "imports"] }, {}, [RUN, "sym:f03.ts#fn03"], w);
    const rest = g.ghosts.find((x) => x.key === "rest:file:hub.ts")!;
    const whole = rest.targets.find((t) => t.target === "file:hub.ts")!;
    expect(whole).toMatchObject({ kind: "file", label: "hub.ts", count: 1, kinds: ["imports"] });
    // the file is the way to add "all of hub.ts as one box": it wraps what is shown and stands for the rest
    const next = expandStub(graphView("view:v", [RUN, "sym:f03.ts#fn03"]), {
      ghost: "file:hub.ts",
    });
    const after = deriveGraph(
      { ...next, edgeKinds: ["calls", "imports"] },
      new ExplainerModel(emptyExplainer({ views: [next] }), w.model),
    );
    expect(after.ghosts.some((x) => x.key === "rest:file:hub.ts")).toBe(false);
    expect(after.nodes.find((n) => n.id === RUN)!.parent).toBe("file:hub.ts");
  });

  it("tells two rest ghosts of files with the same name apart", () => {
    const twin = makeWorld({
      files: [
        { path: "a/index.ts", lines: 30 },
        { path: "b/index.ts", lines: 30 },
        { path: "c/main.ts", lines: 30 },
      ],
      symbols: [
        { id: "a/index.ts#shown", kind: "function", start: 1, end: 5 },
        { id: "a/index.ts#hidden", kind: "function", start: 6, end: 9 },
        { id: "b/index.ts#shown", kind: "function", start: 1, end: 5 },
        { id: "b/index.ts#hidden", kind: "function", start: 6, end: 9 },
        { id: "c/main.ts#main", kind: "function", start: 1, end: 9 },
      ],
      refs: [
        { from: "a/index.ts#shown", to: "a/index.ts#hidden", line: 2 },
        { from: "b/index.ts#shown", to: "b/index.ts#hidden", line: 2 },
        { from: "c/main.ts#main", to: "c/main.ts#main", line: 2 },
      ],
    });
    const g = derive({}, {}, ["sym:a/index.ts#shown", "sym:b/index.ts#shown"], twin);
    expect(g.ghosts.map((x) => x.label)).toEqual(["rest of a/index.ts", "rest of b/index.ts"]);
  });
});

describe("stub policy: the top ghosts, and one more ghost per direction for the rest", () => {
  it("keeps the 8 ghosts with the most references and folds the others into ghost:more:out / ghost:more:in", () => {
    const g = derive();
    // counts: f11 12, f10 11, f09 10, rest of hub.ts 10, f08 9, f07 8, f06 7, f05 6 | f04 5, f03 4, f02 3, f01 2, f00 1+1
    expect(ids(g.ghosts)).toEqual([
      "ghost:file:f05.ts",
      "ghost:file:f06.ts",
      "ghost:file:f07.ts",
      "ghost:file:f08.ts",
      "ghost:file:f09.ts",
      "ghost:file:f10.ts",
      "ghost:file:f11.ts",
      "ghost:more:in",
      "ghost:more:out",
      "ghost:rest:file:hub.ts",
    ]);
    expect(g.ghosts.filter((x) => x.kind === "target")).toHaveLength(7);
  });

  it("the overflow ghost lists every folded target with its count, most referenced first", () => {
    const g = derive();
    const out = g.ghosts.find((x) => x.id === "ghost:more:out")!;
    expect(out).toMatchObject({
      key: "more:out",
      kind: "more",
      label: "+5 more",
      count: 5 + 4 + 3 + 2 + 1,
      kinds: ["calls"],
      direction: "out",
    });
    expect(out.target).toBeUndefined();
    expect(out.targets.map((t) => [t.target, t.count])).toEqual([
      ["file:f04.ts", 5],
      ["file:f03.ts", 4],
      ["file:f02.ts", 3],
      ["file:f01.ts", 2],
      ["file:f00.ts", 1],
    ]);
    // fn00 -> Hub.run is the one reference that enters the view, and f00.ts is folded on that side too
    const inn = g.ghosts.find((x) => x.id === "ghost:more:in")!;
    expect(inn).toMatchObject({ label: "+1 more", count: 1, direction: "in" });
    expect(inn.targets.map((t) => t.target)).toEqual(["file:f00.ts"]);
  });

  it("stubs to the overflow ghost are aggregated per inside node and direction", () => {
    const g = derive();
    expect(g.stubs.filter((s) => s.ghost.startsWith("more:")).map((s) => s.id)).toEqual([
      `stub:in:${RUN}->ghost:more:in`,
      `stub:out:${MAIN}->ghost:more:out`,
    ]);
    const out = g.stubs.find((s) => s.ghost === "more:out")!;
    expect(out).toMatchObject({ direction: "out", inside: MAIN, ghostLabel: "+5 more", count: 15 });
    expect(out.targets).toHaveLength(5);
    // every stub leads to a ghost that is drawn
    const drawn = new Set(g.ghosts.map((x) => x.key));
    expect(g.stubs.every((s) => drawn.has(s.ghost))).toBe(true);
  });

  it("has no overflow ghost when everything fits", () => {
    const g = derive({ stubs: { mode: "top", max: FILES + 1 } });
    expect(g.ghosts.some((x) => x.kind === "more")).toBe(false);
    // f00 is one ghost with both a stub that leaves the view and one that enters it
    const f00 = g.ghosts.find((x) => x.key === "file:f00.ts")!;
    expect(f00).toMatchObject({ direction: "both", count: 2 });
    expect(g.ghosts).toHaveLength(FILES + 1);
  });

  it("max is configurable, 0 folds everything, and a bad value means the default", () => {
    const three = derive({ stubs: { max: 3 } });
    expect(ids(three.ghosts)).toEqual([
      "ghost:file:f09.ts",
      "ghost:file:f10.ts",
      "ghost:file:f11.ts",
      "ghost:more:in",
      "ghost:more:out",
    ]);
    // the rest of hub.ts (10 references) was folded, with the ten symbols it stands for
    const out = three.ghosts.find((x) => x.key === "more:out")!;
    expect(out.label).toBe(`+${10 + 9} more`);
    expect(out.targets.filter((t) => t.target.startsWith("sym:hub.ts#"))).toHaveLength(10);
    const none = derive({ stubs: { max: 0 } });
    expect(ids(none.ghosts)).toEqual(["ghost:more:in", "ghost:more:out"]);
    expect(none.ghosts.find((x) => x.key === "more:out")!.targets).toHaveLength(FILES + 10);
    expect(ids(derive({ stubs: { max: -2 } }).ghosts)).toEqual(ids(derive().ghosts));
    expect(ids(derive({ stubs: { max: "many" as never } }).ghosts)).toEqual(ids(derive().ghosts));
  });

  it("breaks ties by key and does not depend on the order of the references", () => {
    // f09 and the rest of hub.ts both count 10: the key decides (file:f09.ts before rest:file:hub.ts)
    const keys = (max: number) =>
      derive({ stubs: { max } })
        .ghosts.filter((x) => x.kind !== "more")
        .map((x) => x.key);
    expect(keys(3)).toEqual(["file:f09.ts", "file:f10.ts", "file:f11.ts"]);
    expect(keys(4)).toEqual(["file:f09.ts", "file:f10.ts", "file:f11.ts", "rest:file:hub.ts"]);
    expect(keys(2)).toEqual(["file:f10.ts", "file:f11.ts"]);
    const reversed = makeWorld({
      files: world.index.files.map((f) => ({ path: f.path, text: world.texts[f.path]! })),
      symbols: world.index.symbols.map((s) => ({
        id: s.id,
        kind: s.kind,
        start: s.range.startLine,
        end: s.range.endLine,
      })),
      refs: [...world.index.refs].reverse().map((r) => ({
        from: r.from,
        to: r.to,
        kind: r.kind,
        line: r.site.startLine,
      })),
    });
    expect(derive({}, {}, [MAIN, RUN], reversed)).toEqual(derive());
  });

  it("mode all draws every ghost, mode none no stubs and no ghosts (edges are still drawn)", () => {
    const all = derive({ stubs: { mode: "all" } });
    expect(all.ghosts.some((x) => x.kind === "more")).toBe(false);
    expect(all.ghosts).toHaveLength(10 + FILES);
    const none = derive({ stubs: { mode: "none" } });
    expect(none.stubs).toEqual([]);
    expect(none.ghosts).toEqual([]);
    expect(none.nodes).toHaveLength(2);
    const both = derive({ stubs: { mode: "none" } }, {}, [RUN, MAIN, "file:f11.ts"]);
    expect(both.edges.map((e) => e.id)).toContain(`edge:calls:${MAIN}->file:f11.ts`);
  });

  it("an unknown mode or a malformed field falls back to the default", () => {
    expect(ids(derive({ stubs: { mode: "loud" as never } }).ghosts)).toEqual(ids(derive().ghosts));
    expect(ids(derive({ stubs: 7 as never }).ghosts)).toEqual(ids(derive().ghosts));
  });

  it("stored edges leave the view through the same ghosts, and count towards the ranking", () => {
    const stored = edge("edge:wires", MAIN, "file:f00.ts", [], { kind: "emits" });
    const g = derive({ stubs: { max: 100 } }, { edges: [stored] });
    const f00 = g.ghosts.find((x) => x.key === "file:f00.ts")!;
    // fn00 -> Hub.run enters the view; main -> fn00 and the stored edge leave it
    expect(f00).toMatchObject({ count: 1 + 1 + 1, kinds: ["calls", "emits"], direction: "both" });
    // folded into the overflow ghosts, its references split by direction
    const folded = derive({ stubs: { max: 2 } }, { edges: [stored] });
    expect(
      folded.ghosts
        .find((x) => x.key === "more:out")!
        .targets.find((t) => t.target === "file:f00.ts"),
    ).toMatchObject({
      count: 2,
      kinds: ["calls", "emits"],
    });
    expect(
      folded.ghosts
        .find((x) => x.key === "more:in")!
        .targets.find((t) => t.target === "file:f00.ts"),
    ).toMatchObject({
      count: 1,
      kinds: ["calls"],
    });
  });
});

describe("stub policy: hidden ghosts and stubs", () => {
  it("hidden accepts the ids of folded ghosts and of their stubs", () => {
    const withoutRest = derive({ hidden: ["ghost:rest:file:hub.ts"] });
    expect(withoutRest.ghosts.some((x) => x.key === "rest:file:hub.ts")).toBe(false);
    expect(withoutRest.stubs.some((s) => s.ghost === "rest:file:hub.ts")).toBe(false);
    // a hidden ghost frees its place: f04 now makes the top 8
    expect(withoutRest.ghosts.some((x) => x.id === "ghost:file:f04.ts")).toBe(true);
    expect(
      withoutRest.ghosts.find((x) => x.key === "more:out")!.targets.map((t) => t.target),
    ).toEqual(["file:f03.ts", "file:f02.ts", "file:f01.ts", "file:f00.ts"]);

    const noOverflow = derive({ hidden: ["ghost:more:out", "ghost:more:in"] });
    expect(noOverflow.ghosts.some((x) => x.kind === "more")).toBe(false);
    expect(noOverflow.stubs.some((s) => s.ghost.startsWith("more:"))).toBe(false);
    expect(noOverflow.ghosts).toHaveLength(8);

    const oneStub = derive({ hidden: [`stub:out:${MAIN}->ghost:more:out`] });
    expect(oneStub.stubs.some((s) => s.ghost === "more:out")).toBe(false);
    expect(oneStub.ghosts.some((x) => x.key === "more:out")).toBe(false);
    expect(oneStub.ghosts.some((x) => x.key === "more:in")).toBe(true);
  });

  it("hiding the stub of a ghost hides its ghost when it was the only stub", () => {
    const g = derive({ hidden: [`stub:out:${MAIN}->ghost:file:f11.ts`] });
    expect(g.ghosts.some((x) => x.key === "file:f11.ts")).toBe(false);
    expect(g.stubs.some((s) => s.ghost === "file:f11.ts")).toBe(false);
    const hiddenRest = derive({ hidden: [`stub:out:${RUN}->ghost:rest:file:hub.ts`] });
    expect(hiddenRest.ghosts.some((x) => x.key === "rest:file:hub.ts")).toBe(false);
  });

  it("hidden symbol targets leave the rest ghost, whichever way they are named", () => {
    for (const hidden of [
      ["sym:hub.ts#Hub.m3"],
      ["ghost:sym:hub.ts#Hub.m3"], // what earlier views hid, when every symbol had its own ghost
      [`stub:out:${RUN}->ghost:sym:hub.ts#Hub.m3`],
    ]) {
      const rest = derive({ hidden }).ghosts.find((x) => x.key === "rest:file:hub.ts")!;
      expect(rest.count, hidden[0]).toBe(9);
      expect(rest.targets.map((t) => t.target)).not.toContain("sym:hub.ts#Hub.m3");
    }
  });

  it("hiding the file hides its rest ghost, hiding an inside node its stubs", () => {
    expect(
      derive({ hidden: ["file:hub.ts"] }).ghosts.some((x) => x.key === "rest:file:hub.ts"),
    ).toBe(false);
    const g = derive({ hidden: [RUN] });
    expect(g.stubs.some((s) => s.inside === RUN)).toBe(false);
    expect(g.ghosts.some((x) => x.key === "rest:file:hub.ts")).toBe(false);
  });

  it("hidden ids that match nothing change nothing", () => {
    expect(
      derive({ hidden: ["ghost:rest:file:nope.ts", "ghost:more:sideways", "stub:in:x->ghost:y"] }),
    ).toEqual(derive());
  });
});

describe("stub policy: expanding", () => {
  it("expandStub adds a plain ghost's element and does nothing for a folded ghost", () => {
    const view = graphView("view:v", [RUN, MAIN]);
    const g = derive();
    const plain = g.stubs.find((s) => s.ghost === "file:f11.ts")!;
    expect(expandStub(view, plain).include).toEqual([RUN, MAIN, "file:f11.ts"]);
    for (const key of ["rest:file:hub.ts", "more:out", "more:in"]) {
      const folded = g.stubs.find((s) => s.ghost === key)!;
      expect(expandStub(view, folded), key).toBe(view);
      expect(expandStub(view, { ghost: key }), key).toBe(view);
    }
  });

  it("adding one target of a folded ghost expands the view by that element, and the ghost re-folds", () => {
    const view = graphView("view:v", [RUN, MAIN]);
    const g = derive();
    const rest = g.ghosts.find((x) => x.key === "rest:file:hub.ts")!;
    const pick = rest.targets[3]!;
    const next = expandStub(view, { ghost: pick.target });
    expect(next.include).toEqual([RUN, MAIN, pick.target]);
    const after = deriveGraph(
      next,
      new ExplainerModel(emptyExplainer({ views: [next] }), world.model),
    );
    const restAfter = after.ghosts.find((x) => x.key === "rest:file:hub.ts")!;
    expect(restAfter.count).toBe(9);
    expect(restAfter.targets.map((t) => t.target)).not.toContain(pick.target);
    // the picked symbol is a box now, and Hub.run's calls to it an ordinary edge
    expect(after.edges.map((e) => e.id)).toContain(`edge:calls:${RUN}->${pick.target}`);
    // an overflow target works the same way
    const out = g.ghosts.find((x) => x.key === "more:out")!;
    const more = expandStub(view, { ghost: out.targets[0]!.target });
    expect(more.include).toContain("file:f04.ts");
  });

  it("drilling into the file that a rest ghost stands for makes it a container of what is shown", () => {
    const view = drillIn(
      graphView("view:v", [RUN, MAIN]),
      "file:hub.ts",
      new ExplainerModel(emptyExplainer(), world.model),
    );
    const g = deriveGraph(view, new ExplainerModel(emptyExplainer({ views: [view] }), world.model));
    expect(g.ghosts.some((x) => x.key === "rest:file:hub.ts")).toBe(false);
    expect(g.nodes.find((n) => n.id === "file:hub.ts")).toMatchObject({ container: true });
  });
});

describe("stub policy: an end that is one's own container", () => {
  it("drops a stub whose outside end holds the inside node", () => {
    // a stored edge from a shown symbol to its own file, and one to its own directory
    const own = makeWorld({
      files: [
        { path: "pkg/a.ts", lines: 20 },
        { path: "pkg/b.ts", lines: 20 },
      ],
      symbols: [
        { id: "pkg/a.ts#f", kind: "function", start: 1, end: 5 },
        { id: "pkg/b.ts#g", kind: "function", start: 1, end: 5 },
      ],
    });
    const stored = [
      edge("edge:own-file", "sym:pkg/a.ts#f", "file:pkg/a.ts"),
      edge("edge:own-dir", "sym:pkg/a.ts#f", "dir:pkg"),
      edge("edge:sibling", "sym:pkg/a.ts#f", "file:pkg/b.ts"),
    ];
    const g = derive({ stubs: { mode: "all" } }, { edges: stored }, ["sym:pkg/a.ts#f"], own);
    expect(g.stubs.map((s) => s.ghost)).toEqual(["file:pkg/b.ts"]);
    expect(
      derive({}, { edges: stored }, ["sym:pkg/a.ts#f"], own).stubs.map((s) => s.ghost),
    ).toEqual(["file:pkg/b.ts"]);
  });

  it("an included group whose member is the outside end's file is not a stub either", () => {
    const own = makeWorld({
      files: [{ path: "pkg/a.ts", lines: 20 }],
      symbols: [{ id: "pkg/a.ts#f", kind: "function", start: 1, end: 5 }],
    });
    const g = derive(
      {},
      {
        nodes: [group("grp:g", ["file:pkg/a.ts"])],
        edges: [edge("edge:x", "file:pkg/a.ts", "grp:g")],
      },
      ["file:pkg/a.ts"],
      own,
    );
    expect(g.stubs).toEqual([]);
    expect(g.edges).toEqual([]);
  });
});

describe("stored edges that end on a group", () => {
  // the group holds two files; the others are outside it
  const members = ["file:src/runner.ts", "file:src/queue.ts"];
  const stored = edge("edge:x", "sym:src/worker.ts#Worker.run", "grp:app-core");
  const nodes = [group("grp:app-core", members)];
  const w = crowdedJobrunner();

  function crowdedJobrunner(): World {
    return makeWorld({
      files: [
        { path: "src/runner.ts", lines: 50 },
        { path: "src/queue.ts", lines: 50 },
        { path: "src/worker.ts", lines: 50 },
        { path: "src/other.ts", lines: 50 },
      ],
      symbols: [
        { id: "src/runner.ts#Runner", kind: "class", start: 1, end: 40 },
        { id: "src/runner.ts#Runner.go", start: 5, end: 20 },
        { id: "src/queue.ts#Queue", kind: "class", start: 1, end: 40 },
        { id: "src/worker.ts#Worker", kind: "class", start: 1, end: 40 },
        { id: "src/worker.ts#Worker.run", start: 5, end: 20 },
        { id: "src/other.ts#Other", kind: "class", start: 1, end: 40 },
      ],
    });
  }

  it("is drawn from the box that shows its start to the group box when only the group is shown", () => {
    const g = derive({}, { nodes, edges: [stored] }, ["grp:app-core", "file:src/worker.ts"], w);
    expect(g.edges).toMatchObject([
      {
        id: "edge:x",
        from: "file:src/worker.ts", // Worker.run lifts to the file that is shown
        to: "grp:app-core",
        stored: true,
        resolution: "llm",
      },
    ]);
    expect(g.stubs).toEqual([]);
    // the same when the start is a symbol that is shown itself
    const bySymbol = derive(
      {},
      { nodes, edges: [stored] },
      ["grp:app-core", "sym:src/worker.ts#Worker.run"],
      w,
    );
    expect(bySymbol.edges).toMatchObject([
      { id: "edge:x", from: "sym:src/worker.ts#Worker.run", to: "grp:app-core" },
    ]);
  });

  it("lands on the group box, not on a member, when the group is open around its members", () => {
    const g = derive(
      {},
      { nodes, edges: [stored] },
      ["grp:app-core", ...members, "file:src/worker.ts"],
      w,
    );
    expect(g.nodes.find((n) => n.id === "file:src/runner.ts")).toMatchObject({
      parent: "grp:app-core",
    });
    const drawn = g.edges.find((e) => e.id === "edge:x")!;
    expect(drawn).toMatchObject({ from: "file:src/worker.ts", to: "grp:app-core" });
  });

  it("starts at a member and ends on the group: no arrow when the group is a box, none to its own container when open", () => {
    const fromMember = edge("edge:y", "file:src/runner.ts", "grp:app-core");
    const closed = derive({}, { nodes, edges: [fromMember] }, ["grp:app-core"], w);
    expect(closed.edges).toEqual([]);
    const open = derive({}, { nodes, edges: [fromMember] }, ["grp:app-core", ...members], w);
    expect(open.edges).toEqual([]);
    expect(open.stubs).toEqual([]);
  });

  it("an edge to a group that is not shown leaves the view through a ghost for the group", () => {
    const g = derive(
      {},
      { nodes, edges: [stored] },
      ["file:src/worker.ts", "file:src/other.ts"],
      w,
    );
    expect(g.stubs).toMatchObject([
      {
        id: "stub:out:file:src/worker.ts->ghost:grp:app-core",
        ghost: "grp:app-core",
        ghostLabel: "app-core",
        kinds: ["emits"],
      },
    ]);
    expect(g.ghosts).toMatchObject([
      { id: "ghost:grp:app-core", kind: "target", target: "grp:app-core", label: "app-core" },
    ]);
    // adding the group turns the stub into the edge
    const next = expandStub(graphView("view:v", ["file:src/worker.ts"]), { ghost: "grp:app-core" });
    const after = derive({}, { nodes, edges: [stored] }, next.include, w);
    expect(after.edges.map((e) => [e.id, e.from, e.to])).toEqual([
      ["edge:x", "file:src/worker.ts", "grp:app-core"],
    ]);
  });

  it("is drawn from a group too: nested groups lift to the box that is shown", () => {
    const outer = group("grp:outer", ["grp:app-core", "file:src/other.ts"]);
    const both = [...nodes, outer];
    const fromGroup = edge("edge:z", "grp:app-core", "file:src/worker.ts");
    const g = derive(
      {},
      { nodes: both, edges: [fromGroup] },
      ["grp:outer", "file:src/worker.ts"],
      w,
    );
    expect(g.edges.map((e) => [e.id, e.from, e.to])).toEqual([
      ["edge:z", "grp:outer", "file:src/worker.ts"],
    ]);
  });
});

describe("edges to a box's own container", () => {
  const w = crowded();
  const include = ["file:hub.ts", "sym:hub.ts#Hub", RUN, MAIN];

  it("draws none from a shown child to the box it is drawn in", () => {
    // Hub.run calls ten methods that are not shown: they lift to Hub, the box Hub.run is drawn in
    const g = derive({}, {}, include, w);
    expect(g.nodes.find((n) => n.id === RUN)).toMatchObject({ parent: "sym:hub.ts#Hub" });
    expect(g.edges.filter((e) => e.from === RUN || e.to === RUN)).toEqual([]);
    for (const edgeOf of g.edges) {
      const parent = new Map(g.nodes.map((n) => [n.id, n.parent]));
      for (let cur = parent.get(edgeOf.from); cur; cur = parent.get(cur)) {
        expect(cur, edgeOf.id).not.toBe(edgeOf.to);
      }
    }
  });

  it("keeps the arrows between siblings, and between boxes in different containers", () => {
    const withM1 = crowded([{ from: "hub.ts#Hub.m1", to: "hub.ts#Hub.run", line: 25 }]);
    const g = derive({}, {}, [...include, "sym:hub.ts#Hub.m1"], withM1);
    expect(g.edges.map((e) => e.id)).toContain(`edge:calls:sym:hub.ts#Hub.m1->${RUN}`);
    // app.ts#main is drawn at the top: its call into Hub-level code crosses containers
    const across = crowded([{ from: "app.ts#main", to: "hub.ts#Hub.run", line: 9 }]);
    expect(derive({}, {}, include, across).edges.map((e) => e.id)).toContain(
      `edge:calls:${MAIN}->${RUN}`,
    );
  });

  it("applies to stored edges as well: none from a container to its child", () => {
    const stored = edge("edge:own", "file:hub.ts", RUN);
    const g = derive({}, { edges: [stored] }, include, w);
    expect(g.edges.map((e) => e.id)).not.toContain("edge:own");
    expect(g.stubs.filter((s) => s.inside === "file:hub.ts")).toEqual([]);
  });

  it("has no stub for the same-file siblings of a shown container either: they are represented by it", () => {
    const g = derive({}, {}, include, w);
    expect(g.stubs.filter((s) => s.ghost.startsWith("rest:file:hub.ts"))).toEqual([]);
  });
});
