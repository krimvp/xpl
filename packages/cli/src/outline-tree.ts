/**
 * The tree behind `xpl outline` (and the directory listing of `xpl show`): repo, directories, files
 * and symbols, each with its kind, line range and fan-in / fan-out.
 *
 * Fan-in / fan-out of a node = number of index references into / out of its subtree, not counting the
 * ones that stay inside it. A directory's subtree is its files, a file's is its module scope plus all
 * its symbols, a symbol's is itself and its descendants.
 */
import { baseName, dirOf, parseId, symId, type IndexModel, type IndexedSymbol } from "@xpl/core";
import { rangeText } from "./format.js";

export interface OutlineNode {
  id: string;
  type: "repo" | "dir" | "file" | "symbol";
  label: string;
  /** `repo`, `dir`, the file's language, or the symbol's kind. */
  kind: string;
  range?: { startLine: number; endLine: number };
  /** Files below (repo and dir). */
  files?: number;
  /** Symbols in the index (repo only). */
  symbols?: number;
  fanIn: number;
  fanOut: number;
  /** Children below the depth limit that are not shown. */
  more: number;
  /** Config keys of this file that are not shown (see `--keys`). */
  hiddenKeys: number;
  children: OutlineNode[];
}

export interface Fans {
  fanIn: Map<string, number>;
  fanOut: Map<string, number>;
}

const fanCache = new WeakMap<IndexModel, Fans>();

/** Element ids from a reference endpoint up to the root: symbol, parents, file, directories. */
function chainOf(model: IndexModel, endpoint: string): string[] {
  const out: string[] = [];
  const symbol = model.symbol(endpoint);
  let file: string | undefined;
  if (symbol) {
    file = symbol.file;
    let cur: IndexedSymbol | undefined = symbol;
    for (let hops = 0; cur && cur.file === file && hops < 64; hops++) {
      out.push(symId(cur.file, cur.path));
      cur = model.parentSymbol(cur.id);
    }
  } else {
    file = model.fileOfSymbolId(endpoint);
  }
  if (file === undefined) return [];
  out.push(`file:${file}`);
  for (let dir = dirOf(file); dir !== ""; dir = dirOf(dir)) out.push(`dir:${dir}`);
  return out;
}

/** Fan-in and fan-out of every dir, file and symbol (memoised per index). */
export function computeFans(model: IndexModel): Fans {
  const cached = fanCache.get(model);
  if (cached) return cached;
  const fanIn = new Map<string, number>();
  const fanOut = new Map<string, number>();
  const chains = new Map<string, string[]>();
  const chain = (endpoint: string): string[] => {
    let value = chains.get(endpoint);
    if (!value) {
      value = chainOf(model, endpoint);
      chains.set(endpoint, value);
    }
    return value;
  };
  const bump = (map: Map<string, number>, key: string) => map.set(key, (map.get(key) ?? 0) + 1);
  for (const ref of model.refs) {
    const from = chain(ref.from);
    const to = chain(ref.to);
    if (from.length === 0 || to.length === 0) continue;
    const fromSet = new Set(from);
    const toSet = new Set(to);
    for (const id of from) if (!toSet.has(id)) bump(fanOut, id);
    for (const id of to) if (!fromSet.has(id)) bump(fanIn, id);
  }
  const fans = { fanIn, fanOut };
  fanCache.set(model, fans);
  return fans;
}

export interface OutlineOptions {
  /** Levels below the root to show (0: only the root). */
  depth: number;
  /** Show config-key symbols. */
  keys: boolean;
  repoName: string;
}

/** Ids of the children of a node: directories then files, or the symbols inside a file or symbol. */
function childIds(
  model: IndexModel,
  id: string,
  keys: boolean,
): { ids: string[]; hiddenKeys: number } {
  const parsed = parseId(id);
  if (parsed.type === "repo" || parsed.type === "dir") {
    const { dirs, files } = model.dirChildren(parsed.type === "repo" ? "" : parsed.path);
    return {
      ids: [...dirs.map((d) => `dir:${d}`), ...files.map((f) => `file:${f}`)],
      hiddenKeys: 0,
    };
  }
  let symbols: readonly IndexedSymbol[] = [];
  let hiddenKeys = 0;
  if (parsed.type === "file") {
    symbols = model.topLevelSymbols(parsed.path);
    if (!keys) hiddenKeys = model.symbolsInFile(parsed.path).filter((s) => s.kind === "key").length;
  } else if (parsed.type === "symbol") {
    symbols = model.childSymbols(parsed.symbolId);
  }
  const ids = symbols
    .filter((symbol) => keys || symbol.kind !== "key")
    .map((symbol) => symId(symbol.file, symbol.path));
  return { ids, hiddenKeys };
}

