/**
 * Patch-side types (ARCHITECTURE.md §2, §4.7). Never stored: `xpl apply` turns a patch into stored
 * elements. What Claude writes carries `AnchorInput`s (no hashes, no line numbers from memory);
 * the CLI validates them against the index and fills in hash + `resolved`.
 */
import type {
  AnchorRole,
  Concept,
  Edge,
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

/** What Claude writes. The CLI turns it into a stored Anchor (hash + resolved filled in). */
export interface AnchorInput {
  file: FilePath;
  symbol?: SymbolPath;
  role: AnchorRole;
  /** 0-based line offsets relative to the symbol's start (or file line 1), inclusive. */
  span?: { from: number; to: number };
  /** Alternative to span: text that occurs exactly once in the symbol (or file); may be multi-line. */
  find?: string;
  /** Optional; if given it must equal the current hash (catches stale drafts). */
  hash?: Hash;
}

/** A Node as written in a patch: anchors are inputs, provenance is filled in by the CLI. */
export interface PatchNode extends Omit<Node, "anchors" | "provenance"> {
  anchors: AnchorInput[];
  provenance?: Provenance;
}

/** An Edge as written in a patch. */
export interface PatchEdge extends Omit<Edge, "anchors" | "provenance"> {
  anchors: AnchorInput[];
  provenance?: Provenance;
}

/** A Concept as written in a patch. */
export interface PatchConcept extends Omit<Concept, "anchors" | "provenance"> {
  anchors: AnchorInput[];
  provenance?: Provenance;
}

/** A GraphView as written in a patch (it has no anchors of its own). */
export interface PatchGraphView extends Omit<GraphView, "provenance"> {
  provenance?: Provenance;
}

/** A SequenceStep as written in a patch. Step ids are kept and never renumbered. */
export interface PatchSequenceStep extends Omit<SequenceStep, "anchors"> {
  anchors: AnchorInput[];
}

/** A SequenceView as written in a patch: its steps carry `AnchorInput`s. */
export interface PatchSequenceView extends Omit<SequenceView, "steps" | "provenance"> {
  steps: PatchSequenceStep[];
  provenance?: Provenance;
}

export type PatchView = PatchGraphView | PatchSequenceView;

/**
 * A TourStep as written in a patch: the `code` override takes `AnchorInput`s. A stored `Tour` is
 * assignable to `PatchTour`, so patches may also carry stored anchors.
 */
export interface PatchTourStep extends Omit<TourStep, "code"> {
  code?: AnchorInput[];
}

export interface PatchTour extends Omit<Tour, "steps"> {
  steps: PatchTourStep[];
}

/** Elements/views/tours as in the schema, but anchors are AnchorInput and provenance is optional. */
export interface ExplainerPatch {
  title?: string;
  nodes?: PatchNode[];
  edges?: PatchEdge[];
  concepts?: PatchConcept[];
  views?: PatchView[];
  tours?: PatchTour[];
  /** Element / view / tour ids to remove. */
  remove?: string[];
}
