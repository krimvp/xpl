/**
 * Pruning the symbol index for a bundle (ARCHITECTURE.md section 5, "Bundle payload"). `xpl bundle` writes the
 * index into the page next to the explainer, and left whole it is most of the page: every symbol and every
 * reference of the repository, when the page carries the code of a dozen files. `pruneIndex` cuts it down to
 * what the viewer can still draw from it.
 *
 * What the viewer derives from the index is small and known (graph.ts, stubs.ts, focus.ts): directories and
 * files from `files`, what a box opens into from the symbols, edges, stubs and ghosts from the references with
 * an end inside a view, and the parent chain of every symbol involved (`repr`, ghost targets and drill-in walk
 * it). So what stays is:
 *
 *   - every file entry: the viewer lists and labels files from them and derives the directories;
 *   - the symbols of the embedded `files` (a box opens into them), the symbols inside a graph view (so does the
 *     box of a file the code of which is not embedded), the symbols the explainer names (an included node, a
 *     group member, an edge end, a tour focus, an anchor), the symbols the kept references start or end in, and
 *     the parents of all of these: a missing parent would lift a method straight to its file;
 *   - the references that can be drawn:
 *       1. those with an end inside a graph view of the explainer (`repr` finds a box that stands for it), of every
 *          kind: the edge-kind toggles and the stub modes only read the same references again. `excludeFiles` does
 *          not spare any: a directory that opens into an excluded file names it again, and the viewer's code for a
 *          stub looks at every reference that crosses the edge of the view;
 *       2. those of a derived edge that the explainer names outside a view (a tour focuses it, a stored edge
 *          overlays it): `codeFocus` computes their code from the references when the edge is not on screen;
 *       3. those with an end in an embedded file, so that whatever is added to a view next to embedded code
 *          (a ghost, a directory that opens into files) keeps its edges; `read` references, nearly half of all of
 *          them and rarely wanted, need both ends there (`bothEnds`).
 *     References that end in something the index cannot resolve are dropped: no view derives anything from them.
 *
 * So whatever the viewer derives for the explainer's own views (nodes, edges with their anchors, stubs, ghosts,
 * code focus, reverse lookup) is identical with the pruned index, under every edge-kind selection and every stub
 * mode, and so is opening or collapsing anything inside them. Adding a ghost that touches embedded code keeps its
 * edges too, except for `read` ones. What is not exact is exploring past that, into files whose code is not
 * embedded: a ghost added there opens into the symbols the kept references end in rather than all of its symbols,
 * and edges between two such ghosts are missing. The tests (core's `prune.test.ts`, the CLI's
 * `bundle-prune.test.ts`) compare what the full and the pruned index derive.
 */
import { collectAnchors } from "./anchors.js";
import { repr } from "./graph.js";
import { asIndexModel, type IndexModel } from "./index-model.js";
import { EDGE_TO_REF_KIND, elementIdForSymbolId, parseId, symbolId } from "./ids.js";
import { ExplainerModel } from "./model.js";
import type { ElementId, Explainer, FilePath, Reference, SymbolId, SymbolIndex } from "./schema.js";

/** Reference kinds that stay only when both of their ends are in embedded files (`PruneOptions.bothEnds`). */
export const PRUNE_BOTH_ENDS_KINDS: readonly Reference["kind"][] = ["read"];

export interface PruneOptions {
  /**
   * The files whose code is embedded: all their symbols stay, and so do the references that touch them (a
   * reference of a kind in `bothEnds`: only those between two of them). Paths that are not in the index are ignored.
   */
  files: Iterable<FilePath>;
  /**
   * The explainer the index is cut for: what its graph views, tours and stored elements can show stays whole (see
   * the header). Without it only `files` counts, which is enough for a bundle that has no views to draw.
   */
  explainer?: Explainer;
  /** Kinds of reference that need both ends in `files` (default `PRUNE_BOTH_ENDS_KINDS`: `read`). */
  bothEnds?: readonly Reference["kind"][];
}

