/**
 * The viewer bundle (`ViewerBundle`, ARCHITECTURE.md §5) shared by `xpl bundle` (inlined into the HTML)
 * and `xpl view` (injected into `GET /`, served at `GET /api/bundle`): which source files go in
 * (`collectFiles`: the referenced files, optionally with a boundary of neighbours, `boundaryFiles`), and how much
 * of the symbol index (`embedIndex`, which `xpl bundle` uses).
 */
import { lstatSync } from "node:fs";
import { join } from "node:path";
import {
  BUNDLE_SCHEMA,
  ExplainerModel,
  baseVersionFiles,
  basePathOf,
  headPathsOf,
  REF_TO_EDGE_KIND,
  codeFocus,
  collectAnchors,
  deriveGraph,
  derivedEdgeAnchors,
  derivedEdgeMap,
  elementIdForSymbolId,
  excludedRefs,
  isTestFile,
  parseId,
  pruneIndex,
  repr,
  relatedFiles,
  viewCandidates,
  type DerivedGraph,
  type Explainer,
  type FocusOptions,
  type GraphView,
  type IndexModel,
  type Reference,
  type SymbolId,
  type SymbolIndex,
  type TextCache,
  type ViewerBundle,
} from "@xpl/core";

export type FilesChoice = "all" | "referenced" | "boundary";

/**
 * The files the viewer needs for this explainer, i.e. every file whose code something in it can show:
 *
 * - the files of every anchor (elements, sequence steps, tour `code` overrides) and the `editor.primary` of tour
 *   steps;
 * - the code of what the views draw (`codeFocus` of a view's candidates, as the viewer computes it): the files of
 *   the nodes a graph view includes (a directory or group: its files, as many as the viewer focuses at most), of
 *   the sites and definitions behind its derived edges, and of a sequence view's participants and steps;
 * - the code of what a tour step can focus;
 * - the dashed stubs of every graph view, one hop out (`deriveGraph`'s stubs): what the viewer shows when one is
 *   clicked, i.e. the sites of the references that cross the edge of the view there and what they lead to
 *   (see `stubFiles`; `opts.stubs: false` leaves them out, for a viewer that fetches files on demand).
 */
export function referencedFiles(
  explainer: Explainer,
  index: IndexModel,
  opts: { stubs?: boolean } = {},
): string[] {
  const model = new ExplainerModel(explainer, index);
  const files = new Set<string>();
  for (const site of collectAnchors(explainer)) files.add(site.anchor.file);
  const focusOptions = new Map<string, FocusOptions>();
  for (const view of model.views) {
    let derived;
    let options: FocusOptions = {};
    if (view.type === "graph") {
      derived = deriveGraph(view, model);
      options = { derivedEdges: derivedEdgeMap(derived) };
      focusOptions.set(view.id, options);
      if (opts.stubs !== false) for (const file of stubFiles(view, derived, model)) files.add(file);
    }
    const candidates = viewCandidates(view, model, derived);
    for (const focus of codeFocus(candidates, model, options)) files.add(focus.file);
    for (const link of relatedFiles(candidates, model))
      for (const file of link.files) files.add(file);
  }
  for (const tour of model.tours) {
    for (const step of Array.isArray(tour.steps) ? tour.steps : []) {
      const ids = Array.isArray(step.focus) ? step.focus : [];
      for (const focus of codeFocus(ids, model, focusOptions.get(step.view) ?? {})) {
        files.add(focus.file);
      }
      for (const link of relatedFiles(ids, model)) for (const file of link.files) files.add(file);
      if (typeof step.editor?.primary === "string") files.add(step.editor.primary);
    }
  }
  return [...files].filter((file) => index.hasFile(file)).sort();
}

/**
 * The files behind the dashed stubs of a graph view: what the viewer shows when a stub is clicked, the sites of the
 * references that cross the edge of the view there and what they lead to (`derivedEdgeAnchors`, as the viewer
 * builds them), not everything a ghost box could open into: a ghost directory joins the view when it is expanded,
 * and its files are fetched on demand under `xpl view` (a static bundle shows them as not included). The references
 * of files the view excludes (`excludeFiles`) do not count, as in `deriveGraph`.
 */
