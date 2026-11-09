/**
 * Plain words for readers. The explainer's own terms (anchor roles, node kinds, provenance) are the
 * author's vocabulary; a reader (Read mode and Present) sees what they mean instead, or nothing when the
 * word only matters to the author.
 */
import type { AnchorRole, DerivedEdge } from "@xpl/core";

/**
 * Where a map arrow comes from, in plain words. The trust labels `precise` and `heuristic` stay visible (a
 * reader must be able to tell them apart), each with what it means; an arrow found in the code that the author
 * labelled says so after it ("author's note · heuristic" read as "added" and "guessed" at once).
 */
export function mapEdgeSource(edge: Pick<DerivedEdge, "resolution" | "stored">): string {
  const { resolution, stored } = edge;
  const trust = trustWords(resolution);
  if (trust) return stored ? `${trust}; the label is the author's` : trust;
  return resolution === "static" ? "from the code" : "added by the author";
}

/**
 * How the references under an arrow found in the code were found, in one wording per trust label,
 * wherever a reader sees it: the arrow's details, the rail, the text view, the map's arrow labels.
 * Undefined for an arrow that was not found by references (added by the author, or static).
 */
export function trustWords(resolution: DerivedEdge["resolution"] | string): string | undefined {
  if (resolution === "precise") return "precise: checked by a language tool";
  if (resolution === "heuristic") return "heuristic: matched by name";
  if (resolution === "mixed") return "partly matched by name";
  return undefined;
}

/** What a highlighted range is, for a reader: "called here", not "call-site". */
export const ROLE_WORDS: Record<AnchorRole, string> = {
  definition: "defined here",
  "call-site": "called here",
  usage: "used here",
  config: "setting",
  test: "test",
};

/** Plain words for an anchor role (an unknown role is shown as it is). */
export function roleWords(role: string): string {
  return (ROLE_WORDS as Record<string, string>)[role] ?? role;
}

/**
 * The kind badge a reader sees on a diagram box: the kind of a piece of code (file, class, function...),
 * never the explainer's own structure ("group", "dir", "repo", "symbol"). Undefined: no badge.
 */
export function readerBadge(badge: string): string | undefined {
  switch (badge) {
    case "group":
    case "dir":
    case "repo":
    case "symbol":
    case "":
      return undefined;
    default:
      return badge;
  }
}

/**
 * A title that is code, not words: a name (`node.findRoute`, `FindRoute`, `max_age`) or a call
 * (`super().unsign(signed_value)`). Shown in the code font, smaller: a long call set as a heading wraps over
 * several lines and reads as a sentence.
 */
export function looksLikeCode(text: string): boolean {
  const t = text.trim();
  // a name, dotted or not, then any calls: no space before the first "("
  if (!/^[A-Za-z_$#][\w$#.]*(\(.*\)[\w$#.()]*)?$/.test(t)) return false;
  // a single plain word ("Overview") is a word
  return /[().#_$]|[a-z][A-Z]/.test(t);
}

/**
 * The first line of `range` that is not part of a file's preamble: blank lines, imports (also over several
 * lines), `package`, `use`, `#include`. Undefined when the range holds nothing else, or is not in the file.
 */
export function firstContentLine(
  lines: readonly string[],
  range: { startLine: number; endLine: number },
): number | undefined {
  if (range.startLine < 1 || range.endLine > lines.length) return undefined;
  let open = false; // inside a multi-line import: `import {` ... `} from "x"`
  for (let line = range.startLine; line <= range.endLine; line++) {
    const text = lines[line - 1]!.trim();
    if (open) {
      if (/[)}]/.test(text)) open = false;
      continue;
    }
    if (text === "") continue;
    if (PREAMBLE.test(text)) {
      if (/[({]\s*$/.test(text)) open = true;
      continue;
    }
    return line;
  }
  return undefined;
}

const PREAMBLE =
  /^(import\b|from\s+\S+\s+import\b|export\s+(\*|\{[^}]*\})\s+from\b|package\s+[\w.]+;?$|use\s+[\w:{}, *]+;$|#include\b|(const|let|var)\s+\w+\s*=\s*require\()/;

/**
 * The first `count` sentences of a text (all of it when it has no more). A sentence ends at ".", "!" or "?"
 * followed by a space: "a.b" in a name does not end one.
 */
export function leadSentences(text: string, count: number): string {
  const trimmed = text.trim();
  const ends = /[.!?](?=\s+\S)/g;
  let seen = 0;
  for (let match = ends.exec(trimmed); match; match = ends.exec(trimmed)) {
    if (++seen === count) return trimmed.slice(0, match.index + 1);
  }
  return trimmed;
}

/** A person's text as a sentence: a stop is added only when it does not already end in ".", "!" or "?". */
export function asSentence(text: string): string {
  const trimmed = text.trim();
  return /[.!?]$/.test(trimmed) ? trimmed : `${trimmed}.`;
}

/** Inline markdown as plain words, for a tooltip: the backticks of `code` dropped. */
export function plainWords(text: string): string {
  return text.replace(/`/g, "");
}