export interface PruneResult {
  /**
   * The pruned index: a new object with `pruned` set to what the full index had (the input is never touched), or
   * the input itself when nothing was dropped.
   */
  index: SymbolIndex;
  /** Something was dropped. */
  pruned: boolean;
  /** Symbols kept, and symbols the given index had. */
  symbols: { kept: number; total: number };
  /** References kept, and references the given index had. */
  refs: { kept: number; total: number };
}

/**
 * The index cut down for a bundle that embeds the code of `options.files` and draws `options.explainer` (see the
 * header for what is kept and what that guarantees). Entries keep their order; the result is a new object.
 * Pruning an index that is pruned already prunes it further and keeps the counts of the original in `pruned`.
 */
export function pruneIndex(source: SymbolIndex | IndexModel, options: PruneOptions): PruneResult {
  const model = asIndexModel(source);
  const index = model.index;
  const whole = new Set<FilePath>();
  for (const path of options.files) if (model.hasFile(path)) whole.add(path);
  const bothEnds = new Set(options.bothEnds ?? PRUNE_BOTH_ENDS_KINDS);
  const needs = options.explainer ? explainerNeeds(options.explainer, model) : undefined;

  const allRefs = index.refs ?? [];
  const refs = allRefs.filter((ref) => {
    const from = model.fileOfSymbolId(ref.from);
    const to = model.fileOfSymbolId(ref.to);
    if (from === undefined || to === undefined) return false; // dead: deriveGraph skips it as well
    const a = whole.has(from);
    const b = whole.has(to);
    return (bothEnds.has(ref.kind) ? a && b : a || b) || needs?.keepsRef(ref) === true;
  });

  const keep = new Set<SymbolId>();
  for (const symbol of model.symbols) {
    if (whole.has(symbol.file) || needs?.keepsSymbol(symbol.id)) keep.add(symbol.id);
  }
  for (const id of needs?.symbols ?? []) if (model.symbol(id)) keep.add(id);
  for (const ref of refs) {
    if (model.symbol(ref.from)) keep.add(ref.from);
    if (model.symbol(ref.to)) keep.add(ref.to);
  }
  // The parent chains, from a snapshot: what is added on the way brings its own parents along.
  for (const id of [...keep]) {
    let parent = model.symbol(id)?.parent;
    while (parent !== undefined && !keep.has(parent)) {
      const symbol = model.symbol(parent);
      if (!symbol) break;
      keep.add(parent);
      parent = symbol.parent;
    }
  }
  const allSymbols = index.symbols ?? [];
  const symbols = allSymbols.filter((symbol) => keep.has(symbol.id));

  const counts = {
    symbols: { kept: symbols.length, total: allSymbols.length },
    refs: { kept: refs.length, total: allRefs.length },
  };
  if (symbols.length === allSymbols.length && refs.length === allRefs.length) {
    return { index, pruned: false, ...counts };
  }
  const original = index.pruned ?? {
    files: (index.files ?? []).length,
    symbols: allSymbols.length,
    refs: allRefs.length,
  };
  return { index: { ...index, symbols, refs, pruned: original }, pruned: true, ...counts };
}

// ─── What the explainer draws ───────────────────────────────────────────────────────────────────

interface ExplainerNeeds {
  /** The symbols the explainer names (a symbol id may name one the index no longer has). */
  symbols: ReadonlySet<SymbolId>;
  /** A symbol inside a graph view of the explainer: a box that opens into it. */
  keepsSymbol(id: SymbolId): boolean;
  /** A reference that lies on a graph view of the explainer, or that a derived edge it names is made of. */
  keepsRef(ref: Reference): boolean;
}

