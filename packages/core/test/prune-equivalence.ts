/**
 * The check behind `pruneIndex`: everything the viewer derives from the index for an explainer must be the same
 * with the full index and with the pruned one. Shared by core's `prune.test.ts` and the CLI's
 * `bundle-prune.test.ts` (which prunes real fixtures and the index an `xpl bundle` embeds).
 *
 * Compared, for every graph view, in every variant of it (each edge kind alone, all of them, and each stub
 * mode, which is what the viewer's toggles switch between): `deriveGraph` (nodes, edges with their anchors,
 * stubs, ghosts), the children a node opens into (`drillIn`, `collapse`), `codeFocus` of every element the
 * explainer or a view holds, with the view's edge map and without, and the `buildReverseIndex` lookup at the
 * ends of every range those give. Where the code is embedded (`embedded`), also what adding a ghost to the view
 * and opening it makes of it.
 */
import { expect } from "vitest";
import {
  buildReverseIndex,
  codeFocus,
  collapse,
  collectAnchors,
  DERIVED_EDGE_KINDS,
  deriveGraph,
  derivedEdgeAnchors,
  derivedEdgeMap,
  drillIn,
  elementIdForSymbolId,
  expandStub,
  ExplainerModel,
  IndexModel,
  parseId,
  REF_TO_EDGE_KIND,
  repr,
  viewCandidates,
  type DerivedGraph,
  type Edge,
  type ElementId,
  type Explainer,
  type FocusOptions,
  type GraphView,
  type Range,
  type Stub,
  type StubPolicy,
  type SymbolIndex,
} from "@xpl/core";

export interface EquivalenceStats {
  /** `deriveGraph` results compared (every variant of every graph view, and every edit). */
  graphs: number;
  /** What those graphs hold, added up: boxes, edges, stubs, ghosts. */
  nodes: number;
  edges: number;
  stubs: number;
  ghosts: number;
  /** `codeFocus` results compared, and the ranges they held. */
  focus: number;
  ranges: number;
  /** Stubs whose code (what a click on the dashed edge shows) was compared. */
  stubCode: number;
  /** Reverse-index lookups compared. */
  lookups: number;
  /** Drill-ins, collapses and ghost expansions compared. */
  edits: number;
}

export interface EquivalenceOptions {
  /** Files whose code is embedded: adding a ghost of theirs to a view is compared too. */
  embedded?: Iterable<string>;
}

/** Edge kinds of the viewer's toggles, minus `reads`, which the pruning keeps only where a view draws it. */
const EXPANSION_KINDS: Edge["kind"][] = DERIVED_EDGE_KINDS.filter((kind) => kind !== "reads");

const STUB_POLICIES: (StubPolicy | undefined)[] = [
  undefined,
  { mode: "all" },
  { mode: "none" },
  { mode: "top", max: 2 },
];

/** The view as stored, then with each edge kind alone and all of them, each with every stub policy. */
function variants(view: GraphView): { label: string; view: GraphView }[] {
  const kinds: (Edge["kind"][] | undefined)[] = [
    undefined,
    ...DERIVED_EDGE_KINDS.map((kind) => [kind]),
    [...DERIVED_EDGE_KINDS],
  ];
  const out: { label: string; view: GraphView }[] = [];
  for (const edgeKinds of kinds) {
    for (const stubs of STUB_POLICIES) {
      const copy: GraphView = { ...view };
      if (edgeKinds) copy.edgeKinds = edgeKinds;
      if (stubs) copy.stubs = stubs;
      out.push({
        label: `${view.id} [kinds ${edgeKinds?.join("+") ?? "as stored"}, stubs ${stubs ? JSON.stringify(stubs) : "as stored"}]`,
        view: edgeKinds || stubs ? copy : view,
      });
    }
  }
  return out;
}

/** Every element id an explainer names or a view draws. */
function elementIds(explainer: Explainer, graphs: readonly DerivedGraph[]): string[] {
  const ids = new Set<string>();
  for (const node of explainer.nodes ?? []) ids.add(node.id);
  for (const edge of explainer.edges ?? []) ids.add(edge.id);
  for (const concept of explainer.concepts ?? []) {
    ids.add(concept.id);
    for (const related of concept.related ?? []) ids.add(related);
  }
  for (const view of explainer.views ?? []) {
    if (view.type === "graph") for (const id of view.include) ids.add(id);
    else {
      for (const id of view.participants) ids.add(id);
      for (const step of view.steps) ids.add(step.id);
    }
  }
  for (const tour of explainer.tours ?? []) {
    for (const step of tour.steps) for (const id of step.focus) ids.add(id);
  }
  for (const graph of graphs) {
    for (const node of graph.nodes) ids.add(node.id);
    for (const edge of graph.edges) ids.add(edge.id);
  }
  return [...ids].sort();
}

