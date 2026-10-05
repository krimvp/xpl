import { reviewSourceFiles } from "@xpl/core";
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
  referencedFiles,
  baseVersionFiles,
  basePathOf,
  headPathsOf,
  collectAnchors,
  isTestFile,
  packIndex,
  pruneIndex,
  reresolveExplainer,
  type Explainer,
  type IndexModel,
  type SymbolId,
  type SymbolIndex,
  type TextCache,
  type ViewerBundle,
} from "@xpl/core";
import { plural } from "./format.js";

export type FilesChoice = "all" | "referenced" | "boundary";

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
  // Preserve the evidence explicitly covered by an author's review when reopening offline.
  if (opts.explainer.review)
    paths = [
      ...new Set([...paths, ...reviewSourceFiles(opts.explainer.review.scope, opts.index)]),
    ].sort();
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
  /** Size of the embedded index as the page holds it, packed (`packIndex`): what it adds to the page. */
  packedBytes: number;
  /** Symbols and references embedded, and in the whole index. */
  symbols: { embedded: number; indexed: number };
  refs: { embedded: number; indexed: number };
}

const indexBytes = (index: SymbolIndex): number => Buffer.byteLength(JSON.stringify(index));
const packedBytes = (index: SymbolIndex): number =>
  Buffer.byteLength(JSON.stringify(packIndex(index)));

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
      packedBytes: packedBytes(opts.index),
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
    packedBytes: packedBytes(result.index),
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

/** Anchors that no longer match the code: `drifted` (their text changed) and `missing` (their code is gone). */
export interface Drift {
  total: number;
  drifted: number;
  missing: number;
}

/**
 * The explainer as the page must show it: every anchor re-resolved against the index and the code that go into
 * the page. The `resolved` stored in the file is a cache from the last `xpl resolve --write`; code that moved
 * since then would otherwise be highlighted at its old lines with status `ok`. Here an anchor whose text is found
 * at new lines gets them (status `moved`), and one whose text changed or is gone says so (`drifted`, `missing`).
 * Nothing is written back.
 */
export function freshAnchors(
  explainer: Explainer,
  index: IndexModel,
  texts: TextCache,
): { explainer: Explainer; drift: Drift } {
  const { explainer: fresh, report } = reresolveExplainer(explainer, index, texts, {
    ...(explainer.index?.path ? { indexPath: explainer.index.path } : {}),
  });
  return {
    explainer: fresh,
    drift: { total: report.total, drifted: report.counts.drifted, missing: report.counts.missing },
  };
}

/**
 * `92 anchors drifted (their code changed) and 2 are missing (their code is gone)`, the part of a drift message that
 * says how much; "" when nothing drifted.
 */
export function describeDrift(drift: Drift): string {
  const parts: string[] = [];
  if (drift.drifted > 0) {
    parts.push(
      `${plural(drift.drifted, "anchor")} drifted (${drift.drifted === 1 ? "its" : "their"} code changed)`,
    );
  }
  if (drift.missing > 0) {
    const what = `missing (${drift.missing === 1 ? "its" : "their"} code is gone)`;
    parts.push(
      parts.length > 0
        ? `${drift.missing} ${drift.missing === 1 ? "is" : "are"} ${what}`
        : `${plural(drift.missing, "anchor")} ${drift.missing === 1 ? "is" : "are"} ${what}`,
    );
  }
  return parts.join(" and ");
}

export function makeBundle(parts: {
  explainer: Explainer;
  index: ViewerBundle["index"];
  files: Record<string, string>;
  baseFiles?: Record<string, string>;
  mode?: "explore" | "present";
  tour?: string;
  server?: ViewerBundle["server"];
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

export { referencedFiles } from "@xpl/core";
