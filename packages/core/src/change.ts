/**
 * The change an explainer is about (`Explainer.change`, written by `xpl change <name> <base>..<head>`): lookups
 * on the record, its shape check, and the change analysis that `xpl change` prints (`analyzeChange`): the changed
 * files, the index symbols the change touches, their direct callers outside tests and the tests that reference
 * them. Pure: the CLI runs git and hands the record in.
 */
import { elementIdForSymbolId } from "./ids.js";
import { isTestFile, type IndexModel } from "./index-model.js";
import type {
  ChangedFile,
  ChangeHunk,
  ChangeRecord,
  ElementId,
  FilePath,
  IndexedSymbol,
  Range,
  Reference,
  SymbolId,
} from "./schema.js";
import { cmp, isRecord } from "./util.js";

export const CHANGE_STATUSES: readonly ChangedFile["status"][] = [
  "added",
  "modified",
  "deleted",
  "renamed",
];

/** The first 7 characters of a commit SHA, as people write it. */
export function shortSha(sha: string): string {
  return sha.slice(0, 7);
}

/** `85c3b74..2284ff0`. */
export function describeChange(change: Pick<ChangeRecord, "base" | "head">): string {
  return `${shortSha(change.base)}..${shortSha(change.head)}`;
}

/** The changed file named by `file`: its path, else the old path of a renamed file. */
export function changedFile(
  change: ChangeRecord | undefined,
  file: FilePath,
): ChangedFile | undefined {
  const files = Array.isArray(change?.files) ? change.files : [];
  return (
    files.find((f) => isRecord(f) && f.path === file) ??
    files.find((f) => isRecord(f) && f.status === "renamed" && f.oldPath === file)
  );
}

/** Does the file have code before the change (modified, renamed or deleted)? */
export function hasBaseVersion(file: ChangedFile): boolean {
  return file.status !== "added";
}

/** Where the file lies in the base commit: the old path of a renamed file, else its path. */
export function basePathOf(file: ChangedFile): FilePath {
  return file.status === "renamed" && typeof file.oldPath === "string" ? file.oldPath : file.path;
}

/** The changed file a base anchor may point into (`file` is its path or its old path), when it has a base version. */
export function baseFileOf(
  change: ChangeRecord | undefined,
  file: FilePath,
): ChangedFile | undefined {
  const found = changedFile(change, file);
  return found && hasBaseVersion(found) ? found : undefined;
}

/** The changed files that have a base version (modified, renamed, deleted), in record order. */
export function baseVersionFiles(change: ChangeRecord | undefined): ChangedFile[] {
  return (Array.isArray(change?.files) ? change.files : []).filter(
    (f) => isRecord(f) && hasBaseVersion(f),
  );
}

/** The paths of the changed files that exist at head (everything but deleted files), in record order. */
export function headPathsOf(change: ChangeRecord | undefined): FilePath[] {
  return (Array.isArray(change?.files) ? change.files : [])
    .filter((f) => isRecord(f) && f.status !== "deleted" && typeof f.path === "string")
    .map((f) => f.path);
}

/** Why `file` has no base version, with what does (for error messages). */
export function describeNoBase(change: ChangeRecord, file: FilePath): string {
  const found = changedFile(change, file);
  if (found?.status === "added") {
    return `${file} was added by the change ${describeChange(change)}: it has no code before the change`;
  }
  const withBase = baseVersionFiles(change).map((f) => f.path);
  return (
    `${file} is not changed by ${describeChange(change)}, so its code before the change is its current code: anchor it without "at"` +
    (withBase.length > 0
      ? ` (changed files with code before the change: ${withBase.slice(0, 8).join(", ")}${withBase.length > 8 ? ", ..." : ""})`
      : " (the change has no file with code before it)")
  );
}

const SHA = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/;

/**
 * Problems with the shape of a change record (`Explainer.change`), each with a path below `change`. Empty when it
 * is well formed. The record is written by `xpl change`, so a problem here means the file was edited by hand.
 */
