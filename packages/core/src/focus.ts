/**
 * Code focus and reverse lookup (ARCHITECTURE.md section 4.5): which code ranges an element points
 * at (`codeFocus`), how to merge them per file for the editor (`mergeFocusByFile`), and the
 * code -> elements direction (`buildReverseIndex`: innermost range wins, ties return all).
 */
import { isBaseAnchor } from "./anchors.js";
import { deriveGraph, derivedEdgeAnchors, type DerivedEdge, type DerivedGraph } from "./graph.js";
import { EDGE_TO_REF_KIND, elementIdForSymbolId, parseId } from "./ids.js";
import type { ExplainerModel, ModelNode } from "./model.js";
import type {
  Anchor,
  AnchorRole,
  AnchorStatus,
  Edge,
  ElementId,
  FilePath,
  Range,
  View,
} from "./schema.js";
import { cmp, unique } from "./util.js";

/** One highlighted range: an element's anchor (or its structural fallback) in one file. */
export interface FocusRange {
  file: FilePath;
  range: Range;
  role: AnchorRole;
  /** The element (from the `ids` given to `codeFocus`) this range belongs to. */
  elementId: ElementId;
  /** Status of the anchor it comes from (`ok` for structural fallbacks). Never `missing`. */
  status: AnchorStatus;
}

export interface FocusOptions {
  /**
   * Derived edges of the current view, by id (`edgeMap(deriveGraph(...))`). A derived edge id that is
   * not in the map is computed from the references between the two subtrees (a full scan of the
   * index's references: pass the map for anything called repeatedly).
   */
  derivedEdges?: ReadonlyMap<string, DerivedEdge>;
}

/** Dirs and the repo fall back to at most this many files. */
export const MAX_DIR_FOCUS_FILES = 50;

/** The edges of a derived graph by id, for `FocusOptions.derivedEdges`. */
export function derivedEdgeMap(graph: DerivedGraph): Map<string, DerivedEdge> {
  return new Map(graph.edges.map((edge) => [edge.id, edge]));
}

/**
 * The union of the elements' resolved anchors (anchors with status `missing` are excluded), one
 * `FocusRange` per anchor, in the order of `ids`. When an element has no usable anchors:
 * symbol -> its range; file -> the whole file; dir / repo -> its files (at most 50); group -> its
 * members' focus; derived edge (and a stored edge overlaying one, without anchors) -> the derived
 * anchors: the ref sites and the targets' definitions. Concepts, stored edges and steps without
 * anchors have no focus. Unknown ids are skipped.
 */
