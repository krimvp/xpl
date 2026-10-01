/**
 * Anchors (ARCHITECTURE.md section 4.2): resolving stored anchors against an index and the current
 * file text, building stored anchors from what Claude writes (`AnchorInput`), and re-resolving a
 * whole explainer after the code changed.
 */
import { describeSymbolCandidate } from "./ids.js";
import { asIndexModel, type IndexModel, type SymbolHint } from "./index-model.js";
import type { AnchorInput } from "./patch.js";
import type {
  Anchor,
  AnchorRole,
  AnchorStatus,
  Explainer,
  FilePath,
  Hash,
  IndexedFile,
  IndexedSymbol,
  Origin,
  Range,
  SymbolIndex,
} from "./schema.js";
import { hashText, normalizeLines, splitLines } from "./text.js";
import { cloneJson, isRecord } from "./util.js";

/** Current text of a file, or undefined when it cannot be read. */
export type GetText = (file: FilePath) => string | undefined;

/**
 * Memoises `getText` and the line split of each file. The public functions that take a `GetText`
 * build one per call; batch callers (CLI commands) may share one across calls and pass it instead.
 */
export class TextCache {
  private readonly getText: GetText;
  private readonly texts = new Map<FilePath, string | undefined>();
  private readonly lineMap = new Map<FilePath, readonly string[] | undefined>();

  constructor(getText: GetText) {
    this.getText = getText;
  }

  text(file: FilePath): string | undefined {
    if (!this.texts.has(file)) {
      let text: string | undefined;
      try {
        text = this.getText(file);
      } catch {
        text = undefined; // unreadable (deleted since indexing, ...): treated as unavailable
      }
      this.texts.set(file, text);
    }
    return this.texts.get(file);
  }

  lines(file: FilePath): readonly string[] | undefined {
    if (!this.lineMap.has(file)) {
      const text = this.text(file);
      this.lineMap.set(file, text === undefined ? undefined : splitLines(text));
    }
    return this.lineMap.get(file);
  }
}

/** Accepts either form, so batch code can share one cache. */
export function toTextCache(source: GetText | TextCache): TextCache {
  return source instanceof TextCache ? source : new TextCache(source);
}

export const ANCHOR_ROLES: readonly AnchorRole[] = [
  "definition",
  "call-site",
  "usage",
  "config",
  "test",
];

export interface ResolvedAnchor {
  status: AnchorStatus;
  /** Where the anchor is now (lines; symbol ranges keep their columns). For `missing`: the previous range, else 0-0. */
  range: Range;
  /** Set when the span had to be re-found by content (status `moved`): the new offsets. */
  span?: { from: number; to: number };
  /** Hash of the text now at `range` (`""` when `missing`). */
  hash: Hash;
  /** Why the anchor is `drifted` or `missing` (or what was not checkable). */
  reason?: string;
}

/** Human-readable location of an anchor: `src/runner.ts#Runner.dispatch +34..36`. */
export function describeAnchor(anchor: {
  file: FilePath;
  symbol?: string;
  span?: { from: number; to: number };
}): string {
  const where = anchor.symbol ? `${anchor.file}#${anchor.symbol}` : anchor.file;
  return anchor.span ? `${where} +${anchor.span.from}..${anchor.span.to}` : where;
}

function sameLines(a: Range, b: Range): boolean {
  return a.startLine === b.startLine && a.endLine === b.endLine;
}

function isSpan(span: unknown): span is { from: number; to: number } {
  if (!isRecord(span)) return false;
  const { from, to } = span;
  return (
    typeof from === "number" &&
    typeof to === "number" &&
    Number.isInteger(from) &&
    Number.isInteger(to) &&
    from >= 0 &&
    to >= from
  );
}

// ─── Resolution ─────────────────────────────────────────────────────────────────────────────────

/**
 * Resolves a stored anchor against the index and the current text (section 4.2):
 *
 * 1. File or symbol not in the index: `missing`.
 * 2. Region = the symbol's range or the whole file. Without a span the region hash (from the index)
 *    is compared with `anchor.hash`: equal is `ok` (or `moved` when the region is not where
 *    `anchor.resolved.range` says), different is `drifted`.
 * 3. With a span, the lines at `region start + span` are hashed. Equal: `ok`/`moved`. Otherwise the
 *    region is searched for exact text in windows of the same length, nearest to the expected position first. A hit
 *    is `moved` (new `range` and `span`); no hit is `drifted` at the expected range.
 *
 * `getText` is only needed for span anchors. When it cannot supply the file, the cached
 * `anchor.resolved` is kept (or `drifted` if there is none).
 */