export function changeShapeIssues(value: unknown): { path: string; message: string }[] {
  const out: { path: string; message: string }[] = [];
  const add = (path: string, message: string) => out.push({ path, message });
  const rerun = "; write it again with `xpl change <name> <base>..<head>`";
  if (!isRecord(value)) {
    add("change", `change must be {base, head, files}${rerun}`);
    return out;
  }
  for (const key of ["base", "head"] as const) {
    const sha = value[key];
    if (typeof sha !== "string" || !SHA.test(sha)) {
      add(`change.${key}`, `change.${key} must be a full commit SHA (40 hex characters)${rerun}`);
    }
  }
  if (!Array.isArray(value.files)) {
    add("change.files", `change.files must be an array${rerun}`);
    return out;
  }
  const seen = new Set<string>();
  value.files.forEach((file: unknown, i) => {
    const at = `change.files[${i}]`;
    if (!isRecord(file)) {
      add(at, "a changed file must be {path, status, oldPath?, hunks}");
      return;
    }
    if (typeof file.path !== "string" || file.path === "") {
      add(`${at}.path`, "path must be a repo-relative path");
    } else if (seen.has(file.path)) add(`${at}.path`, `${file.path} is listed twice`);
    else seen.add(file.path);
    if (!(CHANGE_STATUSES as readonly unknown[]).includes(file.status)) {
      add(`${at}.status`, `status must be one of ${CHANGE_STATUSES.join(", ")}`);
    }
    if (file.status === "renamed" && (typeof file.oldPath !== "string" || file.oldPath === "")) {
      add(`${at}.oldPath`, "a renamed file needs oldPath, its path at base");
    } else if (file.status !== "renamed" && file.oldPath !== undefined) {
      add(`${at}.oldPath`, "only a renamed file has oldPath");
    }
    if (!Array.isArray(file.hunks)) {
      add(`${at}.hunks`, "hunks must be an array of {oldStart, oldLines, newStart, newLines}");
      return;
    }
    file.hunks.forEach((hunk: unknown, j) => {
      const ok =
        isRecord(hunk) &&
        (["oldStart", "oldLines", "newStart", "newLines"] as const).every(
          (key) => Number.isInteger(hunk[key]) && (hunk[key] as number) >= 0,
        );
      if (!ok) {
        add(
          `${at}.hunks[${j}]`,
          "a hunk must be {oldStart, oldLines, newStart, newLines}: whole numbers, 0 or more",
        );
      }
    });
  });
  return out;
}

// ─── Analysis ───────────────────────────────────────────────────────────────────────────────────

/** One changed file, with its line counts. */
export interface ChangedFileSummary {
  path: FilePath;
  status: ChangedFile["status"];
  oldPath?: FilePath;
  /** Lines added and removed (from the hunks; 0 and 0 for a binary file or a pure rename). */
  added: number;
  removed: number;
  hunks: number;
  /** A test file (`isTestFile`). */
  test: boolean;
  /** In the index (only indexed files have symbols). */
  indexed: boolean;
  /** Changed lines (not blank, not comments) at head that lie in no symbol: imports, module-level code. */
  outside: number[];
}

/** Code that calls (or uses) a changed symbol, one entry per calling symbol. */
export interface CallerEntry {
  /** The calling symbol (`sym:`), or the file (`file:`) for module-level code. */
  id: ElementId;
  file: FilePath;
  /** Lines of the call sites, in order. */
  lines: number[];
  /** Reference kinds of the sites. */
  kinds: Reference["kind"][];
  resolution: Reference["resolution"];
  /** The caller is itself part of the change. */
  changed?: "new" | "changed";
  /**
   * How it reaches the symbol when not by name: `class` = it calls the class, which runs this constructor;
   * `instance` = it builds an instance of the class, which may call this method later (a heuristic).
   */
  via?: "class" | "instance";
}

/** A test that references a changed symbol: a test function (or method), or a test file for module-level code. */
export interface TestEntry {
  id: ElementId;
  file: FilePath;
  /** References from it to the symbol (or, `via`, to its class). */
  refs: number;
  kinds: Reference["kind"][];
  /** The test is itself part of the change. */
  changed?: "new" | "changed";
  via?: "class" | "instance";
}

