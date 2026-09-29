/**
 * The stub policy (ARCHITECTURE.md section 4.4): how a graph view draws the places where it stops.
 *
 * A reference (or stored edge) with exactly one end in the view is a *stub*; the box it leads to is a
 * *ghost*. Left alone, every outside element gets its own ghost, and a view of a dozen boxes can end up
 * with sixty of them. `planStubs` bounds that:
 *
 *   - outside symbols that live in a file the view shows only in part are folded into one "rest of
 *     <file>" ghost per file (`ghost:rest:file:<path>`);
 *   - the ghosts are ranked by the references that lead to them, and only the first `max` (default 8) stay;
 *     the others are folded into one overflow ghost per direction (`ghost:more:in`, `ghost:more:out`).
 *
 * A folded ghost stands for several elements (`Ghost.targets`, each with its reference count): expanding
 * it means adding one of them to `include`. `GraphView.stubs` picks the mode (`top`, `all`, `none`).
 * `deriveGraph` (graph.ts) collects the candidates and calls `planStubs`; everything else here is data
 * shapes and the helpers for the ids of folded ghosts.
 */
import { fileId, ghostId, parseId, stubId } from "./ids.js";
import type { ExplainerModel } from "./model.js";
import type { Edge, ElementId, FilePath, IndexedSymbol, Node } from "./schema.js";
import { cmp, isRecord } from "./util.js";

// ─── Output types ───────────────────────────────────────────────────────────────────────────────

/** One element a ghost box stands for: it joins the view when it is added to `include`. */
export interface GhostTarget {
  target: ElementId;
  label: string;
  kind: Node["kind"];
  /** For symbols: the indexed symbol's kind. */
  symbolKind?: IndexedSymbol["kind"];
  /** References (and stored edges) that cross the edge of the view there. */
  count: number;
  kinds: Edge["kind"][];
}

/**
 * A ghost box: where a view stops. A *target* ghost is one element outside the view (clicking it adds
 * that element); a *rest* ghost stands for the outside symbols of a file the view shows in part, a *more*
 * ghost for everything that did not make the cut of `stubs.max`.
 */
export interface Ghost {
  /** Render id: `ghost:<key>`. */
  id: ElementId;
  /**
   * What the stubs to this ghost carry as `Stub.ghost`: the element the ghost stands for (a target ghost),
   * `rest:file:<path>`, or `more:in` / `more:out`.
   */
  key: string;
  kind: "target" | "rest" | "more";
  label: string;
  /** Target ghosts: the element that joins the view when the ghost is expanded (`key`). */
  target?: ElementId;
  /** Every kind that leaves or enters the view there. */
  kinds: Edge["kind"][];
  /** Number of references (and stored edges) that lead here. */
  count: number;
  /** `in` when every stub enters the view there, `out` when every stub leaves it, else `both`. */
  direction: "in" | "out" | "both";
  /** What it stands for, most referenced first. A target ghost has exactly one. */
  targets: GhostTarget[];
}

/** A dashed edge to a ghost box: where a view stops. */
export interface Stub {
  /** `stub:<in|out>:<inside>->ghost:<ghost>`. */
  id: ElementId;
  direction: "in" | "out";
  /** The rendered node the stub attaches to. */
  inside: ElementId;
  /**
   * The ghost the stub leads to (`Ghost.key`): for a target ghost the element it stands for, which
   * `expandStub` adds to `include`; for a folded ghost `rest:file:<path>`, `more:in` or `more:out` (not an
   * element: pick one of `targets` instead).
   */
  ghost: string;
  ghostLabel: string;
  /** The elements this stub leads to, most referenced first (one entry for a target ghost). */
  targets: GhostTarget[];
  kinds: Edge["kind"][];
  count: number;
}

// ─── Policy ─────────────────────────────────────────────────────────────────────────────────────

export type StubMode = "top" | "all" | "none";

export const STUB_MODES: readonly StubMode[] = ["top", "all", "none"];
/** The mode of a view without `stubs`. */
export const DEFAULT_STUB_MODE: StubMode = "top";
/** The ghosts kept by `mode: "top"` when `max` is not given. */
export const DEFAULT_STUB_MAX = 8;

export interface ResolvedStubPolicy {
  mode: StubMode;
  max: number;
}

/** `GraphView.stubs` with the defaults filled in; anything that is not a mode or a count is ignored. */
export function resolveStubPolicy(value: unknown): ResolvedStubPolicy {
  const given = isRecord(value) ? value : {};
  const mode = STUB_MODES.find((m) => m === given.mode) ?? DEFAULT_STUB_MODE;
  const max = given.max;
  return {
    mode,
    max:
      typeof max === "number" && Number.isFinite(max) && max >= 0
        ? Math.floor(max)
        : DEFAULT_STUB_MAX,
  };
}

// ─── Ids of folded ghosts ───────────────────────────────────────────────────────────────────────

export const MORE_IN = "more:in";
export const MORE_OUT = "more:out";

