/**
 * Graph derivation (ARCHITECTURE.md section 4.4): what a graph view shows, computed from its
 * `include` list, the index and the stored edges. Nodes with their render parents and container
 * flags, derived + stored edges, and stubs with their ghost boxes (edges that leave the view; the
 * policy that keeps them readable is in stubs.ts). Also the pure view edits the viewer applies:
 * expanding a stub, drilling into a node, collapsing one, the default `include`.
 */
import { DEFAULT_EDGE_KINDS } from "./constants.js";
import { globMatcher } from "./glob.js";
import { derivedEdgeId, elementIdForSymbolId, parseId, REF_TO_EDGE_KIND, REPO_ID } from "./ids.js";
import type { IndexModel } from "./index-model.js";
import type { ExplainerModel } from "./model.js";
import type {
  Anchor,
  Edge,
  ElementId,
  GraphView,
  IndexedSymbol,
  Node,
  Range,
  Reference,
  Scope,
  SymbolId,
} from "./schema.js";
import {
  isFoldedGhostKey,
  planStubs,
  resolveStubPolicy,
  type Ghost,
  type Stub,
  type StubCandidate,
} from "./stubs.js";
import { cmp, sortedUnique, unique } from "./util.js";

// ─── Output types ───────────────────────────────────────────────────────────────────────────────

export interface GraphNode {
  id: ElementId;
  label: string;
  kind: Node["kind"];
  /** For symbol nodes: the indexed symbol's kind. */
  symbolKind?: IndexedSymbol["kind"];
  /** Some included node renders inside this one. */
  container: boolean;
  /** The included element this node renders inside (its container), if any. */
  parent?: ElementId;
  /** What the box is in the architecture (`Node.role`), when the explainer says. */
  role?: Node["role"];
  /** Its technology (`Node.tech`). */
  tech?: string;
  /** The view that shows what is inside it (`Node.opens`). */
  opens?: string;
}

/**
 * An edge as drawn in one view: derived from index references (aggregated per kind and pair of
 * represented nodes), or a stored edge (llm / user) lifted to what the view shows.
 */
export interface DerivedEdge {
  /** `edge:<kind>:<from>-><to>` for derived edges, the stored id for stored edges. */
  id: ElementId;
  /** Represented (rendered) ends: included nodes. */
  from: ElementId;
  to: ElementId;
  kind: Edge["kind"];
  label?: string;
  summary?: string;
  /** Number of index references aggregated (1 for a stored edge). */
  count: number;
  /**
   * `precise` when any aggregated reference is precise, else `heuristic`. Stored edges: `llm`,
   * `user` or `static` after their provenance. A stored overlay on a derived id keeps the derived value.
   */
  resolution: "precise" | "heuristic" | "llm" | "user" | "static";
  /** A stored edge exists for this id (a stored edge, or a stored overlay on a derived edge). */
  stored: boolean;
  /** Ref sites (`call-site` for calls, else `usage`) plus the targets' definitions. Never persisted. */
  anchors: Anchor[];
}

export interface DerivedGraph {
  nodes: GraphNode[];
  edges: DerivedEdge[];
  /** Dashed edges to ghost boxes: where the view stops (bounded by the view's stub policy). */
  stubs: Stub[];
  /** The ghost boxes the stubs lead to, sorted by id. */
  ghosts: Ghost[];
}

export interface DeriveOptions {
  /** Overrides `view.edgeKinds` (and the default `calls`, `extends`, `implements`). */
  edgeKinds?: readonly Edge["kind"][];
}

/** Sites and definitions kept per derived edge. */
export const MAX_DERIVED_ANCHORS = 50;

// ─── repr ───────────────────────────────────────────────────────────────────────────────────────

/** Resolves ids to the included element that represents them (section 4.4), memoised per include set. */
class Representation {
  private readonly model: ExplainerModel;
  private readonly include: ReadonlySet<ElementId>;
  private readonly reprMemo = new Map<ElementId, ElementId | undefined>();
  private readonly groupMemo = new Map<ElementId, ElementId | undefined>();

