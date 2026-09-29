/**
 * `classifySite` for Python: what kind of reference site does the identifier at a position belong to?
 * It runs the same shape functions as `extract` (./shapes.ts) on the ancestors of the identifier and keeps
 * the shape whose `nameNode` is that identifier, so kind and span always agree with the extracted sites.
 */
import type { Node } from "web-tree-sitter";
import { nodeSpan } from "../../ast.js";
import type { ClassifiedSite, FileContext } from "../types.js";
import { collectTypeRefs, isAnnotationRoot } from "./annotations.js";
import type { SiteShape } from "./ast.js";
import {
  callShape,
  decoratorShape,
  globalNamesOf,
  heritageShapes,
  importCallShape,
  importSiteNodeOf,
  readShape,
  writeShapes,
} from "./shapes.js";
import { underTypeChecking } from "./ast.js";

/** Ancestors examined above an identifier (a type name can sit a few generics deep). */
const MAX_CLIMB = 32;

/** `global` declarations per function, cached per tree (SCIP asks about thousands of positions per file). */
const globalsByTree = new WeakMap<object, Map<number, ReadonlySet<string>>>();

function globalsCache(tree: object): (fn: Node) => ReadonlySet<string> {
  let perFunction = globalsByTree.get(tree);
  if (!perFunction) {
    perFunction = new Map();
    globalsByTree.set(tree, perFunction);
  }
  const cache = perFunction;
  return (fn) => {
    let names = cache.get(fn.id);
    if (!names) {
      names = globalNamesOf(fn);
      cache.set(fn.id, names);
    }
    return names;
  };
}

export function classifyPythonSite(
  ctx: FileContext,
  line: number,
  col: number,
): ClassifiedSite | undefined {
  const node = ctx.tree.rootNode.descendantForPosition(
    { row: line - 1, column: col - 1 },
    { row: line - 1, column: col },
  );
  // `string_content`: the name inside a forward reference (`x: "Job"`).
  if (!node || (node.type !== "identifier" && node.type !== "string_content")) return undefined;
  const lines = ctx.lines;

  if (node.type === "identifier") {
    const imported = importSiteNodeOf(node);
    if (imported) {
      // Imports under `if TYPE_CHECKING:` are for the type checker, like `import type` (see `onImport`).
      return {
        kind: underTypeChecking(imported) ? "type-ref" : "import",
        site: nodeSpan(imported, lines),
      };
    }
  }

  let n: Node | null = node;
  for (let depth = 0; n && depth < MAX_CLIMB; depth++, n = n.parent) {
    if (n.type === "block" || n.type === "module") break; // statements are not part of an expression
    let shapes: SiteShape[] | undefined;
    switch (n.type) {
      case "call": {
        const shape = callShape(n, lines) ?? importCallShape(n, lines);
        shapes = shape ? [shape] : undefined;
        break;
      }
      case "decorator": {
        const shape = decoratorShape(n, lines);
        shapes = shape ? [shape] : undefined;
        break;
      }
      case "assignment":
      case "augmented_assignment":
        shapes = writeShapes(n, lines, globalsCache(ctx.tree));
        break;
      case "type":
        if (isAnnotationRoot(n)) shapes = collectTypeRefs(n, lines);
        break;
      case "argument_list":
        if (
          n.parent?.type === "class_definition" &&
          n.parent.childForFieldName("superclasses")?.id === n.id
        )
          shapes = heritageShapes(n.parent, lines);
        break;
      default:
        break;
    }
    const hit = shapes?.find((s) => s.nameNode.id === node.id && s.name !== "");
    if (hit) return { kind: hit.kind, site: hit.site };
  }
  // Reads: whether the name is local, or a variable, is for the caller to know (SCIP has resolved it).
  const read = readShape(node, lines);
  if (!read) return undefined;
  return read.qualifierNode
    ? { kind: "read", site: read.site }
    : { kind: "read", site: read.site, bare: true };
}