export function resolveAnchor(
  anchor: Anchor,
  index: SymbolIndex | IndexModel,
  getText: GetText | TextCache,
): ResolvedAnchor {
  return resolveWith(anchor, asIndexModel(index), toTextCache(getText));
}

/** Same as `resolveAnchor` with an `IndexModel` and a `TextCache` (what batch operations use). */
export function resolveWith(anchor: Anchor, index: IndexModel, texts: TextCache): ResolvedAnchor {
  const prev = anchor.resolved?.range;
  const missing = (reason: string): ResolvedAnchor => ({
    status: "missing",
    range: prev ?? { startLine: 0, endLine: 0 },
    hash: "",
    reason,
  });

  const file = index.file(anchor.file);
  if (!file) {
    const hint = index.suggestFiles(anchor.file, 3);
    return missing(
      `file ${anchor.file} is not in the index` +
        (hint.length ? `; did you mean ${hint.join(", ")}?` : ""),
    );
  }
  let symbol: IndexedSymbol | undefined;
  if (anchor.symbol) {
    symbol = index.symbolAt(anchor.file, anchor.symbol);
    if (!symbol) return missing(describeVanished(anchor, index, texts, file));
  }

  const region: Range = symbol ? { ...symbol.range } : { startLine: 1, endLine: file.lines };
  const base = region.startLine;
  const found = (status: AnchorStatus, range: Range, hash: Hash): ResolvedAnchor => ({
    status,
    range,
    hash,
  });

  if (typeof anchor.hash !== "string" || !anchor.hash.startsWith("sha256-v2:")) {
    return {
      status: "drifted",
      range: prev ?? region,
      hash: symbol ? symbol.hash : file.hash,
      reason:
        "legacy whitespace-insensitive hash cannot verify source changes; reindex and re-explain this anchor",
    };
  }

  if (anchor.span === undefined || anchor.span === null) {
    const current = symbol ? symbol.hash : file.hash;
    if (current !== anchor.hash) {
      return {
        status: "drifted",
        range: region,
        hash: current,
        reason: `text of ${describeAnchor(anchor)} changed (expected ${anchor.hash}, now ${current})`,
      };
    }
    return found(prev && !sameLines(prev, region) ? "moved" : "ok", region, current);
  }

  if (!isSpan(anchor.span)) {
    return missing(`invalid span ${JSON.stringify(anchor.span)} (need integers 0 <= from <= to)`);
  }
  const expected: Range = clampRange(
    { startLine: base + anchor.span.from, endLine: base + anchor.span.to },
    region,
  );
  const lines = texts.lines(anchor.file);
  if (!lines) {
    const cached = anchor.resolved;
    return cached
      ? {
          status: cached.status,
          range: cached.range,
          hash: anchor.hash,
          reason: "file text unavailable; kept the cached resolution",
        }
      : {
          status: "drifted",
          range: expected,
          hash: "",
          reason: `text of ${anchor.file} unavailable, cannot verify the span`,
        };
  }

  const currentHash = hashOf(lines, expected);
  if (currentHash === anchor.hash) {
    return found(prev && !sameLines(prev, expected) ? "moved" : "ok", expected, currentHash);
  }
  const rawLen = anchor.span.to - anchor.span.from + 1;
  const hit = searchSpan(lines, region, expected, rawLen, anchor.hash);
  if (hit) {
    return {
      status: "moved",
      range: { startLine: hit.start, endLine: hit.end },
      span: { from: hit.start - base, to: hit.end - base },
      hash: anchor.hash,
    };
  }
  return {
    status: "drifted",
    range: expected,
    hash: currentHash,
    reason: `text of ${describeAnchor(anchor)} changed and was not found elsewhere in ${
      symbol ? `${anchor.file}#${anchor.symbol}` : anchor.file
    } (expected ${anchor.hash}, now ${currentHash})`,
  };
}

/** The number of lines of a stored range (undefined for a missing or malformed one). */
function rangeLines(range: Range | undefined): number | undefined {
  if (!range || !Number.isInteger(range.startLine) || !Number.isInteger(range.endLine)) {
    return undefined;
  }
  return range.endLine >= range.startLine ? range.endLine - range.startLine + 1 : undefined;
}

/** What the anchor remembers of the symbol that is gone: its size and text, when it pointed at all of it. */
function vanishedHint(anchor: Anchor): SymbolHint {
  if (anchor.span !== undefined && anchor.span !== null) return {};
  const lines = rangeLines(anchor.resolved?.range);
  return {
    ...(lines !== undefined ? { lines } : {}),
    ...(typeof anchor.hash === "string" && anchor.hash !== "" ? { hash: anchor.hash } : {}),
  };
}

/**
 * Why an anchor's symbol is missing, with where it may have gone: for a span anchor, the symbol whose text
 * now contains the anchored lines (found by content: a renamed method keeps its body); then the likeliest
 * candidates of `suggestSymbols`. Every candidate is spelled as an id and as anchor fields.
 */
function describeVanished(
  anchor: Anchor,
  index: IndexModel,
  texts: TextCache,
  file: IndexedFile,
): string {
  let text = `symbol ${anchor.symbol} is not in ${anchor.file}`;
  let moved: IndexedSymbol | undefined;
  if (isSpan(anchor.span) && typeof anchor.hash === "string") {
    const lines = texts.lines(anchor.file);
    if (lines) {
      const rawLen = anchor.span.to - anchor.span.from + 1;
      const prev = anchor.resolved?.range;
      const expected = prev ?? { startLine: 1, endLine: rawLen };
      const region = { startLine: 1, endLine: Math.min(lines.length, file.lines) };
      const hit = searchSpan(lines, region, expected, rawLen, anchor.hash);
      const holder = hit ? index.innermostSymbolAt(anchor.file, hit.start) : undefined;
      if (hit && holder && hit.end <= holder.range.endLine) {
        moved = holder;
        const from = hit.start - holder.range.startLine;
        const to = hit.end - holder.range.startLine;
        text += `; the anchored lines now sit in ${describeSymbolCandidate(holder, {
          anchor: true,
          extra: `, span: {from: ${from}, to: ${to}}`,
        })}`;
      }
    }
  }
  const candidates = index
    .suggestSymbols(anchor.file, anchor.symbol ?? "", 4, vanishedHint(anchor))
    .filter((sym) => sym.id !== moved?.id)
    .slice(0, 3);
  if (candidates.length > 0) {
    text += `; ${moved ? "or" : "did you mean"} ${candidates
      .map((sym) => describeSymbolCandidate(sym, { anchor: true }))
      .join(", ")}?`;
  }
  return text;
}

function clampRange(range: Range, region: Range): Range {
  const startLine = Math.min(Math.max(range.startLine, region.startLine), region.endLine);
  const endLine = Math.min(Math.max(range.endLine, startLine), region.endLine);
  return { startLine, endLine };
}

function hashOf(lines: readonly string[], range: Range): Hash {
  return hashText(lines.slice(Math.max(0, range.startLine - 1), range.endLine).join("\n"));
}

/** Integers in `[lo, hi]` ordered by distance to `center`; the lower one first on ties. */
function* byDistance(center: number, lo: number, hi: number): Generator<number> {
  if (center <= lo) {
    for (let x = lo; x <= hi; x++) yield x;
    return;
  }
  if (center >= hi) {
    for (let x = hi; x >= lo; x--) yield x;
    return;
  }
  yield center;
  for (let d = 1; center - d >= lo || center + d <= hi; d++) {
    if (center - d >= lo) yield center - d;
    if (center + d <= hi) yield center + d;
  }
}

/** Re-find an unchanged span at new lines; internal whitespace changes are drift. */
function searchSpan(
  lines: readonly string[],
  region: Range,
  expected: Range,
  rawLen: number,
  target: Hash,
): { start: number; end: number } | undefined {
  const first = Math.max(1, region.startLine);
  const last = Math.min(lines.length, region.endLine);
  const maxStart = last - rawLen + 1;
  if (maxStart >= first) {
    for (const start of byDistance(expected.startLine, first, maxStart)) {
      const end = start + rawLen - 1;
      if (hashText(lines.slice(start - 1, end).join("\n")) === target) {
        return { start, end };
      }
    }
  }

  return undefined;
}

// ─── Building anchors ───────────────────────────────────────────────────────────────────────────

export type MakeAnchorResult = { ok: true; anchor: Anchor } | { ok: false; error: string };

export interface MakeAnchorOptions {
  /**
   * What is known about a symbol that is not in the index (the explainer's stored anchors remember the
   * size of a symbol that was renamed): steers the "did you mean" candidates.
   */
  symbolHint?: (file: FilePath, symbol: string) => SymbolHint | undefined;
}

const INPUT_KEYS = new Set(["file", "symbol", "role", "span", "find", "hash", "resolved"]);

/**
 * Turns an `AnchorInput` (what Claude writes) into a stored `Anchor`: validates the file and symbol
 * against the index (errors suggest candidates), converts `find` to a span, checks the span lies
 * inside the symbol (or file), computes the hash, and sets `resolved` with status `ok`.
 *
 * `find` must occur exactly once in the symbol (or file). It is matched exactly first; when there is
 * no exact match, again with runs of whitespace collapsed to one space on both sides. Zero or several
 * matches are errors that say which. A `hash` on the input must equal the current hash, otherwise the
 * draft is stale and the anchor is rejected.
 */
export function makeAnchor(
  input: AnchorInput,
  indexLike: SymbolIndex | IndexModel,
  getText: GetText | TextCache,
  opts: MakeAnchorOptions = {},
): MakeAnchorResult {
  const index = asIndexModel(indexLike);
  const texts = toTextCache(getText);
  const fail = (error: string): MakeAnchorResult => ({ ok: false, error });

  if (!isRecord(input))
    return fail("anchor must be an object like {file, symbol?, span?|find?, role}");
  // JSON written by a model often has null for "not given"; treat it like an absent field.
  input = Object.fromEntries(
    Object.entries(input).filter(
      ([key, value]) => value !== null || key === "file" || key === "role",
    ),
  ) as unknown as AnchorInput;
  for (const key of Object.keys(input)) {
    if (!INPUT_KEYS.has(key)) {
      return fail(`unknown anchor field "${key}" (allowed: file, symbol, span, find, role, hash)`);
    }
  }
  if (typeof input.file !== "string" || input.file === "") {
    return fail("anchor.file must be a repo-relative path string");
  }
  if (!ANCHOR_ROLES.includes(input.role)) {
    return fail(
      `anchor.role must be one of ${ANCHOR_ROLES.join(", ")}` +
        (input.role === undefined ? " (missing)" : ` (got ${JSON.stringify(input.role)})`),
    );
  }
  if (input.symbol !== undefined && typeof input.symbol !== "string") {
    return fail('anchor.symbol must be a symbol path string like "Runner.dispatch"');
  }
  if (input.find !== undefined && typeof input.find !== "string") {
    return fail("anchor.find must be a string");
  }
  if (input.hash !== undefined && typeof input.hash !== "string") {
    return fail("anchor.hash must be a string");
  }
  if (input.span !== undefined && !isSpan(input.span)) {
    return fail(
      `anchor.span must be {from, to}: integers with 0 <= from <= to (got ${JSON.stringify(input.span)})`,
    );
  }
  if (input.span !== undefined && input.find !== undefined) {
    return fail("anchor has both span and find; give exactly one of them");
  }

  const file = index.file(input.file);
  if (!file) {
    const hint = index.suggestFiles(input.file);
    return fail(
      `file "${input.file}" is not in the index` +
        (hint.length ? `. Did you mean: ${hint.join(", ")}?` : ""),
    );
  }

  const symbolPath = input.symbol === "" ? undefined : input.symbol;
  let symbol: IndexedSymbol | undefined;
  if (symbolPath !== undefined) {
    symbol = index.symbolAt(input.file, symbolPath);
    if (!symbol) {
      const hint = index.suggestSymbols(
        input.file,
        symbolPath,
        3,
        opts.symbolHint?.(input.file, symbolPath) ?? {},
      );
      const mistaken = symbolPath.startsWith(`${input.file}#`)
        ? ` The symbol is the path inside the file, without the file part: "${symbolPath.slice(input.file.length + 1)}".`
        : "";
      return fail(
        `symbol "${symbolPath}" not found in ${input.file}.${mistaken}` +
          (hint.length
            ? ` Did you mean: ${hint.map((s) => describeSymbolCandidate(s, { anchor: true })).join(", ")}?`
            : "") +
          (hint.length === 0 ? " Use `xpl outline` to list the symbols of the file." : ""),
      );
    }
  }

  // Spans depend on indexed line positions too. Hashing current text cannot make a legacy index safe.
  if (
    [file.hash, ...(symbol ? [symbol.hash] : [])].some(
      (hash) => typeof hash !== "string" || !hash.startsWith("sha256-v2:"),
    )
  ) {
    return fail(
      "legacy index hashes cannot verify source changes; run `xpl index` before building anchors",
    );
  }
  const region: Range = symbol ? symbol.range : { startLine: 1, endLine: file.lines };
  const base = region.startLine;
  const target = symbol ? `${input.file}#${symbolPath}` : input.file;
  const size = region.endLine - region.startLine + 1;
  let span = input.span;

  if (input.find !== undefined) {
    const lines = texts.lines(input.file);
    if (!lines) return fail(`cannot read ${input.file} to locate the find text`);
    const located = locateText(lines.slice(region.startLine - 1, region.endLine), input.find);
    if (located.kind === "empty") return fail("anchor.find is empty");
    if (located.kind === "none") {
      const hint = firstLineHint(lines.slice(region.startLine - 1, region.endLine), input.find);
      return fail(
        `find text not found in ${target} (tried an exact match and one ignoring whitespace differences)` +
          hint +
          ". Copy the text from `xpl show`, or use span offsets.",
      );
    }
    if (located.kind === "many") {
      return fail(
        `find text occurs ${located.count} times in ${target} (at offsets ${located.offsets.join(", ")}` +
          `${located.count > located.offsets.length ? ", ..." : ""}). Extend it with neighbouring text so it is unique, or use span.`,
      );
    }
    span = { from: located.from, to: located.to };
  }

  let range: Range;
  let hash: Hash;
  if (span === undefined) {
    range = { ...region };
    hash = symbol ? symbol.hash : file.hash;
  } else {
    if (base + span.to > region.endLine) {
      return fail(
        `span ${span.from}..${span.to} lies outside ${target}, which has offsets 0..${size - 1}`,
      );
    }
    const lines = texts.lines(input.file);
    if (!lines) return fail(`cannot read ${input.file} to hash the span`);
    range = { startLine: base + span.from, endLine: base + span.to };
    const normalized = normalizeLines(lines.slice(range.startLine - 1, range.endLine));
    if (normalized === "")
      return fail(`span ${span.from}..${span.to} of ${target} covers only blank lines`);
    hash = hashOf(lines, range);
  }
  if (input.hash !== undefined && input.hash !== hash) {
    return fail(
      `stale anchor for ${describeAnchor({ file: input.file, symbol: symbolPath, span })}: given hash ${input.hash} but the current text hashes to ${hash}; the code changed since it was read, so re-read it and rebuild the anchor`,
    );
  }

  const anchor: Anchor = {
    file: input.file,
    ...(symbolPath !== undefined ? { symbol: symbolPath } : {}),
    ...(span !== undefined ? { span: { from: span.from, to: span.to } } : {}),
    role: input.role,
    hash,
    resolved: { commit: index.commit, range: { ...range }, status: "ok" },
  };
  return { ok: true, anchor };
}

