/**
 * Everything the UI derives from the state, computed with @xpl/core and memoised: the graph of the
 * current view, the code focus of the selection, the editor panes, the reverse lookup for the caret and
 * the elements to co-highlight. Pure functions of `ViewerState`; the UI and `window.__xpl` share them,
 * so a test sees exactly what the screen shows.
 *
 * Three stages, each cached on the identity of its inputs (so a caret move recomputes only `matches`):
 *   view       (model, viewId)      -> graph, edge map, stubs, lazy reverse index
 *   selection  (view stage, ids)    -> focus ranges, per-file focus, related ids
 *   matches    (view stage, cursor) -> ids whose code contains the caret
 */
import {
  baseAnchorFocus,
  buildReverseIndex,
  codeFocus,
  deriveGraph,
  derivedEdgeAnchors,
  elementIdForSymbolId,
  excludedRefs,
  expandInPlace,
  isBaseAnchor,
  mergeFocusByFile,
  parseId,
  REF_TO_EDGE_KIND,
  repr,
  viewCandidates,
  type Anchor,
  type DerivedEdge,
  type DerivedGraph,
  type ElementId,
  type ExplainerModel,
  type FileFocus,
  type FilePath,
  type FocusRange,
  type ReverseIndex,
  type Stub,
  type TourStep,
  type View,
} from "@xpl/core";
import { drawnEdges } from "./drawnEdges.js";
import type { Cursor, ViewerState } from "./store.js";

/** More editor panes than this are listed instead of shown. */
export const MAX_PANES = 10;
/** A caret selection covering more lines than this only looks up its first lines. */
const MAX_LOOKUP_LINES = 400;

export interface ViewDerived {
  view: View | undefined;
  /** Graph views only. */
  graph: DerivedGraph | undefined;
  edgeMap: ReadonlyMap<string, DerivedEdge>;
  stubMap: ReadonlyMap<string, Stub>;
  /** Ids the graph view includes (for `repr`). */
  include: ReadonlySet<ElementId>;
  /** The reverse index of the view's candidates; built on first use. */
  reverse(): ReverseIndex;
}

export interface SelectionDerived {
  /** Focus of the selected elements, in selection order (what `codeFocus` returns). */
  focus: readonly FocusRange[];
  /**
   * Base anchors (`at: "base"`) of the selected elements (or of the step's code override), as ranges of the
   * code before the change (`baseAnchorFocus`): `file` is the changed file's path, the lines are base lines.
   */
  base: readonly FocusRange[];
  /** The same, per file, overlapping ranges merged. */
  baseFiles: readonly FileFocus[];
  /** Head and base files in the order the focus names them: the order of the editor panes. */
  order: readonly { file: FilePath; base: boolean }[];
  /** The same, per file (first appearance first) with overlapping ranges merged. */
  files: readonly FileFocus[];
  focusFiles: ReadonlySet<FilePath>;
  /** Elements as they appear in the current view that a selected concept points at. */
  related: ReadonlySet<ElementId>;
}

export interface PaneSpec {
  file: FilePath;
  /**
   * `base`: the code before the change of this file (a base anchor's lines, or a file the change removed),
   * read-only and labelled as such. Absent: the code as it is now.
   */
  side?: "base";
  /** Focus ranges in this file (empty for a file that was only opened). */
  ranges: readonly FocusRange[];
  /** The file is in the current focus. */
  focused: boolean;
  /** Lines outside the ranges are dimmed: a focused file, unless the tour step says `dimOthers: false`. */
  dim: boolean;
  /** The user asked for this file (tree, anchor list). */
  opened: boolean;
  /**
   * The line the pane scrolls to: the start of the first range in this file in the order of the focus (the
   * tour step's code override, else its focus list, else the selection), not the lowest line. A step about
   * the second of two places in a file shows that place first.
   */
  lead?: number;
}

export interface Derived {
  view: ViewDerived;
  selection: SelectionDerived;
  /**
   * Elements whose code contains the caret, sorted: the innermost of the elements the view draws, plus the
   * innermost concepts (`viewReverseIndex`).
   */
  matches: readonly ElementId[];
  panes: readonly PaneSpec[];
  /** Files in the focus that did not fit into `MAX_PANES` panes. */
  overflow: readonly FilePath[];
}

// ─── Stage 1: the view ──────────────────────────────────────────────────────────────────────────

