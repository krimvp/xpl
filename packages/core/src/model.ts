/**
 * `ExplainerModel` (ARCHITECTURE.md section 4.3): the explainer merged with the index. Derived
 * structural nodes (repo / dir / file / symbol) overlaid by stored nodes with the same id, stored
 * groups, edges, concepts, views, tours and sequence steps, plus the structural parent chain.
 */
import { asIndexModel, baseName, dirOf, type IndexModel } from "./index-model.js";
import { dirId, fileId, parseId, REPO_ID, symId } from "./ids.js";
import type {
  Concept,
  Edge,
  ElementId,
  Explainer,
  FilePath,
  IndexedSymbol,
  Node,
  Provenance,
  Range,
  SequenceStep,
  SequenceView,
  SymbolIndex,
  SymbolPath,
  Tour,
  View,
} from "./schema.js";
import { cmp, isRecord } from "./util.js";

/** A node as the model sees it: derived from the index and/or stored, overlay applied. */
export interface ModelNode extends Node {
  /** For symbol nodes: the indexed symbol's kind. */
  symbolKind?: IndexedSymbol["kind"];
  /** A stored node with this id exists in the explainer (a group, or an overlay on a structural node). */
  stored: boolean;
  /** The node is derived from the index (repo, dir, file, symbol); false for stored groups. */
  structural: boolean;
}

/** What an element id refers to. */
export type ElementRef =
  | { type: "node"; id: ElementId; node: ModelNode }
  /** A stored edge (llm / user), including a stored overlay on a derived edge id. */
  | { type: "edge"; id: ElementId; edge: Edge }
  /** A derived edge id (`edge:<kind>:<a>-><b>`) with no stored overlay; both ends are nodes. */
  | { type: "derived-edge"; id: ElementId; kind: Edge["kind"]; from: ElementId; to: ElementId }
  | { type: "concept"; id: ElementId; concept: Concept }
  | { type: "step"; id: ElementId; step: SequenceStep; view: SequenceView; index: number };

const STATIC: Provenance = Object.freeze({ origin: "static" }) as Provenance;
const NONE: readonly never[] = Object.freeze([]) as readonly never[];

/** Label of a symbol: its last path segment; methods keep `Class.method`. */
export function symbolLabel(sym: Pick<IndexedSymbol, "path" | "kind">): string {
  const segments = sym.path.split(".");
  return segments.slice(sym.kind === "method" ? -2 : -1).join(".");
}

/**
 * Default label of a structural id (section 4.3): the repo name, a directory's or file's base name,
 * a symbol's last path segment (methods keep `Class.method`). Other ids: the id itself.
 */
export function defaultLabel(id: ElementId, index: IndexModel, repoName: string): string {
  const parsed = parseId(id);
  switch (parsed.type) {
    case "repo":
      return repoName;
    case "dir":
    case "file":
      return baseName(parsed.path);
    case "symbol": {
      const sym = index.symbol(parsed.symbolId);
      return symbolLabel(sym ?? { path: parsed.path, kind: "other" });
    }
    default:
      return id;
  }
}

export class ExplainerModel {
  readonly explainer: Explainer;
  readonly index: IndexModel;

  private readonly storedNodes = new Map<ElementId, Node>();
  private readonly groupNodes = new Map<ElementId, Node>();
  private readonly edgeMap = new Map<ElementId, Edge>();
  private readonly conceptMap = new Map<ElementId, Concept>();
  private readonly viewMap = new Map<string, View>();
  private readonly tourMap = new Map<string, Tour>();
  private readonly stepMap = new Map<
    string,
    { step: SequenceStep; view: SequenceView; index: number }
  >();
  private readonly groupsByMember = new Map<ElementId, ElementId[]>();
  private readonly nodeCache = new Map<ElementId, ModelNode | null>();

  constructor(explainer: Explainer, index: SymbolIndex | IndexModel) {
    this.explainer = explainer;
    this.index = asIndexModel(index);

    // The first element wins when an id is (wrongly) repeated; validation reports the duplicates.
    // Entries that are not objects with a string id (hand-edited files) are skipped.
    for (const node of records(explainer.nodes)) {
      if (this.storedNodes.has(node.id)) continue;
      this.storedNodes.set(node.id, node);
      if (parseId(node.id).type === "group") this.groupNodes.set(node.id, node);
    }
    for (const edge of records(explainer.edges)) {
      if (!this.edgeMap.has(edge.id)) this.edgeMap.set(edge.id, edge);
    }
    for (const concept of records(explainer.concepts)) {
      if (!this.conceptMap.has(concept.id)) this.conceptMap.set(concept.id, concept);
    }
    for (const tour of records(explainer.tours)) {
      if (!this.tourMap.has(tour.id)) this.tourMap.set(tour.id, tour);
    }
    for (const view of records(explainer.views)) {
      if (!this.viewMap.has(view.id)) this.viewMap.set(view.id, view);
      if (view.type === "sequence" || view.type === "flow") {
        arr(view.steps).forEach((step, index) => {
          if (isRecord(step) && typeof step.id === "string" && !this.stepMap.has(step.id)) {
            this.stepMap.set(step.id, { step, view, index });
          }
        });
      }
    }
    for (const group of [...this.groupNodes.values()].sort((a, b) => cmp(a.id, b.id))) {
      for (const member of arr(group.members)) {
        if (typeof member !== "string") continue;
        const list = this.groupsByMember.get(member);
        if (list) {
          if (!list.includes(group.id)) list.push(group.id);
        } else this.groupsByMember.set(member, [group.id]);
      }
    }
  }