const MAX_LISTED = 8;

type Located =
  | { kind: "unique"; from: number; to: number }
  | { kind: "none" }
  | { kind: "empty" }
  | { kind: "many"; count: number; offsets: number[] };

/** All (overlapping) occurrences of `needle` in `haystack`. */
function allIndexes(haystack: string, needle: string): number[] {
  const out: number[] = [];
  for (let at = haystack.indexOf(needle); at !== -1; at = haystack.indexOf(needle, at + 1)) {
    out.push(at);
  }
  return out;
}

/** Runs of whitespace become one space; `map[i]` is the original index of collapsed char `i`. */
function collapseWhitespace(text: string): { text: string; map: number[] } {
  const chars: string[] = [];
  const map: number[] = [];
  let inSpace = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (/\s/.test(ch)) {
      if (!inSpace) {
        chars.push(" ");
        map.push(i);
      }
      inSpace = true;
    } else {
      chars.push(ch);
      map.push(i);
      inSpace = false;
    }
  }
  return { text: chars.join(""), map };
}

/** Finds `find` in the region's lines: exactly first, then with whitespace collapsed on both sides. */
function locateText(regionLines: readonly string[], find: string): Located {
  const haystack = regionLines.join("\n");
  const lineStarts: number[] = [];
  let offset = 0;
  for (const line of regionLines) {
    lineStarts.push(offset);
    offset += line.length + 1;
  }
  const lineOf = (index: number): number => {
    let lo = 0;
    let hi = lineStarts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (lineStarts[mid]! <= index) lo = mid;
      else hi = mid - 1;
    }
    return lo;
  };

  const needle = find.replace(/\r\n?/g, "\n");
  if (needle.trim() === "") return { kind: "empty" };

  const exact = allIndexes(haystack, needle);
  if (exact.length === 1) {
    let start = exact[0]!;
    let end = start + needle.length; // exclusive
    while (start < end && haystack[start] === "\n") start++;
    while (end > start && haystack[end - 1] === "\n") end--;
    return { kind: "unique", from: lineOf(start), to: lineOf(Math.max(start, end - 1)) };
  }
  if (exact.length > 1) {
    return { kind: "many", count: exact.length, offsets: startLines(exact, lineOf) };
  }

  const collapsed = collapseWhitespace(haystack);
  const collapsedNeedle = collapseWhitespace(needle.trim()).text;
  const hits = allIndexes(collapsed.text, collapsedNeedle);
  if (hits.length === 0) return { kind: "none" };
  if (hits.length > 1) {
    return {
      kind: "many",
      count: hits.length,
      offsets: startLines(
        hits.map((h) => collapsed.map[h]!),
        lineOf,
      ),
    };
  }
  const first = collapsed.map[hits[0]!]!;
  const last = collapsed.map[hits[0]! + collapsedNeedle.length - 1]!;
  return { kind: "unique", from: lineOf(first), to: lineOf(last) };
}