function makeNode(model: IndexModel, fans: Fans, id: string, opts: OutlineOptions): OutlineNode {
  const parsed = parseId(id);
  const base = {
    id,
    fanIn: fans.fanIn.get(id) ?? 0,
    fanOut: fans.fanOut.get(id) ?? 0,
    more: 0,
    hiddenKeys: 0,
    children: [] as OutlineNode[],
  };
  switch (parsed.type) {
    case "dir":
      return {
        ...base,
        type: "dir",
        label: baseName(parsed.path),
        kind: "dir",
        files: model.filesUnder(parsed.path).length,
      };
    case "file": {
      const file = model.file(parsed.path)!;
      return {
        ...base,
        type: "file",
        label: baseName(parsed.path),
        kind: file.language,
        range: { startLine: 1, endLine: file.lines },
      };
    }
    case "symbol": {
      const symbol = model.symbol(parsed.symbolId)!;
      return {
        ...base,
        type: "symbol",
        label: symbol.path.slice(symbol.path.lastIndexOf(".") + 1),
        kind: symbol.kind,
        range: { startLine: symbol.range.startLine, endLine: symbol.range.endLine },
      };
    }
    default:
      return {
        ...base,
        id: "repo",
        type: "repo",
        label: opts.repoName,
        kind: "repo",
        files: model.files.length,
        symbols: model.symbols.length,
        fanIn: 0,
        fanOut: 0,
      };
  }
}

/** The outline below the element `id` (repo, dir, file or symbol), `opts.depth` levels deep. */
export function buildOutline(model: IndexModel, id: string, opts: OutlineOptions): OutlineNode {
  const fans = computeFans(model);
  const fill = (node: OutlineNode, depth: number): void => {
    const { ids, hiddenKeys } = childIds(model, node.id, opts.keys);
    node.hiddenKeys = hiddenKeys;
    if (depth <= 0) {
      node.more = ids.length;
      return;
    }
    for (const childId of ids) {
      const child = makeNode(model, fans, childId, opts);
      fill(child, depth - 1);
      node.children.push(child);
    }
  };
  const root = makeNode(model, fans, id, opts);
  fill(root, opts.depth);
  return root;
}

export function renderOutline(root: OutlineNode): string[] {
  const lines: string[] = [];
  const visit = (node: OutlineNode, indent: number): void => {
    const parts: string[] = [node.id];
    if (node.type === "repo") {
      parts.push(node.label, `${node.files} files, ${node.symbols} symbols`);
    } else {
      parts.push(node.kind);
      if (node.type === "dir") parts.push(`${node.files} file${node.files === 1 ? "" : "s"}`);
      if (node.range) parts.push(rangeText(node.range));
      parts.push(`in=${node.fanIn} out=${node.fanOut}`);
    }
    let line = `${"  ".repeat(indent)}${parts.join("  ")}`;
    if (node.more > 0) line += `  [+${node.more}]`;
    if (node.hiddenKeys > 0) line += `  [${node.hiddenKeys} keys hidden]`;
    lines.push(line);
    for (const child of node.children) visit(child, indent + 1);
  };
  visit(root, 0);
  return lines;
}

/** JSON form: `children` are nested, `more` and `hiddenKeys` are left out when zero. */
export function outlineJson(node: OutlineNode): unknown {
  return {
    id: node.id,
    type: node.type,
    label: node.label,
    kind: node.kind,
    ...(node.range ? { range: node.range } : {}),
    ...(node.files !== undefined ? { files: node.files } : {}),
    ...(node.symbols !== undefined ? { symbols: node.symbols } : {}),
    fanIn: node.fanIn,
    fanOut: node.fanOut,
    ...(node.more > 0 ? { more: node.more } : {}),
    ...(node.hiddenKeys > 0 ? { hiddenKeys: node.hiddenKeys } : {}),
    ...(node.children.length > 0 ? { children: node.children.map(outlineJson) } : {}),
  };
}

/** Does the tree contain nodes with children cut off by the depth limit / hidden config keys? */
export function outlineNotes(root: OutlineNode): { cut: boolean; hiddenKeys: boolean } {
  const notes = { cut: false, hiddenKeys: false };
  const visit = (node: OutlineNode): void => {
    if (node.more > 0) notes.cut = true;
    if (node.hiddenKeys > 0) notes.hiddenKeys = true;
    node.children.forEach(visit);
  };
  visit(root);
  return notes;
}