  constructor(model: ExplainerModel, include: ReadonlySet<ElementId>) {
    this.model = model;
    this.include = include;
  }

  /** The nearest included group that (transitively, through nested groups) lists `x` as a member. */
  private includedGroup(x: ElementId): ElementId | undefined {
    if (this.groupMemo.has(x)) return this.groupMemo.get(x);
    let found: ElementId | undefined;
    const seen = new Set<ElementId>([x]);
    let frontier: readonly ElementId[] = this.model.groupIdsContaining(x);
    while (frontier.length > 0 && found === undefined) {
      found = frontier.find((g) => this.include.has(g));
      if (found !== undefined) break;
      const next: ElementId[] = [];
      for (const g of frontier) {
        if (seen.has(g)) continue;
        seen.add(g);
        for (const outer of this.model.groupIdsContaining(g))
          if (!seen.has(outer)) next.push(outer);
      }
      frontier = sortedUnique(next);
    }
    this.groupMemo.set(x, found);
    return found;
  }

  /** `repr(x)`: walk x, parent(x), ... `repo`; at each step the element if included, else the first included group containing it. */
  repr(x: ElementId): ElementId | undefined {
    if (this.reprMemo.has(x)) return this.reprMemo.get(x);
    const result = this.walk(x, false);
    this.reprMemo.set(x, result);
    return result;
  }

  /**
   * The container `x` renders inside: the first included element found walking up from `x`, checking
   * the groups that contain the element at each level (including x's own level) before moving to the
   * structural parent. `x` itself does not count.
   */
  renderParent(x: ElementId): ElementId | undefined {
    return this.walk(x, true);
  }

  private walk(x: ElementId, skipSelf: boolean): ElementId | undefined {
    const seen = new Set<ElementId>();
    for (
      let cur: ElementId | undefined = x;
      cur !== undefined && !seen.has(cur);
      cur = this.model.parent(cur)
    ) {
      seen.add(cur);
      if (!(skipSelf && cur === x) && this.include.has(cur)) return cur;
      const group = this.includedGroup(cur);
      if (group !== undefined && group !== x) return group;
    }
    return undefined;
  }
}

/**
 * `repr(x, include)`: the element of `include` that stands for `x` in a view. Walks `x`, `parent(x)`,
 * ..., `repo`; at each step returns the element if it is included, else the first included group
 * (by id) whose `members` contain it. Undefined: `x` is outside the view.
 */
export function repr(
  x: ElementId,
  include: ReadonlySet<ElementId> | readonly ElementId[],
  model: ExplainerModel,
): ElementId | undefined {
  const set = Array.isArray(include)
    ? new Set<ElementId>(include)
    : (include as ReadonlySet<ElementId>);
  return new Representation(model, set).repr(x);
}

// ─── Derived anchors ────────────────────────────────────────────────────────────────────────────

/**
 * Anchors for a derived edge: each reference site (`call-site` for calls, `usage` otherwise; sorted,
 * at most 50) and each distinct target's definition (symbol range; a module scope means the whole
 * file; at most 50). `hash` is the index's hash for definitions and `""` for sites (no text at hand);
 * `resolved` is `{ commit, range, status: "ok" }`. These anchors are never persisted.
 */