export function codeFocus(
  ids: readonly ElementId[],
  model: ExplainerModel,
  opts: FocusOptions = {},
): FocusRange[] {
  const out: FocusRange[] = [];
  const seen = new Set<string>();
  for (const id of unique(ids)) {
    if (typeof id !== "string") continue;
    for (const range of focusOf(id, id, model, opts, new Set())) {
      const r = range.range;
      const key = `${id}\0${range.file}\0${r.startLine}\0${r.startCol ?? ""}\0${r.endLine}\0${r.endCol ?? ""}\0${range.role}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(range);
    }
  }
  return out;
}

function focusOf(
  id: ElementId,
  owner: ElementId,
  model: ExplainerModel,
  opts: FocusOptions,
  visiting: Set<ElementId>,
): FocusRange[] {
  if (visiting.has(id)) return [];
  const ref = model.element(id);
  if (!ref) return [];
  switch (ref.type) {
    case "node":
      return nodeFocus(ref.node, owner, model, opts, visiting);
    case "edge": {
      const own = anchorRanges(ref.edge.anchors, owner, model);
      if (own.length > 0) return own;
      const parsed = parseId(id);
      return parsed.type === "derived-edge"
        ? derivedFocus(id, parsed.kind, parsed.from, parsed.to, owner, model, opts)
        : [];
    }
    case "derived-edge":
      return derivedFocus(id, ref.kind, ref.from, ref.to, owner, model, opts);
    case "concept":
      return anchorRanges(ref.concept.anchors, owner, model);
    case "step":
      return anchorRanges(ref.step.anchors, owner, model);
  }
}

function anchorRanges(
  anchors: readonly Anchor[] | undefined,
  elementId: ElementId,
  model: ExplainerModel,
): FocusRange[] {
  const out: FocusRange[] = [];
  for (const anchor of Array.isArray(anchors) ? anchors : []) {
    const focus = anchorFocus(anchor, elementId, model);
    if (focus) out.push(focus);
  }
  return out;
}

/**
 * The base anchors (`at: "base"`) of a list as ranges of the base version of their file: what a diff view shows
 * on the "before" side. `codeFocus` leaves them out, because their lines are lines of the base commit, not of the
 * code the editor shows. `file` is the changed file's path (`ChangedFile.path`; for a renamed file the new path,
 * whose base text is `ViewerBundle.baseFiles[file]`). Missing and never-resolved anchors are skipped.
 */
export function baseAnchorFocus(
  anchors: readonly Anchor[] | undefined,
  elementId: ElementId,
): FocusRange[] {
  const out: FocusRange[] = [];
  for (const anchor of Array.isArray(anchors) ? anchors : []) {
    if (!isBaseAnchor(anchor) || !anchor.resolved || anchor.resolved.status === "missing") continue;
    out.push({
      file: anchor.file,
      range: { ...anchor.resolved.range },
      role: anchor.role,
      elementId,
      status: anchor.resolved.status,
    });
  }
  return out;
}

/** The focus range of one anchor: its resolved range, or (never resolved) computed from the index. */
function anchorFocus(
  anchor: Anchor,
  elementId: ElementId,
  model: ExplainerModel,
): FocusRange | undefined {
  if (typeof anchor !== "object" || anchor === null) return undefined;
  if (isBaseAnchor(anchor)) return undefined; // lines of the base commit: see `baseAnchorFocus`
  const resolved = anchor.resolved;
  if (resolved) {
    if (resolved.status === "missing") return undefined;
    return {
      file: anchor.file,
      range: { ...resolved.range },
      role: anchor.role,
      elementId,
      status: resolved.status,
    };
  }
  const file = model.index.file(anchor.file);
  if (!file) return undefined;
  let region: Range = { startLine: 1, endLine: file.lines };
  if (anchor.symbol) {
    const sym = model.index.symbolAt(anchor.file, anchor.symbol);
    if (!sym) return undefined;
    region = sym.range;
  }
  const range: Range = anchor.span
    ? {
        startLine: Math.min(region.startLine + anchor.span.from, region.endLine),
        endLine: Math.min(region.startLine + anchor.span.to, region.endLine),
      }
    : { ...region };
  return { file: anchor.file, range, role: anchor.role, elementId, status: "ok" };
}

function nodeFocus(
  node: ModelNode,
  owner: ElementId,
  model: ExplainerModel,
  opts: FocusOptions,
  visiting: Set<ElementId>,
): FocusRange[] {
  const own = anchorRanges(node.anchors, owner, model);
  if (own.length > 0) return own;
  const index = model.index;
  const wholeFile = (path: FilePath): FocusRange | undefined => {
    const file = index.file(path);
    return file
      ? {
          file: path,
          range: { startLine: 1, endLine: file.lines },
          role: "definition",
          elementId: owner,
          status: "ok",
        }
      : undefined;
  };
  switch (node.kind) {
    case "symbol": {
      const parsed = parseId(node.id);
      const sym = parsed.type === "symbol" ? index.symbol(parsed.symbolId) : undefined;
      return sym
        ? [
            {
              file: sym.file,
              range: { ...sym.range },
              role: "definition",
              elementId: owner,
              status: "ok",
            },
          ]
        : [];
    }
    case "file": {
      const parsed = parseId(node.id);
      const range = parsed.type === "file" ? wholeFile(parsed.path) : undefined;
      return range ? [range] : [];
    }
    case "dir":
    case "repo": {
      const parsed = parseId(node.id);
      const path = parsed.type === "dir" ? parsed.path : "";
      const out: FocusRange[] = [];
      for (const file of index.filesUnder(path).slice(0, MAX_DIR_FOCUS_FILES)) {
        const range = wholeFile(file);
        if (range) out.push(range);
      }
      return out;
    }
    case "group": {
      visiting.add(node.id);
      const out: FocusRange[] = [];
      for (const member of model.members(node.id)) {
        out.push(...focusOf(member, owner, model, opts, visiting));
      }
      visiting.delete(node.id);
      return out;
    }
  }
}

function derivedFocus(
  id: ElementId,
  kind: Edge["kind"],
  from: ElementId,
  to: ElementId,
  owner: ElementId,
  model: ExplainerModel,
  opts: FocusOptions,
): FocusRange[] {
  const known = opts.derivedEdges?.get(id);
  let anchors: readonly Anchor[];
  if (known) anchors = known.anchors;
  else {
    const refKind = EDGE_TO_REF_KIND[kind];
    const refs = refKind
      ? model.index.refs.filter(
          (ref) =>
            ref.kind === refKind &&
            model.subtreeContains(from, elementIdForSymbolId(ref.from)) &&
            model.subtreeContains(to, elementIdForSymbolId(ref.to)),
        )
      : [];
    anchors = derivedEdgeAnchors(refs, model.index);
  }
  return anchorRanges(anchors, owner, model);
}

// ─── Merging for the editor ─────────────────────────────────────────────────────────────────────

/** A run of overlapping focus ranges of one file, as whole lines. */
export interface MergedRange {
  range: { startLine: number; endLine: number };
  /** Every role of the ranges merged into this one, in order of first appearance. */
  roles: AnchorRole[];
  elementIds: ElementId[];
  /** The original ranges (with roles, elements, statuses; sorted by start line), for finer decoration. */
  sources: FocusRange[];
}

export interface FileFocus {
  file: FilePath;
  /** Sorted by start line; no two ranges overlap. */
  ranges: MergedRange[];
}

/**
 * Groups focus ranges by file (files in order of first appearance, so the first focused file comes
 * first) and merges the ranges that overlap (they share at least one line) into whole-line runs.
 * All roles are kept: an inner `call-site` inside an outer `definition` is still in `sources`.
 */
export function mergeFocusByFile(ranges: readonly FocusRange[]): FileFocus[] {
  const byFile = new Map<FilePath, FocusRange[]>();
  for (const range of ranges) {
    const list = byFile.get(range.file);
    if (list) list.push(range);
    else byFile.set(range.file, [range]);
  }
  const out: FileFocus[] = [];
  for (const [file, list] of byFile) {
    const sorted = [...list].sort(
      (a, b) => a.range.startLine - b.range.startLine || b.range.endLine - a.range.endLine,
    );
    const merged: MergedRange[] = [];
    for (const source of sorted) {
      const last = merged[merged.length - 1];
      if (last && source.range.startLine <= last.range.endLine) {
        last.range.endLine = Math.max(last.range.endLine, source.range.endLine);
        if (!last.roles.includes(source.role)) last.roles.push(source.role);
        if (!last.elementIds.includes(source.elementId)) last.elementIds.push(source.elementId);
        last.sources.push(source);
      } else {
        merged.push({
          range: { startLine: source.range.startLine, endLine: source.range.endLine },
          roles: [source.role],
          elementIds: [source.elementId],
          sources: [source],
        });
      }
    }
    out.push({ file, ranges: merged });
  }
  return out;
}

// ─── Reverse lookup ─────────────────────────────────────────────────────────────────────────────

export interface ReverseIndex {
  /**
   * The candidate elements whose code contains `line` of `file` (1-based). Among the elements whose
   * ranges contain the line, the ones with the smallest line span win (innermost); ties return all.
   * Sorted by id.
   */
  lookup(file: FilePath, line: number): ElementId[];
}

/**
 * Interval index over the focus ranges of `candidateIds` (see `viewCandidates`). Pass
 * `opts.derivedEdges` (from `derivedEdgeMap`) so derived-edge candidates do not rescan the index.
 * An element with several ranges around a line counts with its smallest one.
 */
export function buildReverseIndex(
  candidateIds: readonly ElementId[],
  model: ExplainerModel,
  opts: FocusOptions = {},
): ReverseIndex {
  interface Entry {
    start: number;
    end: number;
    id: ElementId;
  }
  const byFile = new Map<FilePath, Entry[]>();
  for (const id of unique(candidateIds)) {
    for (const focus of codeFocus([id], model, opts)) {
      const entry = { start: focus.range.startLine, end: focus.range.endLine, id };
      const list = byFile.get(focus.file);
      if (list) list.push(entry);
      else byFile.set(focus.file, [entry]);
    }
  }
  return {
    lookup(file: FilePath, line: number): ElementId[] {
      const entries = byFile.get(file);
      if (!entries) return [];
      const spans = new Map<ElementId, number>();
      for (const entry of entries) {
        if (entry.start > line || entry.end < line) continue;
        const span = entry.end - entry.start + 1;
        const known = spans.get(entry.id);
        if (known === undefined || span < known) spans.set(entry.id, span);
      }
      let best = Infinity;
      for (const span of spans.values()) best = Math.min(best, span);
      const out: ElementId[] = [];
      for (const [id, span] of spans) if (span === best) out.push(id);
      return out.sort(cmp);
    },
  };
}

/**
 * The candidate ids of a view for `buildReverseIndex`: a graph's included nodes and shown edges (from
 * `derived`, or derived here), a sequence's participants and steps; plus every concept.
 */
export function viewCandidates(
  view: View,
  model: ExplainerModel,
  derived?: DerivedGraph,
): ElementId[] {
  const ids: ElementId[] = [];
  if (view.type === "graph") {
    const graph = derived ?? deriveGraph(view, model);
    ids.push(...graph.nodes.map((n) => n.id), ...graph.edges.map((e) => e.id));
  } else {
    ids.push(...(Array.isArray(view.participants) ? view.participants : []));
    ids.push(
      ...(Array.isArray(view.steps)
        ? view.steps.filter((s) => s && typeof s.id === "string").map((s) => s.id)
        : []),
    );
  }
  ids.push(...model.concepts.map((c) => c.id).sort(cmp));
  return unique(ids);
}
