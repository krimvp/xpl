/**
 * The loops and branches inside a function, from its syntax tree: what `xpl draft path` needs to put `loop`, `alt`
 * and `opt` frames around the calls it draws. One walk over tree-sitter node types that the grammars share (TS/JS,
 * Python, Go, Java, Rust); a grammar with other names simply yields no blocks.
 */
import type { FileLanguage } from "@xpl/core";
import { ParserPool, withParsedFile, type FileContext } from "@xpl/indexer";

type SyntaxNode = FileContext["tree"]["rootNode"];

/** Lines are 1-based and inclusive. */
export interface LineRange {
  start: number;
  end: number;
}

/** A loop, or a branch (`if` with its `else if` and `else` arms, a `switch`/`match` with its cases). */
export interface ControlBlock extends LineRange {
  kind: "loop" | "branch";
  /** The code that decides: the loop or `if` header, or the switch value (one line, cut when long). */
  condition: string;
  /** A branch's arms, in source order; an `if` without `else` has one. */
  arms: LineRange[];
}

const LOOP =
  /^(?:for|while|do|for_in|enhanced_for|for_range)_statement$|^(?:loop|while|for)_expression$/;
const IF = /^if_(?:statement|expression)$/;
const SWITCH =
  /^(?:switch_statement|expression_switch_statement|type_switch_statement|select_statement|switch_expression|match_statement|match_expression)$/;
const CASE =
  /^(?:switch_case|switch_default|expression_case|type_case|default_case|communication_case|case_clause|match_arm|switch_rule|switch_block_statement_group)$/;

const range = (node: SyntaxNode): LineRange => ({
  start: node.startPosition.row + 1,
  end: node.endPosition.row + 1,
});

/** The first line of a node, whitespace folded, at most 60 characters. */
function header(node: SyntaxNode): string {
  const text = node.text
    .split("\n")[0]!
    .replace(/\s+/g, " ")
    .replace(/\s*\{$/, "")
    .trim();
  return text.length > 60 ? `${text.slice(0, 59)}…` : text;
}

/** The arms of an `if`: its consequence, then each `elif`, `else if` and `else`, flattened. */
function ifArms(node: SyntaxNode): LineRange[] {
  const arms: LineRange[] = [];
  const consequence = node.childForFieldName("consequence");
  if (consequence) arms.push(range(consequence));
  for (const alt of node.childrenForFieldName("alternative")) {
    if (!alt) continue;
    if (IF.test(alt.type)) {
      arms.push(...ifArms(alt)); // Go: `else if` is the alternative itself
      continue;
    }
    const nested = alt.namedChildren.filter((c) => c !== null);
    if (alt.type === "elif_clause") {
      const body = alt.childForFieldName("consequence");
      arms.push(range(body ?? alt));
    } else if (nested.length === 1 && IF.test(nested[0]!.type)) {
      arms.push(...ifArms(nested[0]!)); // `else if`: one more arm of the same branch
    } else {
      arms.push(range(alt));
    }
  }
  return arms;
}

/** The case nodes of a switch, not those of a switch nested in one of them. */
function caseArms(node: SyntaxNode): LineRange[] {
  const arms: LineRange[] = [];
  const walk = (n: SyntaxNode) => {
    for (const child of n.namedChildren) {
      if (!child) continue;
      if (CASE.test(child.type)) arms.push(range(child));
      else if (!SWITCH.test(child.type)) walk(child);
    }
  };
  walk(node);
  return arms;
}

/** Every loop and branch in `lines` of the tree, outermost first (in source order). */
function controlBlocks(root: SyntaxNode, lines: LineRange): ControlBlock[] {
  const out: ControlBlock[] = [];
  const walk = (node: SyntaxNode, elseIf: boolean) => {
    const at = range(node);
    if (at.end < lines.start || at.start > lines.end) return;
    const inside = at.start >= lines.start && at.end <= lines.end;
    if (inside && LOOP.test(node.type)) {
      out.push({ kind: "loop", ...at, condition: header(node), arms: [] });
    } else if (inside && IF.test(node.type) && !elseIf) {
      out.push({ kind: "branch", ...at, condition: header(node), arms: ifArms(node) });
    } else if (inside && SWITCH.test(node.type)) {
      out.push({ kind: "branch", ...at, condition: header(node), arms: caseArms(node) });
    }
    for (const child of node.namedChildren) {
      if (!child) continue;
      // the `if` of an `else if` is an arm of its parent, not a branch of its own
      const chained =
        IF.test(child.type) &&
        ((IF.test(node.type) && child.equals(node.childForFieldName("alternative") ?? child)) ||
          (node.type === "else_clause" && node.namedChildren.length === 1));
      walk(child, chained);
    }
  };
  walk(root, false);
  return out;
}

/** Parse `source` and return the loops and branches between `lines`; [] for a language without a grammar. */
export async function controlBlocksOf(
  pool: ParserPool,
  file: string,
  language: FileLanguage,
  source: string,
  lines: LineRange,
): Promise<ControlBlock[]> {
  return (
    (await withParsedFile(pool, file, language, source, (ctx) =>
      controlBlocks(ctx.tree.rootNode, lines),
    )) ?? []
  );
}