export function derivedEdgeAnchors(refs: readonly Reference[], index: IndexModel): Anchor[] {
  const commit = index.commit;
  interface Site {
    file: string;
    symbol?: string;
    role: Anchor["role"];
    range: Range;
    span: { from: number; to: number };
  }
  const sites: Site[] = [];
  for (const ref of refs) {
    const file = index.fileOfSymbolId(ref.from);
    if (file === undefined) continue;
    const sym = index.symbol(ref.from);
    const base = sym ? sym.range.startLine : 1;
    sites.push({
      file,
      ...(sym ? { symbol: sym.path } : {}),
      role: ref.kind === "call" ? "call-site" : "usage",
      range: { ...ref.site },
      span: {
        from: Math.max(0, ref.site.startLine - base),
        to: Math.max(0, ref.site.endLine - base),
      },
    });
  }
  sites.sort(
    (a, b) =>
      cmp(a.file, b.file) ||
      a.range.startLine - b.range.startLine ||
      (a.range.startCol ?? 0) - (b.range.startCol ?? 0) ||
      a.range.endLine - b.range.endLine ||
      cmp(a.role, b.role),
  );
  const anchors: Anchor[] = [];
  const seen = new Set<string>();
  for (const site of sites) {
    const key = `${site.file}\0${site.range.startLine}\0${site.range.startCol ?? ""}\0${site.range.endLine}\0${site.range.endCol ?? ""}\0${site.role}`;
    if (seen.has(key)) continue;
    seen.add(key);
    anchors.push({
      file: site.file,
      ...(site.symbol !== undefined ? { symbol: site.symbol } : {}),
      span: site.span,
      role: site.role,
      hash: "",
      resolved: { commit, range: site.range, status: "ok" },
    });
    if (anchors.length >= MAX_DERIVED_ANCHORS) break;
  }

  interface Target {
    file: string;
    symbol?: string;
    range: Range;
    hash: string;
  }
  const targets = new Map<SymbolId, Target>();
  for (const ref of refs) {
    if (targets.has(ref.to)) continue;
    const sym = index.symbol(ref.to);
    if (sym) {
      targets.set(ref.to, {
        file: sym.file,
        symbol: sym.path,
        range: { ...sym.range },
        hash: sym.hash,
      });
      continue;
    }
    const file = index.fileOfSymbolId(ref.to);
    const info = file !== undefined ? index.file(file) : undefined;
    if (file !== undefined && info) {
      targets.set(ref.to, {
        file,
        range: { startLine: 1, endLine: info.lines },
        hash: info.hash,
      });
    }
  }
  const ordered = [...targets.values()].sort(
    (a, b) =>
      cmp(a.file, b.file) ||
      a.range.startLine - b.range.startLine ||
      cmp(a.symbol ?? "", b.symbol ?? ""),
  );
  for (const target of ordered.slice(0, MAX_DERIVED_ANCHORS)) {
    anchors.push({
      file: target.file,
      ...(target.symbol !== undefined ? { symbol: target.symbol } : {}),
      role: "definition",
      hash: target.hash,
      resolved: { commit, range: target.range, status: "ok" },
    });
  }
  return anchors;
}

// ─── deriveGraph ────────────────────────────────────────────────────────────────────────────────

interface EdgeAgg {
  kind: Edge["kind"];
  from: ElementId;
  to: ElementId;
  refs: Reference[];
  precise: boolean;
}

interface StubAgg extends StubCandidate {
  kinds: Set<Edge["kind"]>;
}

/**
 * What a graph view shows (section 4.4).
 *
 * - `nodes`: the included nodes that exist, with their render `parent` and `container` flag.
 * - `edges`: index references mapped through `repr` (skipped when an end is outside, when both ends
 *   coincide, or when one end is drawn inside the other: an arrow from a box to its own container says
 *   nothing), aggregated per `(kind, from, to)`, for the kinds in `opts.edgeKinds ?? view.edgeKinds ??
 *   DEFAULT_EDGE_KINDS`; plus every stored edge with both ends through `repr` (whatever its kind, and
 *   under the same rules). A stored edge whose id equals a derived id overlays that edge (label,
 *   summary, anchors).
 * - `stubs` and `ghosts`: references and stored edges with exactly one end inside. The candidate ghost of
 *   a stub is the highest structural ancestor of the outside end, below `repo`, that contains no included
 *   node (a group is its own); one whose end contains the inside node itself is dropped. What is drawn is
 *   then up to `view.stubs` (stubs.ts): by default outside symbols of partly shown files fold into one
 *   `rest:file:<path>` ghost per file and only the 8 most referenced ghosts stay, the others being folded
 *   into `more:in` / `more:out`; `stubs: { mode: "all" }` keeps one ghost per candidate, `"none"` no stubs.
 * - `view.excludeFiles` (glob patterns, see glob.ts) drops the references that start or end in a matching
 *   file before anything is aggregated: an edge or stub that only exists through such files disappears,
 *   the others count only their remaining references. Included nodes are never removed, and the files a
 *   view includes by name (`file:`, or a `sym:` in it, also as a member of an included group) keep their
 *   references. Stored edges are not filtered.
 * - `view.hidden` is applied last: hidden nodes are removed (their children move up to the nearest
 *   visible container), together with the edges and stubs touching them; hidden edge, stub and ghost
 *   ids are removed too (a hidden ghost or stub frees its place among the top ghosts for the next one).
 *
 * Everything is sorted by id.
 */