function deriveView(
  model: ExplainerModel,
  viewId: string | undefined,
  expanded: ReadonlySet<ElementId> = new Set(),
): ViewDerived {
  const view = viewId === undefined ? undefined : model.view(viewId);
  let graph: DerivedGraph | undefined;
  let include: ReadonlySet<ElementId> = new Set();
  if (view?.type === "graph") {
    // boxes the reader opened in place show the boxes of the view they open, inside them
    const drawn = expandInPlace(view, model, expanded);
    graph = deriveGraph(drawn, model);
    include = new Set(
      (Array.isArray(drawn.include) ? drawn.include : []).filter((id) => model.hasNode(id)),
    );
  }
  // Keep hidden kind ids addressable by tours, but select a drawn arrow with all its evidence.
  const edgeMap = new Map(
    (graph ? [...graph.edges, ...drawnEdges(graph.edges)] : []).map((edge) => [edge.id, edge]),
  );
  const stubMap = new Map((graph?.stubs ?? []).map((stub) => [stub.id, stub] as const));
  let reverse: ReverseIndex | undefined;
  return {
    view,
    graph,
    edgeMap,
    stubMap,
    include,
    reverse() {
      reverse ??= view
        ? viewReverseIndex(view, model, graph, edgeMap)
        : buildReverseIndex(
            model.concepts.map((concept) => concept.id),
            model,
          );
      return reverse;
    },
  };
}

/**
 * The reverse index of what a view draws, for the caret: the innermost range wins among the elements the view
 * draws, and the innermost concepts are added on top. Concepts do not compete with the drawn elements: a concept
 * anchored on two lines inside a flow step must not hide the step (the pop on chi's `tree.go:500`).
 */
export function viewReverseIndex(
  view: View,
  model: ExplainerModel,
  graph?: DerivedGraph,
  edgeMap?: ReadonlyMap<string, DerivedEdge>,
): ReverseIndex {
  const concepts = new Set(model.concepts.map((concept) => concept.id));
  const candidates = viewCandidates(view, model, graph);
  const opts = edgeMap ? { derivedEdges: edgeMap } : {};
  const drawn = buildReverseIndex(
    candidates.filter((id) => !concepts.has(id)),
    model,
    opts,
  );
  const ideas = buildReverseIndex(
    candidates.filter((id) => concepts.has(id)),
    model,
    opts,
  );
  return {
    lookup: (file, line) =>
      [...drawn.lookup(file, line), ...ideas.lookup(file, line)].sort((a, b) =>
        a < b ? -1 : a > b ? 1 : 0,
      ),
  };
}

// ─── Stage 2: the selection ─────────────────────────────────────────────────────────────────────

/**
 * Code behind a stub: the reference sites that cross the view's boundary at that stub, plus the
 * definitions on the far side (core builds those anchors for derived edges; a stub is the same thing
 * with one end outside), and the anchors of stored edges that leave the view there. A stub to a folded
 * ghost ("rest of <file>", "N more") covers every element it folds (`stub.targets`).
 */
function stubFocus(stub: Stub, vd: ViewDerived, model: ExplainerModel): FocusRange[] {
  const kinds = new Set<string>(stub.kinds);
  const targets = stub.targets.map((t) => t.target);
  const crosses = (from: ElementId, to: ElementId): boolean => {
    const inside = stub.direction === "out" ? from : to;
    const outside = stub.direction === "out" ? to : from;
    return (
      repr(inside, vd.include, model) === stub.inside &&
      repr(outside, vd.include, model) === undefined &&
      targets.some((target) => model.subtreeContains(target, outside))
    );
  };
  const dropRef =
    vd.view?.type === "graph" ? excludedRefs(vd.view, model, [...vd.include]) : undefined;
  const refs = model.index.refs.filter(
    (ref) =>
      !dropRef?.(ref) &&
      kinds.has(REF_TO_EDGE_KIND[ref.kind]) &&
      crosses(elementIdForSymbolId(ref.from), elementIdForSymbolId(ref.to)),
  );
  const out: FocusRange[] = [];
  for (const anchor of derivedEdgeAnchors(refs, model.index)) {
    if (!anchor.resolved) continue;
    out.push({
      file: anchor.file,
      range: { ...anchor.resolved.range },
      role: anchor.role,
      elementId: stub.id,
      status: anchor.resolved.status,
    });
  }
  for (const edge of model.storedEdges) {
    if (kinds.has(edge.kind) && crosses(edge.from, edge.to)) {
      for (const range of codeFocus([edge.id], model)) out.push({ ...range, elementId: stub.id });
    }
  }
  return out;
}