  // ─── Lookup ───────────────────────────────────────────────────────────────────────────────────

  /** The node with this id (structural, derived from the index, or a stored group), overlay applied. */
  node(id: ElementId): ModelNode | undefined {
    const cached = this.nodeCache.get(id);
    if (cached !== undefined) return cached ?? undefined;
    const node = this.buildNode(id);
    this.nodeCache.set(id, node ?? null);
    return node;
  }

  hasNode(id: ElementId): boolean {
    return this.node(id) !== undefined;
  }

  /** True when `id` names an element: a node, stored edge, derivable edge, concept or sequence step. */
  hasElement(id: ElementId): boolean {
    return this.element(id) !== undefined;
  }

  /**
   * What an element id refers to: a node, a stored edge, a derived edge (both ends must be nodes),
   * a concept or a sequence step. Undefined when it is none of them.
   */
  element(id: ElementId): ElementRef | undefined {
    const step = this.stepMap.get(id);
    if (step) return { type: "step", id, ...step };
    const concept = this.conceptMap.get(id);
    if (concept) return { type: "concept", id, concept };
    const edge = this.edgeMap.get(id);
    if (edge) return { type: "edge", id, edge };
    const parsed = parseId(id);
    switch (parsed.type) {
      case "repo":
      case "dir":
      case "file":
      case "symbol":
      case "group": {
        const node = this.node(id);
        return node ? { type: "node", id, node } : undefined;
      }
      case "derived-edge":
        return this.hasNode(parsed.from) && this.hasNode(parsed.to)
          ? { type: "derived-edge", id, kind: parsed.kind, from: parsed.from, to: parsed.to }
          : undefined;
      default:
        return undefined;
    }
  }

  /** Stored edge by id. */
  edge(id: ElementId): Edge | undefined {
    return this.edgeMap.get(id);
  }

  concept(id: ElementId): Concept | undefined {
    return this.conceptMap.get(id);
  }

  view(id: string): View | undefined {
    return this.viewMap.get(id);
  }

  tour(id: string): Tour | undefined {
    return this.tourMap.get(id);
  }

  /** A sequence step by id, with its view and its position in that view. */
  step(id: string): { step: SequenceStep; view: SequenceView; index: number } | undefined {
    return this.stepMap.get(id);
  }

  /** The id of the sequence view a step belongs to. */
  stepViewId(stepId: string): string | undefined {
    return this.stepMap.get(stepId)?.view.id;
  }

  /** Stored edges, in stored order. */
  get storedEdges(): readonly Edge[] {
    return records(this.explainer.edges);
  }

  get concepts(): readonly Concept[] {
    return records(this.explainer.concepts);
  }

  get views(): readonly View[] {
    return records(this.explainer.views);
  }

  get tours(): readonly Tour[] {
    return records(this.explainer.tours);
  }

  /** Stored groups, sorted by id. */
  get groups(): readonly Node[] {
    return [...this.groupNodes.values()].sort((a, b) => cmp(a.id, b.id));
  }

  // ─── Structure ────────────────────────────────────────────────────────────────────────────────

  /**
   * Structural parent: symbol -> its parent symbol or its file; file -> its directory or `repo`; dir
   * -> its parent directory or `repo`; group -> its stored `parent` (default `repo`). Undefined for
   * `repo` and for ids that are not nodes.
   */
  parent(id: ElementId): ElementId | undefined {
    const parsed = parseId(id);
    switch (parsed.type) {
      case "dir": {
        if (!this.index.hasDirectory(parsed.path)) return undefined;
        const dir = dirOf(parsed.path);
        return dir === "" ? REPO_ID : dirId(dir);
      }
      case "file": {
        if (!this.index.hasFile(parsed.path)) return undefined;
        const dir = dirOf(parsed.path);
        return dir === "" ? REPO_ID : dirId(dir);
      }
      case "symbol": {
        const sym = this.index.symbol(parsed.symbolId);
        if (!sym) return undefined;
        const parent = this.index.parentSymbol(sym.id);
        return parent && parent.file === sym.file
          ? symId(parent.file, parent.path)
          : fileId(sym.file);
      }
      case "group": {
        const group = this.groupNodes.get(id);
        if (!group) return undefined;
        const parent = group.parent;
        return typeof parent === "string" && parent !== id && this.hasNode(parent)
          ? parent
          : REPO_ID;
      }
      default:
        return undefined;
    }
  }