/** A symbol of the index that the change touches. */
export interface ChangedSymbol {
  id: ElementId;
  symbolId: SymbolId;
  file: FilePath;
  kind: IndexedSymbol["kind"];
  range: { startLine: number; endLine: number };
  /** `new`: every line of it was added; `changed`: some lines were. */
  status: "new" | "changed";
  /** Lines of it that the change added or edited (at head); a pure deletion inside it counts its line. */
  lines: number[];
  /** Direct callers outside test files (depth 1); for a variable or key, the code that reads or writes it. */
  callers: CallerEntry[];
  /** Methods reached through an instance (`__call__`, `handle`): the code that builds one. A heuristic. */
  viaInstance: CallerEntry[];
  /** Test functions and test files that reference it (directly, through its class, or through an instance). */
  tests: TestEntry[];
}

export interface ChangeAnalysis {
  base: string;
  head: string;
  files: ChangedFileSummary[];
  totals: { files: number; added: number; removed: number };
  /** Changed symbols outside test files, in file and line order. */
  symbols: ChangedSymbol[];
  /**
   * Changed symbols in test files (tests the change adds or edits: top-level functions and methods of classes, not
   * the helpers nested in them), in file and line order, without callers.
   */
  testSymbols: Omit<ChangedSymbol, "callers" | "viaInstance" | "tests">[];
  /** Ids of the changed symbols (outside tests) that no test references. */
  untested: ElementId[];
}

/** Methods that code reaches through an instance, not by name: what builds the instance may call them later. */
export const INSTANCE_ENTRY_METHODS: ReadonlySet<string> = new Set(["__call__", "handle"]);
/** Constructors: calling the class runs them. */
export const CONSTRUCTOR_METHODS: ReadonlySet<string> = new Set([
  "__init__",
  "__new__",
  "constructor",
]);

/** Which reference kinds count as "using" a symbol of this kind. */
function useKinds(kind: IndexedSymbol["kind"]): ReadonlySet<Reference["kind"]> {
  switch (kind) {
    case "variable":
    case "key":
      return new Set(["read", "write"]);
    case "type":
    case "interface":
    case "enum":
      return new Set(["type-ref", "extends", "implements", "read"]);
    case "other":
      return new Set(["call", "read", "write", "type-ref", "extends", "implements"]);
    default:
      return new Set(["call"]);
  }
}

/** Is a line nothing but a comment or blank (by the file's language)? */
function blankOrComment(text: string, language: string | undefined): boolean {
  const line = text.trim();
  if (line === "") return true;
  switch (language) {
    case "python":
    case "yaml":
    case "toml":
    case "text":
      return line.startsWith("#");
    case "typescript":
    case "tsx":
    case "javascript":
    case "go":
      return (
        line.startsWith("//") || line.startsWith("/*") || line.startsWith("*") || line === "*/"
      );
    default:
      return false;
  }
}

/** The new-side lines the hunks added or edited, and the lines after which a pure deletion happened. */
function hunkLines(hunks: readonly ChangeHunk[]): { lines: Set<number>; deletions: number[] } {
  const lines = new Set<number>();
  const deletions: number[] = [];
  for (const hunk of hunks) {
    if (hunk.newLines > 0) {
      for (let line = hunk.newStart; line < hunk.newStart + hunk.newLines; line++) lines.add(line);
    } else deletions.push(hunk.newStart);
  }
  return { lines, deletions };
}

/**
 * Classify a head range conservatively from the diff. Only pure insertions prove that a declaration
 * is new. A replacement may rewrite an existing one-line field/function, even when every head line
 * is added; without a base symbol index it must remain changed.
 */
