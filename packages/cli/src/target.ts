/**
 * What a command argument names: repo, `dir:`, `file:` or `sym:` (ARCHITECTURE.md §4.3), resolved
 * against the index through core's `normalizeElementId`, so `src/a.ts#A.b`, `src/a.ts` and `./src/`
 * work too, and mistakes come back with core's "did you mean" suggestions.
 */
import {
  REPO_ID,
  normalizeElementId,
  parseId,
  type IndexModel,
  type IndexedFile,
  type IndexedSymbol,
  type SymbolId,
} from "@xpl/core";
import { CliError } from "./errors.js";

export type Target =
  | { type: "repo"; id: string }
  | { type: "dir"; id: string; path: string }
  | { type: "file"; id: string; path: string; file: IndexedFile }
  | { type: "symbol"; id: string; symbolId: SymbolId; symbol: IndexedSymbol };

export const REPO_TARGET: Target = { type: "repo", id: REPO_ID };

/**
 * `kinds`: the symbol kinds the command takes. A suggestion of another kind (an interface for a command that needs an
 * enum) is dropped, so the next run is not refused for it; with none left, `kindHint` says how to find one.
 */
export function resolveTarget(
  model: IndexModel,
  input: string,
  kinds?: { kinds: ReadonlySet<IndexedSymbol["kind"]>; kindHint: string },
): Target {
  const normalized = normalizeElementId(input, model);
  if (!normalized.ok && kinds && normalized.candidates && normalized.candidates.length > 0) {
    const kept = normalized.candidates.filter((id) => {
      const parsed = parseId(id);
      const sym = parsed.type === "symbol" ? model.symbol(parsed.symbolId) : undefined;
      return sym !== undefined && kinds.kinds.has(sym.kind);
    });
    const base = normalized.error.replace(/\.? Did you mean: .*\?$/, "");
    throw new CliError(
      kept.length > 0 ? `${base}. Did you mean: ${kept.join(", ")}?` : `${base}. ${kinds.kindHint}`,
      1,
      kept.length > 0 ? { candidates: kept } : {},
    );
  }
  if (!normalized.ok) {
    // nothing close to suggest: say how to find an id
    const word =
      input
        .replace(/^(?:sym|file|dir):/, "")
        .split(/[#/.]/)
        .filter(Boolean)
        .at(-1) ?? input;
    const hint =
      (normalized.candidates?.length ?? 0) === 0 &&
      !/`xpl (?:outline|search)/.test(normalized.error)
        ? ` Find ids with \`xpl search ${word}\` or \`xpl outline\`.`
        : "";
    throw new CliError(normalized.error + hint, 1, {
      ...(normalized.candidates ? { candidates: normalized.candidates } : {}),
    });
  }
  const id = normalized.id;
  const parsed = parseId(id);
  switch (parsed.type) {
    case "repo":
      return REPO_TARGET;
    case "dir":
      return { type: "dir", id, path: parsed.path };
    case "file": {
      const file = model.file(parsed.path);
      if (!file) throw new CliError(`unknown file "${parsed.path}"`);
      return { type: "file", id, path: parsed.path, file };
    }
    case "symbol": {
      const symbol = model.symbol(parsed.symbolId);
      if (!symbol) throw new CliError(`unknown symbol "${parsed.symbolId}"`);
      return { type: "symbol", id, symbolId: parsed.symbolId, symbol };
    }
    default:
      throw new CliError(
        `"${input}" is not something the index knows: use repo, dir:<path>, file:<path> or sym:<file>#<symbol> ` +
          `(ids of groups, concepts, edges and steps only exist inside an explainer)`,
      );
  }
}

function fileScope(model: IndexModel, path: string): SymbolId[] {
  return [model.moduleScopeId(path), ...model.symbolsInFile(path).map((s) => s.id)];
}

function symbolSubtree(model: IndexModel, id: SymbolId, out: SymbolId[]): void {
  out.push(id);
  for (const child of model.childSymbols(id)) symbolSubtree(model, child.id, out);
}

/**
 * The reference endpoints a target contains: a symbol and its descendants; a file's module scope
 * (`<file>#`) and all its symbols; a directory's files likewise; everything for the repo.
 */
export function subtreeIds(model: IndexModel, target: Target): SymbolId[] {
  switch (target.type) {
    case "symbol": {
      const out: SymbolId[] = [];
      symbolSubtree(model, target.symbolId, out);
      return out;
    }
    case "file":
      return fileScope(model, target.path);
    case "dir":
      return model.filesUnder(target.path).flatMap((path) => fileScope(model, path));
    case "repo":
      return model.files.flatMap((file) => fileScope(model, file.path));
  }
}

/** One line naming a target: `sym:src/a.ts#A.b (method) src/a.ts:12-30`. */
export function describeTarget(target: Target): string {
  switch (target.type) {
    case "repo":
      return "repo";
    case "dir":
      return `${target.id} (dir)`;
    case "file":
      return `${target.id} (${target.file.language}) ${target.path}:1-${target.file.lines}`;
    case "symbol": {
      const { file, kind, range } = target.symbol;
      return `${target.id} (${kind}) ${file}:${range.startLine}-${range.endLine}`;
    }
  }
}