export function deriveGraph(
  view: GraphView,
  model: ExplainerModel,
  opts: DeriveOptions = {},
): DerivedGraph {
  const index = model.index;
  const kinds = new Set<Edge["kind"]>(opts.edgeKinds ?? view.edgeKinds ?? DEFAULT_EDGE_KINDS);
  const hidden = new Set<string>(Array.isArray(view.hidden) ? view.hidden : []);
  const includeIds = unique(Array.isArray(view.include) ? view.include : []).filter(
    (id) => typeof id === "string" && model.hasNode(id),
  );
  const include = new Set(includeIds);
  const rep = new Representation(model, include);
  const dropRef = excludedRefs(view, model, includeIds);
  const policy = resolveStubPolicy(view.stubs);

  // Nodes with render parents.
  const parents = new Map<ElementId, ElementId>();
  for (const id of includeIds) {
    const parent = rep.renderParent(id);
    if (parent !== undefined && include.has(parent)) parents.set(id, parent);
  }
  breakCycles(parents, [...includeIds].sort(cmp));

  // A box drawn inside another one (any depth) has no arrow to or from it: the arrow would run from the
  // box to its own container (a call from an opened file's child to a sibling that is not shown lifts
  // to the file, say).
  const aboveMemo = new Map<ElementId, ReadonlySet<ElementId>>();
  const above = (id: ElementId): ReadonlySet<ElementId> => {
    let known = aboveMemo.get(id);
    if (!known) {
      const list = new Set<ElementId>();
      for (let cur = parents.get(id); cur !== undefined && !list.has(cur); cur = parents.get(cur))
        list.add(cur);
      aboveMemo.set(id, (known = list));
    }
    return known;
  };
  const nested = (a: ElementId, b: ElementId): boolean => above(a).has(b) || above(b).has(a);

  // Ghost targets need to know which elements have an included node in their subtree.
  let covered: Set<ElementId> | undefined;
  const coveredSet = (): Set<ElementId> => {
    if (covered) return covered;
    covered = new Set();
    const mark = (id: ElementId, visited: Set<ElementId>) => {
      if (visited.has(id)) return;
      visited.add(id);
      covered!.add(id);
      for (const ancestor of model.ancestors(id)) covered!.add(ancestor);
      for (const member of model.members(id)) mark(member, visited);
    };
    const visited = new Set<ElementId>();
    for (const id of includeIds) mark(id, visited);
    return covered;
  };
  const ghostMemo = new Map<ElementId, ElementId>();
  const ghostTarget = (outside: ElementId): ElementId => {
    const known = ghostMemo.get(outside);
    if (known !== undefined) return known;
    let target = outside;
    if (model.node(outside)?.kind !== "group") {
      const set = coveredSet();
      for (const ancestor of model.ancestors(outside)) {
        if (ancestor === REPO_ID || set.has(ancestor)) break;
        target = ancestor;
      }
    }
    ghostMemo.set(outside, target);
    return target;
  };

  const edgeAggs = new Map<ElementId, EdgeAgg>();
  const stubAggs = new Map<string, StubAgg>();
  const rejectedStubs = new Set<string>();
  const addStub = (
    direction: "in" | "out",
    inside: ElementId,
    outside: ElementId,
    kind: Edge["kind"],
  ) => {
    const target = ghostTarget(outside);
    const key = `${direction}\0${inside}\0${target}`;
    let agg = stubAggs.get(key);
    if (!agg) {
      if (rejectedStubs.has(key)) return;
      // An outside end that holds the inside node (a stored edge to its own file, say) is no place to stop.
      if (model.subtreeContains(target, inside) || model.subtreeContains(inside, target)) {
        rejectedStubs.add(key);
        return;
      }
      agg = { direction, inside, target, kinds: new Set(), count: 0 };
      stubAggs.set(key, agg);
    }
    agg.kinds.add(kind);
    agg.count++;
  };
  const endpoint = (id: SymbolId): ElementId | undefined =>
    index.fileOfSymbolId(id) === undefined ? undefined : elementIdForSymbolId(id);

  for (const ref of index.refs) {
    const kind = REF_TO_EDGE_KIND[ref.kind];
    if (!kind || !kinds.has(kind)) continue;
    const fromEl = endpoint(ref.from);
    const toEl = endpoint(ref.to);
    if (fromEl === undefined || toEl === undefined) continue;
    if (dropRef?.(ref)) continue;
    const a = rep.repr(fromEl);
    const b = rep.repr(toEl);
    if (a !== undefined && b !== undefined) {
      if (a === b || nested(a, b)) continue;
      const id = derivedEdgeId(kind, a, b);
      let agg = edgeAggs.get(id);
      if (!agg) {
        agg = { kind, from: a, to: b, refs: [], precise: false };
        edgeAggs.set(id, agg);
      }
      agg.refs.push(ref);
      if (ref.resolution === "precise") agg.precise = true;
    } else if (a !== undefined) addStub("out", a, toEl, kind);
    else if (b !== undefined) addStub("in", b, fromEl, kind);
  }

  const edges = new Map<ElementId, DerivedEdge>();
  for (const [id, agg] of edgeAggs) {
    edges.set(id, {
      id,
      from: agg.from,
      to: agg.to,
      kind: agg.kind,
      count: agg.refs.length,
      resolution: agg.precise ? "precise" : "heuristic",
      stored: false,
      anchors: derivedEdgeAnchors(agg.refs, index),
    });
  }

  // Stored edges: overlay a derived edge with the same id, else shown as their own edge.
  const seenStored = new Set<ElementId>();
  // Stored edges lifted to a box that stands for their ends (a service box on a system map, for the
  // edges of its components): one arrow per pair of boxes and kind, which carries the anchors of all.
  const lifted = new Map<string, DerivedEdge>();
  for (const stored of [...model.storedEdges].sort((a, b) => cmp(a.id, b.id))) {
    if (typeof stored.id !== "string" || seenStored.has(stored.id)) continue;
    seenStored.add(stored.id);
    const derived = edges.get(stored.id);
    if (derived) {
      derived.stored = true;
      if (stored.label) derived.label = stored.label;
      if (stored.summary) derived.summary = stored.summary;
      if (Array.isArray(stored.anchors) && stored.anchors.length > 0)
        derived.anchors = stored.anchors;
      continue;
    }
    if (!model.hasNode(stored.from) || !model.hasNode(stored.to)) continue;
    const a = rep.repr(stored.from);
    const b = rep.repr(stored.to);
    if (a !== undefined && b !== undefined) {
      if (a === b || nested(a, b)) continue;
      const edge: DerivedEdge = {
        id: stored.id,
        from: a,
        to: b,
        kind: stored.kind,
        count: 1,
        resolution:
          stored.provenance?.origin === "llm"
            ? "llm"
            : stored.provenance?.origin === "user"
              ? "user"
              : "static",
        stored: true,
        anchors: Array.isArray(stored.anchors) ? stored.anchors : [],
      };
      if (stored.label) edge.label = stored.label;
      if (stored.summary) edge.summary = stored.summary;
      if (a !== stored.from || b !== stored.to) {
        const key = `${edge.kind}\0${a}\0${b}`;
        const first = lifted.get(key);
        if (first) {
          first.count += 1;
          first.anchors = [...first.anchors, ...edge.anchors];
          // several labels make none: the arrow then says what kind it is, and how many it stands for
          if (first.label !== edge.label) delete first.label;
          delete first.summary;
          continue;
        }
        lifted.set(key, edge);
      }
      edges.set(stored.id, edge);
    } else if (a !== undefined) addStub("out", a, stored.to, stored.kind);
    else if (b !== undefined) addStub("in", b, stored.from, stored.kind);
  }

  // Hidden: applied after derivation.
  const visibleParent = (id: ElementId): ElementId | undefined => {
    let cur = parents.get(id);
    const seen = new Set<ElementId>();
    while (cur !== undefined && hidden.has(cur) && !seen.has(cur)) {
      seen.add(cur);
      cur = parents.get(cur);
    }
    return cur !== undefined && hidden.has(cur) ? undefined : cur;
  };
  const visibleIds = includeIds.filter((id) => !hidden.has(id)).sort(cmp);
  const finalParent = new Map<ElementId, ElementId>();
  for (const id of visibleIds) {
    const parent = visibleParent(id);
    if (parent !== undefined) finalParent.set(id, parent);
  }
  const containers = new Set(finalParent.values());
  const nodes: GraphNode[] = visibleIds.map((id) => {
    const node = model.node(id)!;
    const out: GraphNode = {
      id,
      label: node.label,
      kind: node.kind,
      container: containers.has(id),
    };
    if (node.symbolKind !== undefined) out.symbolKind = node.symbolKind;
    if (node.role !== undefined) out.role = node.role;
    if (node.tech !== undefined) out.tech = node.tech;
    if (node.opens !== undefined) out.opens = node.opens;
    const parent = finalParent.get(id);
    if (parent !== undefined) out.parent = parent;
    return out;
  });

  const outEdges = [...edges.values()]
    .filter((e) => !hidden.has(e.id) && !hidden.has(e.from) && !hidden.has(e.to))
    .sort((a, b) => cmp(a.id, b.id));
  const { stubs, ghosts } = planStubs([...stubAggs.values()], {
    model,
    policy,
    covered: (id) => coveredSet().has(id),
    hidden,
  });
  return { nodes, edges: outEdges, stubs, ghosts };
}

