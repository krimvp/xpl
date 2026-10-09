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
 *  10. GraphView adds `excludeFiles` (glob patterns on repo paths): derived edges and stubs ignore the
 *      references that start or end in a matching file (test files in an overview, say).
 *  11. GraphView adds `stubs` ({ mode, max }): how many of the places where the view stops are drawn as
 *      ghost boxes. Default: the 8 most referenced, with the rest folded into "N more".
 *  12. Edge adds `via` (what the link passes through without a box); an llm edge's evidence is then per hop.
 *  13. A flow step's `next` links (FlowLink) add `kind`: "recurse" (one level down) or "return" (up one level,
 *      to `step` or, without one, the caller).
 *  14. SequenceView adds `layout` ("code-first" or "diagram"): how Read and Explore lay the view out.
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
 * file gets "~2", "~3", … appended, in source order. Config keys (YAML/JSON/TOML) are dotted key paths,
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

/** Versioned hash of source with CRLF canonicalized to LF, e.g. "sha256-v2:3f1a9c…". */
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
  /** Shared identities for optional symbol/reference provenance. Absent on legacy indexes. */
  providers?: AnalysisProvenance[];
  resources?: ResourceReference[];
  /** Provider abilities and observed run coverage. Absent on legacy indexes: coverage is unknown. */
  analysis?: AnalysisReport[];
  /**
   * Set when this index was cut down for a bundle (`xpl bundle` embeds a pruned one by default, see
   * `pruneIndex`): how many files, symbols and references the full index had. Every file entry is kept, so
   * `files` only repeats `files.length`; `symbols.length` and `refs.length` say what is left, and `languages`
   * still describes the full index. Absent on a complete index (everything `xpl index` writes).
   */
  pruned?: { files: number; symbols: number; refs: number };
}

/** Independent source claims and relationship kinds that an analyzer can check. */
export type AnalysisCapability =
  "fileAnchors" | "symbols" | "declarationRanges" | "nesting" | Reference["kind"];
/** Missing keys mean unsupported, never inferred from symbols or references. */
export type AnalysisCapabilities = Partial<Record<AnalysisCapability, "supported" | "partial">>;
export interface AnalysisResult {
  /** Relationship resolution, including empty results. Absent on legacy/structural results: unknown. */
  resolution?: Reference["resolution"];
  /** Capabilities with the same observed outcome, grouped to avoid repeating file lists. */
  capabilities: AnalysisCapability[];
  status: "supported" | "partial" | "unsupported" | "failed";
  analyzedFiles: FilePath[];
  /** Reader-facing limits; no tool commands, paths to executables, or stack traces. */
  limitations: string[];
}
export interface AnalysisReport {
  /** Stable provider id; labels the source of each reader-facing coverage result. */
  provider: string;
  /** Optional on legacy indexes. Adapter version and reuse identities for the analyzed snapshot. */
  version?: string;
  configuration?: string;
  snapshot?: string;
  /** Advertised abilities, separate from the results of this run. */
  capabilities: AnalysisCapabilities;
  /** Files in scope, including those not analyzed or whose analysis failed. */
  files: FilePath[];
  results: AnalysisResult[];
  /** Diagnostic detail for authors. Reader summaries use only the results' limitations. */
  diagnostics?: string[];
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
   * extracted for this language (e.g. yaml, json, toml, text).
   * This is a coarse compatibility label; independent support and run coverage live in `analysis`.
   */
  refs: "precise" | "heuristic" | "none";
  /** Tool that produced the references, e.g. "scip-typescript@0.4.0". */
  tool?: string;
  /**
   * Only with `refs: "precise"`: how many files of this language keep the heuristic resolver's references
   * because the precise tool did not describe them (excluded by build constraints or by the tool's own
   * configuration, unreadable, ...). Other files may also keep heuristic kinds a precise provider cannot
   * check. Read each reference's resolution and the analysis reports. Absent when the tool described every file.
   */
  heuristicFiles?: number;
}

/**
 * (amended) Values of `IndexedFile.language`. Files with an unknown extension are "text", so
 * file-relative anchors work anywhere.
 */
export type FileLanguage =
  | "typescript"
  | "tsx"
  | "javascript"
  | "python"
  | "go"
  | "java"
  | "rust"
  | "ruby"
  | "php"
  | "yaml"
  | "json"
  /** TOML config (`pyproject.toml`, `Cargo.toml`): keys are symbols, like YAML and JSON. */
  | "toml"
  | "text";