export function changeStatusOfRange(
  file: ChangedFile,
  range: Range,
): "new" | "changed" | undefined {
  if (file.status === "deleted") return undefined;
  if (file.status === "added") return "new";
  const added = new Set<number>();
  let touched = false;
  for (const hunk of Array.isArray(file.hunks) ? file.hunks : []) {
    if (hunk.newLines === 0) {
      if (hunk.newStart >= range.startLine && hunk.newStart < range.endLine) touched = true;
      continue;
    }
    const from = Math.max(range.startLine, hunk.newStart);
    const to = Math.min(range.endLine, hunk.newStart + hunk.newLines - 1);
    if (from > to) continue;
    touched = true;
    if (hunk.oldLines > 0) return "changed";
    for (let line = from; line <= to; line++) added.add(line);
  }
  if (added.size === range.endLine - range.startLine + 1) return "new";
  return touched ? "changed" : undefined;
}

/**
 * The analysis of a change against the index of its head (ARCHITECTURE.md, `xpl change`):
 *
 * - files with their +/- line counts;
 * - changed symbols: for each line the change added or edited (and each place where it only removed lines), the
 *   innermost index symbol around it; a function nested in a function counts as part of the outer one. A class
 *   counts only for lines of its own (not for blank lines or comments between its methods). A symbol all of whose
 *   lines were purely inserted is `new`; replacement hunks are conservatively `changed`;
 * - for each changed symbol outside tests: its direct callers outside test files (references of kind `call`; for a
 *   variable or key the reads and writes; for a type its uses), the code inside it excluded; for a constructor
 *   (`__init__`, `constructor`) the calls of its class too (`via: "class"`); for a method reached through an
 *   instance (`__call__`, `handle`) the code that builds the class, as a heuristic (`viaInstance`);
 * - the tests that reference it: test functions (or test files, for an import) with a reference of any kind to it,
 *   or to its class for a constructor or an instance method;
 * - `untested`: the changed symbols that no test references.
 *
 * `getText` (the head text) is used to skip blank and comment lines; without it every changed line counts.
 */