function stubFiles(view: GraphView, graph: DerivedGraph, model: ExplainerModel): Set<string> {
  const files = new Set<string>();
  if (graph.stubs.length === 0) return files;
  const include = new Set(view.include.filter((id) => typeof id === "string" && model.hasNode(id)));
  const dropRef = excludedRefs(view, model, [...include]);
  const stubsInside = new Map<string, DerivedGraph["stubs"]>();
  for (const stub of graph.stubs) {
    const list = stubsInside.get(stub.inside);
    if (list) list.push(stub);
    else stubsInside.set(stub.inside, [stub]);
  }
  const crossing = new Map<string, Reference[]>();
  // most references share their ends: what stands for an element in the view is worked out once
  const shown = new Map<string, string | undefined>();
  const reprOf = (id: string): string | undefined => {
    if (!shown.has(id)) shown.set(id, repr(id, include, model));
    return shown.get(id);
  };
  for (const ref of model.index.refs) {
    const from = elementIdForSymbolId(ref.from);
    const to = elementIdForSymbolId(ref.to);
    const a = reprOf(from);
    const b = reprOf(to);
    if ((a === undefined) === (b === undefined)) continue; // inside the view or outside it, not across
    if (dropRef?.(ref)) continue;
    const kind = REF_TO_EDGE_KIND[ref.kind];
    const direction = a !== undefined ? "out" : "in";
    const outside = a !== undefined ? to : from;
    for (const stub of stubsInside.get((a ?? b)!) ?? []) {
      if (stub.direction !== direction || !stub.kinds.includes(kind)) continue;
      if (!stub.targets.some((t) => model.subtreeContains(t.target, outside))) continue;
      const list = crossing.get(stub.id);
      if (list) list.push(ref);
      else crossing.set(stub.id, [ref]);
    }
  }
  for (const refs of crossing.values()) {
    for (const anchor of derivedEdgeAnchors(refs, model.index)) files.add(anchor.file);
  }
  return files;
}

// ─── Boundary ───────────────────────────────────────────────────────────────────────────────────

/** Methods that code reaches through their class (constructing it, or calling an instance), not by name. */
export const ENTRY_METHODS: ReadonlySet<string> = new Set([
  "__init__",
  "__new__",
  "__call__",
  "constructor",
  "New",
]);

/** How many files `--files boundary` adds at most to the referenced ones (`--boundary-max`). */
export const BOUNDARY_MAX = 40;

/** Why a boundary file is in: it calls an anchored symbol, an anchored symbol calls it, or it is a test of one. */
export type BoundaryReason = "caller" | "callee" | "test";

export interface BoundaryFile {
  file: string;
  reason: BoundaryReason;
  /** References that tie it to the anchored symbols (of its reason). */
  refs: number;
}

export interface Boundary {
  /** The files added, in the order they were taken (most references first, callers, tests and callees in turn). */
  added: BoundaryFile[];
  /** The files over the cap, in the same order: what a larger `max` would add next. */
  cut: BoundaryFile[];
  /** The cap that was applied. */
  max: number;
  /** Anchored symbols found in the index (the boundary is drawn around them and their members). */
  symbols: number;
}

/**
 * The boundary around what the explainer anchors: the files one call away from it, and its tests. Around every
 * anchored symbol (an anchor with a `symbol` that the index knows; a class counts with its members; symbols in
 * test files do not count, their callees are test helpers and the framework, not neighbours of the code):
 *
 * - callers: files with a `call` reference to an anchored symbol, from outside the anchored symbols;
 * - callees: files that an anchored symbol calls (depth 1);
 * - tests: test files (`isTestFile`) with a reference of any kind (a call, an import, a type use) to an anchored
 *   symbol. A test file that calls one counts as a test, not as a caller.
 *
 * A constructor or call method (`ENTRY_METHODS`: `__init__`, `__call__`, `constructor`, ...) is reached through its
 * class: `URL(scope)` calls `URL.__init__`, and a test hands `TrustedHostMiddleware` to the app, which then calls
 * its `__call__`. So when one is anchored, a call of its class counts as a call of it, and a test file's reference
 * to its class as a reference to it.
 *
 * Files in `exclude` (the referenced ones) are not added again. The candidates are ranked by how many references
 * tie them to the anchored symbols, and taken from the callers, the tests and the callees in turn, so that each
 * kind is represented when the cap (`max`, default `BOUNDARY_MAX`) cuts the list.
 */
