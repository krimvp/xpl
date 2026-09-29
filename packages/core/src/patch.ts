/**
 * Patch-side types (ARCHITECTURE.md sections 2 and 4.7). Never stored: `applyPatch` turns a patch into
 * stored elements. What Claude writes carries `AnchorInput`s (no hashes, no line numbers from memory);
 * `applyPatch` validates them against the index and fills in hash and `resolved`.
 *
 * Merge semantics (see `applyPatch` in apply.ts):
 *
 * - Elements, views and tours are upserted by `id`.
 * - An id that exists: the patch is shallow-merged onto it. Fields absent from the patch keep their
 *   values, arrays and nested objects (`members`, `include`, `steps`, `layout`, `scope`, ...) are
 *   replaced wholesale, and `null` clears an optional field (`summary`, `detail`, `members`,
 *   `related`, `edgeKinds`, `hidden`, `layout`, `frames`). In particular a sequence view's `steps` are
 *   sent whole (keep every step id: tours and frames point at them; `remove` deletes single steps).
 * - A new id: the fields that cannot be inferred must be present. Required when creating:
 *   - node: `label` (except for `dir:`/`file:`/`sym:` overlays, whose default label is used) and, for a
 *     group, `members`. `kind` is inferred from the id, `parent` defaults to the structural parent
 *     (`repo` for groups), `anchors` to `[]`.
 *   - edge: `from`, `to`, `kind` and `label` (for an id of the derived form `edge:<kind>:<a>-><b>`
 *     they come from the id and `label` may be omitted).
 *   - concept: `label`.
 *   - graph view: `type`, `title`, `include`. Sequence view: `type`, `title`, `participants`, `steps`.
 *     `scope` defaults to `{ root: "repo", depth: 1 }`.
 *   - tour: `title`, `steps`.
 * - `provenance` is optional. New elements get `{ origin: <actor>, commit: <index commit> }` unless
 *   given; on existing elements it is managed by `applyPatch` (an `llm` patch cannot change it).
 */
import type {
  AnchorRole,
  Concept,
  Edge,
  ElementId,
  FilePath,
  GraphView,
  Hash,
  Node,
  Provenance,
  SequenceStep,
  SequenceView,
  SymbolPath,
  Tour,
  TourStep,
} from "./schema.js";

/** What Claude writes. `applyPatch` turns it into a stored Anchor (hash + resolved filled in). */
export interface AnchorInput {
  file: FilePath;
  /** The symbol's path inside `file` (`Runner.dispatch`), not a symbol id (`src/runner.ts#Runner.dispatch`). */
  symbol?: SymbolPath;
  role: AnchorRole;
  /** 0-based line offsets relative to the symbol's start (or file line 1), inclusive. */
  span?: { from: number; to: number };
  /**
   * Alternative to span (give one of them): text that occurs exactly once in the symbol (or file);
   * may be multi-line. Matched exactly first, then ignoring whitespace differences.
   */
  find?: string;
  /** Optional; if given it must equal the current hash (catches stale drafts). */
  hash?: Hash;
}

type OptionalKeys<T> = { [K in keyof T]-?: {} extends Pick<T, K> ? K : never }[keyof T];

/**
 * A patch of `T`: every field optional (absent keeps the existing value), and `null` allowed on the
 * fields that are optional in `T` (it clears them).
 */
export type PatchFields<T> = {
  [K in keyof T]?: K extends OptionalKeys<T> ? T[K] | null : T[K];
};

/** Provenance in a patch: any subset. Only honoured for new elements and for `user` patches. */
export type PatchProvenance = Partial<Provenance>;

/** A Node as written in a patch: anchors are inputs; `id` is the only required field for an existing node. */
export type PatchNode = {
  id: ElementId;
  anchors?: AnchorInput[];
  provenance?: PatchProvenance;
} & PatchFields<Omit<Node, "id" | "anchors" | "provenance">>;

/** An Edge as written in a patch. */
export type PatchEdge = {
  id: ElementId;
  anchors?: AnchorInput[];
  provenance?: PatchProvenance;
} & PatchFields<Omit<Edge, "id" | "anchors" | "provenance">>;

/** A Concept as written in a patch. */
export type PatchConcept = {
  id: ElementId;
  anchors?: AnchorInput[];
  provenance?: PatchProvenance;
} & PatchFields<Omit<Concept, "id" | "anchors" | "provenance">>;

/** A GraphView as written in a patch (`type` is required so the union can be told apart). */
export type PatchGraphView = {
  id: string;
  type: "graph";
  provenance?: PatchProvenance;
} & PatchFields<Omit<GraphView, "id" | "type" | "provenance">>;

/** A SequenceStep as written in a patch. Step ids are kept and never renumbered. */
export interface PatchSequenceStep extends Omit<SequenceStep, "anchors"> {
  /** Default `[]`. */
  anchors?: AnchorInput[];
}

/** A SequenceView as written in a patch: `steps` (replaced wholesale) carry `AnchorInput`s. */
export type PatchSequenceView = {
  id: string;
  type: "sequence";
  provenance?: PatchProvenance;
  steps?: PatchSequenceStep[];
} & PatchFields<Omit<SequenceView, "id" | "type" | "provenance" | "steps">>;

export type PatchView = PatchGraphView | PatchSequenceView;

/**
 * A TourStep as written in a patch: the `code` override takes `AnchorInput`s. A stored `Tour` is
 * assignable to `PatchTour`, so patches may also carry stored anchors.
 */
export interface PatchTourStep extends Omit<TourStep, "code"> {
  code?: AnchorInput[];
}

export type PatchTour = { id: string; steps?: PatchTourStep[] } & PatchFields<
  Omit<Tour, "id" | "steps">
>;

/**
 * Elements/views/tours as in the schema, but with every field optional beyond the id, anchors as
 * `AnchorInput` and provenance optional. See the header of this file for the merge rules.
 */
export interface ExplainerPatch {
  title?: string;
  nodes?: PatchNode[];
  edges?: PatchEdge[];
  concepts?: PatchConcept[];
  views?: PatchView[];
  tours?: PatchTour[];
  /** Element / view / tour / step ids to remove. `llm` patches cannot remove `user` elements. */
  remove?: string[];
}