export interface IndexedFile {
  path: FilePath;
  /** (amended) See FileLanguage. */
  language: FileLanguage;
  /** Hash of the whole file. */
  hash: Hash;
  lines: number;
}

/** The analyzer that supplied a checked fact. Optional on legacy indexes. */
export interface AnalysisProvenance {
  id: string;
  version: string;
}

export interface IndexedSymbol {
  /** Position in SymbolIndex.providers. */
  provider?: number;
  id: SymbolId;
  file: FilePath;
  path: SymbolPath;
  /**
   * (amended) Adds "enum" and "key". "key" is a config key (YAML/JSON/TOML key); `path` is then
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
  /** Position in SymbolIndex.providers. */
  provider?: number;
  /**
   * (amended) Innermost symbol enclosing `site`, or the file's module scope ("<file>#", empty
   * symbol path) for top-level code.
   */
  from: SymbolId;
  /** (amended) Referenced symbol, or a module scope ("<file>#") for whole-module imports. */
  to: SymbolId;
  /** `read` includes function values/callback registration; only an invocation is a `call`. */
  kind: "call" | "import" | "extends" | "implements" | "type-ref" | "read" | "write";
  site: Range;
  /**
   * (amended) How `to` was determined. "precise": a SCIP indexer resolved it. "heuristic": the
   * scope-aware tree-sitter resolver guessed it; the viewer draws such edges lighter and Claude
   * treats them as hints.
   */
  resolution: "precise" | "heuristic";
}

export interface ResourceReference {
  from: SymbolId;
  files: FilePath[];
  kind: "loads" | "discovers" | "configures" | "overrides";
  site: Range;
  pattern?: string;
  resolution: "static" | "inferred";
}

// ─── Anchors ────────────────────────────────────────────────────────────────────────────────────

/**
 * A pointer into code, resolved by (file, symbol). `span` narrows to lines relative to the
 * symbol's first line, so edits above the symbol don't break it. Without `symbol`, span is
 * relative to the file (use for config files and other symbol-less text).
 */
export interface Anchor {
  /**
   * For a base anchor (`at: "base"`): the changed file's `ChangedFile.path` (for a renamed file the new path; a
   * patch may name the old one, it is stored as the new one), the key of `ViewerBundle.baseFiles`.
   */
  file: FilePath;
  /**
   * `"base"`: the anchor points at the code before the change, the base commit of `Explainer.change`
   * (read with `git show <base>:<file>`). It has no `symbol` (there is no index of the base commit): its
   * `span` counts from line 1 of the base file, and `resolved.range` and `resolved.commit` are lines and
   * commit of the base. Only allowed in a changed file that has a base version (modified, renamed,
   * deleted). Absent: the current code (the head), like every other anchor.
   */
  at?: "base";
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
  /**
   * Groups only: what the group clusters. Members keep their structural parent. A group with a `role` may
   * have none: an outside system (a database, an external API) is not code in the repo, so its box is
   * anchored at the code that talks to it (its `anchors`) instead.
   */
  members?: ElementId[];
  /**
   * (amended) What the box is in the architecture, for architecture maps (a system map, the inside of one
   * service). The viewer draws each role with its own shape (a cylinder for a database, a dashed box for
   * an outside system) and names the role instead of the kind of code. Absent: a box of code.
   */
  role?: NodeRole;
  /** (amended) The technology, in 1-3 words ("PostgreSQL", "REST API", "Go service"). Shown on the box. */
  tech?: string;
  /**
   * (amended) A view that shows what is inside this box: the next level down (a service's components, a
   * component's code). The viewer opens it when the reader zooms into the box, and shows the way back.
   */
  opens?: string;
}

/**
 * (amended) The role of a box on an architecture map (`Node.role`), in the spirit of the C4 model: a
 * system map shows people, services and data stores; the map of one service shows its components.
 *
 * - `person`: a user or another team that uses the system.
 * - `system`: a whole system, yours or a neighbour's, drawn as one box.
 * - `service`: a program that runs on its own (a web server, a worker, a CLI).
 * - `component`: a part of a service with one responsibility (handlers, domain logic, a client).
 * - `database`, `cache`, `queue`, `storage`: where data is kept or passed on.
 * - `external`: a system outside the repo that the code calls (a payment API, an identity provider).
 */