export function boundaryFiles(
  explainer: Explainer,
  index: IndexModel,
  exclude: Iterable<string>,
  max = BOUNDARY_MAX,
): Boundary {
  const anchored = new Set<SymbolId>();
  // the classes of anchored constructors and call methods: code reaches those through the class
  const entryClasses = new Set<SymbolId>();
  for (const site of collectAnchors(explainer)) {
    const { file, symbol } = site.anchor;
    if (typeof file !== "string" || typeof symbol !== "string" || symbol === "") continue;
    const sym = index.symbolAt(file, symbol);
    if (!sym || isTestFile(sym.file)) continue;
    anchored.add(sym.id);
    const parent = index.parentSymbol(sym.id);
    const name = sym.path.slice(sym.path.lastIndexOf(".") + 1);
    if (parent?.kind === "class" && ENTRY_METHODS.has(name)) entryClasses.add(parent.id);
  }
  // is a reference end an anchored symbol, or inside one? (most ends repeat: worked out once each)
  const inside = new Map<SymbolId, boolean>();
  const within = (id: SymbolId): boolean => {
    let known = inside.get(id);
    if (known === undefined) {
      known = false;
      let cur: SymbolId | undefined = id;
      for (let hops = 0; cur !== undefined && hops < 64; hops++) {
        if (anchored.has(cur)) {
          known = true;
          break;
        }
        cur = index.symbol(cur)?.parent;
      }
      inside.set(id, known);
    }
    return known;
  };
  const skip = new Set(exclude);
  const counts: Record<BoundaryReason, Map<string, number>> = {
    caller: new Map(),
    callee: new Map(),
    test: new Map(),
  };
  const count = (reason: BoundaryReason, file: string | undefined) => {
    if (file === undefined || skip.has(file)) return;
    counts[reason].set(file, (counts[reason].get(file) ?? 0) + 1);
  };
  if (anchored.size > 0) {
    for (const ref of index.refs) {
      const toIn = within(ref.to);
      const fromIn = within(ref.from);
      if ((toIn || entryClasses.has(ref.to)) && !fromIn) {
        const file = index.fileOfSymbolId(ref.from);
        if (file !== undefined && isTestFile(file)) count("test", file);
        else if (ref.kind === "call") count("caller", file);
      } else if (fromIn && !toIn && ref.kind === "call") {
        count("callee", index.fileOfSymbolId(ref.to));
      }
    }
  }
  // one reason per file: a test is a test, a caller that is also called is a caller
  const ranked = (reason: BoundaryReason, taken: Set<string>): BoundaryFile[] =>
    [...counts[reason]]
      .filter(([file]) => !taken.has(file))
      .map(([file, refs]) => ({ file, reason, refs }))
      .sort((a, b) => b.refs - a.refs || (a.file < b.file ? -1 : a.file > b.file ? 1 : 0));
  const taken = new Set<string>();
  const lists: BoundaryFile[][] = [];
  for (const reason of ["test", "caller", "callee"] as const) {
    const list = ranked(reason, taken);
    for (const entry of list) taken.add(entry.file);
    lists.push(list);
  }
  const [tests, callers, callees] = lists as [BoundaryFile[], BoundaryFile[], BoundaryFile[]];
  const order: BoundaryFile[] = [];
  for (let i = 0; i < Math.max(callers.length, tests.length, callees.length); i++) {
    for (const list of [callers, tests, callees]) if (i < list.length) order.push(list[i]!);
  }
  const cap = Math.max(0, max);
  return {
    added: order.slice(0, cap),
    cut: order.slice(cap),
    max: cap,
    symbols: anchored.size,
  };
}