function startLines(starts: readonly number[], lineOf: (index: number) => number): number[] {
  const out: number[] = [];
  for (const start of starts) {
    const line = lineOf(start);
    if (!out.includes(line)) out.push(line);
    if (out.length >= MAX_LISTED) break;
  }
  return out;
}

/** When the whole needle is not found, tell where its first line occurs (helps fix a near miss). */
function firstLineHint(regionLines: readonly string[], find: string): string {
  const firstLine = find
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((l) => l.trim())
    .find((l) => l !== "");
  if (!firstLine) return "";
  const offsets: number[] = [];
  regionLines.forEach((line, i) => {
    if (line.includes(firstLine) && offsets.length < MAX_LISTED) offsets.push(i);
  });
  return offsets.length > 0
    ? `; its first line "${firstLine.length > 40 ? firstLine.slice(0, 40) + "..." : firstLine}" occurs at offsets ${offsets.join(", ")}`
    : "";
}

// ─── Re-resolving a whole explainer ─────────────────────────────────────────────────────────────

/** One anchor of an explainer and where it lives. */
export interface AnchorSite {
  anchor: Anchor;
  /** JSON-pointer-ish path, e.g. `views[1].steps[2].anchors[0]`. */
  path: string;
  /** Id of the owning element; for tour step code overrides `"<tour id>/<step id>"`. */
  elementId: string;
  owner: "node" | "edge" | "concept" | "step" | "tour-step";
  /**
   * Origin of the owning element (a step: its view's origin; a tour step: its tour's, undefined for a tour
   * without provenance, which counts as `llm`).
   */
  origin?: Origin;
  /** Fields the user edited on the owner (a step: its view's `userFields`; a tour step: its tour's). */
  userFields: string[];
  /** Steps: the id of the sequence view the step belongs to. */
  viewId?: string;
}