export type NodeRole =
  | "person"
  | "system"
  | "service"
  | "component"
  | "database"
  | "cache"
  | "queue"
  | "storage"
  | "external";

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
    | "loads"
    | "discovers"
    | "configures"
    | "overrides"
    | "custom";
  /**
   * (amended) "A reaches C through B": elements (nodes: symbols, files, groups) the link passes through, in
   * order, that the view does not draw as boxes. The map draws one arrow from `from` to `to`, marked "via B".
   * Evidence of an llm edge with `via` is per hop (`from` → via[0] → … → `to`): a hop that the index shows (a
   * reference from inside one end to inside the other) needs no anchors; any other hop needs an anchor inside
   * each of its two ends, like an llm edge without `via`.
   */
  via?: ElementId[];
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
  /**
   * (amended) Glob patterns on repo-relative paths, e.g. `["*_test.go", "test/**"]`: a double star crosses
   * directories, `*` stays inside one path segment, `?` is one character, and a pattern without a slash also
   * matches the file name at any depth (see glob.ts). Derived edges and stubs are computed without the
   * references that start or end in a matching file, so an edge that exists only through test files
   * disappears, and so does a stub that leads only to them. What is not filtered: nodes in `include` (they
   * always show, and so do the edges of a file or symbol the view includes by name), stored (llm/user)
   * edges, and the references of files that do not match.
   */
  excludeFiles?: string[];
  /**
   * (amended) How many of the places where the view stops are drawn: a ghost box for what lies outside,
   * with dashed stubs from the boxes that reach it. Default when omitted: `{ mode: "top", max: 8 }`, so
   * a crowded view stays readable (see StubPolicy).
   */
  stubs?: StubPolicy;
  /** Finite positions relative to the rendered container's stable origin (canvas for roots).
   * Negative children expand the frame around that origin. Everything else is auto-laid-out. */
  layout?: Record<ElementId, { x: number; y: number }>;
}

/**
 * (amended) The stub policy of a graph view (`GraphView.stubs`): how many ghost boxes it draws where it
 * stops. Every reference or stored edge with exactly one end in the view is a stub; the ghost is what it
 * leads to.
 *
 * - `"top"` (the default): at most `max` ghosts, the ones most references lead to. Outside symbols that
 *   live in a file the view shows only in part are folded into one "rest of <file>" ghost per file
 *   (`ghost:rest:file:<path>`), and the ghosts beyond `max` into one "N more" ghost per direction
 *   (`ghost:more:in`, `ghost:more:out`). A folded ghost is not expanded by one click: it offers the
 *   elements it stands for, each with its reference count, and adding one of them expands the view.
 * - `"all"`: every ghost, one per outside element, however many that are (a crowded view).
 * - `"none"`: no stubs and no ghosts; edges that leave the view are simply not drawn.
 */
export interface StubPolicy {
  /** Default `"top"`. */
  mode?: "top" | "all" | "none";
  /**
   * With `mode: "top"`: how many ghosts are kept, most referenced first (ties by id), before the rest are
   * folded away. A whole number, 0 or more; default 8.
   */
  max?: number;
}

/** A sequence diagram: ordered messages between lifelines. */
export interface SequenceView extends ViewBase {
  type: "sequence" | "flow";
  /** Lifelines, left to right. */
  participants: ElementId[];
  steps: SequenceStep[];
  frames?: SequenceFrame[];
  /**
   * (amended) How Read and Explore lay the view out. `"code-first"`: the code is the main pane and the diagram
   * a narrow outline beside it that follows the selection and the caret (made for the steps of one function).
   * `"diagram"`: the diagram is the main pane. Absent: code-first when the view has at least 3 steps and
   * every step's code (current, not base anchors) is in one file, else the diagram.
   */
  layout?: "code-first" | "diagram";
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
  shape?: "stage" | "decision" | "terminal";
  next?: FlowLink[];
  /** The edge this message instantiates, if any. */
  edge?: ElementId;
  anchors: Anchor[];
  summary?: string;
}

/**
 * A transition of a flow step (`SequenceStep.next`): to `step`, taken when `label` says.
 *
 * (amended) `kind` marks a transition that changes the level of a recursive function:
 * - `"recurse"`: the step calls the function again, and the steps from `step` (an earlier step, often the
 *   first of the function) run again, one level down. It does not end the step: a step whose `next` has only
 *   recurse links still goes on to the next step in the list.
 * - `"return"`: the call returns, back up one level, and the caller goes on at `step` (the step that made the
 *   call, or the step that uses the result). Without `step`, back to whoever made the call: the step that
 *   recursed one level up, or at the top the code that first called the function (drawn as an arrow out of
 *   the step). A terminal step may have return links.
 * Absent: an ordinary transition, at the same level.
 */
