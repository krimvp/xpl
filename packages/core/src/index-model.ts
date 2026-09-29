/**
 * `IndexModel`: read-only lookup structures over a `SymbolIndex` (files by path, symbols by id and
 * per file, symbol children, refs by from/to, derived directories, innermost symbol at a line).
 * Built once per index; everything else in core (anchors, model, graph, ...) goes through it.
 *
 * This module is a leaf (it imports only the schema types and `util`), so ids.ts can depend on it.
 */
import { TEST_FILE_GLOBS } from "./constants.js";
import { matchesAnyGlob } from "./glob.js";
import type {
  FilePath,
  Hash,
  IndexedFile,
  IndexedSymbol,
  Reference,
  SymbolId,
  SymbolIndex,
  SymbolPath,
} from "./schema.js";
import { cmp } from "./util.js";

const NONE: readonly never[] = Object.freeze([]) as readonly never[];

/** Directory part of a repo-relative path (`""` for files at the repo root). */
export function dirOf(path: FilePath): string {
  const slash = path.lastIndexOf("/");
  return slash === -1 ? "" : path.slice(0, slash);
}

/** Last segment of a path (`src/a.ts` -> `a.ts`). */
export function baseName(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1);
}

/** Last segment of a dotted symbol path, without a duplicate suffix (`Runner.dispatch~2` -> `dispatch`). */
function lastSegment(path: SymbolPath): string {
  return path.slice(path.lastIndexOf(".") + 1).replace(/~\d+$/, "");
}

/** The symbol path without its last segment (`Runner.dispatch` -> `Runner`; `""` for a top-level symbol). */
function parentPathOf(path: SymbolPath): SymbolPath {
  const dot = path.lastIndexOf(".");
  return dot === -1 ? "" : path.slice(0, dot);
}

/** Is this file test code (see `TEST_FILE_GLOBS`)? */
export function isTestFile(path: FilePath): boolean {
  return matchesAnyGlob(path, TEST_FILE_GLOBS);
}

/**
 * What is known about a symbol that vanished (renamed or deleted), to rank the candidates that might be
 * it. Everything is optional; `suggestSymbols` uses what it is given.
 */
export interface SymbolHint {
  /** Its kind, when known: same-kind siblings come first. */
  kind?: IndexedSymbol["kind"];
  /** Its size in lines (a whole-symbol anchor remembers the range it had). */
  lines?: number;
  /** Its hash (a whole-symbol anchor remembers it): a symbol with identical text is where it moved to. */
  hash?: Hash;
}

/** 0..1: how alike two names are (case-insensitive edit distance, or containment). */
export function nameSimilarity(a: string, b: string): number {
  const x = a.toLowerCase();
  const y = b.toLowerCase();
  if (x === y) return 1;
  const longest = Math.max(x.length, y.length);
  if (longest === 0) return 0;
  const shortest = Math.min(x.length, y.length);
  const byDistance = 1 - editDistance(x, y, longest) / longest;
  const contained =
    shortest > 0 && (x.includes(y) || y.includes(x)) ? 0.5 + (0.5 * shortest) / longest : 0;
  return Math.max(byDistance, contained);
}

/** 0..1: how close two line counts are. */
function sizeSimilarity(a: number, b: number): number {
  return 1 - Math.abs(a - b) / Math.max(a, b, 1);
}

export class IndexModel {
  readonly index: SymbolIndex;
  /** The index's commit id. */
  readonly commit: string;
  /** Files sorted by path. */
  readonly files: readonly IndexedFile[];
  /** All symbols, sorted by file then range (outer symbols before the ones they contain). */
  readonly symbols: readonly IndexedSymbol[];
  readonly refs: readonly Reference[];
  /** Every directory that contains an indexed file (the root excluded), sorted. */
  readonly directories: readonly string[];

  private readonly fileMap = new Map<FilePath, IndexedFile>();
  private readonly symbolMap = new Map<SymbolId, IndexedSymbol>();
  private readonly byFile = new Map<FilePath, IndexedSymbol[]>();
  private readonly byFilePath = new Map<string, IndexedSymbol>();
  private readonly childMap = new Map<SymbolId, IndexedSymbol[]>();
  private readonly topLevelMap = new Map<FilePath, IndexedSymbol[]>();
  private readonly fromMap = new Map<SymbolId, Reference[]>();
  private readonly toMap = new Map<SymbolId, Reference[]>();
  private readonly dirSet = new Set<string>();
  private readonly dirChildMap = new Map<string, { dirs: string[]; files: string[] }>();
  private readonly dirFilesMap = new Map<string, string[]>();
  private readonly depthCache = new Map<SymbolId, number>();