export function analyzeChange(
  change: ChangeRecord,
  index: IndexModel,
  getText?: (file: FilePath) => string | undefined,
): ChangeAnalysis {
  const files: ChangedFileSummary[] = [];
  /** Changed symbols of every file, with the lines that touch them. */
  const touched = new Map<SymbolId, { sym: IndexedSymbol; lines: Set<number> }>();
  const changedFiles = new Map(
    (Array.isArray(change.files) ? change.files : []).map((file) => [file.path, file]),
  );

  for (const file of Array.isArray(change.files) ? change.files : []) {
    const hunks = Array.isArray(file.hunks) ? file.hunks : [];
    const summary: ChangedFileSummary = {
      path: file.path,
      status: file.status,
      ...(file.oldPath !== undefined ? { oldPath: file.oldPath } : {}),
      added: hunks.reduce((sum, h) => sum + h.newLines, 0),
      removed: hunks.reduce((sum, h) => sum + h.oldLines, 0),
      hunks: hunks.length,
      test: isTestFile(file.path),
      indexed: file.status !== "deleted" && index.hasFile(file.path),
      outside: [],
    };
    files.push(summary);
    if (!summary.indexed) continue;
    const language = index.file(file.path)?.language;
    let text: readonly string[] | undefined;
    try {
      const raw = getText?.(file.path);
      text = raw === undefined ? undefined : raw.split(/\r?\n/);
    } catch {
      text = undefined;
    }
    const quiet = (line: number): boolean =>
      text !== undefined && blankOrComment(text[line - 1] ?? "", language);
    const { lines, deletions } = hunkLines(hunks);
    const touch = (inner: IndexedSymbol, line: number) => {
      // a function nested in a function is part of it: nothing outside can call it
      let sym = inner;
      for (let parent = index.parentSymbol(sym.id), hops = 0; parent && hops < 64; hops++) {
        if (parent.kind !== "function" && parent.kind !== "method") break;
        sym = parent;
        parent = index.parentSymbol(sym.id);
      }
      const entry = touched.get(sym.id) ?? { sym, lines: new Set<number>() };
      entry.lines.add(line);
      touched.set(sym.id, entry);
    };
    const outside = new Set<number>();
    for (const line of [...lines].sort((a, b) => a - b)) {
      const sym = index.innermostSymbolAt(file.path, line);
      // blank lines and comments count inside a function, not in the gaps of a class or at module level
      if (quiet(line) && (!sym || (sym.kind !== "function" && sym.kind !== "method"))) continue;
      if (sym) touch(sym, line);
      else outside.add(line);
    }
    for (const at of deletions) {
      // lines were removed between `after` and `after + 1` (0: at the top): the symbol that holds both lost them
      const after = Math.max(1, at);
      let sym = index.innermostSymbolAt(file.path, after);
      while (sym && !(sym.range.startLine <= after && sym.range.endLine >= after + 1)) {
        sym = index.parentSymbol(sym.id);
      }
      if (sym) touch(sym, after);
      else outside.add(after);
    }
    summary.outside = [...outside].sort((a, b) => a - b);
  }

  const statusOf = (sym: IndexedSymbol): "new" | "changed" => {
    const file = changedFiles.get(sym.file);
    return file ? (changeStatusOfRange(file, sym.range) ?? "changed") : "changed";
  };
  const changedStatus = new Map<SymbolId, "new" | "changed">();
  for (const { sym } of touched.values()) changedStatus.set(sym.id, statusOf(sym));
  /**
   * Is a symbol part of the change: changed itself, inside a new symbol (new too), or holding a changed one (a
   * function whose nested function changed)?
   */
  const changeOf = (id: SymbolId): "new" | "changed" | undefined => {
    const own = changedStatus.get(id);
    if (own) return own;
    for (let cur = index.symbol(id)?.parent, hops = 0; cur !== undefined && hops < 64; hops++) {
      if (changedStatus.get(cur) === "new") return "new";
      cur = index.symbol(cur)?.parent;
    }
    for (const changed of changedStatus.keys()) {
      if (changed !== id && index.symbolWithin(changed, id)) return "changed";
    }
    return undefined;
  };

  const entries = [...touched.values()].sort(
    (a, b) =>
      cmp(a.sym.file, b.sym.file) ||
      a.sym.range.startLine - b.sym.range.startLine ||
      cmp(a.sym.id, b.sym.id),
  );
  const base = (sym: IndexedSymbol, lines: Set<number>) => ({
    id: elementIdForSymbolId(sym.id),
    symbolId: sym.id,
    file: sym.file,
    kind: sym.kind,
    range: { startLine: sym.range.startLine, endLine: sym.range.endLine },
    status: changedStatus.get(sym.id) ?? "changed",
    lines: [...lines].sort((a, b) => a - b),
  });

  const symbols: ChangedSymbol[] = [];
  const testSymbols: ChangeAnalysis["testSymbols"] = [];
  for (const { sym, lines } of entries) {
    if (isTestFile(sym.file)) {
      // the tests themselves: top-level functions and methods of test classes, not the helpers nested in them
      const parent = index.parentSymbol(sym.id);
      if (parent === undefined || parent.kind === "class") testSymbols.push(base(sym, lines));
      continue;
    }
    symbols.push({ ...base(sym, lines), ...relations(sym, index, changeOf) });
  }

  return {
    base: change.base,
    head: change.head,
    files,
    totals: {
      files: files.length,
      added: files.reduce((sum, f) => sum + f.added, 0),
      removed: files.reduce((sum, f) => sum + f.removed, 0),
    },
    symbols,
    testSymbols,
    untested: symbols.filter((s) => s.tests.length === 0).map((s) => s.id),
  };
}

/** The test function a reference from a test file belongs to: its top-level function, or a method of a test class. */
function testOwner(index: IndexModel, from: SymbolId): { id: ElementId; symbolId?: SymbolId } {
  const chain: IndexedSymbol[] = [];
  for (let sym = index.symbol(from); sym && chain.length < 64; sym = index.parentSymbol(sym.id)) {
    chain.unshift(sym);
  }
  const top = chain[0];
  if (!top) {
    const file = index.fileOfSymbolId(from) ?? from.slice(0, Math.max(0, from.indexOf("#")));
    return { id: `file:${file}` };
  }
  const owner = top.kind === "class" && chain[1] ? chain[1] : top;
  return { id: elementIdForSymbolId(owner.id), symbolId: owner.id };
}