export interface FlowLink {
  /** The step it goes to; only a `return` link may leave it out (back to the caller). */
  step?: string;
  label?: string;
  kind?: "recurse" | "return";
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
  /**
   * What the tour is about, in 2-4 sentences of markdown: what it is, why it matters (for a change: what
   * changes in behaviour, the risk, the tests). Readers see it first, under the tour title. Optional; `null`
   * in a patch clears it.
   */
  summary?: string;
  steps: TourStep[];
  /**
   * (amended) Who made the tour and what the user edited on it, like every other element. An `llm` patch never
   * changes or removes a tour with `origin: "user"` (one made in the viewer's tour panel), nor a field listed in
   * `userFields` (`title`, `summary`, `steps`) of a tour the user edited, nor removes a tour that carries
   * `userFields`.
   * Optional: a tour without it (written before tours had provenance) counts as `origin: "llm"`.
   */
  provenance?: Provenance;
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

/** Exact stored content and evidence inspected by an author; no implicit runtime coverage. */
export interface ReviewScope {
  /** All stored content, or non-empty node/edge/concept/view/tour IDs (not their dependencies). */
  content: "all" | string[];
  /** Attached anchors only, or also the full indexed file manifest. */
  source: "anchored" | "repository";
  /** Additional whole indexed files explicitly inspected. */
  files?: FilePath[];
}

export interface ReviewFingerprint {
  version: "xpl-review@1";
  contentHash: Hash;
  evidenceHash: Hash;
}

/** Self-reported author inspection, not authenticated identity or automatic semantic verification. */
export interface ReviewRecord {
  reviewer: string;
  reviewedAt: string;
  scope: ReviewScope;
  omissions: string[];
  fingerprint: ReviewFingerprint;
  /** Index commit at recording time. Narrow reviews can remain current across later commits. */
  sourceCommit: string;
}

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
  /** (amended) Who the page is for and how deep it goes: shown under the title. */
  scope?: ExplainerScope;
  /** Absent on legacy explainers: unchecked. Written only by user patches. */
  review?: ReviewRecord;
  /**
   * The change this explainer is about (a PR or MR), when there is one: written by `xpl change <name>
   * <base>..<head>`, never by patches. `head` is the commit the index was built from.
   */
  change?: ChangeRecord;
  nodes: Node[];
  edges: Edge[];
  concepts: Concept[];
  views: View[];
  tours: Tour[];
}

/** (amended) The explainer as a whole (`Explainer.scope`); not a view's `Scope`. */
export interface ExplainerScope {
  /**
   * One short line: who the page is for and at what level ("Overview, for anyone new to ky", "Deep dive, for
   * engineers working on chi's router"). The viewer shows it under the title; absent, it shows nothing.
   */
  audience?: string;
}

// ─── Change record (Explainer.change) ───────────────────────────────────────────────────────────

/** The change between two commits, as git computes it (`git diff -M`). */
export interface ChangeRecord {
  /** Full commit SHA of the code before the change. */
  base: string;
  /** Full commit SHA of the code after the change: the commit the index was built from. */
  head: string;
  /** Every changed file, in git's order (sorted by path). */
  files: ChangedFile[];
}

export interface ChangedFile {
  /** Path at head; for a deleted file the path it had at base. */
  path: FilePath;
  status: "added" | "modified" | "deleted" | "renamed";
  /** Renamed files only: the path at base. */
  oldPath?: FilePath;
  /** `git diff -U0` hunks: 1-based lines as git prints them (`@@ -oldStart,oldLines +newStart,newLines @@`). */
  hunks: ChangeHunk[];
}

/**
 * One hunk of a diff without context lines. `oldLines` lines starting at `oldStart` in the base were replaced by
 * `newLines` lines starting at `newStart` in the head. A count of 0 means a pure insertion or deletion; the start is
 * then the line after which it happened (git's convention).
 */
export interface ChangeHunk {
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
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
 * - Stubs: edges from an included node to a non-included one, drawn to ghost boxes (by default the 8 most
 *   referenced; the others are folded, see StubPolicy). Clicking a ghost expands it, or offers what it folds.
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
