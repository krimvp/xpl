# Code Explainer — handoff

Self-contained brief for starting the build. Everything decided so far is here. The schema and a worked example are inlined at the bottom (Appendix A and B), so no other files are needed.

**Status:** design done, schema draft v0 passes `tsc --strict`. Nothing built yet. Krimmy (the user) agreed to proceed on this design but hasn't reviewed the schema line by line: treat it as a strong draft, not frozen.

**Working style:** concise answers; push back and argue instead of agreeing by default.

## 1. The idea

A Claude skill that generates interactive code explainers:

- Diagrams (box-and-arrow and sequence) plus a list of concepts, next to a built-in code editor.
- Click a box, an arrow or a concept → the editor focuses the relevant code: unrelated files and lines are greyed out, relevant ranges are highlighted, across one or more files.
- Reverse: select code → the matching diagram elements and concepts light up.

It replaces Krimmy's current routine when presenting code: walk through the architecture, then hunt for the right files and snippets by hand.

## 2. Requirements (from the user)

- **Two uses, both needed:** exploring unfamiliar code alone, and preparing presentations.
- **Scope is chosen each time:** a slice driven by a question ("how does X work"), the whole repo, or anything in between. Scope is a setting, not a mode.
- **Everything is clickable in both directions:** diagram components, sequence-diagram arrows and concepts → code, and code → those elements.

## 3. Decisions

### Architecture

- **Generator and viewer are separate.** The skill outputs data. The viewer is one fixed, versioned app that reads it. Claude never regenerates the UI per explainer.
- **Two data files per repo:** a symbol index per commit (static analysis, built once) and an explainer file (what Claude and the user add on top). Only store what can't be derived from the index.
- **Static analysis first, LLM on top.** The index provides structure and call edges; Claude groups, names and explains. Claude-made edges are only for what static analysis can't see (event bus, dependency injection, HTTP, queues), and each needs evidence anchors at both ends.
- **Claude can't invent code.** Every anchor Claude writes must resolve against the index, or the write is rejected.

### Anchoring and change

- **Anchor** = file + symbol path + optional line span relative to the symbol + content hash. Absolute line ranges are only a cache.
- **Re-resolving on a new commit** gives each anchor a status: `ok` / `moved` / `drifted` / `missing`. Only Claude-made elements with drifted anchors get re-explained. Missing anchors are surfaced, never dropped silently.
- **Provenance on every element:** `static` / `llm` / `user`. Elements with origin `user`, and any field listed in `userFields`, are never overwritten on regeneration.
- **Stable IDs:** derived from paths (`file:…`, `sym:…`), slugs for groups and Claude-made edges. Sequence-step IDs are never renumbered, because tours point at them.

### Views and navigation

- **One view recipe covers every scope:** `{ root, depth, question?, entryPoints? }`. Whole repo is `{ root: "repo", depth: 1 }`.
- **A view's `include` list is the source of truth** for what's shown. If a node and its children are both included, the node renders as a container.
- **Stubs** (dashed edges leaving the view) mark where a view stops. Clicking one expands the view by adding nodes to `include`. Zooming out and slicing are the same mechanism. Stubs are derived, not stored.
- **Whole-repo views start coarse** (packages or services) and the user drills in.
- **Explanations are lazy.** The index is built up front; summaries are generated when a node is first opened, then cached.
- **Sequence steps are clickable elements** with their own anchors: the exact call site plus the callee's definition, so clicking highlights both files. Frames (`loop` / `alt` / `opt` / `par`) span ranges of steps.

### Viewer

- **Two modes over the same data:**
  - *Explore:* full diagram, expandable stubs, click anywhere, code→element lookup on.
  - *Present:* tour steps, arrow-key navigation, large focus view, file tree hidden.
- **Tours** are ordered focus states stored in the same explainer file. A useful exploration becomes a talk by adding a tour; nothing is rebuilt.
- **Code focus of a selection** = the union of its anchors. A structural node without anchors falls back to its symbol range, its whole file, or its files (for a directory).
- **Reverse lookup** = interval index over resolved anchor ranges. The innermost range wins; ties highlight all matches.

