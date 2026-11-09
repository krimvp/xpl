/**
 * The text a search result shows: a guide's Markdown as plain words, cut around the match at word
 * boundaries, a test's describe titles joined the way a reader reads them, and the order of name hits.
 * Pure, for the search worker and its unit tests.
 */

import { isTestFile } from "@xpl/core";

/**
 * Where a name hit ranks in its group, lowest first: names whose code is in the page first, and names in
 * tests after the others: in a real repository the test cases are sentences that match most words, and they
 * hid the code the reader looks for.
 */
export const symbolRank = (hit: object, files: Record<string, string>): number =>
  "file" in hit && typeof hit.file === "string"
    ? (hit.file in files ? 0 : 2) + (isTestFile(hit.file) ? 1 : 0)
    : 0;

/** Characters of context before the match, and of snippet in all. */
const BEFORE = 80;
const LENGTH = 400;
/** A cut moves at most this far to reach a space; past it (minified code) the cut stays where it is. */
const WORD_REACH = 24;

/** A guide's Markdown as the words a reader sees: no `#`, backticks, emphasis marks or link targets. */
export function plainText(markdown: string): string {
  return markdown
    .replace(/^\s{0,3}#{1,6}\s+/gm, "")
    .replace(/^\s*(?:[-*+]|\d+\.)\s+/gm, "")
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/`+([^`]*)`+/g, "$1")
    .replace(/(\*\*|__)(?=\S)(.+?)(?<=\S)\1/g, "$2")
    .replace(/(?<![\w*])([*_])(?=\S)(.+?)(?<=\S)\1(?![\w*])/g, "$2")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * The part of `text` around the first match of `pattern` (case-insensitive): up to 80 characters before it
 * and 400 in all, each cut moved to a space so no word is cut in half, with "…" where text was left out.
 */
export function snippet(text: string, pattern: string): string {
  const at = Math.max(0, text.toLowerCase().indexOf(pattern.toLowerCase()));
  let start = Math.max(0, at - BEFORE);
  if (start > 0) {
    const space = text.lastIndexOf(" ", start);
    if (space >= 0 && start - space <= WORD_REACH) start = space + 1;
  }
  let end = Math.min(text.length, start + LENGTH);
  if (end < text.length) {
    const space = text.lastIndexOf(" ", end);
    if (space > Math.max(start, at + pattern.length) && end - space <= WORD_REACH) end = space;
  }
  return `${start ? "…" : ""}${text.slice(start, end)}${end < text.length ? "…" : ""}`;
}

/**
 * A test case's name as its describe titles, outermost first, joined with " › " ("retries › gives up after
 * maxRetries"): the index joins them with "." like a class and its method, which glues sentences together.
 */
export function testTitle(
  model: { symbol(id: string): { path: string; parent?: string } | undefined },
  id: string,
): string | undefined {
  const names: string[] = [];
  let at = model.symbol(id);
  for (let hops = 0; at && hops < 16; hops++) {
    const parent = at.parent ? model.symbol(at.parent) : undefined;
    const outer = parent && at.path.startsWith(`${parent.path}.`) ? parent.path.length + 1 : 0;
    names.unshift(at.path.slice(outer));
    if (!outer) break;
    at = parent;
  }
  return names.length ? names.join(" › ") : undefined;
}

/** A test title with a placeholder (`describe.each` "$name", "%s") is a template: one test per case. */
export const isTemplateTitle = (title: string): boolean => /\$[A-Za-z_]\w*|%[sdifjo]/.test(title);

/** `text` cut into plain parts and the parts that match `pattern` (case-insensitive), for `<mark>`. */
export function markParts(text: string, pattern: string): { text: string; match: boolean }[] {
  const needle = pattern.trim().toLowerCase();
  if (!needle) return [{ text, match: false }];
  const parts: { text: string; match: boolean }[] = [];
  const lower = text.toLowerCase();
  let from = 0;
  for (let at = lower.indexOf(needle); at >= 0; at = lower.indexOf(needle, at + needle.length)) {
    if (at > from) parts.push({ text: text.slice(from, at), match: false });
    parts.push({ text: text.slice(at, at + needle.length), match: true });
    from = at + needle.length;
  }
  if (from < text.length) parts.push({ text: text.slice(from), match: false });
  return parts;
}
