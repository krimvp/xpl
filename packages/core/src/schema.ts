/**
 * Code Explainer — data schema, draft v0
 *
 * Amended by docs/ARCHITECTURE.md §2 (the amendments are marked "(amended)" below):
 *   1. Range lines AND columns are 1-based and inclusive; columns count UTF-16 code units.
 *   2. IndexedSymbol.kind adds "key" (config keys) and "enum".
 *   3. Reference adds `resolution`; from/to may be a module scope id "<file>#".
 *   4. SymbolIndex adds `languages` (LanguageInfo) and an informational `root`.
 *   5. IndexedFile.language is an enumerated set (FileLanguage).
 *   6. Edge.kind adds "references" (lifted type-refs).
 *   7. GraphView adds `edgeKinds` (derived edge kinds shown).
 *   8. Explainer.index.path is repo-root-relative.
 *   9. Symbol ranges exclude leading comments but include decorators/modifiers; Anchor.span
 *      offsets are relative to that start line and must lie inside the symbol.
 *
 * Two files per repo:
 *   index-<commit>.json    SymbolIndex. Static analysis of one commit. Built once, shared by every view.
 *   <name>.explainer.json  Explainer. What Claude and you add on top: labels, explanations, groups,
 *                          edges static analysis can't see, concepts, views, tours.
 *
 * Principles
 *   1. Anchor to symbols, not lines. Line ranges are a cache, re-resolved per commit.
 *   2. Store facts, derive the rest. Structural nodes, static edges, stubs, reverse lookup and
 *      code focus are computed by the viewer from the index (see bottom of file).
 *   3. Every element says who made it (static / llm / user). Regeneration never touches `user`
 *      elements, or fields you edited on other elements.
 *   4. IDs are stable across regenerations: derived from paths where possible, slugs otherwise.
 *   5. Claude can't invent code: every anchor it writes must resolve against the index, and every
 *      llm edge needs evidence anchors at both ends. Otherwise the write is rejected.
 */

// ─── Shared ───────────────────────────────────────────────────────────────────────────────────

/** Repo-relative POSIX path, e.g. "src/runner.ts". */
export type FilePath = string;

/**
 * Dot-separated path inside a file, e.g. "Runner.dispatch". A path that occurs more than once in a
 * file gets "~2", "~3", … appended, in source order. Config keys (YAML/JSON) are dotted key paths,
 * with sequence items addressed by index, e.g. "retry.maxRetries" or "workers.0.name".
 */
export type SymbolPath = string;

/**
 * `${FilePath}#${SymbolPath}`, e.g. "src/runner.ts#Runner.dispatch".
 *
 * (amended) An empty symbol path, "src/runner.ts#", is the file's *module scope*. It appears only as
 * `Reference.from` / `Reference.to` (top-level code, whole-module imports); `SymbolIndex.symbols`
 * has no entry for it.
 */
export type SymbolId = string;

/** Hash of normalised text (trimmed lines), e.g. "sha256:3f1a9c…". */
export type Hash = string;

/**
 * (amended) Lines AND columns are 1-based and inclusive. Columns count UTF-16 code units (JS string
 * indices), not bytes or code points.
 */
export interface Range {
  /** 1-based, inclusive. */
  startLine: number;
  /** 1-based, inclusive. */
  endLine: number;
  /** (amended) 1-based, inclusive, UTF-16 code units. Omitted = the range covers whole lines. */
  startCol?: number;
  /** (amended) 1-based, inclusive, UTF-16 code units. Omitted = the range covers whole lines. */
  endCol?: number;
}

export type Origin =
  | "static" // mechanical fact from the index
  | "llm" // Claude's interpretation: grouping, naming, "this handles retries"
  | "user"; // written by you; never overwritten

export interface Provenance {
  origin: Origin;
  /** Fields you edited on a static/llm element; regeneration leaves them alone. */
  userFields?: string[];
  /** Commit this element was last generated or checked against. */
  commit?: string;
}

// ─── Symbol index (index-<commit>.json) ─────────────────────────────────────────────────────────

