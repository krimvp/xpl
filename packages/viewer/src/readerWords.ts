/**
 * Plain words for readers. The explainer's own terms (anchor roles, node kinds, provenance) are the
 * author's vocabulary; a reader (Read mode and Present) sees what they mean instead, or nothing when the
 * word only matters to the author.
 */
import type { AnchorRole, DerivedEdge } from "@xpl/core";

/** A map arrow's source, including an authored note laid over a derived relationship. */
export function mapEdgeSource(edge: Pick<DerivedEdge, "resolution" | "stored">): string {
  const { resolution, stored } = edge;
  if (resolution === "precise" || resolution === "heuristic" || resolution === "mixed") {
    const precision = resolution === "mixed" ? "mixed precision" : resolution;
    return `${stored ? "authored overlay · " : ""}derived · ${precision}`;
  }
  return resolution === "static" ? "from index" : "authored";
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