export interface CollectedFiles {
  /** Working-tree text of the embedded files. */
  files: Record<string, string>;
  /** The files selected, sorted: those of `files`, and any whose text could not be read. */
  paths: string[];
  /** Which selection was used. */
  choice: FilesChoice;
  /** With `referenced` and `boundary`: how many files the explainer references (before the boundary). */
  referenced?: number;
  /** With `boundary`: what the boundary added, and what the cap cut. */
  boundary?: Boundary;
  /**
   * With a change record (`explainer.change`): the changed files that exist at head and are indexed, and how many of
   * them the selection had left out (added so that every changed file is embedded, whatever `--files` says).
   */
  changed?: { files: number; added: string[] };
  /** Bytes of source text embedded (UTF-8). */
  embeddedBytes: number;
  /** Files in the index, and their total size on disk (0 unless measured): what `--files all` would embed. */
  indexedFiles: number;
  indexedBytes: number;
}

/** Sum of the on-disk sizes of the indexed files (missing files count as 0). */
export function indexedBytes(root: string, index: IndexModel): number {
  let total = 0;
  for (const file of index.files) {
    try {
      total += lstatSync(join(root, ...file.path.split("/"))).size;
    } catch {
      // deleted since indexing
    }
  }
  return total;
}

/**
 * Working-tree text of the files to embed: the files the explainer references (`choice` absent or `referenced`,
 * see `referencedFiles`), those plus a boundary of callers, callees and tests around its anchored symbols
 * (`boundary`, see `boundaryFiles`), or every indexed file (`all`).
 */
export function collectFiles(opts: {
  root: string;
  index: IndexModel;
  texts: TextCache;
  explainer: Explainer;
  choice?: FilesChoice;
  /** Also measure the indexed files on disk (`indexedBytes`; one `stat` per file). Default: yes. */
  measure?: boolean;
  /** With `referenced`: also the code behind the stubs of graph views (default: yes; see `referencedFiles`). */
  stubs?: boolean;
  /** With `boundary`: how many files it adds at most (default `BOUNDARY_MAX`). */
  boundaryMax?: number;
}): CollectedFiles {
  const choice: FilesChoice = opts.choice ?? "referenced";
  let paths: string[];
  let referenced: number | undefined;
  let boundary: Boundary | undefined;
  if (choice === "all") {
    paths = opts.index.files.map((file) => file.path);
  } else {
    paths = referencedFiles(opts.explainer, opts.index, { stubs: opts.stubs !== false });
    referenced = paths.length;
    if (choice === "boundary") {
      boundary = boundaryFiles(opts.explainer, opts.index, paths, opts.boundaryMax);
      paths = [...paths, ...boundary.added.map((entry) => entry.file)].sort();
    }
  }
  // a change is reviewed file by file: every changed file that exists at head goes in, whatever the selection
  let changed: CollectedFiles["changed"];
  if (opts.explainer.change !== undefined) {
    const heads = headPathsOf(opts.explainer.change).filter((path) => opts.index.hasFile(path));
    const have = new Set(paths);
    const added = heads.filter((path) => !have.has(path));
    if (added.length > 0) paths = [...paths, ...added].sort();
    changed = { files: heads.length, added };
  }
  const files: Record<string, string> = {};
  let embeddedBytes = 0;
  for (const path of paths) {
    const text = opts.texts.text(path);
    if (text === undefined) continue;
    files[path] = text;
    embeddedBytes += Buffer.byteLength(text);
  }
  return {
    files,
    paths,
    choice,
    ...(referenced !== undefined ? { referenced } : {}),
    ...(boundary !== undefined ? { boundary } : {}),
    ...(changed !== undefined ? { changed } : {}),
    embeddedBytes,
    indexedFiles: opts.index.files.length,
    indexedBytes: opts.measure === false ? 0 : indexedBytes(opts.root, opts.index),
  };
}

export type IndexChoice = "full" | "pruned";

/** What `xpl bundle` embeds of the index when `--embed-index` is not given: all of it with `--files all`. */
export function defaultIndexChoice(files: FilesChoice): IndexChoice {
  return files === "all" ? "full" : "pruned";
}