/** `rest:file:<path>`: the key of the ghost for what a partly shown file holds outside the view. */
export const restGhostKey = (path: FilePath): string => `rest:file:${path}`;
/** `more:in` / `more:out`: the key of the overflow ghost of a direction. */
export const moreGhostKey = (direction: "in" | "out"): string =>
  direction === "in" ? MORE_IN : MORE_OUT;

export type GhostKeyInfo =
  | { kind: "target"; target: ElementId }
  | { kind: "rest"; path: FilePath; file: ElementId }
  | { kind: "more"; direction: "in" | "out" };

/**
 * What a ghost key (`Stub.ghost`, or the part of a `ghost:<key>` id after the prefix) stands for. Node ids
 * start with `repo`, `dir:`, `file:`, `sym:` or `grp:`, so `rest:` and `more:` cannot be mistaken for them.
 */
export function parseGhostKey(key: string): GhostKeyInfo {
  if (key === MORE_IN) return { kind: "more", direction: "in" };
  if (key === MORE_OUT) return { kind: "more", direction: "out" };
  if (key.startsWith("rest:file:") && key.length > "rest:file:".length) {
    const path = key.slice("rest:file:".length);
    return { kind: "rest", path, file: fileId(path) };
  }
  return { kind: "target", target: key };
}

/** True for the keys of folded ghosts: they are not elements, so they cannot be added to a view. */
export function isFoldedGhostKey(key: string): boolean {
  return parseGhostKey(key).kind !== "target";
}

// ─── The plan ───────────────────────────────────────────────────────────────────────────────────

/** Stubs of one `(direction, inside, target)` before any folding: `target` is what a plain ghost would be. */
export interface StubCandidate {
  direction: "in" | "out";
  inside: ElementId;
  /** The highest structural ancestor of the outside end that holds no node of the view (or a group). */
  target: ElementId;
  kinds: ReadonlySet<Edge["kind"]>;
  count: number;
}

export interface StubPlanOptions {
  model: ExplainerModel;
  policy: ResolvedStubPolicy;
  /** True for an element that holds a node of the view (or is a member of an included group). */
  covered(id: ElementId): boolean;
  /** `view.hidden`: node, ghost and stub ids. */
  hidden: ReadonlySet<string>;
}

interface Item extends StubCandidate {
  /** The ghost after folding symbols into their file. */
  key: string;
  /** The ghost it is drawn with: `key`, or an overflow ghost. */
  final: string;
}

function foldKey(target: ElementId, opts: StubPlanOptions): string {
  const parsed = parseId(target);
  if (parsed.type === "symbol") {
    const file = opts.model.index.symbol(parsed.symbolId)?.file ?? parsed.file;
    return opts.covered(fileId(file)) ? restGhostKey(file) : target;
  }
  return parsed.type === "file" && opts.covered(target) ? restGhostKey(parsed.path) : target;
}

/** Removed by `hidden` before the ranking: a hidden box, ghost or stub frees its place for the next one. */
function hiddenEarly(item: Item, opts: StubPlanOptions): boolean {
  const { hidden } = opts;
  if (hidden.size === 0) return false;
  const parsed = parseGhostKey(item.key);
  return (
    hidden.has(item.inside) ||
    hidden.has(item.target) ||
    hidden.has(ghostId(item.target)) ||
    hidden.has(ghostId(item.key)) ||
    hidden.has(stubId(item.direction, item.inside, item.target)) ||
    hidden.has(stubId(item.direction, item.inside, item.key)) ||
    (parsed.kind === "rest" && hidden.has(parsed.file))
  );
}

function targetsOf(items: readonly Item[], model: ExplainerModel): GhostTarget[] {
  const byTarget = new Map<ElementId, { count: number; kinds: Set<Edge["kind"]> }>();
  for (const item of items) {
    const entry = byTarget.get(item.target) ?? { count: 0, kinds: new Set() };
    entry.count += item.count;
    item.kinds.forEach((kind) => entry.kinds.add(kind));
    byTarget.set(item.target, entry);
  }
  const out: GhostTarget[] = [];
  for (const [target, entry] of byTarget) {
    const node = model.node(target);
    const info: GhostTarget = {
      target,
      label: model.label(target),
      kind: node?.kind ?? "symbol",
      count: entry.count,
      kinds: [...entry.kinds].sort(cmp),
    };
    if (node?.symbolKind !== undefined) info.symbolKind = node.symbolKind;
    out.push(info);
  }
  return out.sort((a, b) => b.count - a.count || cmp(a.label, b.label) || cmp(a.target, b.target));
}

const sum = (items: readonly Item[]): number => items.reduce((n, item) => n + item.count, 0);

function kindsOf(items: readonly Item[]): Edge["kind"][] {
  const kinds = new Set<Edge["kind"]>();
  for (const item of items) item.kinds.forEach((kind) => kinds.add(kind));
  return [...kinds].sort(cmp);
}

