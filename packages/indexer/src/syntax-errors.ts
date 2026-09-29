/**
 * Where a parsed file has syntax errors, and how seriously to take them.
 *
 * tree-sitter recovers from what it cannot parse: the offending tokens become an `ERROR` node (or a zero-width
 * MISSING token is inserted) and the rest of the file is parsed normally. Such a file is indexed anyway, but
 * the symbols right around the error may be missing or cut short, which is what the warning says, with the
 * lines to look at.
 *
 * Not every error is the file's fault or costs anything: the TypeScript grammar does not understand a valid
 * labelled tuple element whose label is a type keyword (`[symbol: string]`), and the recovery stays inside the
 * tuple. A pack can tell such errors (`LanguagePack.errorInTypePosition`); a file whose errors are all of that
 * kind is not reported.
 */
import type { Node } from "web-tree-sitter";
import type { FilePath } from "@xpl/core";
import type { LanguagePack } from "./languages/types.js";

/** Most error nodes looked at per file (a file that is mostly garbage need not be walked to the end). */
const MAX_ERRORS_PER_FILE = 64;

/** Files named in the warning, and lines named per file. */
const WARNING_FILES = 5;
const WARNING_LINES = 3;

/** One syntax error: the 1-based line it starts on, and whether the pack says it is harmless (see above). */
export interface SyntaxErrorSpot {
  line: number;
  /** Inside a type expression, where the parser's recovery cannot have cost a symbol. */
  inType: boolean;
}

/**
 * The `ERROR` and MISSING nodes of a tree, in source order (at most `MAX_ERRORS_PER_FILE`). Only the paths
 * that lead to an error are walked (`hasError` is precomputed), so a clean tree costs one property read.
 */
export function findSyntaxErrors(root: Node, pack?: LanguagePack): SyntaxErrorSpot[] {
  const out: SyntaxErrorSpot[] = [];
  if (!root.hasError) return out;
  const stack: Node[] = [root];
  while (stack.length > 0 && out.length < MAX_ERRORS_PER_FILE) {
    const node = stack.pop()!;
    if (node.isError || node.isMissing) {
      out.push({
        line: node.startPosition.row + 1,
        inType: pack?.errorInTypePosition?.(node) ?? false,
      });
      continue; // what an error node holds is what the parser could not place
    }
    const children = node.children;
    for (let i = children.length - 1; i >= 0; i--) {
      const child = children[i]!;
      if (child.hasError) stack.push(child);
    }
  }
  return out;
}

/** A file whose syntax errors matter: the lines they start on, sorted and distinct. */
export interface SyntaxErrorFile {
  file: FilePath;
  lines: number[];
}

/** The file's entry for the warning, or undefined when it has no error that matters. */
export function significantSyntaxErrors(
  file: FilePath,
  spots: readonly SyntaxErrorSpot[],
): SyntaxErrorFile | undefined {
  const lines = [...new Set(spots.filter((s) => !s.inType).map((s) => s.line))].sort(
    (a, b) => a - b,
  );
  return lines.length > 0 ? { file, lines } : undefined;
}

/**
 * The one warning `buildIndex` gives for all files with syntax errors (all on one line, files first-come):
 * `2 file(s) have syntax errors; symbols near these lines may be incomplete: a.ts:12,40, b.py:7`.
 */
export function syntaxErrorWarning(files: readonly SyntaxErrorFile[]): string {
  const shown = files.slice(0, WARNING_FILES).map(({ file, lines }) => {
    const first = lines.slice(0, WARNING_LINES).join(",");
    return `${file}:${first}${lines.length > WARNING_LINES ? ",…" : ""}`;
  });
  const more = files.length > WARNING_FILES ? `, and ${files.length - WARNING_FILES} more` : "";
  return `${files.length} file(s) have syntax errors; symbols near these lines may be incomplete: ${shown.join(", ")}${more}`;
}