function relatedIds(vd: ViewDerived, model: ExplainerModel, selection: readonly ElementId[]) {
  const out = new Set<ElementId>();
  for (const id of selection) {
    const concept = model.concept(id);
    if (!concept) continue;
    for (const related of concept.related ?? []) {
      out.add(related);
      const view = vd.view;
      if (view?.type === "graph") {
        // What the view draws for it: the element itself, or the group / container that stands for it.
        const shown = repr(related, vd.include, model);
        if (shown !== undefined) out.add(shown);
      } else if (view?.type === "sequence" || view?.type === "flow") {
        for (const participant of view.participants ?? []) {
          if (participant === related || model.subtreeContains(participant, related)) {
            out.add(participant);
          }
        }
      }
    }
  }
  return out;
}

/** Code a tour step shows instead of what its focus points at (`TourStep.code`). */
export interface CodeOverride {
  anchors: readonly Anchor[];
  /** What the ranges are attributed to: `<tour id>/<step id>`, like core's anchor owners. */
  owner: string;
}

/**
 * The focus range of one anchor of a code override: its resolved range (never a missing anchor), or,
 * for an anchor that was never resolved, computed from the index like core does for elements.
 */
export function overrideFocus(override: CodeOverride, model: ExplainerModel): FocusRange[] {
  const out: FocusRange[] = [];
  for (const anchor of override.anchors) {
    if (typeof anchor !== "object" || anchor === null) continue;
    // Lines of the code before the change: they belong in a "before" pane (`overrideBaseFocus`).
    if (isBaseAnchor(anchor)) continue;
    const resolved = anchor.resolved;
    if (resolved) {
      if (resolved.status === "missing") continue;
      out.push({
        file: anchor.file,
        range: { ...resolved.range },
        role: anchor.role,
        elementId: override.owner,
        status: resolved.status,
      });
      continue;
    }
    const file = model.index.file(anchor.file);
    if (!file) continue;
    let region = { startLine: 1, endLine: file.lines };
    if (anchor.symbol) {
      const symbol = model.index.symbolAt(anchor.file, anchor.symbol);
      if (!symbol) continue;
      region = { startLine: symbol.range.startLine, endLine: symbol.range.endLine };
    }
    out.push({
      file: anchor.file,
      range: anchor.span
        ? {
            startLine: Math.min(region.startLine + anchor.span.from, region.endLine),
            endLine: Math.min(region.startLine + anchor.span.to, region.endLine),
          }
        : region,
      role: anchor.role,
      elementId: override.owner,
      status: "ok",
    });
  }
  return out;
}

/** The anchors an element stores itself (base anchors live only there: nothing derives them). */
function ownAnchors(id: ElementId, model: ExplainerModel): readonly Anchor[] {
  const element = model.element(id);
  if (!element) return [];
  const anchors =
    element.type === "node"
      ? element.node.anchors
      : element.type === "edge"
        ? element.edge.anchors
        : element.type === "concept"
          ? element.concept.anchors
          : element.type === "step"
            ? element.step.anchors
            : undefined;
  return Array.isArray(anchors) ? anchors : [];
}

/**
 * The base anchors of a list of anchors in their order, each with its place among the head anchors: the order
 * of `entries` is the order the editor panes take (a step whose code names the old lines first shows them first).
 */
function sideOrder(
  anchors: readonly Anchor[],
  head: readonly FocusRange[],
  base: readonly FocusRange[],
): { file: FilePath; base: boolean }[] {
  const order: { file: FilePath; base: boolean }[] = [];
  let h = 0;
  let b = 0;
  for (const anchor of anchors) {
    if (typeof anchor !== "object" || anchor === null) continue;
    if (isBaseAnchor(anchor)) {
      const range = base[b];
      if (range && range.file === anchor.file) {
        order.push({ file: range.file, base: true });
        b++;
      }
    } else {
      const range = head[h];
      if (range && range.file === anchor.file) {
        order.push({ file: range.file, base: false });
        h++;
      }
    }
  }
  // Whatever the walk could not place (unresolved anchors computed from the index) follows in its own order.
  for (; h < head.length; h++) order.push({ file: head[h]!.file, base: false });
  for (; b < base.length; b++) order.push({ file: base[b]!.file, base: true });
  return order;
}

/** Read mode uses the same checked focus and before/head ordering as opening the tour step. */
export function stepSelection(
  step: TourStep,
  tourId: string,
  model: ExplainerModel,
): SelectionDerived {
  return deriveSelection(
    deriveView(model, step.view),
    model,
    step.focus,
    step.code?.length ? { anchors: step.code, owner: `${tourId}/${step.id}` } : undefined,
  );
}