/**
 * What the stored anchors of an explainer remember about symbols: a whole-symbol anchor keeps the range and
 * hash the symbol had, which helps to find where a renamed or moved symbol went (see `suggestSymbols`).
 * Returns a lookup by file and symbol path.
 */
export function storedSymbolHints(
  explainer: Explainer,
): (file: FilePath, symbol: string) => SymbolHint | undefined {
  const known = new Map<string, SymbolHint>();
  try {
    for (const site of collectAnchors(explainer)) {
      const a = site.anchor;
      if (typeof a.symbol !== "string" || (a.span !== undefined && a.span !== null)) continue;
      const lines = rangeLines(a.resolved?.range);
      if (lines === undefined) continue;
      const key = `${a.file}\0${a.symbol}`;
      if (known.has(key)) continue;
      known.set(key, {
        lines,
        ...(typeof a.hash === "string" && a.hash !== "" ? { hash: a.hash } : {}),
      });
    }
  } catch {
    // a hand-edited explainer with junk in it: fewer hints, never an error
  }
  return (file, symbol) => known.get(`${file}\0${symbol}`);
}

/** Every anchor of an explainer (elements, sequence steps, tour code overrides), by reference. */
export function collectAnchors(explainer: Explainer): AnchorSite[] {
  const sites: AnchorSite[] = [];
  const add = (
    anchors: readonly Anchor[] | undefined,
    path: string,
    elementId: string,
    owner: AnchorSite["owner"],
    origin: Origin | undefined,
    userFields: string[] | undefined,
    viewId?: string,
  ) => {
    if (!Array.isArray(anchors)) return;
    anchors.forEach((anchor, i) => {
      if (typeof anchor === "object" && anchor !== null) {
        sites.push({
          anchor,
          path: `${path}[${i}]`,
          elementId,
          owner,
          origin,
          userFields: userFields ?? [],
          ...(viewId !== undefined ? { viewId } : {}),
        });
      }
    });
  };
  const list = <T>(value: readonly T[] | undefined): readonly T[] =>
    Array.isArray(value) ? value : [];

  list(explainer.nodes).forEach((node, i) =>
    add(
      node.anchors,
      `nodes[${i}].anchors`,
      node.id,
      "node",
      node.provenance?.origin,
      node.provenance?.userFields,
    ),
  );
  list(explainer.edges).forEach((edge, i) =>
    add(
      edge.anchors,
      `edges[${i}].anchors`,
      edge.id,
      "edge",
      edge.provenance?.origin,
      edge.provenance?.userFields,
    ),
  );
  list(explainer.concepts).forEach((concept, i) =>
    add(
      concept.anchors,
      `concepts[${i}].anchors`,
      concept.id,
      "concept",
      concept.provenance?.origin,
      concept.provenance?.userFields,
    ),
  );
  list(explainer.views).forEach((view, i) => {
    if (view.type !== "sequence" && view.type !== "flow") return;
    list(view.steps).forEach((step, j) =>
      add(
        step.anchors,
        `views[${i}].steps[${j}].anchors`,
        step.id,
        "step",
        view.provenance?.origin,
        view.provenance?.userFields,
        view.id,
      ),
    );
  });
  list(explainer.tours).forEach((tour, i) =>
    list(tour.steps).forEach((step, j) =>
      add(
        step.code,
        `tours[${i}].steps[${j}].code`,
        `${tour.id}/${step.id}`,
        "tour-step",
        // a tour written before tours had provenance has none: it counts as the llm's
        tour.provenance?.origin,
        tour.provenance?.userFields,
      ),
    ),
  );
  return sites;
}

