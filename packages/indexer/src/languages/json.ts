/**
 * JSON language pack: every object key is a symbol (`kind: "key"`), path = dotted key path, array items
 * addressed by index (`items.0.id`), max key depth 6. A key's range is its whole `"key": value` pair.
 * Comments (JSONC) are tolerated by the grammar. No reference sites.
 */
import type { Node } from "web-tree-sitter";
import { nodeSpan } from "../ast.js";
import { KeyCollector, MAX_KEY_DEPTH, MAX_NESTING } from "./keys.js";
import type { FileContext, FileFacts, LanguagePack, RepoView } from "./types.js";

/** Unescaped text of a JSON string node. */
function stringValue(node: Node): string {
  const raw = node.text;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed === "string") return parsed;
  } catch {
    // e.g. an unterminated string in a file being edited: fall through
  }
  return raw.replace(/^"/, "").replace(/"$/, "");
}

class JsonWalker {
  readonly keys = new KeyCollector();

  constructor(private readonly ctx: FileContext) {}

  visit(node: Node, segments: string[], keyDepth: number, parentPath: string | undefined): void {
    if (segments.length > MAX_NESTING) return;
    switch (node.type) {
      case "document":
        for (const child of node.namedChildren) this.visit(child, segments, keyDepth, parentPath);
        break;
      case "object":
        for (const child of node.namedChildren) {
          if (child.type === "pair") this.pair(child, segments, keyDepth, parentPath);
        }
        break;
      case "array": {
        let index = 0;
        for (const item of node.namedChildren) {
          if (item.type === "comment") continue;
          this.visit(item, [...segments, String(index)], keyDepth, parentPath);
          index++;
        }
        break;
      }
      default:
        break; // scalars
    }
  }

  private pair(
    pair: Node,
    segments: string[],
    keyDepth: number,
    parentPath: string | undefined,
  ): void {
    if (keyDepth >= MAX_KEY_DEPTH) return;
    const key = pair.childForFieldName("key");
    if (!key) return;
    const name = stringValue(key);
    if (name === "") return;
    const path = [...segments, name].join(".");
    if (!this.keys.add(path, nodeSpan(pair, this.ctx.lines), parentPath)) return;
    const value = pair.childForFieldName("value");
    if (value) this.visit(value, [...segments, name], keyDepth + 1, path);
  }
}

export const jsonPack: LanguagePack = {
  id: "json",
  languages: ["json"],
  grammarFor: () => "json",
  packageScope: "file",
  refs: "none",

  extract(ctx: FileContext): FileFacts {
    const walker = new JsonWalker(ctx);
    walker.visit(ctx.tree.rootNode, [], 0, undefined);
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