### Skill interface (proposed)

- `explain <question | repo>` → creates a view
- `expand <node>` → grows a view
- `make tour` → turns a view into a presentation

### Rendering

- Mermaid's click hooks only work on nodes, not sequence-diagram arrows. Use a renderer with stable element IDs, e.g. ELK or D2 for layout plus our own SVG.
- Editor: Monaco decorations for dimming and highlighting. CodeMirror 6 is the lighter alternative.

### Build order

- **Exploration before presentation.** Exploration forces the hard part (accurate mappings) to be good. Presentation mode is then mostly tours plus regeneration that keeps user edits. Starting with presentation would let bad mappings be hand-fixed and hide a weak generator.

### Prior art

None of these links diagrams and code in both directions:

- **CodeTour:** step-by-step walkthroughs, no diagrams.
- **Swimm:** docs anchored to code.
- **CodeSee:** code maps; absorbed into GitKraken.

## 4. Open questions

1. **Indexer.** tree-sitter works for any language but only approximates which function a call resolves to. SCIP or LSP give real references but need one indexer per language. This decides how trustworthy the "static" edges are; settle it before building the viewer.
2. **Code with no symbols** (YAML, long top-level scripts). Spans then fall back to file-relative lines, which break easily. Likely needs another anchor kind, e.g. a key path for YAML.
3. **Prototype target.** No repo or language chosen yet. Use a repo Krimmy knows well, so he can judge whether the mappings are right.
4. **Viewer packaging** (not discussed yet): one self-contained HTML file with sources bundled, or a local dev server that reads the repo.

## 5. Suggested first steps

1. **Fixture repo.** Create a tiny real repo that matches the example: `src/runner.ts`, `src/queue.ts`, `src/worker.ts`, `src/metrics.ts`, `config/default.yaml`, `test/retry.test.ts`. Then correct the example's spans and hashes so every anchor resolves against real code.
2. **Indexer v0** on the fixture: produce `index-<commit>.json` matching `SymbolIndex`, plus the anchor resolver (`ok` / `moved` / `drifted` / `missing`) and the validation rules at the bottom of the schema.
3. **Viewer v0** on fixture + index + example: graph view, sequence view, multi-file editor, click → dim and highlight, select code → highlight elements. Acceptance checks:
   - Clicking step `dispatch:3` highlights the `requeue` call inside `Runner.dispatch` and the `Queue.requeue` definition, and dims everything else.
   - Cursor on the `requeue` call (offsets 34–36 in `Runner.dispatch`) highlights `dispatch:3`, the innermost match. Cursor elsewhere in the retry block (offsets 30–33) highlights `concept:retry-policy`.
4. **Generator skill:** `explain <question>` writes views and elements into the explainer file and passes validation.
5. **Then:** stubs and expand, tours and present mode, regeneration on a new commit.

## Appendix A — `explainer-schema.ts`

```ts
/**
 * Code Explainer — data schema, draft v0
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

/** Dot-separated path inside a file, e.g. "Runner.dispatch". */
export type SymbolPath = string;

/** `${FilePath}#${SymbolPath}`, e.g. "src/runner.ts#Runner.dispatch". */
export type SymbolId = string;

/** Hash of normalised text (trimmed lines), e.g. "sha256:3f1a9c…". */
export type Hash = string;

/** 1-based, inclusive. */
export interface Range {
  startLine: number;
  endLine: number;
  startCol?: number;
  endCol?: number;
}

export type Origin =
  | "static" // mechanical fact from the index
  | "llm"    // Claude's interpretation: grouping, naming, "this handles retries"
  | "user";  // written by you; never overwritten

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
  /** e.g. "tree-sitter@0.22", "scip-typescript@0.3" */
  tool: string;
  files: IndexedFile[];
  symbols: IndexedSymbol[];
  refs: Reference[];
}

export interface IndexedFile {
  path: FilePath;
  language: string;
  hash: Hash;
  lines: number;
}