/** A place in the code: what a stub shows. */
interface CodePiece {
  file: string;
  range: Range | undefined;
  role: string;
}

/** Stubs of a variant whose code is compared: enough to cover every direction and kind, and quick. */
const MAX_STUB_CODE = 6;

/**
 * The code behind a stub as the viewer works it out when the dashed edge is selected (`stubFocus` in the viewer's
 * derive.ts, which this follows): the sites of the references that cross the edge of the view there, with what they
 * lead to, and the anchors of the stored edges that leave the view there. It reads every reference of the index
 * that the stub's kinds allow, and does not care about `excludeFiles` or `hidden`.
 */
function stubCode(stub: Stub, view: GraphView, model: ExplainerModel): CodePiece[] {
  const include = new Set(view.include.filter((id) => model.hasNode(id)));
  const kinds = new Set<string>(stub.kinds);
  const targets = stub.targets.map((target) => target.target);
  const memo = new Map<string, string | undefined>();
  const reprOf = (id: ElementId): string | undefined => {
    if (!memo.has(id)) memo.set(id, repr(id, include, model));
    return memo.get(id);
  };
  const crosses = (from: ElementId, to: ElementId): boolean => {
    const inside = stub.direction === "out" ? from : to;
    const outside = stub.direction === "out" ? to : from;
    return (
      reprOf(inside) === stub.inside &&
      reprOf(outside) === undefined &&
      targets.some((target) => model.subtreeContains(target, outside))
    );
  };
  const refs = model.index.refs.filter(
    (ref) =>
      kinds.has(REF_TO_EDGE_KIND[ref.kind]) &&
      crosses(elementIdForSymbolId(ref.from), elementIdForSymbolId(ref.to)),
  );
  const pieces: CodePiece[] = derivedEdgeAnchors(refs, model.index).map((anchor) => ({
    file: anchor.file,
    range: anchor.resolved?.range,
    role: anchor.role,
  }));
  for (const edge of model.storedEdges) {
    if (kinds.has(edge.kind) && crosses(edge.from, edge.to)) {
      for (const focus of codeFocus([edge.id], model)) {
        pieces.push({ file: focus.file, range: focus.range, role: focus.role });
      }
    }
  }
  return pieces;
}

/** True when the code of this element is embedded: a file, a symbol's file, every file under a directory. */
function embeddedTarget(
  id: ElementId,
  model: ExplainerModel,
  embedded: ReadonlySet<string>,
): boolean {
  const parsed = parseId(id);
  switch (parsed.type) {
    case "file":
      return embedded.has(parsed.path);
    case "symbol":
      return embedded.has(parsed.file);
    case "dir": {
      const files = model.index.filesUnder(parsed.path);
      return files.length > 0 && files.every((file) => embedded.has(file));
    }
    default:
      return false;
  }
}