export interface ResolveOptions {
  /** Repo-relative path of the index file; becomes `explainer.index.path`. Default: unchanged. */
  indexPath?: string;
}

/** A drifted anchor inside a `DriftedElement`. */
export interface DriftedAnchor {
  path: string;
  anchor: {
    file: FilePath;
    symbol?: string;
    span?: { from: number; to: number };
    role: AnchorRole;
  };
  range: Range;
  /**
   * Set for span anchors: a span is only re-found while its text is unchanged, so for a drifted one `range`
   * is just where the span used to sit. Lines added or removed above it inside the symbol put the changed
   * code a few lines off; re-read the code instead of trusting these lines.
   */
  approximate?: true;
  reason?: string;
}

/** An llm element with at least one drifted anchor: to be re-explained. */
export interface DriftedElement {
  elementId: string;
  owner: AnchorSite["owner"];
  /** Steps: the sequence view they belong to. */
  view?: string;
  /** Fields the user edited; a re-explanation must leave them alone. */
  userFields: string[];
  anchors: DriftedAnchor[];
}

export interface MissingAnchor {
  elementId: string;
  owner: AnchorSite["owner"];
  /** Steps: the sequence view they belong to. */
  view?: string;
  origin?: Origin;
  path: string;
  anchor: {
    file: FilePath;
    symbol?: string;
    span?: { from: number; to: number };
    role: AnchorRole;
  };
  reason: string;
}