function explainerNeeds(explainer: Explainer, index: IndexModel): ExplainerNeeds {
  const model = new ExplainerModel(explainer, index);

  // Every symbol the explainer names, in an element id (`sym:`, or inside a derived edge, stub or ghost id) or an
  // anchor. Named symbols must exist in the pruned index, or `hasNode` would drop them from a view, a tour
  // step's focus, a sequence lifeline...
  const symbols = new Set<SymbolId>();
  forEachString(explainer, (text) => symbolIdsIn(text, symbols));
  for (const site of collectAnchors(explainer)) {
    const { file, symbol } = site.anchor;
    if (typeof file === "string" && typeof symbol === "string" && symbol !== "") {
      symbols.add(symbolId(file, symbol));
    }
  }

  // References with an end inside a graph view: what `deriveGraph` turns into edges (both ends inside) and
  // stubs (one end). It looks at them through `include` alone, so this is exact whatever `edgeKinds`, `stubs`,
  // `hidden` and `excludeFiles` say; the edits the viewer offers (`drillIn`, `collapse`, `expandStub`) change
  // `include` and are covered where they stay in or next to the embedded files.
  const includes: ReadonlySet<ElementId>[] = [];
  for (const view of model.views) {
    if (view.type !== "graph") continue;
    const include = new Set(
      (Array.isArray(view.include) ? view.include : []).filter(
        (id) => typeof id === "string" && model.hasNode(id),
      ),
    );
    if (include.size > 0) includes.push(include);
  }
  // Most references share their ends: what stands for an element in the views is worked out once.
  const insideMemo = new Map<ElementId, boolean>();
  const inside = (id: ElementId): boolean => {
    let known = insideMemo.get(id);
    if (known === undefined) {
      known = includes.some((include) => repr(id, include, model) !== undefined);
      insideMemo.set(id, known);
    }
    return known;
  };

  // The derived edges the explainer names where nothing draws them: `codeFocus` finds an edge that is not in the
  // view's edge map by scanning the references between the two subtrees (focus.ts, `derivedFocus`).
  const named: { kind: Reference["kind"]; from: ElementId; to: ElementId }[] = [];
  const name = (id: unknown): void => {
    if (typeof id !== "string") return;
    const parsed = parseId(id);
    if (parsed.type !== "derived-edge") return;
    const kind = EDGE_TO_REF_KIND[parsed.kind];
    if (kind && model.hasNode(parsed.from) && model.hasNode(parsed.to)) {
      named.push({ kind, from: parsed.from, to: parsed.to });
    }
  };
  for (const edge of model.storedEdges) name(edge.id);
  for (const tour of model.tours) {
    for (const step of Array.isArray(tour.steps) ? tour.steps : []) {
      for (const id of Array.isArray(step?.focus) ? step.focus : []) name(id);
    }
  }
  const containsMemo = new Map<string, boolean>();
  const contains = (container: ElementId, end: SymbolId): boolean => {
    const key = `${container}\0${end}`;
    let known = containsMemo.get(key);
    if (known === undefined) {
      known = model.subtreeContains(container, elementIdForSymbolId(end));
      containsMemo.set(key, known);
    }
    return known;
  };

  return {
    symbols,
    keepsSymbol: (id) => inside(elementIdForSymbolId(id)),
    keepsRef: (ref) =>
      inside(elementIdForSymbolId(ref.from)) ||
      inside(elementIdForSymbolId(ref.to)) ||
      named.some(
        (edge) =>
          edge.kind === ref.kind && contains(edge.from, ref.from) && contains(edge.to, ref.to),
      ),
  };
}

/** The symbol ids inside an element id: a `sym:` id, and the ends of a derived edge, stub or ghost id. */
function symbolIdsIn(id: string, out: Set<SymbolId>): void {
  const parsed = parseId(id);
  switch (parsed.type) {
    case "symbol":
      out.add(parsed.symbolId);
      break;
    case "derived-edge":
      symbolIdsIn(parsed.from, out);
      symbolIdsIn(parsed.to, out);
      break;
    case "stub":
      symbolIdsIn(parsed.inside, out);
      symbolIdsIn(parsed.ghost, out);
      break;
    case "ghost":
      symbolIdsIn(parsed.target, out);
      break;
  }
}

/** Calls `visit` with every string value of some JSON-shaped data (keys are not visited). */
function forEachString(value: unknown, visit: (text: string) => void): void {
  if (typeof value === "string") visit(value);
  else if (Array.isArray(value)) for (const item of value) forEachString(item, visit);
  else if (typeof value === "object" && value !== null) {
    for (const item of Object.values(value)) forEachString(item, visit);
  }
}