export interface IndexedSymbol {
  id: SymbolId;
  file: FilePath;
  path: SymbolPath;
  kind: "class" | "interface" | "function" | "method" | "type" | "variable" | "other";
  range: Range;
  hash: Hash;
  parent?: SymbolId;
}

/** `from` mentions `to` at `site` (a range in from's file). Raw material for static edges. */
export interface Reference {
  from: SymbolId;
  to: SymbolId;
  kind: "call" | "import" | "extends" | "implements" | "type-ref" | "read" | "write";
  site: Range;
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
  /** 0-based line offsets from the symbol's start, inclusive. Omit = whole symbol / file. */
  span?: { from: number; to: number };
  role: AnchorRole;
  /** Hash of the anchored text when last resolved; how drift is detected. */
  hash: Hash;
  /** Resolution cache. Rewritten on every re-resolve; never hand-edited. */
  resolved?: { commit: string; range: Range; status: AnchorStatus };
}

export type AnchorRole =
  | "definition" // where the thing lives
  | "call-site"  // where it's invoked (arrows)
  | "usage"      // other notable references
  | "config"     // config/env that shapes behaviour
  | "test";      // tests that exercise it

export type AnchorStatus =
  | "ok"      // found, text unchanged
  | "moved"   // found at a new range, text unchanged
  | "drifted" // found, text changed; explanation may be stale
  | "missing";// symbol gone; fix or drop explicitly

// ─── Elements (everything clickable) ────────────────────────────────────────────────────────────

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
  kind: "calls" | "imports" | "extends" | "implements" | "reads" | "writes" | "emits" | "custom";
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
  /** The index this file was last resolved against. */
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
 *   file→file when files are shown). Anchors: the ref sites + the target's definition.
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
```

## Appendix B — `example.explainer.ts`

```ts
import type { Explainer } from "./explainer-schema";

/**
 * A small job runner. Shows: a group node, an explained symbol with a user-edited summary,
 * an llm edge static analysis can't see (event bus), a concept, a whole-repo graph view,
 * a question-driven sequence view with a retry loop, and a two-step tour.
 * Structural nodes and static edges (e.g. runner → queue calls) are NOT stored; the viewer
 * derives them from the index.
 */