export interface ResolveReport {
  /** The index commit everything was resolved against. */
  commit: string;
  total: number;
  counts: Record<AnchorStatus, number>;
  /** Anchors that moved (`counts.moved`). */
  moved: number;
  /** Drifted anchors grouped by owning element, for elements with origin `llm` (and tours, which have none). */
  drifted: DriftedElement[];
  /** Elements with drifted anchors that are not re-explained: origin `user` or `static`. */
  driftedOther: { elementId: string; origin: Origin | undefined; paths: string[] }[];
  /** Every missing anchor, whatever its owner's origin. Never dropped silently. */
  missing: MissingAnchor[];
}

function anchorRef(anchor: Anchor): DriftedAnchor["anchor"] {
  return {
    file: anchor.file,
    ...(anchor.symbol !== undefined ? { symbol: anchor.symbol } : {}),
    ...(anchor.span !== undefined ? { span: { ...anchor.span } } : {}),
    role: anchor.role,
  };
}

/**
 * Re-resolves every anchor of an explainer (elements, sequence steps, tour code overrides) against
 * a (new) index: rewrites `anchor.resolved`, updates `span` for `moved` anchors, and sets
 * `explainer.index` (path from `opts.indexPath`) and `explainer.repo.commit`. Hashes are left alone,
 * so a drifted anchor stays `drifted` until its element is re-explained. Returns a modified copy.
 */