export interface SymbolIndex {
  schema: "code-explainer/index@0";
  commit: string;
  /** e.g. "tree-sitter@0.22", "scip-typescript@0.3". Per-language tools: see `languages`. */
  tool: string;
  /**
   * (amended) Per-language summary, keyed by `IndexedFile.language`: how many files and symbols were
   * indexed, and how trustworthy the references are.
   */
  languages: Record<string, LanguageInfo>;
  /**
   * (amended) Absolute path of the directory the index was built from. Informational only: never
   * used for resolution (all paths in the index and in explainers are repo-root-relative).
   */
  root?: string;
  files: IndexedFile[];
  symbols: IndexedSymbol[];
  refs: Reference[];
}

/** (amended) One entry of `SymbolIndex.languages`. */
export interface LanguageInfo {
  /** Number of indexed files of this language. */
  files: number;
  /** Number of symbols extracted from them. */
  symbols: number;
  /**
   * Where this language's references come from. "precise": resolved by a SCIP indexer.
   * "heuristic": scope-aware tree-sitter resolver; treat as hints. "none": no references are
   * extracted for this language (e.g. yaml, json, text).
   */
  refs: "precise" | "heuristic" | "none";
  /** Tool that produced the references, e.g. "scip-typescript@0.4.0". */
  tool?: string;
}

/**
 * (amended) Values of `IndexedFile.language`. Files with an unknown extension are "text", so
 * file-relative anchors work anywhere.
 */
export type FileLanguage =
  "typescript" | "tsx" | "javascript" | "python" | "go" | "yaml" | "json" | "text";

export interface IndexedFile {
  path: FilePath;
  /** (amended) See FileLanguage. */
  language: FileLanguage;
  /** Hash of the whole file. */
  hash: Hash;
  lines: number;
}

export interface IndexedSymbol {
  id: SymbolId;
  file: FilePath;
  path: SymbolPath;
  /**
   * (amended) Adds "enum" and "key". "key" is a config key (YAML/JSON mapping key); `path` is then
   * the dotted key path. Type aliases are "type"; Go structs are "class".
   */
  kind:
    "class" | "interface" | "function" | "method" | "type" | "variable" | "enum" | "key" | "other";
  /**
   * (amended) Excludes leading comments (including doc comments) but includes decorators, `export`
   * and other modifiers. Anchor spans are relative to `range.startLine`.
   */
  range: Range;
  /** Hash of the symbol's full lines. */
  hash: Hash;
  parent?: SymbolId;
}

/** `from` mentions `to` at `site` (a range in from's file). Raw material for static edges. */
export interface Reference {
  /**
   * (amended) Innermost symbol enclosing `site`, or the file's module scope ("<file>#", empty
   * symbol path) for top-level code.
   */
  from: SymbolId;
  /** (amended) Referenced symbol, or a module scope ("<file>#") for whole-module imports. */
  to: SymbolId;
  kind: "call" | "import" | "extends" | "implements" | "type-ref" | "read" | "write";
  site: Range;
  /**
   * (amended) How `to` was determined. "precise": a SCIP indexer resolved it. "heuristic": the
   * scope-aware tree-sitter resolver guessed it; the viewer draws such edges lighter and Claude
   * treats them as hints.
   */
  resolution: "precise" | "heuristic";
}

// ─── Anchors ────────────────────────────────────────────────────────────────────────────────────

/**
 * A pointer into code, resolved by (file, symbol). `span` narrows to lines relative to the
 * symbol's first line, so edits above the symbol don't break it. Without `symbol`, span is
 * relative to the file (use for config files and other symbol-less text).
 */
export interface Anchor {
  file: FilePath;
  symbol?: SymbolPath;
  /**
   * 0-based line offsets, inclusive. Omit = whole symbol / file.
   *
   * (amended) Offsets are relative to the symbol's start line (which excludes leading comments and
   * includes decorators/modifiers; see IndexedSymbol.range), or to file line 1 when `symbol` is
   * absent, and must lie inside the symbol.
   */
  span?: { from: number; to: number };
  role: AnchorRole;
  /** Hash of the anchored text when last resolved; how drift is detected. */
  hash: Hash;
  /** Resolution cache. Rewritten on every re-resolve; never hand-edited. */
  resolved?: { commit: string; range: Range; status: AnchorStatus };
}

