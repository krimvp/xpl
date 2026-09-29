/**
 * TOML language pack: every key is a symbol (`kind: "key"`) whose path is the dotted key path, like YAML and
 * JSON (`pyproject.toml`: `[project.scripts]` + `flask = "flask.cli:main"` -> `project.scripts.flask`).
 * No reference sites.
 *
 * - a table header `[a.b]` is the symbol `a.b`, spanning the header and the pairs under it up to the next
 *   header (comments after the last pair belong to what follows, as in YAML). The tables that are only
 *   implied (`a` in `[a.b]`) are not symbols: they have no range of their own, and tables of one name are
 *   not contiguous;
 * - a pair `k = v` is `<table>.k`; a dotted key `x.y = v` is `<table>.x.y` (one symbol, the pair; its prefixes
 *   are not symbols). The range is the whole pair, a multi-line array included;
 * - an array of tables `[[a.b]]` addresses its elements by index, `a.b.0`, `a.b.1`, ..., each element being a
 *   symbol that spans its header and pairs; a table below one belongs to the latest element:
 *   `[[fruits]]` + `[fruits.physical]` -> `fruits.0.physical`; a pair inside is `fruits.0.name`;
 * - inline tables and arrays behave like YAML mappings and sequences: `opts = { a = 1, b = { c = 2 } }` gives
 *   `opts`, `opts.a`, `opts.b`, `opts.b.c`; `xs = [{ k = 1 }]` gives `xs`, `xs.0.k`;
 * - quoted keys are unquoted (`"a b" = 1` -> `a b`); at most 6 levels of keys (indices do not count) and 2000
 *   keys per file, as for YAML.
 *
 * The files are `text` in the index: `FileLanguage` (core) has no "toml" yet, so the pack is found by file
 * extension (`LanguagePack.extensions`) and parsed with its own grammar.
 */
import type { Node } from "web-tree-sitter";
import { pointsToSpan } from "../ast.js";
import { KeyCollector, MAX_KEY_DEPTH, MAX_NESTING } from "./keys.js";
import type { FileContext, FileFacts, LanguagePack, RepoView, Span } from "./types.js";

/** Named children without comments (comments are extras and can sit between any two tokens). */
function named(node: Node): Node[] {
  return node.namedChildren.filter((c) => c.type !== "comment");
}

/** The text of a quoted key without its quotes (`"a\tb"` with its escapes, `'a\b'` literally). */
function unquote(raw: string): string {
  if (raw.startsWith("'")) return raw.slice(1, -1);
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed === "string") return parsed;
  } catch {
    // TOML escapes JSON does not have (`\xHH`, `\e`): fall back to the raw text
  }
  return raw.slice(1, -1);
}

/** The segments a key node spells: `a` -> [a], `a."b c".d` -> [a, "b c", d]. */
function keySegments(key: Node | undefined, out: string[] = []): string[] {
  if (!key) return out;
  switch (key.type) {
    case "bare_key":
      out.push(key.text);
      break;
    case "quoted_key":
      out.push(unquote(key.text));
      break;
    case "dotted_key":
      for (const part of named(key)) keySegments(part, out);
      break;
    default:
      break;
  }
  return out;
}

/** Position after the last token of `node` that is not a comment (a pair's trailing comment is not part of it). */
function contentEnd(node: Node): { row: number; column: number } {
  const children = node.children;
  for (let i = children.length - 1; i >= 0; i--) {
    if (children[i]!.type !== "comment") return children[i]!.endPosition;
  }
  return node.endPosition;
}

const SEPARATOR = "\u0000";

class TomlWalker {
  readonly keys = new KeyCollector();
  /** The index of the latest element of each array of tables, by its logical path (no indices). */
  private readonly latest = new Map<string, number>();
  /** Elements seen so far per array of tables, by its resolved path: a new parent element restarts the count. */
  private readonly counts = new Map<string, number>();

  constructor(private readonly ctx: FileContext) {}