function deriveSelection(
  vd: ViewDerived,
  model: ExplainerModel,
  selection: readonly ElementId[],
  override: CodeOverride | undefined,
): SelectionDerived {
  const focus: FocusRange[] = [];
  const base: FocusRange[] = [];
  const order: { file: FilePath; base: boolean }[] = [];
  if (override) {
    const head = overrideFocus(override, model);
    const before = baseAnchorFocus(override.anchors, override.owner);
    focus.push(...head);
    base.push(...before);
    order.push(...sideOrder(override.anchors, head, before));
  } else {
    for (const id of selection) {
      const type = parseId(id).type;
      if (type === "stub") {
        const stub = vd.stubMap.get(id);
        const head = stub ? stubFocus(stub, vd, model) : [];
        focus.push(...head);
        order.push(...head.map((r) => sideOf(r, false)));
      } else if (type !== "ghost") {
        const head = codeFocus([id], model, { derivedEdges: vd.edgeMap });
        const anchors = ownAnchors(id, model);
        const before = baseAnchorFocus(anchors, id);
        focus.push(...head);
        base.push(...before);
        order.push(
          ...(before.length > 0
            ? sideOrder(anchors, head, before)
            : head.map((r) => sideOf(r, false))),
        );
      }
    }
  }
  const files = mergeFocusByFile(focus);
  return {
    focus,
    files,
    base,
    baseFiles: mergeFocusByFile(base),
    order,
    focusFiles: new Set(files.map((f) => f.file)),
    related: relatedIds(vd, model, selection),
  };
}

const sideOf = (range: FocusRange, base: boolean) => ({ file: range.file, base });

// ─── Stage 3: the caret ─────────────────────────────────────────────────────────────────────────

function deriveMatches(vd: ViewDerived, cursor: Cursor | undefined): ElementId[] {
  if (!cursor || cursor.side === "base") return [];
  const reverse = vd.reverse();
  const found = new Set<ElementId>();
  const last = Math.min(cursor.toLine, cursor.fromLine + MAX_LOOKUP_LINES - 1);
  for (let line = cursor.fromLine; line <= last; line++) {
    for (const id of reverse.lookup(cursor.file, line)) found.add(id);
  }
  return [...found].sort();
}

// ─── Panes ──────────────────────────────────────────────────────────────────────────────────────

/** Options for the panes: what the user opened, and what the tour step asks of the editor. */
interface PaneOptions {
  openedFile: FilePath | undefined;
  /** The opened file is shown as its code before the change (`ViewerState.openedBase`). */
  openedBase: boolean;
  /** Where that "Before" pane opens (`ViewerState.openedLine`). */
  openedLine: number | undefined;
  /** `editor.primary` of the applied tour step. */
  primary: FilePath | undefined;
  dimOthers: boolean;
}

/**
 * One pane per focused file, in the order of the focus. A file the user opened comes first (focused or
 * not), then the tour step's primary file, then the rest.
 */
function derivePanes(
  sel: SelectionDerived,
  { openedFile, openedBase, openedLine, primary, dimOthers }: PaneOptions,
  hasFile: (file: FilePath) => boolean,
): { panes: PaneSpec[]; overflow: FilePath[] } {
  const paneFor = (file: FilePath, opened: boolean, base: boolean): PaneSpec => {
    const own = (base ? sel.baseFiles : sel.files).find((f) => f.file === file);
    const focusLead = (base ? sel.base : sel.focus).find((range) => range.file === file)?.range
      .startLine;
    // A "Before" pane opened at a line (a base anchor's row) goes there; otherwise to the first range.
    const lead =
      opened && base && openedLine !== undefined
        ? openedLine
        : own !== undefined
          ? focusLead
          : undefined;
    return {
      file,
      ...(base ? { side: "base" as const } : {}),
      ranges: own ? own.ranges.flatMap((r) => r.sources) : [],
      focused: own !== undefined,
      dim: own !== undefined && dimOthers,
      opened,
      ...(lead !== undefined ? { lead } : {}),
    };
  };
  const all: PaneSpec[] = [];
  const seen = new Set<string>();
  // Files that are asked for by name must exist; focused files are shown whatever the index says.
  const add = (file: FilePath | undefined, opened: boolean, mustExist: boolean, base = false) => {
    const key = `${base ? "base" : "head"}\0${file}`;
    if (file === undefined || seen.has(key) || (mustExist && !base && !hasFile(file))) return;
    seen.add(key);
    all.push(paneFor(file, opened, base));
  };
  add(openedFile, true, true, openedBase);
  // The primary file first: as it is now, and before the change when the focus has both, in the focus's order.
  for (const entry of sel.order)
    if (entry.file === primary) add(entry.file, false, true, entry.base);
  add(primary, false, true);
  for (const entry of sel.order) add(entry.file, false, false, entry.base);
  for (const focus of sel.files) add(focus.file, false, false);
  for (const focus of sel.baseFiles) add(focus.file, false, false, true);
  return {
    panes: all.slice(0, MAX_PANES),
    overflow: all.slice(MAX_PANES).map((p) => p.file),
  };
}