export type AnchorRole =
  | "definition" // where the thing lives
  | "call-site" // where it's invoked (arrows)
  | "usage" // other notable references
  | "config" // config/env that shapes behaviour
  | "test"; // tests that exercise it

export type AnchorStatus =
  | "ok" // found, text unchanged
  | "moved" // found at a new range, text unchanged
  | "drifted" // found, text changed; explanation may be stale
  | "missing"; // symbol gone; fix or drop explicitly

// ─── Elements (everything clickable) ────────────────────────────────────────────────────────────

/**
 * Structural: "repo" | "dir:<path>" | "file:<path>" | "sym:<file>#<symbolPath>".
 * Stored: "grp:<slug>" | "concept:<slug>" | "edge:<slug>" (llm/user edges). Derived (never stored):
 * "edge:<kind>:<fromId>-><toId>". Sequence steps share this namespace ("<view-slug>:<n>").
 */
export type ElementId = string;

interface ElementBase {
  id: ElementId;
  label: string;
  /** One or two sentences. Generated lazily when first opened, then cached. */
  summary?: string;
  /** Longer markdown. Also lazy. */
  detail?: string;
  anchors: Anchor[];
  provenance: Provenance;
}

/**
 * A box. The hierarchy is repo → dir → file → symbol, plus groups that cluster things across
 * folders (e.g. "Scheduling" spanning three files).
 *
 * Structural nodes (dir/file/symbol) are derived from the index and only stored here to attach
 * something: a label, an explanation, extra anchors. Groups are always stored.
 *
 * IDs:  "repo" | "dir:src/core" | "file:src/runner.ts" | "sym:src/runner.ts#Runner.dispatch"
 *       | "grp:<slug>"  (slug chosen once, then kept)
 */
export interface Node extends ElementBase {
  kind: "repo" | "dir" | "file" | "symbol" | "group";
  /** Null only for "repo". */
  parent: ElementId | null;
  /** Groups only: what the group clusters. Members keep their structural parent. */
  members?: ElementId[];
}

/**
 * An arrow that static analysis can't produce, or a static one you want to label/explain.
 * Typical llm edges: event bus emit → handler, DI wiring, HTTP client → route, queue producer →
 * consumer. These need anchors at BOTH ends (e.g. emit call-site + handler definition), which
 * is the evidence for the claim.
 *
 * IDs:  "edge:<kind>:<from>-><to>" for static; "edge:<slug>" for llm/user.
 */
export interface Edge extends ElementBase {
  from: ElementId;
  to: ElementId;
  /** (amended) Adds "references": lifted type-refs (`Reference.kind === "type-ref"`). */
  kind:
    | "calls"
    | "imports"
    | "extends"
    | "implements"
    | "references"
    | "reads"
    | "writes"
    | "emits"
    | "custom";
}

/** A cross-cutting idea that isn't one box: "retry policy", "idempotency", "backpressure". */
export interface Concept extends ElementBase {
  /** Diagram elements to co-highlight when the concept is selected. */
  related?: ElementId[];
}

// ─── Views ──────────────────────────────────────────────────────────────────────────────────────

/**
 * How a view was made. "No slice" and "slice" are the same recipe:
 *   whole repo → { root: "repo", depth: 1 }
 *   slice      → { root: "repo", depth: 3, question: "...", entryPoints: [...] }
 */
export interface Scope {
  root: ElementId;
  depth: number;
  question?: string;
  entryPoints?: SymbolId[];
}

interface ViewBase {
  id: string;
  title: string;
  scope: Scope;
  provenance: Provenance;
}

/**
 * A box-and-arrow diagram. `include` is the source of truth for what's shown; `scope` records
 * how it was made so it can be regenerated. If a node and its children are both included, the
 * node renders as a container. Expanding a stub adds nodes to `include`.
 */
export interface GraphView extends ViewBase {
  type: "graph";
  include: ElementId[];
  /**
   * (amended) Which derived (static) edge kinds this view shows. Default when omitted:
   * ["calls", "extends", "implements"] (see DEFAULT_EDGE_KINDS). Stored edges are always shown,
   * whatever their kind.
   */
  edgeKinds?: Edge["kind"][];
  /** Curation: derived nodes/edges you don't want shown here. */
  hidden?: ElementId[];
  /** Positions you pinned by hand; everything else is auto-laid-out. */
  layout?: Record<ElementId, { x: number; y: number }>;
}