export function expectSameViewer(
  full: SymbolIndex,
  pruned: SymbolIndex,
  explainer: Explainer,
  options: EquivalenceOptions = {},
): EquivalenceStats {
  const a = new ExplainerModel(explainer, new IndexModel(full));
  const b = new ExplainerModel(explainer, new IndexModel(pruned));
  const embedded = new Set(options.embedded ?? []);
  const stats: EquivalenceStats = {
    graphs: 0,
    nodes: 0,
    edges: 0,
    stubs: 0,
    ghosts: 0,
    focus: 0,
    ranges: 0,
    stubCode: 0,
    lookups: 0,
    edits: 0,
  };

  // The tree the viewer lists and labels files from.
  expect(b.index.files).toEqual(a.index.files);
  expect(b.index.directories).toEqual(a.index.directories);

  /** `deriveGraph` of a view with both indexes; returns the full index's graph. */
  const same = (label: string, view: GraphView, kinds?: Edge["kind"][]): DerivedGraph => {
    const opts = kinds ? { edgeKinds: kinds } : {};
    const expected = deriveGraph(view, a, opts);
    expect(deriveGraph(view, b, opts), label).toEqual(expected);
    stats.graphs++;
    stats.nodes += expected.nodes.length;
    stats.edges += expected.edges.length;
    stats.stubs += expected.stubs.length;
    stats.ghosts += expected.ghosts.length;
    return expected;
  };

  // The graph views, in every variant.
  const graphViews = a.views.filter((view): view is GraphView => view.type === "graph");
  const stored = new Map<string, DerivedGraph>();
  for (const view of graphViews) {
    for (const variant of variants(view)) {
      const graph = same(variant.label, variant.view);
      if (variant.view === view) stored.set(view.id, graph);
      for (const stub of graph.stubs.slice(0, MAX_STUB_CODE)) {
        expect(stubCode(stub, variant.view, b), `code of ${stub.id} in ${variant.label}`).toEqual(
          stubCode(stub, variant.view, a),
        );
        stats.stubCode++;
      }
    }
  }

  // Editing the views: what a node opens into, and what is left when it is collapsed.
  for (const view of graphViews) {
    const graph = stored.get(view.id)!;
    for (const node of graph.nodes) {
      const opened = drillIn(view, node.id, a);
      expect(drillIn(view, node.id, b), `${view.id}: what ${node.id} opens into`).toEqual(opened);
      same(`${view.id}: open ${node.id}`, opened);
      same(`${view.id}: collapse ${node.id}`, collapse(view, node.id, a));
      stats.edits += 2;
    }
    // Adding a ghost whose code is embedded, and opening it.
    for (const ghost of graph.ghosts) {
      for (const { target } of ghost.targets) {
        if (!embeddedTarget(target, a, embedded)) continue;
        const expanded = expandStub(view, { ghost: target });
        if (expanded === view) continue;
        same(`${view.id}: add ${target}`, expanded, EXPANSION_KINDS);
        same(`${view.id}: add and open ${target}`, drillIn(expanded, target, a), EXPANSION_KINDS);
        stats.edits += 2;
      }
    }
  }

  // The code of every element, with the edge map of each graph view and without.
  const ids = elementIds(explainer, [...stored.values()]);
  const focusOptions: { label: string; a: FocusOptions; b: FocusOptions }[] = [
    { label: "no edge map", a: {}, b: {} },
  ];
  for (const view of graphViews) {
    focusOptions.push({
      label: `edge map of ${view.id}`,
      a: { derivedEdges: derivedEdgeMap(stored.get(view.id)!) },
      b: { derivedEdges: derivedEdgeMap(deriveGraph(view, b)) },
    });
  }
  for (const options of focusOptions) {
    for (const id of ids) {
      const expected = codeFocus([id], a, options.a);
      expect(codeFocus([id], b, options.b), `code of ${id} (${options.label})`).toEqual(expected);
      stats.focus++;
      stats.ranges += expected.length;
    }
    expect(codeFocus(ids, b, options.b), `code of everything (${options.label})`).toEqual(
      codeFocus(ids, a, options.a),
    );
  }

  // The caret: which element's code contains a line, in every view, at the ends of every range in play.
  const points = new Map<string, { file: string; line: number }>();
  const point = (file: string, line: number) => points.set(`${file}\0${line}`, { file, line });
  for (const site of collectAnchors(explainer)) {
    const range = site.anchor.resolved?.range;
    if (range) {
      point(site.anchor.file, range.startLine);
      point(site.anchor.file, range.endLine);
    }
  }
  for (const range of codeFocus(ids, a, {})) {
    point(range.file, range.range.startLine);
    point(range.file, range.range.endLine);
    point(range.file, Math.floor((range.range.startLine + range.range.endLine) / 2));
  }
  for (const view of a.views) {
    const graphA = view.type === "graph" ? stored.get(view.id) : undefined;
    const graphB = view.type === "graph" ? deriveGraph(view, b) : undefined;
    const reverseA = buildReverseIndex(
      viewCandidates(view, a, graphA),
      a,
      graphA ? { derivedEdges: derivedEdgeMap(graphA) } : {},
    );
    const reverseB = buildReverseIndex(
      viewCandidates(view, b, graphB),
      b,
      graphB ? { derivedEdges: derivedEdgeMap(graphB) } : {},
    );
    for (const { file, line } of points.values()) {
      expect(reverseB.lookup(file, line), `${view.id}: who owns ${file}:${line}`).toEqual(
        reverseA.lookup(file, line),
      );
      stats.lookups++;
    }
  }
  return stats;
}