/**
 * The `excludeFiles` filter of a view: true for a reference that starts or ends in an excluded file that
 * the view does not include by name. Undefined when the view excludes nothing.
 */
export function excludedRefs(
  view: GraphView,
  model: ExplainerModel,
  includeIds: readonly ElementId[],
): ((ref: Reference) => boolean) | undefined {
  const matches = globMatcher(view.excludeFiles);
  if (!matches) return undefined;
  const index = model.index;
  // Files the view names itself: through `file:`/`sym:` ids, and through the members of included groups.
  const named = new Set<string>();
  const seen = new Set<ElementId>();
  const visit = (id: ElementId): void => {
    if (seen.has(id)) return;
    seen.add(id);
    const parsed = parseId(id);
    if (parsed.type === "file") named.add(parsed.path);
    else if (parsed.type === "symbol") {
      const file = index.fileOfSymbolId(parsed.symbolId);
      if (file !== undefined) named.add(file);
    } else if (parsed.type === "group") for (const member of model.members(id)) visit(member);
  };
  for (const id of includeIds) visit(id);
  const dropped = new Map<string, boolean>();
  const isDropped = (file: string | undefined): boolean => {
    if (file === undefined) return false;
    let known = dropped.get(file);
    if (known === undefined) {
      known = matches(file) && !named.has(file);
      dropped.set(file, known);
    }
    return known;
  };
  return (ref) =>
    isDropped(index.fileOfSymbolId(ref.from)) || isDropped(index.fileOfSymbolId(ref.to));
}

