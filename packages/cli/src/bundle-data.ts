/**
 * The viewer bundle (`ViewerBundle`, ARCHITECTURE.md §5) shared by `xpl bundle` (inlined into the HTML)
 * and `xpl view` (injected into `GET /`, served at `GET /api/bundle`): which source files go in
 * (`collectFiles`), and how much of the symbol index (`embedIndex`, which `xpl bundle` uses).
 */
import { lstatSync } from "node:fs";
import { join } from "node:path";
import {
  BUNDLE_SCHEMA,
  ExplainerModel,
  REF_TO_EDGE_KIND,
  codeFocus,
  collectAnchors,
  deriveGraph,
  derivedEdgeAnchors,
  derivedEdgeMap,
  elementIdForSymbolId,
  globMatcher,
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
  type SymbolIndex,
  type TextCache,
  type ViewerBundle,
} from "@xpl/core";

export type FilesChoice = "all" | "referenced";

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

/** The files of the elements a view includes by name (a file, a symbol's file, a group's members'). */
function namedFiles(view: GraphView, model: ExplainerModel): Set<string> {
  const named = new Set<string>();
  const seen = new Set<string>();
  const visit = (id: string): void => {
    if (seen.has(id)) return;
    seen.add(id);
    const parsed = parseId(id);
    if (parsed.type === "file") named.add(parsed.path);
    else if (parsed.type === "symbol") named.add(parsed.file);
    else if (parsed.type === "group") model.members(id).forEach(visit);
  };
  view.include.forEach(visit);
  return named;
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
  const excluded = globMatcher(view.excludeFiles);
  const named = excluded ? namedFiles(view, model) : new Set<string>();
  const dropped = (id: string): boolean => {
    if (!excluded) return false;
    const file = model.index.fileOfSymbolId(id);
    return file !== undefined && excluded(file) && !named.has(file);
  };
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
    if (dropped(ref.from) || dropped(ref.to)) continue;
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

export interface CollectedFiles {
  /** Working-tree text of the embedded files. */
  files: Record<string, string>;
  /** The files selected, sorted: those of `files`, and any whose text could not be read. */
  paths: string[];
  /** Which selection was used. */
  choice: FilesChoice;
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
 * see `referencedFiles`), or every indexed file (`all`).
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
}): CollectedFiles {
  const choice: FilesChoice = opts.choice ?? "referenced";
  const paths =
    choice === "all"
      ? opts.index.files.map((file) => file.path)
      : referencedFiles(opts.explainer, opts.index, { stubs: opts.stubs !== false });
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

export function makeBundle(parts: {
  explainer: Explainer;
  index: ViewerBundle["index"];
  files: Record<string, string>;
  mode?: "explore" | "present";
  tour?: string;
  server?: { api: string };
}): ViewerBundle {
  return {
    schema: BUNDLE_SCHEMA,
    explainer: parts.explainer,
    index: parts.index,
    files: parts.files,
    ...(parts.mode !== undefined ? { mode: parts.mode } : {}),
    ...(parts.tour !== undefined ? { tour: parts.tour } : {}),
    ...(parts.server !== undefined ? { server: parts.server } : {}),
  };
}
