/**
 * From symbol drafts (what a language pack found) to `IndexedSymbol`s (what the index stores), and the
 * innermost-symbol lookup used to attribute reference sites and SCIP occurrences.
 *
 * The framework, not the pack, assigns: ids (`<file>#<path>`), `~2`/`~3` duplicate suffixes (in source
 * order), whole-line ranges, hashes (`hashText` of the symbol's full lines) and parents.
 */
import { moduleScopeId, type FilePath, type IndexedSymbol, type SymbolId } from "@xpl/core";
import { SpanIndex, comparePos } from "./ast.js";
import { FileHasher } from "./hash.js";
import type { Span } from "./ast.js";
import type { SymbolDraft } from "./languages/types.js";

/** An indexed symbol with the columns the index itself does not store. */
export interface SymbolEntry {
  symbol: IndexedSymbol;
  /** Full extent including columns. */
  span: Span;
  /** The pack's pre-dedup path (`symbol.path` without a `~N` suffix). */
  basePath: string;
  /** `SymbolDraft.anchorOnly`: never looked up by name, never the target of a reference. */
  anchorOnly?: boolean;
}

export interface AssembledSymbols {
  /** In source order. */
  entries: SymbolEntry[];
}

/** Order drafts by position: earlier start first, then larger extent first, then input order. */
function sortDrafts(drafts: readonly SymbolDraft[]): SymbolDraft[] {
  return drafts
    .map((draft, i) => ({ draft, i }))
    .sort(
      (a, b) =>
        comparePos(
          a.draft.range.startLine,
          a.draft.range.startCol,
          b.draft.range.startLine,
          b.draft.range.startCol,
        ) ||
        comparePos(
          b.draft.range.endLine,
          b.draft.range.endCol,
          a.draft.range.endLine,
          a.draft.range.endCol,
        ) ||
        a.i - b.i,
    )
    .map((x) => x.draft);
}

/**
 * Build the `IndexedSymbol`s of one file. `lines` are the file's lines (`splitLines`); pass the file's
 * `hasher` if you have one (it trims the lines once).
 */
export function assembleSymbols(
  file: FilePath,
  lines: readonly string[],
  drafts: readonly SymbolDraft[],
  hasher: FileHasher = new FileHasher(lines),
): AssembledSymbols {
  const sorted = sortDrafts(drafts.filter((d) => d.path !== "" && d.range.startLine >= 1));

  // Numbering of duplicate paths, in source order.
  const seen = new Map<string, number>();
  const finalPaths = sorted.map((d) => {
    const n = (seen.get(d.path) ?? 0) + 1;
    seen.set(d.path, n);
    return n === 1 ? d.path : `${d.path}~${n}`;
  });

  // Drafts by pre-dedup path, for parent lookup.
  const byPath = new Map<string, number[]>();
  sorted.forEach((d, i) => {
    const list = byPath.get(d.path);
    if (list) list.push(i);
    else byPath.set(d.path, [i]);
  });

  const entries: SymbolEntry[] = [];
  sorted.forEach((draft, i) => {
    const path = finalPaths[i]!;
    const range = {
      startLine: draft.range.startLine,
      endLine: Math.max(draft.range.endLine, draft.range.startLine),
    };
    const symbol: IndexedSymbol = {
      id: `${file}#${path}`,
      file,
      path,
      kind: draft.kind,
      range,
      hash: hasher.hashRange(range),
    };
    if (draft.parentPath !== undefined) {
      const candidates = byPath.get(draft.parentPath);
      if (candidates) {
        // Prefer the candidate that contains the child (innermost such), else the closest one before it.
        let best: number | undefined;
        for (const c of candidates) {
          if (c === i) continue;
          const cs = sorted[c]!.range;
          const contains =
            comparePos(cs.startLine, cs.startCol, draft.range.startLine, draft.range.startCol) <=
              0 && comparePos(cs.endLine, cs.endCol, draft.range.endLine, draft.range.endCol) >= 0;
          if (contains) best = c;
        }
        if (best === undefined) {
          for (const c of candidates) if (c < i) best = c;
        }
        best ??= candidates.find((c) => c !== i);
        if (best !== undefined) symbol.parent = `${file}#${finalPaths[best]!}`;
      }
    }
    const entry: SymbolEntry = { symbol, span: draft.range, basePath: draft.path };
    if (draft.anchorOnly) entry.anchorOnly = true;
    entries.push(entry);
  });
  return { entries };
}

/**
 * Innermost-symbol lookup over the built symbols of every file. Used to find the `from` of a reference
 * site and the `to` of a SCIP definition. Positions are 1-based.
 */
export class SymbolLookup {
  private readonly perFile = new Map<FilePath, SpanIndex<SymbolEntry>>();
  private readonly byIdMap = new Map<SymbolId, SymbolEntry>();

  constructor(entries: readonly SymbolEntry[]) {
    const grouped = new Map<FilePath, SymbolEntry[]>();
    for (const entry of entries) {
      this.byIdMap.set(entry.symbol.id, entry);
      const list = grouped.get(entry.symbol.file);
      if (list) list.push(entry);
      else grouped.set(entry.symbol.file, [entry]);
    }
    for (const [file, list] of grouped) {
      this.perFile.set(
        file,
        new SpanIndex(list.map((entry) => ({ span: entry.span, value: entry }))),
      );
    }
  }

  /** The symbol with this id. */
  get(id: SymbolId): IndexedSymbol | undefined {
    return this.byIdMap.get(id)?.symbol;
  }

  /** The entry (symbol + columns) with this id. */
  entry(id: SymbolId): SymbolEntry | undefined {
    return this.byIdMap.get(id);
  }

  /**
   * The innermost symbol of `file` containing the 1-based position. Without `col` only lines are compared
   * (a symbol is taken to span its whole lines), which is ambiguous for several symbols on one line.
   */
  innermost(file: FilePath, line: number, col?: number): IndexedSymbol | undefined {
    return this.innermostEntry(file, line, col)?.symbol;
  }

  innermostEntry(file: FilePath, line: number, col?: number): SymbolEntry | undefined {
    const index = this.perFile.get(file);
    if (!index) return undefined;
    if (col !== undefined) return index.innermost(line, col);
    // Line-only query: prefer a symbol that covers the whole line, else one that ends on it.
    return index.innermost(line, 1) ?? index.innermost(line, Number.MAX_SAFE_INTEGER);
  }

  /** Id of the innermost symbol at the position, or the file's module scope (`"<file>#"`). */
  fromId(file: FilePath, line: number, col?: number): SymbolId {
    return this.innermost(file, line, col)?.id ?? moduleScopeId(file);
  }
}