/** Removes parent links that would form a cycle (nested groups that contain each other). */
function breakCycles(parents: Map<ElementId, ElementId>, order: readonly ElementId[]): void {
  for (const start of order) {
    const path = new Set<ElementId>();
    for (let cur: ElementId | undefined = start; cur !== undefined; cur = parents.get(cur)) {
      if (path.has(cur)) {
        parents.delete(cur);
        break;
      }
      path.add(cur);
    }
  }
}

// ─── View edits ─────────────────────────────────────────────────────────────────────────────────

/** Elements a node opens into: a group's members, otherwise its structural children. */
export function drillChildren(model: ExplainerModel, id: ElementId): ElementId[] {
  return model.node(id)?.kind === "group" ? [...model.members(id)] : model.children(id);
}

/**
 * `include += stub.ghost` (returns `view` itself when it is already included). A folded ghost (`rest:file:...`,
 * `more:in`, `more:out`) is not an element and expands nothing: add one of the targets it stands for
 * (`stub.targets[i].target`, or `Ghost.targets`), which is what `expandStub(view, { ghost: target })` does.
 */
export function expandStub(view: GraphView, stub: Pick<Stub, "ghost">): GraphView {
  return isFoldedGhostKey(stub.ghost) || view.include.includes(stub.ghost)
    ? view
    : { ...view, include: [...view.include, stub.ghost] };
}