export function reresolveExplainer(
  explainer: Explainer,
  indexLike: SymbolIndex | IndexModel,
  getText: GetText | TextCache,
  opts: ResolveOptions = {},
): { explainer: Explainer; report: ResolveReport } {
  const index = asIndexModel(indexLike);
  const texts = toTextCache(getText);
  const next = cloneJson(explainer);
  const counts: Record<AnchorStatus, number> = { ok: 0, moved: 0, drifted: 0, missing: 0 };
  const drifted = new Map<string, DriftedElement>();
  const other = new Map<
    string,
    { elementId: string; origin: Origin | undefined; paths: string[] }
  >();
  const missing: MissingAnchor[] = [];
  const sites = collectAnchors(next);

  for (const site of sites) {
    const { anchor } = site;
    const result = resolveWith(anchor, index, texts);
    counts[result.status]++;
    anchor.resolved = { commit: index.commit, range: result.range, status: result.status };
    if (result.status === "moved" && result.span) anchor.span = result.span;

    if (result.status === "missing") {
      missing.push({
        elementId: site.elementId,
        owner: site.owner,
        ...(site.viewId !== undefined ? { view: site.viewId } : {}),
        origin: site.origin,
        path: site.path,
        anchor: anchorRef(anchor),
        reason: result.reason ?? "missing",
      });
    } else if (result.status === "drifted") {
      if (site.origin === "llm" || site.origin === undefined) {
        let element = drifted.get(site.elementId);
        if (!element) {
          element = {
            elementId: site.elementId,
            owner: site.owner,
            ...(site.viewId !== undefined ? { view: site.viewId } : {}),
            userFields: [...site.userFields],
            anchors: [],
          };
          drifted.set(site.elementId, element);
        }
        element.anchors.push({
          path: site.path,
          anchor: anchorRef(anchor),
          range: result.range,
          ...(anchor.span !== undefined ? { approximate: true as const } : {}),
          ...(result.reason !== undefined ? { reason: result.reason } : {}),
        });
      } else {
        const entry = other.get(site.elementId) ?? {
          elementId: site.elementId,
          origin: site.origin,
          paths: [],
        };
        entry.paths.push(site.path);
        other.set(site.elementId, entry);
      }
    }
  }

  next.index = { path: opts.indexPath ?? explainer.index?.path ?? "", commit: index.commit };
  next.repo = { ...next.repo, commit: index.commit };

  return {
    explainer: next,
    report: {
      commit: index.commit,
      total: sites.length,
      counts,
      moved: counts.moved,
      drifted: [...drifted.values()],
      driftedOther: [...other.values()],
      missing,
    },
  };
}
