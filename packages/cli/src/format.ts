/** Small text helpers shared by the commands. */
import {
  symbolKindWord,
  type IndexedSymbol,
  type IndexModel,
  type Issue,
  type Range,
} from "@xpl/core";

export function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

/** `a class`, `an interface`, `an enum`: the noun with its indefinite article. */
export function withArticle(noun: string): string {
  return `${/^[aeiou]/i.test(noun) ? "an" : "a"} ${noun}`;
}

/**
 * The reader's word for a symbol's kind (core `symbolKindWord`): a Go struct is `struct`, a variable declared in a
 * type is `field`. The index and `--json` keep the stored kind (`class`, `variable`), which `--kind` filters take.
 */
export function kindWord(model: IndexModel, symbol: IndexedSymbol): string {
  return (
    symbolKindWord(
      model.file(symbol.file)?.language,
      symbol.kind,
      model.parentSymbol(symbol.id)?.kind,
    ) ?? symbol.kind
  );
}

/**
 * A file's last line as an editor and `wc -l` number it: a final newline ends the last line and starts none.
 * The index counts that empty "line" (`IndexedFile.lines`, the region a whole-file anchor hashes); without the
 * text, that count is all there is.
 */
export function editorLineCount(lines: readonly string[] | undefined, indexed: number): number {
  if (!lines) return indexed;
  return lines.length > 1 && lines.at(-1) === "" ? lines.length - 1 : lines.length;
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** Cuts a line to `max` characters, marking the cut with an ellipsis. */
export function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, Math.max(0, max - 1))}…`;
}

/** `42-88`: a symbol or file range, always with both ends (parseable as a range). */
export function rangeText(range: Pick<Range, "startLine" | "endLine">): string {
  return `${range.startLine}-${range.endLine}`;
}

/** `46` or `76-78`: the lines of a reference site. */
export function linesText(range: Pick<Range, "startLine" | "endLine">): string {
  return range.startLine === range.endLine
    ? String(range.startLine)
    : `${range.startLine}-${range.endLine}`;
}

/** `+4` or `+34..36`: line offsets as an anchor `span` uses them. */
export function offsetText(offset: { from: number; to: number }): string {
  return offset.from === offset.to ? `+${offset.from}` : `+${offset.from}..${offset.to}`;
}

/** Up to `max` items joined by ", ", then an ellipsis. */
export function listText(items: readonly string[], max = 3): string {
  return items.length <= max ? items.join(", ") : `${items.slice(0, max).join(", ")}, ...`;
}

/**
 * One line per issue: `error   nodes[1].anchors[0] (id): message`. With `name`, a hint's `<explainer>` placeholder
 * becomes the guide's name, so the command it names runs as printed.
 */
export function renderIssue(issue: Issue, name?: string): string {
  const where = issue.path === "" ? "(explainer)" : issue.path;
  const id =
    issue.elementId !== undefined && !where.includes(issue.elementId)
      ? ` [${issue.elementId}]`
      : "";
  const message = name ? issue.message.replaceAll("<explainer>", name) : issue.message;
  return `${issue.severity.padEnd(7)} ${where}${id}: ${message}`;
}

export function renderIssues(issues: readonly Issue[], name?: string): string[] {
  return issues.map((issue) => renderIssue(issue, name));
}

/** `2 errors, 1 warning`. */
export function issueSummary(issues: readonly Issue[]): string {
  const errors = issues.filter((i) => i.severity === "error").length;
  const warnings = issues.length - errors;
  return `${plural(errors, "error")}, ${plural(warnings, "warning")}`;
}