export const example = {
  schema: "code-explainer@0",
  title: "Job runner",
  repo: { name: "acme/jobrunner", commit: "a1b2c3d" },
  index: { path: ".explainer/index-a1b2c3d.json", commit: "a1b2c3d" },

  nodes: [
    {
      id: "grp:scheduling",
      kind: "group",
      parent: "repo",
      label: "Scheduling",
      summary: "Decides which job runs next and hands it to a free worker.",
      members: ["file:src/runner.ts", "file:src/queue.ts"],
      anchors: [],
      provenance: { origin: "llm", commit: "a1b2c3d" },
    },
    {
      id: "sym:src/runner.ts#Runner.dispatch",
      kind: "symbol",
      parent: "file:src/runner.ts",
      label: "Runner.dispatch",
      summary: "The hot loop: pop, lease a worker, run, ack or requeue.",
      anchors: [
        {
          file: "src/runner.ts",
          symbol: "Runner.dispatch",
          role: "definition",
          hash: "sha256:3f1a9c",
          resolved: {
            commit: "a1b2c3d",
            range: { startLine: 42, endLine: 88 },
            status: "ok",
          },
        },
      ],
      provenance: { origin: "llm", userFields: ["summary"], commit: "a1b2c3d" },
    },
  ],

  edges: [
    {
      id: "edge:job-completed",
      from: "file:src/worker.ts",
      to: "file:src/metrics.ts",
      kind: "emits",
      label: "job.completed",
      summary: "Worker publishes on the event bus; metrics subscribes. Invisible to the call graph.",
      anchors: [
        { file: "src/worker.ts", symbol: "Worker.run", span: { from: 21, to: 21 }, role: "call-site", hash: "sha256:77c0de" },
        { file: "src/metrics.ts", symbol: "onJobCompleted", role: "definition", hash: "sha256:b41d02" },
      ],
      provenance: { origin: "llm", commit: "a1b2c3d" },
    },
  ],

  concepts: [
    {
      id: "concept:retry-policy",
      label: "Retry policy",
      summary: "Failed jobs are requeued with exponential backoff up to maxRetries, then dead-lettered.",
      anchors: [
        { file: "src/runner.ts", symbol: "Runner.dispatch", span: { from: 30, to: 41 }, role: "definition", hash: "sha256:9e0f11" },
        { file: "config/default.yaml", span: { from: 12, to: 15 }, role: "config", hash: "sha256:c3aa70" },
        { file: "test/retry.test.ts", role: "test", hash: "sha256:5d6e8f" },
      ],
      related: ["sym:src/runner.ts#Runner.dispatch", "file:src/queue.ts"],
      provenance: { origin: "user" },
    },
  ],

  views: [
    {
      id: "view:overview",
      type: "graph",
      title: "Overview",
      scope: { root: "repo", depth: 1 },
      include: ["grp:scheduling", "file:src/worker.ts", "file:src/metrics.ts"],
      provenance: { origin: "llm", commit: "a1b2c3d" },
    },
    {
      id: "view:dispatch",
      type: "sequence",
      title: "How a job is dispatched",
      scope: {
        root: "repo",
        depth: 3,
        question: "How does a job get from the queue to a worker?",
        entryPoints: ["src/runner.ts#Runner.dispatch"],
      },
      participants: [
        "sym:src/runner.ts#Runner.dispatch",
        "file:src/queue.ts",
        "file:src/worker.ts",
      ],
      steps: [
        {
          id: "dispatch:1",
          from: "sym:src/runner.ts#Runner.dispatch",
          to: "file:src/queue.ts",
          label: "pop()",
          kind: "call",
          anchors: [
            { file: "src/runner.ts", symbol: "Runner.dispatch", span: { from: 4, to: 4 }, role: "call-site", hash: "sha256:0a1b2c" },
            { file: "src/queue.ts", symbol: "Queue.pop", role: "definition", hash: "sha256:3d4e5f" },
          ],
        },
        {
          id: "dispatch:2",
          from: "sym:src/runner.ts#Runner.dispatch",
          to: "file:src/worker.ts",
          label: "run(job)",
          kind: "call",
          anchors: [
            { file: "src/runner.ts", symbol: "Runner.dispatch", span: { from: 18, to: 19 }, role: "call-site", hash: "sha256:6a7b8c" },
            { file: "src/worker.ts", symbol: "Worker.run", role: "definition", hash: "sha256:9d0e1f" },
          ],
        },
        {
          id: "dispatch:3",
          from: "sym:src/runner.ts#Runner.dispatch",
          to: "file:src/queue.ts",
          label: "requeue(job, backoff)",
          kind: "call",
          anchors: [
            { file: "src/runner.ts", symbol: "Runner.dispatch", span: { from: 34, to: 36 }, role: "call-site", hash: "sha256:2a3b4c" },
            { file: "src/queue.ts", symbol: "Queue.requeue", role: "definition", hash: "sha256:5d6e7f" },
          ],
        },
      ],
      frames: [
        { id: "frame:retry", kind: "loop", label: "until success or maxRetries", fromStep: "dispatch:2", toStep: "dispatch:3" },
      ],
      provenance: { origin: "llm", commit: "a1b2c3d" },
    },
  ],

  tours: [
    {
      id: "tour:intro",
      title: "Intro talk",
      steps: [
        {
          id: "t1",
          view: "view:overview",
          focus: ["grp:scheduling"],
          note: "Big picture first: scheduling is two files.",
        },
        {
          id: "t2",
          view: "view:dispatch",
          focus: ["dispatch:3", "concept:retry-policy"],
          note: "Where failures go: requeue with backoff.",
          editor: { primary: "src/runner.ts" },
        },
      ],
    },
  ],
} satisfies Explainer;
```