  constructor(index: SymbolIndex) {
    this.index = index;
    this.commit = index.commit;
    this.refs = index.refs ?? NONE;

    // First occurrence wins when an index (wrongly) repeats a path or an id.
    const files = [...(index.files ?? [])].sort((a, b) => cmp(a.path, b.path));
    this.files = files.filter((file) => {
      if (this.fileMap.has(file.path)) return false;
      this.fileMap.set(file.path, file);
      return true;
    });

    const seenIds = new Set<SymbolId>();
    const symbols = (index.symbols ?? [])
      .filter((sym) => !seenIds.has(sym.id) && seenIds.add(sym.id))
      .sort(
        (a, b) =>
          cmp(a.file, b.file) ||
          a.range.startLine - b.range.startLine ||
          b.range.endLine - a.range.endLine ||
          cmp(a.id, b.id),
      );
    this.symbols = symbols;
    for (const sym of symbols) {
      this.symbolMap.set(sym.id, sym);
      this.byFilePath.set(`${sym.file}\0${sym.path}`, sym);
      push(this.byFile, sym.file, sym);
    }
    for (const list of this.byFile.values()) {
      for (const sym of list) {
        const parent = sym.parent !== undefined ? this.symbolMap.get(sym.parent) : undefined;
        if (parent && parent.file === sym.file) push(this.childMap, parent.id, sym);
        else push(this.topLevelMap, sym.file, sym);
      }
    }

    for (const ref of this.refs) {
      push(this.fromMap, ref.from, ref);
      push(this.toMap, ref.to, ref);
    }

    // Directories: every ancestor of every file, root excluded.
    this.dirChildMap.set("", { dirs: [], files: [] });
    this.dirFilesMap.set("", []);
    for (const file of this.files) {
      const dir = dirOf(file.path);
      this.dirFilesMap.get("")!.push(file.path);
      let chain = "";
      if (dir !== "") {
        for (const segment of dir.split("/")) {
          const parent = chain;
          chain = parent === "" ? segment : `${parent}/${segment}`;
          if (!this.dirSet.has(chain)) {
            this.dirSet.add(chain);
            this.dirChildMap.set(chain, { dirs: [], files: [] });
            this.dirFilesMap.set(chain, []);
            this.dirChildMap.get(parent)!.dirs.push(chain);
          }
          this.dirFilesMap.get(chain)!.push(file.path);
        }
      }
      this.dirChildMap.get(dir)!.files.push(file.path);
    }
    this.directories = [...this.dirSet].sort(cmp);
    for (const entry of this.dirChildMap.values()) {
      entry.dirs.sort(cmp);
      entry.files.sort(cmp);
    }
  }

  // ─── Files and directories ────────────────────────────────────────────────────────────────────

  file(path: FilePath): IndexedFile | undefined {
    return this.fileMap.get(path);
  }

  hasFile(path: FilePath): boolean {
    return this.fileMap.has(path);
  }

  /** True for a directory that contains an indexed file. `""` (the repo root) is not a directory here. */
  hasDirectory(path: string): boolean {
    return this.dirSet.has(path);
  }

  /** Parent directory of a directory (`""` = the repo root), or undefined when `path` is unknown. */
  dirParent(path: string): string | undefined {
    return this.dirSet.has(path) ? dirOf(path) : undefined;
  }

  /** Direct children of a directory (`""` = the repo root): subdirectories, then files; both sorted. */
  dirChildren(path: string): { dirs: readonly string[]; files: readonly string[] } {
    return this.dirChildMap.get(path) ?? { dirs: NONE, files: NONE };
  }

  /** Every indexed file under a directory, recursively, sorted (`""` = all files). */
  filesUnder(path: string): readonly string[] {
    return this.dirFilesMap.get(path) ?? NONE;
  }

  // ─── Symbols ──────────────────────────────────────────────────────────────────────────────────

  symbol(id: SymbolId): IndexedSymbol | undefined {
    return this.symbolMap.get(id);
  }

  /** Symbol by file and symbol path (not a `SymbolId`). */
  symbolAt(file: FilePath, path: SymbolPath): IndexedSymbol | undefined {
    return this.byFilePath.get(`${file}\0${path}`);
  }

  /** Symbols of a file sorted by range: by start line, outer symbols before the ones they contain. */
  symbolsInFile(file: FilePath): readonly IndexedSymbol[] {
    return this.byFile.get(file) ?? NONE;
  }

  /** Symbols of a file without a parent in that file, sorted by range. */
  topLevelSymbols(file: FilePath): readonly IndexedSymbol[] {
    return this.topLevelMap.get(file) ?? NONE;
  }

  /** Direct child symbols of a symbol (by `IndexedSymbol.parent`), sorted by range. */
  childSymbols(id: SymbolId): readonly IndexedSymbol[] {
    return this.childMap.get(id) ?? NONE;
  }