/**
 * `include += children of id`, so the node becomes a container (a group opens into its members).
 * `id` itself is included too when it was not. Returns `view` itself when nothing changes.
 */
export function drillIn(view: GraphView, id: ElementId, model: ExplainerModel): GraphView {
  if (!model.hasNode(id)) return view;
  const present = new Set(view.include);
  const add: ElementId[] = [];
  for (const candidate of [id, ...drillChildren(model, id)]) {
    if (!present.has(candidate) && model.hasNode(candidate)) {
      present.add(candidate);
      add.push(candidate);
    }
  }
  return add.length === 0 ? view : { ...view, include: [...view.include, ...add] };
}

/** Removes the included descendants of `id` (structural subtree; for a group: its members' subtrees). */
export function collapse(view: GraphView, id: ElementId, model: ExplainerModel): GraphView {
  const include = view.include.filter((other) => other === id || !model.subtreeContains(id, other));
  return include.length === view.include.length ? view : { ...view, include };
}

/**
 * The chain of single-child directories that starts at `id` (`repo` or a `dir:`): `["dir:src",
 * "dir:src/flask"]` when `src/` holds nothing but `src/flask/`, and so on down to the first directory that
 * holds a file or several things. `[id]` for anything else. A chain is one level of a project, not
 * several: `defaultInclude` counts it once, and an outline can mark it (`dir:src -> dir:src/flask`).
 */
export function singleChildChain(model: ExplainerModel, id: ElementId): ElementId[] {
  const chain = [id];
  for (;;) {
    const last = chain[chain.length - 1]!;
    const kind = model.node(last)?.kind;
    if (kind !== "repo" && kind !== "dir") break;
    const children = model.children(last);
    const only = children.length === 1 ? children[0]! : undefined;
    if (only === undefined || model.node(only)?.kind !== "dir") break;
    chain.push(only);
  }
  return chain;
}

/**
 * The default `include` for a scope: the nodes exactly `depth` levels under `root`, plus shallower
 * leaves (files and symbols without children). `depth` 0 is the root itself. Order: breadth first,
 * in structural order (directories, then files; symbols by position). A chain of single-child directories
 * (`src/` that holds only `src/flask/`, see `singleChildChain`) counts as one level: the node shown for it
 * is the end of the chain (`dir:src/flask`), so a src layout does not put a whole project into one box;
 * the same goes for a `root` that starts such a chain.
 */
export function defaultInclude(scope: Scope, model: ExplainerModel): ElementId[] {
  const root = scope.root ?? REPO_ID;
  if (!model.hasNode(root)) return [];
  const depth = Math.max(0, Math.floor(scope.depth ?? 1));
  if (depth === 0) return [root];
  const chainEnd = (id: ElementId): ElementId => singleChildChain(model, id).at(-1)!;
  const out: ElementId[] = [];
  let level: ElementId[] = [chainEnd(root)];
  for (let d = 1; d <= depth && level.length > 0; d++) {
    const next: ElementId[] = [];
    for (const id of level) {
      for (const child of drillChildren(model, id)) {
        const shown = chainEnd(child);
        if (d === depth || drillChildren(model, shown).length === 0) out.push(shown);
        else next.push(shown);
      }
    }
    level = next;
  }
  return out.length === 0 ? [root] : unique(out);
}