  /** Structural children (dir -> subdirectories then files; file -> top-level symbols; symbol -> members). Groups have none: see `members`. */
  children(id: ElementId): ElementId[] {
    const parsed = parseId(id);
    switch (parsed.type) {
      case "repo":
      case "dir": {
        const path = parsed.type === "repo" ? "" : parsed.path;
        if (parsed.type === "dir" && !this.index.hasDirectory(path)) return [];
        const { dirs, files } = this.index.dirChildren(path);
        return [...dirs.map(dirId), ...files.map(fileId)];
      }
      case "file":
        return this.index.topLevelSymbols(parsed.path).map((s) => symId(s.file, s.path));
      case "symbol":
        return this.index.childSymbols(parsed.symbolId).map((s) => symId(s.file, s.path));
      default:
        return [];
    }
  }

  /** Members of a stored group (empty for anything else). */
  members(id: ElementId): readonly ElementId[] {
    return arr(this.groupNodes.get(id)?.members).filter((m) => typeof m === "string");
  }

  /** Structural chain above `id`: parent, grandparent, ..., `repo`. Empty for `repo` and unknown ids. */
  ancestors(id: ElementId): ElementId[] {
    const out: ElementId[] = [];
    const seen = new Set<ElementId>([id]);
    for (let cur = this.parent(id); cur !== undefined && !seen.has(cur); cur = this.parent(cur)) {
      out.push(cur);
      seen.add(cur);
    }
    return out;
  }

  /** Ids of the stored groups whose `members` list `id`, sorted by id. */
  groupIdsContaining(id: ElementId): readonly ElementId[] {
    return this.groupsByMember.get(id) ?? NONE;
  }

  /** Stored groups whose `members` list `id`, sorted by id. */
  groupsContaining(id: ElementId): ModelNode[] {
    const out: ModelNode[] = [];
    for (const gid of this.groupIdsContaining(id)) {
      const node = this.node(gid);
      if (node) out.push(node);
    }
    return out;
  }

  /**
   * True when `id` is `ancestorId` or lies in its subtree: `ancestorId` is on its structural chain,
   * or (for a group) it is one of the group's members or lies in a member's subtree.
   */
  subtreeContains(ancestorId: ElementId, id: ElementId): boolean {
    return this.contains(ancestorId, id, new Set());
  }

  private contains(ancestorId: ElementId, id: ElementId, seen: Set<ElementId>): boolean {
    if (ancestorId === id) return true;
    if (seen.has(ancestorId)) return false;
    seen.add(ancestorId);
    if (this.ancestors(id).includes(ancestorId)) return true;
    const group = this.groupNodes.get(ancestorId);
    if (group) {
      for (const member of this.members(ancestorId)) {
        if (this.contains(member, id, seen)) return true;
      }
    }
    return false;
  }

  /**
   * True when code at (`file`, `symbol`?) lies inside the element `id`: `repo` contains everything;
   * a dir contains the files under it; a file its own code; a symbol itself and its descendants (a
   * file-relative location without a symbol counts when its `range` lies inside the symbol's range);
   * a group contains what any member contains. Used by the llm-edge evidence rule.
   */
  containsCode(
    id: ElementId,
    where: { file: FilePath; symbol?: SymbolPath; range?: Range },
    seen: Set<ElementId> = new Set(),
  ): boolean {
    if (seen.has(id)) return false;
    seen.add(id);
    const parsed = parseId(id);
    switch (parsed.type) {
      case "repo":
        return true;
      case "dir":
        return where.file.startsWith(`${parsed.path}/`);
      case "file":
        return where.file === parsed.path;
      case "symbol": {
        if (where.file !== parsed.file) return false;
        if (where.symbol) {
          const sym = this.index.symbolAt(where.file, where.symbol);
          return sym
            ? this.index.symbolWithin(sym.id, parsed.symbolId)
            : where.symbol === parsed.path || where.symbol.startsWith(`${parsed.path}.`);
        }
        const target = this.index.symbol(parsed.symbolId);
        return (
          !!target &&
          !!where.range &&
          where.range.startLine >= target.range.startLine &&
          where.range.endLine <= target.range.endLine
        );
      }
      case "group":
        return (
          this.members(id).some((m) => this.containsCode(m, where, seen)) ||
          this.ownAnchorsCover(id, where)
        );
      default:
        return false;
    }
  }

