/**
 * `classifySite` for Go: which kind of reference site the identifier at a position is, with the same
 * rules and the same site span `extract` uses (both go through ./shapes.ts).
 *
 * One deliberate difference: `extract` cannot express every receiver (`arr[0].Run()`, `handlers[k].Run()`)
 * and drops those sites, and it drops bare calls / assignments / reads of names that are local variables. A SCIP
 * occurrence has been resolved precisely already, so `classifySite` classifies those by syntax alone.
 */
import type { Node } from "web-tree-sitter";
import { nodeSpan } from "../../ast.js";
import type { ClassifiedSite, FileContext } from "../types.js";
import { readShape, shapeOfLeaf } from "./shapes.js";

/** Leaves that can sit inside an import spec: the alias, `_`, `.` and the quoted path. */
const IMPORT_LEAVES = new Set([
  "import_spec",
  "package_identifier",
  "blank_identifier",
  "dot",
  ".", // the token inside `dot`
  "interpreted_string_literal",
  "interpreted_string_literal_content",
  "raw_string_literal",
  "raw_string_literal_content",
  "escape_sequence",
  '"',
  "`",
]);

/** The import spec a leaf belongs to (`import str "strings"`, `. "os"`, `_ "embed"`), if any. */
function importSpecOf(leaf: Node): Node | undefined {
  if (!IMPORT_LEAVES.has(leaf.type)) return undefined;
  let node: Node | null = leaf;
  for (let i = 0; node && i < 4; i++, node = node.parent) {
    if (node.type === "import_spec") return node;
    if (node.type === "import_declaration" || node.type === "source_file") return undefined;
  }
  return undefined;
}

export function classifyGoSite(
  ctx: FileContext,
  line: number,
  col: number,
): ClassifiedSite | undefined {
  const leaf = ctx.tree.rootNode.descendantForPosition(
    { row: line - 1, column: col - 1 },
    { row: line - 1, column: col },
  );
  if (!leaf) return undefined;
  const spec = importSpecOf(leaf);
  if (spec) return { kind: "import", site: nodeSpan(spec, ctx.lines) };
  const shape = shapeOfLeaf(leaf, ctx.lines) ?? readShape(leaf, ctx.lines);
  if (!shape) return undefined;
  const site: ClassifiedSite = { kind: shape.kind, site: shape.site };
  if (shape.kind === "read" && !shape.operand) site.bare = true;
  return site;
}