// ─── Memoised entry point ───────────────────────────────────────────────────────────────────────

let lastView:
  | {
      model: ExplainerModel;
      viewId: string | undefined;
      expanded: ReadonlySet<ElementId>;
      value: ViewDerived;
    }
  | undefined;
let lastSelection:
  | {
      view: ViewDerived;
      selection: readonly ElementId[];
      override: readonly Anchor[] | undefined;
      value: SelectionDerived;
    }
  | undefined;
let lastMatches: { view: ViewDerived; cursor: Cursor | undefined; value: ElementId[] } | undefined;
let lastPanes:
  | {
      sel: SelectionDerived;
      opened: FilePath | undefined;
      openedBase: boolean;
      openedLine: number | undefined;
      primary: FilePath | undefined;
      dimOthers: boolean;
      value: ReturnType<typeof derivePanes>;
    }
  | undefined;
const byState = new WeakMap<ViewerState, Derived>();

/**
 * True when nothing a view is drawn from differs between the two models. A tour edit builds a new model
 * but leaves nodes, edges, concepts and views alone; the graph (and its layout) must survive that, or
 * typing a note would lay the diagram out again on every key.
 */
function sameDrawing(a: ExplainerModel, b: ExplainerModel): boolean {
  if (a === b) return true;
  const x = a.explainer;
  const y = b.explainer;
  return (
    a.index === b.index &&
    x.nodes === y.nodes &&
    x.edges === y.edges &&
    x.concepts === y.concepts &&
    x.views === y.views
  );
}

export function getDerived(state: ViewerState): Derived {
  const known = byState.get(state);
  if (known) return known;

  if (
    !lastView ||
    !sameDrawing(lastView.model, state.model) ||
    lastView.viewId !== state.viewId ||
    lastView.expanded !== state.expanded
  ) {
    lastView = {
      model: state.model,
      viewId: state.viewId,
      expanded: state.expanded,
      value: deriveView(state.model, state.viewId, state.expanded),
    };
  }
  const view = lastView.value;

  const applied = state.applied;
  const override = applied?.code;
  if (
    !lastSelection ||
    lastSelection.view !== view ||
    lastSelection.selection !== state.selection ||
    lastSelection.override !== override
  ) {
    lastSelection = {
      view,
      selection: state.selection,
      override,
      value: deriveSelection(
        view,
        state.model,
        state.selection,
        applied && override
          ? { anchors: override, owner: `${applied.tourId}/${applied.stepId}` }
          : undefined,
      ),
    };
  }
  const selection = lastSelection.value;

  if (!lastMatches || lastMatches.view !== view || lastMatches.cursor !== state.cursor) {
    lastMatches = { view, cursor: state.cursor, value: deriveMatches(view, state.cursor) };
  }

  const primary = applied?.primary;
  const dimOthers = applied?.dimOthers ?? true;
  if (
    !lastPanes ||
    lastPanes.sel !== selection ||
    lastPanes.opened !== state.openedFile ||
    lastPanes.openedBase !== state.openedBase ||
    lastPanes.openedLine !== state.openedLine ||
    lastPanes.primary !== primary ||
    lastPanes.dimOthers !== dimOthers
  ) {
    lastPanes = {
      sel: selection,
      opened: state.openedFile,
      openedBase: state.openedBase,
      openedLine: state.openedLine,
      primary,
      dimOthers,
      value: derivePanes(
        selection,
        {
          openedFile: state.openedFile,
          openedBase: state.openedBase,
          openedLine: state.openedLine,
          primary,
          dimOthers,
        },
        (file) => state.model.index.hasFile(file),
      ),
    };
  }

  const derived: Derived = {
    view,
    selection,
    matches: lastMatches.value,
    panes: lastPanes.value.panes,
    overflow: lastPanes.value.overflow,
  };
  byState.set(state, derived);
  return derived;
}