/**
 * Decides which ghosts a view draws and which stubs lead to them (see the header). `mode: "none"` draws
 * none; `"all"` one plain ghost per candidate target; `"top"` folds the symbols of partly shown files
 * (and a partly shown file itself) into `rest:file:<path>`, keeps the `max` ghosts with the most
 * references (ties by key) and folds the others into `more:in` / `more:out`, by the direction of their
 * stubs. Hidden ids (`view.hidden`) are honoured on the way: before the ranking for boxes, ghosts and
 * stubs as they are without folding, afterwards for the overflow ghosts. Both lists are sorted by id.
 */
export function planStubs(
  candidates: readonly StubCandidate[],
  opts: StubPlanOptions,
): { stubs: Stub[]; ghosts: Ghost[] } {
  const { model, policy, hidden } = opts;
  if (policy.mode === "none") return { stubs: [], ghosts: [] };

  let items: Item[] = [];
  for (const candidate of candidates) {
    const key = policy.mode === "top" ? foldKey(candidate.target, opts) : candidate.target;
    const item: Item = { ...candidate, key, final: key };
    if (!hiddenEarly(item, opts)) items.push(item);
  }

  if (policy.mode === "top") {
    const totals = new Map<string, number>();
    for (const item of items) totals.set(item.key, (totals.get(item.key) ?? 0) + item.count);
    if (totals.size > policy.max) {
      const kept = new Set(
        [...totals]
          .sort((a, b) => b[1] - a[1] || cmp(a[0], b[0]))
          .slice(0, policy.max)
          .map(([key]) => key),
      );
      for (const item of items) if (!kept.has(item.key)) item.final = moreGhostKey(item.direction);
      items = items.filter(
        (item) =>
          item.final === item.key ||
          !(
            hidden.has(ghostId(item.final)) ||
            hidden.has(stubId(item.direction, item.inside, item.final))
          ),
      );
    }
  }

  // Ghosts, by the key they are drawn with.
  const byGhost = new Map<string, Item[]>();
  for (const item of items) {
    const list = byGhost.get(item.final);
    if (list) list.push(item);
    else byGhost.set(item.final, [item]);
  }
  const ghosts: Ghost[] = [];
  for (const [key, list] of byGhost) {
    const targets = targetsOf(list, model);
    const directions = new Set(list.map((item) => item.direction));
    const info = parseGhostKey(key);
    const ghost: Ghost = {
      id: ghostId(key),
      key,
      kind: info.kind,
      label:
        info.kind === "target"
          ? model.label(info.target)
          : info.kind === "rest"
            ? `rest of ${model.label(info.file)}`
            : `+${targets.length} more`,
      kinds: kindsOf(list),
      count: sum(list),
      direction: directions.size === 2 ? "both" : directions.has("in") ? "in" : "out",
      targets,
    };
    if (info.kind === "target") ghost.target = info.target;
    ghosts.push(ghost);
  }
  disambiguateRestLabels(ghosts);
  ghosts.sort((a, b) => cmp(a.id, b.id));
  const labelOf = new Map(ghosts.map((ghost) => [ghost.key, ghost.label] as const));

  // Stubs: one per (direction, inside, ghost).
  const byStub = new Map<string, Item[]>();
  for (const item of items) {
    const id = stubId(item.direction, item.inside, item.final);
    const list = byStub.get(id);
    if (list) list.push(item);
    else byStub.set(id, [item]);
  }
  const stubs: Stub[] = [];
  for (const [id, list] of byStub) {
    const first = list[0]!;
    stubs.push({
      id,
      direction: first.direction,
      inside: first.inside,
      ghost: first.final,
      ghostLabel: labelOf.get(first.final) ?? first.final,
      targets: targetsOf(list, model),
      kinds: kindsOf(list),
      count: sum(list),
    });
  }
  stubs.sort((a, b) => cmp(a.id, b.id));
  return { stubs, ghosts };
}

/**
 * Two files with the same name (`__init__.py`) would both read "rest of __init__.py": such labels take as
 * many trailing path segments as it needs to tell them apart.
 */
function disambiguateRestLabels(ghosts: Ghost[]): void {
  const rest = ghosts.filter((ghost) => ghost.kind === "rest");
  const seen = new Map<string, Ghost[]>();
  for (const ghost of rest) seen.set(ghost.label, [...(seen.get(ghost.label) ?? []), ghost]);
  for (const group of seen.values()) {
    if (group.length < 2) continue;
    const segments = group.map((ghost) => {
      const info = parseGhostKey(ghost.key);
      return info.kind === "rest" ? info.path.split("/") : [];
    });
    for (let depth = 2; ; depth++) {
      const labels = segments.map((parts) => parts.slice(-depth).join("/"));
      const longest = Math.max(...segments.map((parts) => parts.length));
      if (new Set(labels).size === labels.length || depth >= longest) {
        group.forEach((ghost, i) => (ghost.label = `rest of ${labels[i]}`));
        break;
      }
    }
  }
}