  run(root: Node): void {
    let table: string[] = []; // path of the current table (indices included)
    let tableDepth = 0; // keys in it (indices excluded)
    let tableSymbol: string | undefined; // the path of its symbol, when it has one
    for (const node of named(root)) {
      switch (node.type) {
        case "table":
        case "table_array_element": {
          const logical = keySegments(named(node)[0]);
          if (logical.length === 0) {
            table = [];
            tableDepth = 0;
            tableSymbol = undefined;
            break;
          }
          table = this.headerPath(logical, node.type === "table_array_element");
          tableDepth = logical.length;
          tableSymbol = undefined;
          if (tableDepth <= MAX_KEY_DEPTH) {
            const path = table.join(".");
            if (this.emit(path, node, undefined)) tableSymbol = path;
          }
          for (const pair of named(node)) {
            if (pair.type === "pair") this.pair(pair, table, tableDepth, tableSymbol);
          }
          break;
        }
        case "pair":
          this.pair(node, [], 0, undefined);
          break;
        default:
          break;
      }
    }
  }

  /**
   * The path of a table header: its segments, with the index of the current element after every one that
   * names an array of tables (`[fruits.physical]` below `[[fruits]]` is `fruits.0.physical`), and, for
   * `[[...]]`, the index of the element it starts.
   */
  private headerPath(logical: readonly string[], isElement: boolean): string[] {
    const path: string[] = [];
    for (let i = 0; i < logical.length; i++) {
      path.push(logical[i]!);
      const key = logical.slice(0, i + 1).join(SEPARATOR);
      if (i < logical.length - 1) {
        const current = this.latest.get(key);
        if (current !== undefined) path.push(String(current));
      } else if (isElement) {
        const resolved = path.join(SEPARATOR);
        const next = this.counts.get(resolved) ?? 0;
        this.counts.set(resolved, next + 1);
        this.latest.set(key, next);
        path.push(String(next));
      }
    }
    return path;
  }

  private emit(path: string, node: Node, parentPath: string | undefined): boolean {
    const start = node.startPosition;
    const end = contentEnd(node);
    const span: Span = pointsToSpan(start.row, start.column, end.row, end.column, this.ctx.lines);
    return this.keys.add(path, span, parentPath);
  }

  /** `key = value` (key possibly dotted) under the table `prefix`, whose symbol is `parent`. */
  private pair(node: Node, prefix: readonly string[], depth: number, parent: string | undefined) {
    if (prefix.length > MAX_NESTING) return;
    const parts = named(node);
    const key = keySegments(parts[0]);
    if (key.length === 0) return;
    const keyDepth = depth + key.length;
    if (keyDepth > MAX_KEY_DEPTH) return;
    const segments = [...prefix, ...key];
    const path = segments.join(".");
    if (!this.emit(path, node, parent)) return;
    const value = parts[parts.length - 1];
    if (value && value !== parts[0]) this.value(value, segments, keyDepth, path);
  }

  /** The keys inside an inline table or array value: `segments` is the path of the value. */
  private value(node: Node, segments: readonly string[], depth: number, parent: string): void {
    if (segments.length > MAX_NESTING) return;
    if (node.type === "inline_table") {
      for (const pair of named(node)) {
        if (pair.type === "pair") this.pair(pair, segments, depth, parent);
      }
    } else if (node.type === "array") {
      let index = 0;
      for (const item of named(node)) {
        this.value(item, [...segments, String(index)], depth, parent);
        index++;
      }
    }
  }
}

export const tomlPack: LanguagePack = {
  id: "toml",
  languages: [],
  extensions: [".toml"],
  grammarFor: () => "toml",
  packageScope: "file",
  refs: "none",

  extract(ctx: FileContext): FileFacts {
    const walker = new TomlWalker(ctx);
    walker.run(ctx.tree.rootNode);
    return {
      symbols: walker.keys.drafts,
      sites: [],
      imports: [],
      typeFacts: [],
      warnings: walker.keys.warnings(),
    };
  },

  classifySite: () => undefined,

  resolveModule(_spec: string, _fromFile: string, _repo: RepoView): string[] {
    return [];
  },
};