function relations(
  sym: IndexedSymbol,
  index: IndexModel,
  changeOf: (id: SymbolId) => "new" | "changed" | undefined,
): Pick<ChangedSymbol, "callers" | "viaInstance" | "tests"> {
  const kinds = useKinds(sym.kind);
  const name = sym.path.slice(sym.path.lastIndexOf(".") + 1).replace(/~\d+$/, "");
  const parent = index.parentSymbol(sym.id);
  const viaClass = parent?.kind === "class" && CONSTRUCTOR_METHODS.has(name) ? parent : undefined;
  const viaInstance =
    parent?.kind === "class" && INSTANCE_ENTRY_METHODS.has(name) ? parent : undefined;

  const callers = new Map<string, CallerEntry>();
  const instance = new Map<string, CallerEntry>();
  const tests = new Map<string, TestEntry>();
  const addCaller = (
    into: Map<string, CallerEntry>,
    ref: Reference,
    via?: CallerEntry["via"],
  ): void => {
    const file = index.fileOfSymbolId(ref.from);
    if (file === undefined) return;
    const id = elementIdForSymbolId(ref.from);
    let entry = into.get(id);
    if (!entry) {
      const changed = index.symbol(ref.from) ? changeOf(ref.from) : undefined;
      entry = {
        id,
        file,
        lines: [],
        kinds: [],
        resolution: ref.resolution,
        ...(changed ? { changed } : {}),
        ...(via ? { via } : {}),
      };
      into.set(id, entry);
    }
    if (!entry.lines.includes(ref.site.startLine)) entry.lines.push(ref.site.startLine);
    if (!entry.kinds.includes(ref.kind)) entry.kinds.push(ref.kind);
    if (ref.resolution === "precise") entry.resolution = "precise";
  };
  const addTest = (ref: Reference, via?: TestEntry["via"]): void => {
    const file = index.fileOfSymbolId(ref.from);
    if (file === undefined) return;
    const owner = testOwner(index, ref.from);
    let entry = tests.get(owner.id);
    if (!entry) {
      const changed = owner.symbolId ? changeOf(owner.symbolId) : undefined;
      entry = {
        id: owner.id,
        file,
        refs: 0,
        kinds: [],
        ...(changed ? { changed } : {}),
        ...(via ? { via } : {}),
      };
      tests.set(owner.id, entry);
    }
    entry.refs++;
    if (!entry.kinds.includes(ref.kind)) entry.kinds.push(ref.kind);
  };

  const inside = (id: SymbolId, of: IndexedSymbol) => index.symbolWithin(id, of.id);
  const scan = (target: IndexedSymbol, via?: "class" | "instance") => {
    for (const ref of index.refsTo(target.id)) {
      if (inside(ref.from, target) || inside(ref.from, sym)) continue;
      const file = index.fileOfSymbolId(ref.from);
      if (file === undefined) continue;
      if (isTestFile(file)) addTest(ref, via);
      else if (via === "instance") {
        if (ref.kind === "call") addCaller(instance, ref, via);
      } else if (via === "class") {
        if (ref.kind === "call") addCaller(callers, ref, via);
      } else if (kinds.has(ref.kind)) addCaller(callers, ref);
    }
  };
  scan(sym);
  if (viaClass) scan(viaClass, "class");
  if (viaInstance) scan(viaInstance, "instance");

  // a test file that imports the symbol and also uses it in its tests: the tests say more than the import
  const testList = [...tests.values()];
  const withSymbols = new Set(testList.filter((t) => t.id.startsWith("sym:")).map((t) => t.file));
  const order = <T extends { file: string; id: string }>(list: T[]) =>
    list.sort((a, b) => cmp(a.file, b.file) || cmp(a.id, b.id));
  return {
    callers: order([...callers.values()]),
    viaInstance: order([...instance.values()].filter((entry) => !callers.has(entry.id))),
    tests: order(testList.filter((t) => t.id.startsWith("sym:") || !withSymbols.has(t.file))),
  };
}