export interface EmbeddedIndex {
  /** What goes into the bundle: the index itself, or a pruned copy of it (`index.pruned` says what it had). */
  index: SymbolIndex;
  /** The selection made: the whole index, or the pruned one. */
  choice: IndexChoice;
  /** Something was dropped (`choice` is `pruned` and the explainer did not need everything). */
  pruned: boolean;
  /** Size of the embedded index and of the whole one, as compact JSON (UTF-8 bytes). */
  bytes: number;
  fullBytes: number;
  /** Symbols and references embedded, and in the whole index. */
  symbols: { embedded: number; indexed: number };
  refs: { embedded: number; indexed: number };
}

const indexBytes = (index: SymbolIndex): number => Buffer.byteLength(JSON.stringify(index));

/**
 * The index the bundle carries. `pruned` (the default with `--files referenced`) cuts it down to what the viewer can
 * draw for this explainer with the code of `files` embedded: see `pruneIndex` in core for what stays and why the
 * viewer derives the same from it. `full` embeds the index as it is. `model` is `index` as an `IndexModel`, when one
 * is at hand.
 */
export function embedIndex(opts: {
  index: SymbolIndex;
  model?: IndexModel;
  explainer: Explainer;
  /** The files whose code is embedded (`CollectedFiles.paths`). */
  files: readonly string[];
  choice?: IndexChoice;
}): EmbeddedIndex {
  const choice = opts.choice ?? "pruned";
  const fullBytes = indexBytes(opts.index);
  const indexed = {
    symbols: (opts.index.symbols ?? []).length,
    refs: (opts.index.refs ?? []).length,
  };
  if (choice === "full") {
    return {
      index: opts.index,
      choice,
      pruned: false,
      bytes: fullBytes,
      fullBytes,
      symbols: { embedded: indexed.symbols, indexed: indexed.symbols },
      refs: { embedded: indexed.refs, indexed: indexed.refs },
    };
  }
  const result = pruneIndex(opts.model ?? opts.index, {
    files: opts.files,
    explainer: opts.explainer,
  });
  return {
    index: result.index,
    choice,
    pruned: result.pruned,
    bytes: result.pruned ? indexBytes(result.index) : fullBytes,
    fullBytes,
    symbols: { embedded: result.symbols.kept, indexed: result.symbols.total },
    refs: { embedded: result.refs.kept, indexed: result.refs.total },
  };
}

/**
 * The code before the change (`ViewerBundle.baseFiles`): the base text of every changed file of `explainer.change`
 * that is modified, renamed or deleted, keyed by its `ChangedFile.path`. `missing` lists the files whose base text
 * could not be read (no git, a binary file). Undefined without a change record.
 */
export function collectBaseFiles(
  explainer: Explainer,
  texts: TextCache,
): { files: Record<string, string>; bytes: number; missing: string[] } | undefined {
  const change = explainer.change;
  if (change === undefined) return undefined;
  const files: Record<string, string> = {};
  const missing: string[] = [];
  let bytes = 0;
  for (const file of baseVersionFiles(change)) {
    const text = texts.textAt(change.base, basePathOf(file));
    if (text === undefined) {
      missing.push(file.path);
      continue;
    }
    files[file.path] = text;
    bytes += Buffer.byteLength(text);
  }
  return { files, bytes, missing };
}

export function makeBundle(parts: {
  explainer: Explainer;
  index: ViewerBundle["index"];
  files: Record<string, string>;
  baseFiles?: Record<string, string>;
  mode?: "explore" | "present";
  tour?: string;
  server?: { api: string };
}): ViewerBundle {
  return {
    schema: BUNDLE_SCHEMA,
    explainer: parts.explainer,
    index: parts.index,
    files: parts.files,
    ...(parts.baseFiles !== undefined ? { baseFiles: parts.baseFiles } : {}),
    ...(parts.mode !== undefined ? { mode: parts.mode } : {}),
    ...(parts.tour !== undefined ? { tour: parts.tour } : {}),
    ...(parts.server !== undefined ? { server: parts.server } : {}),
  };
}