  /** The parent symbol, when the symbol has one that is in the index. */
  parentSymbol(id: SymbolId): IndexedSymbol | undefined {
    const parent = this.symbolMap.get(id)?.parent;
    return parent !== undefined ? this.symbolMap.get(parent) : undefined;
  }

  /** True when `ancestor` is `id` itself or one of its parents (via `IndexedSymbol.parent`). */
  symbolWithin(id: SymbolId, ancestor: SymbolId): boolean {
    let cur: SymbolId | undefined = id;
    for (let hops = 0; cur !== undefined && hops < 64; hops++) {
      if (cur === ancestor) return true;
      cur = this.symbolMap.get(cur)?.parent;
    }
    return false;
  }

  /**
   * The innermost symbol whose line range contains `line` (1-based): the smallest range; on equal
   * ranges the deeper one (following `parent`). Undefined when the line is outside every symbol.
   */
  innermostSymbolAt(file: FilePath, line: number): IndexedSymbol | undefined {
    let best: IndexedSymbol | undefined;
    let bestSpan = Infinity;
    let bestDepth = -1;
    for (const sym of this.symbolsInFile(file)) {
      if (sym.range.startLine > line) break;
      if (sym.range.endLine < line) continue;
      const span = sym.range.endLine - sym.range.startLine;
      const depth = this.depth(sym.id);
      if (span < bestSpan || (span === bestSpan && depth >= bestDepth)) {
        best = sym;
        bestSpan = span;
        bestDepth = depth;
      }
    }
    return best;
  }

  private depth(id: SymbolId): number {
    const cached = this.depthCache.get(id);
    if (cached !== undefined) return cached;
    let depth = 0;
    let cur = this.symbolMap.get(id)?.parent;
    while (cur !== undefined && depth < 64) {
      depth++;
      cur = this.symbolMap.get(cur)?.parent;
    }
    this.depthCache.set(id, depth);
    return depth;
  }

  // ─── Module scopes ────────────────────────────────────────────────────────────────────────────

  /** Module scope id of a file: `"<file>#"`. */
  moduleScopeId(file: FilePath): SymbolId {
    return `${file}#`;
  }

  /** True for `"<file>#"` ids whose file is in the index. */
  isModuleScope(id: SymbolId): boolean {
    return id.length > 1 && id.endsWith("#") && this.fileMap.has(id.slice(0, -1));
  }

  /** File of a symbol id or a module scope id; undefined when neither is in the index. */
  fileOfSymbolId(id: SymbolId): FilePath | undefined {
    const sym = this.symbolMap.get(id);
    if (sym) return sym.file;
    if (id.length > 1 && id.endsWith("#")) {
      const file = id.slice(0, -1);
      if (this.fileMap.has(file)) return file;
    }
    return undefined;
  }

  // ─── References ───────────────────────────────────────────────────────────────────────────────

  /** References whose `from` is this symbol id (or module scope id), in index order. */
  refsFrom(id: SymbolId): readonly Reference[] {
    return this.fromMap.get(id) ?? NONE;
  }

  /** References whose `to` is this symbol id (or module scope id), in index order. */
  refsTo(id: SymbolId): readonly Reference[] {
    return this.toMap.get(id) ?? NONE;
  }

  // ─── Suggestions (for error messages Claude reads) ────────────────────────────────────────────

