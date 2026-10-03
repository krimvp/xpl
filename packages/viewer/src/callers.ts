/**
 * "Who calls this": the code that calls (or extends, implements) a file or a symbol, from the index's
 * references, one row per calling symbol (its first call site). Calls from inside the element itself are
 * left out: a method calling its own class is not an answer to "who uses this".
 *
 * And what a change did to an element ("Added by this change", "+5 −2 in it"), for the details of a picked
 * box and the guide of a change.
 */
import {
  parseId,
  type ChangeRecord,
  type ElementId,
  type FilePath,
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
  if (parsed.type === "file") {
    const words =
      file.status === "added"
        ? "Added by this change"
        : file.status === "renamed"
          ? `Renamed by this change, from ${file.oldPath ?? "?"}`
          : "Edited by this change";
    return {
      text: `${words}: +${diff.added} −${diff.deleted}`,
      file: path,
      line: Math.min(...lines.filter((n) => n >= 1), Infinity) || 1,
    };
  }
  const status = changeStatus(id, index, change);
  const sym = parsed.type === "symbol" ? index.symbol(parsed.symbolId) : undefined;
  if (!status || !sym) return undefined;
  const within = lines.filter((n) => n >= sym.range.startLine && n <= sym.range.endLine);
  return {
    text: status === "new" ? "Added by this change" : "Edited by this change",
    file: path,
    line: within.length ? Math.min(...within) : sym.range.startLine,
  };
}