/** A sequence diagram: ordered messages between lifelines. */
export interface SequenceView extends ViewBase {
  type: "sequence";
  /** Lifelines, left to right. */
  participants: ElementId[];
  steps: SequenceStep[];
  frames?: SequenceFrame[];
}

/**
 * One arrow in a sequence diagram. Clickable like any element. Anchors are usually the exact
 * call-site in `from` plus the definition in `to`, so clicking highlights both files.
 * IDs must be unique within the explainer and are never renumbered (tours point at them).
 */
export interface SequenceStep {
  id: string;
  from: ElementId;
  to: ElementId;
  label: string;
  kind: "call" | "return" | "async";
  /** The edge this message instantiates, if any. */
  edge?: ElementId;
  anchors: Anchor[];
  summary?: string;
}

/** loop / alt / opt / par block spanning a run of steps. */
export interface SequenceFrame {
  id: string;
  kind: "loop" | "alt" | "opt" | "par";
  label: string;
  fromStep: string;
  toStep: string;
}

export type View = GraphView | SequenceView;

// ─── Tours (presentation) ───────────────────────────────────────────────────────────────────────

export interface Tour {
  id: string;
  title: string;
  steps: TourStep[];
}

export interface TourStep {
  id: string;
  view: string;
  /** Nodes, edges, concepts or sequence steps to highlight. */
  focus: ElementId[];
  /** Override which code is shown. Default: union of the focused elements' anchors. */
  code?: Anchor[];
  /** Caption / speaker note, markdown. */
  note?: string;
  editor?: {
    /** Grey out unfocused code. Default true. */
    dimOthers?: boolean;
    /** Default true in present mode. */
    hideFileTree?: boolean;
    /** File to open first when focus spans several. */
    primary?: FilePath;
  };
}

// ─── Explainer (<name>.explainer.json) ──────────────────────────────────────────────────────────

export interface Explainer {
  schema: "code-explainer@0";
  title: string;
  repo: { name: string; url?: string; commit: string };
  /**
   * The index this file was last resolved against. (amended) `path` is repo-root-relative, e.g.
   * ".explainer/index-wt-3f1a9c2e4b.json"; `commit` is that index's commit id (a short git hash, an
   * explicit `--commit`, or "wt-<hash>" for a dirty work tree).
   */
  index: { path: string; commit: string };
  nodes: Node[];
  edges: Edge[];
  concepts: Concept[];
  views: View[];
  tours: Tour[];
}

/* ───────────────────────────────────────────────────────────────────────────────────────────────
 * Derived by the viewer (never stored)
 *
 * - Structural nodes: every dir/file/symbol in the index is a node ("dir:…", "file:…", "sym:…").
 *   A stored Node with the same id overlays label/summary/anchors on top.
 * - Static edges: index refs lifted to the level a view shows (symbol→symbol calls become
 *   file→file when files are shown), for the kinds in the view's `edgeKinds`. Anchors: the ref
 *   sites + the target's definition. Refs to or from a module scope ("<file>#") lift to the file.
 *   Edges built only from heuristic refs are drawn lighter.
 * - Stubs: edges from an included node to a non-included one. Clicking one expands.
 * - Code focus of a selection: union of its anchors. A structural node with no anchors falls
 *   back to its own range (symbol), whole file (file) or its files (dir).
 * - Reverse lookup (code → elements): interval index over resolved anchor ranges. Innermost
 *   range wins; ties highlight all matches.
 *
 * Regeneration on a new commit
 *   1. Build the new index.
 *   2. Re-resolve every anchor → ok | moved | drifted | missing.
 *   3. Re-explain only llm elements with drifted anchors, skipping userFields and origin "user".
 *   4. Surface missing anchors for fixing; never drop them silently.
 *
 * Validation on every write by Claude
 *   - Every anchor resolves to "ok" against the current index.
 *   - Every referenced ElementId exists in the file or is derivable from the index.
 *   - llm edges carry anchors at both ends.
 * ─────────────────────────────────────────────────────────────────────────────────────────────── */
