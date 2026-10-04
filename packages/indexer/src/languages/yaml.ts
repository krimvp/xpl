/**
 * YAML language pack: every mapping key is a symbol (`kind: "key"`), path = dotted key path, sequence items
 * addressed by index (`workers.0.name`), max key depth 6. A key's range is its whole `key: value` pair, so
 * `retry:` and its indented children are one symbol spanning all their lines. No reference sites.
 *
 * Merge keys (`<<`), empty keys, complex (`? ...`) keys and alias keys are not symbols. Duplicate paths
 * (repeated keys, several documents in one stream) are numbered `~2`, `~3`... by the framework.
 */
import { STRUCTURE_SUPPORT } from "../analysis.js";
import type { Node } from "web-tree-sitter";
import { pointsToSpan } from "../ast.js";
import { KeyCollector, MAX_KEY_DEPTH, MAX_NESTING } from "./keys.js";
import type { FileContext, FileFacts, LanguagePack, RepoView } from "./types.js";

/** The text of a scalar key node, unquoted; undefined for keys that are not plain/quoted scalars. */
function scalarKey(key: Node | null): string | undefined {
  if (!key) return undefined;
  for (const child of key.namedChildren) {
    switch (child.type) {
      case "plain_scalar":
        return child.text.trim();
      case "double_quote_scalar": {
        const raw = child.text;
        try {
          const parsed: unknown = JSON.parse(raw);
          if (typeof parsed === "string") return parsed;
        } catch {
          // not valid JSON escapes (e.g. \x41): fall back to the raw text
        }
        return raw.slice(1, -1);
      }
      case "single_quote_scalar":
        return child.text.slice(1, -1).replace(/''/g, "'");
      default:
        break;
    }
  }
  return undefined;
}

const OPAQUE_VALUES = new Set([
  "block_scalar",
  "plain_scalar",
  "double_quote_scalar",
  "single_quote_scalar",
  "flow_mapping",
  "flow_sequence",
  "alias",
]);

/**
 * The last node of `node` that is not a comment. tree-sitter-yaml attaches the comment lines that follow a
 * block (and precede the next key) to the block; they belong to the next key, so a key's range stops at its
 * last real token.
 */
function lastContentLeaf(node: Node): Node {
  let current = node;
  for (;;) {
    // Scalars (a block scalar's text is part of the node itself) and flow collections are opaque.
    if (OPAQUE_VALUES.has(current.type)) return current;
    const children = current.children;
    let next: Node | undefined;
    for (let i = children.length - 1; i >= 0; i--) {
      if (children[i]!.type !== "comment") {
        next = children[i];
        break;
      }
    }
    if (!next) return current;
    current = next;
  }
}

class YamlWalker {
  readonly keys = new KeyCollector();

  constructor(private readonly ctx: FileContext) {}

  /** Visit a value node. `segments` is the path of the value; `parentPath` the nearest emitted key. */
  visit(node: Node, segments: string[], keyDepth: number, parentPath: string | undefined): void {
    if (segments.length > MAX_NESTING) {
      this.keys.nestingLimited = true;
      return;
    }
    switch (node.type) {
      case "stream":
      case "document":
      case "block_node":
      case "flow_node":
        for (const child of node.namedChildren) this.visit(child, segments, keyDepth, parentPath);
        break;
      case "block_mapping":
      case "flow_mapping":
        for (const child of node.namedChildren) {
          if (child.type === "block_mapping_pair" || child.type === "flow_pair") {
            this.pair(child, segments, keyDepth, parentPath);
          }
        }
        break;
      case "block_sequence": {
        let index = 0;
        for (const item of node.namedChildren) {
          if (item.type !== "block_sequence_item") continue;
          for (const child of item.namedChildren) {
            this.visit(child, [...segments, String(index)], keyDepth, parentPath);
          }
          index++;
        }
        break;
      }
      case "flow_sequence": {
        let index = 0;
        for (const item of node.namedChildren) {
          if (item.type === "comment") continue;
          if (item.type === "flow_pair")
            this.pair(item, [...segments, String(index)], keyDepth, parentPath);
          else this.visit(item, [...segments, String(index)], keyDepth, parentPath);
          index++;
        }
        break;
      }
      default:
        break; // scalars, aliases, block scalars, comments, tags, anchors
    }
  }

  private pair(
    pair: Node,
    segments: string[],
    keyDepth: number,
    parentPath: string | undefined,
  ): void {
    if (keyDepth >= MAX_KEY_DEPTH) {
      this.keys.depthLimited = true;
      return;
    }
    const name = scalarKey(pair.childForFieldName("key"));
    if (name === undefined || name === "" || name === "<<") return;
    const path = [...segments, name].join(".");
    const start = pair.startPosition;
    const end = lastContentLeaf(pair).endPosition;
    const span = pointsToSpan(start.row, start.column, end.row, end.column, this.ctx.lines);
    if (!this.keys.add(path, span, parentPath)) return;
    const value = pair.childForFieldName("value");
    if (value) this.visit(value, [...segments, name], keyDepth + 1, path);
  }
}

export const yamlPack: LanguagePack = {
  id: "yaml",
  capabilities: { ...STRUCTURE_SUPPORT },
  languages: ["yaml"],
  grammarFor: () => "yaml",
  packageScope: "file",
  refs: "none",

  extract(ctx: FileContext): FileFacts {
    const walker = new YamlWalker(ctx);
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