  /**
   * A group's own anchors as its code: a box for an outside system (a database) has no members, and the
   * code that talks to it is what its anchors point at. True when `where` is on, inside or around one of them.
   */
  private ownAnchorsCover(
    id: ElementId,
    where: { file: FilePath; symbol?: SymbolPath; range?: Range },
  ): boolean {
    const group = this.storedNodes.get(id);
    return arr(group?.anchors).some((anchor) => {
      if (!isRecord(anchor) || anchor.at === "base" || anchor.file !== where.file) return false;
      const range = anchor.resolved?.range;
      if (where.range && range)
        return where.range.startLine <= range.endLine && where.range.endLine >= range.startLine;
      if (where.symbol !== undefined && anchor.symbol !== undefined)
        return where.symbol === anchor.symbol || where.symbol.startsWith(`${anchor.symbol}.`);
      return anchor.symbol === undefined && anchor.span === undefined;
    });
  }

  // ─── Labels ───────────────────────────────────────────────────────────────────────────────────

  /**
   * Display label of any element id: a node's label, a stored edge's / concept's / step's label, the
   * kind of a derived edge, else the id.
   */
  label(id: ElementId): string {
    const ref = this.element(id);
    if (!ref) return id;
    switch (ref.type) {
      case "node":
        return ref.node.label;
      case "edge":
        return ref.edge.label || ref.edge.kind;
      case "derived-edge":
        return ref.kind;
      case "concept":
        return ref.concept.label;
      case "step":
        return ref.step.label;
    }
  }

  // ─── Internals ────────────────────────────────────────────────────────────────────────────────

  private buildNode(id: ElementId): ModelNode | undefined {
    const parsed = parseId(id);
    const stored = this.storedNodes.get(id);
    const repoName = this.explainer.repo?.name ?? "repo";
    let base: ModelNode;
    switch (parsed.type) {
      case "repo":
        base = derived(id, "repo", repoName, null, stored);
        break;
      case "dir":
        if (!this.index.hasDirectory(parsed.path)) return undefined;
        base = derived(id, "dir", baseName(parsed.path), this.parent(id) ?? REPO_ID, stored);
        break;
      case "file":
        if (!this.index.hasFile(parsed.path)) return undefined;
        base = derived(id, "file", baseName(parsed.path), this.parent(id) ?? REPO_ID, stored);
        break;
      case "symbol": {
        const sym = this.index.symbol(parsed.symbolId);
        if (!sym) return undefined;
        base = derived(id, "symbol", symbolLabel(sym), this.parent(id) ?? REPO_ID, stored);
        base.symbolKind = sym.kind;
        break;
      }
      case "group": {
        const group = this.groupNodes.get(id);
        if (!group) return undefined;
        return {
          ...group,
          kind: "group",
          parent: this.parent(id) ?? REPO_ID,
          members: this.members(id) as string[],
          anchors: arr(group.anchors),
          provenance: group.provenance ?? STATIC,
          stored: true,
          structural: false,
        };
      }
      default:
        return undefined;
    }
    return base;
  }
}

/** A structural node from the index, with the stored overlay (label, summary, detail, anchors, provenance) on top. */
function derived(
  id: ElementId,
  kind: Node["kind"],
  label: string,
  parent: ElementId | null,
  stored: Node | undefined,
): ModelNode {
  const node: ModelNode = {
    id,
    kind,
    label: stored && typeof stored.label === "string" && stored.label !== "" ? stored.label : label,
    parent,
    anchors: stored ? arr(stored.anchors) : [],
    provenance: stored?.provenance ?? STATIC,
    stored: stored !== undefined,
    structural: true,
  };
  if (stored?.summary !== undefined) node.summary = stored.summary;
  if (stored?.detail !== undefined) node.detail = stored.detail;
  if (stored?.members !== undefined) node.members = stored.members;
  if (stored?.role !== undefined) node.role = stored.role;
  if (stored?.tech !== undefined) node.tech = stored.tech;
  if (stored?.opens !== undefined) node.opens = stored.opens;
  return node;
}

/** The elements of a stored list that are objects with a string id (skips junk in hand-edited files). */
function records<T extends { id: string }>(value: readonly T[] | undefined): T[] {
  return arr(value).filter((x) => isRecord(x) && typeof x.id === "string");
}

/** The array, or an empty one when a hand-edited explainer lacks the field. Treat as read-only. */
function arr<T>(value: readonly T[] | undefined): T[] {
  return Array.isArray(value) ? (value as T[]) : [];
}
