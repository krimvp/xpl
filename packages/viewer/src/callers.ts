/**
 * "Who calls this": the code that calls (or extends, implements) a file or a symbol, from the index's
 * references, one row per calling symbol (its first call site). Calls from inside the element itself are
 * left out: a method calling its own class is not an answer to "who uses this".
 *
 * And what a change did to an element ("Added by this change", "+5 −2 in it"), for the details of a picked
 * box and the guide of a change.
 */
import {
  codeFocus,
  elementIdForSymbolId,
  parseId,
  type ChangeRecord,
  type ElementId,
  type ExplainerModel,
  type FilePath,
  type IndexedSymbol,
  type IndexModel,
  type SymbolId,
} from "@xpl/core";
import { changeAt, changeStatus, fileDiff } from "./diff.js";

/** One caller: the symbol (or a file's top level) that calls, and where. */
export interface Caller {
  from: SymbolId;
  /** `Runner.dispatch`, or `main.ts (top level)`. */
  label: string;
  file: FilePath;
  line: number;
}

const USES = new Set(["call", "extends", "implements"]);

const base = (path: string) => path.slice(path.lastIndexOf("/") + 1);

/** What `id` (a file or a symbol) is called from; empty for any other element. Sorted by file, then line. */
export function callersOf(id: ElementId, index: IndexModel): Caller[] {
  const parsed = parseId(id);
  let targets: SymbolId[];
  let inside: (from: SymbolId) => boolean;
  if (parsed.type === "symbol") {
    const prefix = parsed.symbolId;
    targets = index
      .symbolsInFile(parsed.file)
      .filter((sym) => sym.id === prefix || sym.id.startsWith(prefix + "."))
      .map((sym) => sym.id);
    inside = (from) => from === prefix || from.startsWith(prefix + ".");
  } else if (parsed.type === "file") {
    targets = [`${parsed.path}#`, ...index.symbolsInFile(parsed.path).map((sym) => sym.id)];
    inside = (from) => index.fileOfSymbolId(from) === parsed.path;
  } else return [];
  const byCaller = new Map<SymbolId, Caller>();
  for (const target of targets) {
    for (const ref of index.refsTo(target)) {
      if (!USES.has(ref.kind) || inside(ref.from)) continue;
      const known = byCaller.get(ref.from);
      const file = index.fileOfSymbolId(ref.from) ?? ref.from.slice(0, ref.from.indexOf("#"));
      if (known && known.line <= ref.site.startLine) continue;
      const sym = index.symbol(ref.from);
      byCaller.set(ref.from, {
        from: ref.from,
        label: sym ? sym.path : `${base(file)} (top level)`,
        file,
        line: ref.site.startLine,
      });
    }
  }
  return [...byCaller.values()].sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);
}

/** What the change did to a file or a symbol, in a reader's words, and where to look at it. */
export interface ChangeSummary {
  /** "Added by this change", "Edited by this change", "Renamed by this change, from old/path". */
  words: string;
  /** Lines the change added or rewrote in the element, and the lines it removed from it. */
  added: number;
  deleted: number;
  /** All of it: "Edited by this change · +5 −1". */
  text: string;
  file: FilePath;
  /** The line to open the file at: the first change inside the element. */
  line: number;
}

export function changeSummary(
  id: ElementId,
  index: IndexModel,
  change: ChangeRecord | undefined,
): ChangeSummary | undefined {
  if (!change) return undefined;
  const parsed = parseId(id);
  const path =
    parsed.type === "file" ? parsed.path : parsed.type === "symbol" ? parsed.file : undefined;
  const file = path ? changeAt(change, path) : undefined;
  if (!path || !file || file.status === "deleted") return undefined;
  const diff = fileDiff(file);
  const lines = [...diff.lines.keys(), ...diff.removed.map((block) => block.at)];
  const summary = (words: string, added: number, deleted: number, line: number) => ({
    words,
    added,
    deleted,
    text: `${words} · +${added} −${deleted}`,
    file: path,
    line,
  });
  if (parsed.type === "file") {
    const words =
      file.status === "added"
        ? "Added by this change"
        : file.status === "renamed"
          ? `Renamed by this change, from ${file.oldPath ?? "?"}`
          : "Edited by this change";
    return summary(
      words,
      diff.added,
      diff.deleted,
      Math.min(...lines.filter((n) => n >= 1), Infinity) || 1,
    );
  }
  const status = changeStatus(id, index, change);
  const sym = parsed.type === "symbol" ? index.symbol(parsed.symbolId) : undefined;
  if (!status || !sym) return undefined;
  const { startLine, endLine } = sym.range;
  const inside = (n: number) => n >= startLine && n <= endLine;
  const within = lines.filter(inside);
  // Removed lines count where they sit: above a line of the symbol, or below one that is not its last.
  const deleted = diff.removed
    .filter((block) => inside(block.at) && !(block.place === "after" && block.at === endLine))
    .reduce((sum, block) => sum + block.to - block.from + 1, 0);
  return summary(
    status === "new" ? "Added by this change" : "Edited by this change",
    [...diff.lines.keys()].filter(inside).length,
    deleted,
    within.length ? Math.min(...within) : startLine,
  );
}

/**
 * The element whose callers answer "who calls this": a file or a symbol itself; for a flow step inside one
 * part (from = to), the symbol that holds its code (a step of `findRoute` asks who calls `findRoute`, not who
 * calls its file). Undefined for anything else.
 */
export function callerSubject(id: ElementId, model: ExplainerModel): ElementId | undefined {
  const parsed = parseId(id);
  if (parsed.type === "file" || parsed.type === "symbol") return id;
  const element = model.element(id);
  if (element?.type !== "step" || element.step.from !== element.step.to) return undefined;
  const first = codeFocus([id], model)[0];
  const holder = first
    ? model.index.innermostSymbolAt(first.file, first.range.startLine)
    : undefined;
  if (holder) return elementIdForSymbolId(holder.id);
  const owner = parseId(element.step.from).type;
  return owner === "symbol" || owner === "file" ? element.step.from : undefined;
}

/** The last name of a symbol path, as the code writes it: `Ky.#retry` -> `retry`, `Signer.sign` -> `sign`. */
const nameOf = (path: string) => path.slice(path.lastIndexOf(".") + 1).replace(/^#/, "");

/**
 * The symbol a name in the code stands for, at a line of a file: what a reference on that line points at, or
 * the symbol declared there. Undefined when the index knows neither.
 */
export function symbolAtWord(
  index: IndexModel,
  file: FilePath,
  line: number,
  word: string,
): IndexedSymbol | undefined {
  const name = word.replace(/^#/, "");
  if (!name) return undefined;
  for (const from of [index.moduleScopeId(file), ...index.symbolsInFile(file).map((s) => s.id)]) {
    for (const ref of index.refsFrom(from)) {
      if (ref.site.startLine > line || ref.site.endLine < line || ref.kind === "import") continue;
      const target = index.symbol(ref.to);
      if (target && nameOf(target.path) === name) return target;
    }
  }
  // A declaration: the symbol of that name whose range starts on that line (or just above: a decorator).
  return index
    .symbolsInFile(file)
    .filter(
      (sym) =>
        nameOf(sym.path) === name && sym.range.startLine <= line && line <= sym.range.startLine + 3,
    )
    .sort((a, b) => b.range.startLine - a.range.startLine)[0];
}