  /**
   * Candidates for a symbol path that does not exist in `file` (a typo, or a symbol that was renamed,
   * moved or deleted), best first:
   *
   *   1. a symbol with the very text the missing one had (`hint.hash`; a move, not a rename);
   *   2. the siblings: same file, same parent (same kind first, when `hint.kind` is known), ranked by
   *      name similarity and, when `hint.lines` is known, by how close their size is to the old one, so a
   *      renamed `Runner.dispatch` is found among `Runner`'s methods by its length;
   *   3. same-named symbols elsewhere: the same name under another parent in the file, the same path in
   *      another file, the same name in another file;
   *   4. paths in the file within two edits (typos in the parent part).
   *
   * Test files rank after everything else of the same tier and are never preferred over production code
   * (unless `file` is a test file itself).
   */
  suggestSymbols(
    file: FilePath,
    path: SymbolPath,
    limit = 5,
    hint: SymbolHint = {},
  ): IndexedSymbol[] {
    const last = lastSegment(path);
    const parent = parentPathOf(path);
    const wantedLower = path.toLowerCase();
    const fromTest = isTestFile(file);
    interface Candidate {
      sym: IndexedSymbol;
      rank: number;
      score: number;
    }
    const found = new Map<SymbolId, Candidate>();
    const offer = (sym: IndexedSymbol, rank: number, score = 0): void => {
      const known = found.get(sym.id);
      if (known && (known.rank < rank || (known.rank === rank && known.score >= score))) return;
      found.set(sym.id, { sym, rank, score });
    };
    const size = (sym: IndexedSymbol) => sym.range.endLine - sym.range.startLine + 1;
    const nameOf = (sym: IndexedSymbol) => nameSimilarity(last, lastSegment(sym.path));
    const sizeOf = (sym: IndexedSymbol) =>
      hint.lines === undefined ? 0 : sizeSimilarity(size(sym), hint.lines);
    const similarity = (sym: IndexedSymbol): number =>
      hint.lines === undefined ? nameOf(sym) : 0.65 * nameOf(sym) + 0.35 * sizeOf(sym);

    if (hint.hash !== undefined) {
      const same = this.symbols.filter((sym) => sym.hash === hint.hash && size(sym) >= 3);
      if (same.length > 0 && same.length <= 2) for (const sym of same) offer(sym, -1);
    }
    // A size can only stand in for a name when it points at one sibling: three methods of four lines each
    // say nothing about which of them a deleted four-line method became.
    const sameSize =
      hint.lines !== undefined && hint.lines >= 3
        ? this.symbolsInFile(file).filter(
            (sym) => parentPathOf(sym.path) === parent && nameOf(sym) < 0.5 && sizeOf(sym) >= 0.7,
          )
        : [];
    for (const sym of this.symbolsInFile(file)) {
      if (parentPathOf(sym.path) === parent) {
        // A sibling is offered when something about it fits: a similar name, or the one sibling of the old
        // size (a rename keeps the body). Members that merely share the class are not candidates.
        const fits = nameOf(sym) >= 0.5 || (sameSize.length === 1 && sameSize[0] === sym);
        const kindOk = hint.kind === undefined || sym.kind === hint.kind;
        if (fits) offer(sym, kindOk ? 0 : 0.5, similarity(sym));
      } else if (lastSegment(sym.path) === last) {
        offer(sym, 1, similarity(sym));
      } else if (lastSegment(sym.path).toLowerCase() === last.toLowerCase()) {
        offer(sym, 1.05, similarity(sym));
      }
    }
    for (const sym of this.symbols) {
      if (sym.file === file) continue;
      if (sym.path === path) offer(sym, 1.2, 1);
      else if (lastSegment(sym.path) === last) offer(sym, 1.3, similarity(sym));
    }
    // A typo: a path in the same file within two edits.
    for (const sym of this.symbolsInFile(file)) {
      if (editDistance(sym.path.toLowerCase(), wantedLower, 2) <= 2) offer(sym, 2, similarity(sym));
    }

    return [...found.values()]
      .map((c) => ({ ...c, rank: c.rank + (!fromTest && isTestFile(c.sym.file) ? 10 : 0) }))
      .sort(
        (a, b) =>
          a.rank - b.rank ||
          b.score - a.score ||
          cmp(a.sym.file, b.sym.file) ||
          a.sym.range.startLine - b.sym.range.startLine,
      )
      .slice(0, limit)
      .map((c) => c.sym);
  }

  /** Candidate file paths for an unknown path: same base name, then containing the text. */
  suggestFiles(input: string, limit = 5): FilePath[] {
    const needle = input.replace(/^\.?\//, "").toLowerCase();
    const base = baseName(needle);
    const out: FilePath[] = [];
    const add = (path: FilePath) => {
      if (out.length < limit && !out.includes(path)) out.push(path);
    };
    for (const file of this.files) if (baseName(file.path).toLowerCase() === base) add(file.path);
    for (const file of this.files) if (file.path.toLowerCase().includes(needle)) add(file.path);
    for (const file of this.files)
      if (base && file.path.toLowerCase().includes(base)) add(file.path);
    return out;
  }
}

/** Levenshtein distance, giving up (returning `max + 1`) once it must exceed `max`. */
function editDistance(a: string, b: string, max: number): number {
  if (Math.abs(a.length - b.length) > max) return max + 1;
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const row = [i];
    let best = i;
    for (let j = 1; j <= b.length; j++) {
      const value = Math.min(
        prev[j]! + 1,
        row[j - 1]! + 1,
        prev[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
      row.push(value);
      if (value < best) best = value;
    }
    if (best > max) return max + 1;
    prev = row;
  }
  return prev[b.length]!;
}

function push<K, V>(map: Map<K, V[]>, key: K, value: V): void {
  const list = map.get(key);
  if (list) list.push(value);
  else map.set(key, [value]);
}

const cache = new WeakMap<SymbolIndex, IndexModel>();

/**
 * An `IndexModel` for a `SymbolIndex` (memoised per index object), or the model itself. Lets every
 * public core function accept either.
 */
export function asIndexModel(index: SymbolIndex | IndexModel): IndexModel {
  if (index instanceof IndexModel) return index;
  let model = cache.get(index);
  if (!model) {
    model = new IndexModel(index);
    cache.set(index, model);
  }
  return model;
}
