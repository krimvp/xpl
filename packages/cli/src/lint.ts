/**
 * `xpl lint`: deterministic checks of the text a reader sees in an explainer. They apply the plain-language and
 * structure rules of the skill (reference/writing.md): a summary first, plain titles, short sentences that name
 * their subject, no marketing words, no absolute claims without evidence, say it once.
 *
 * The checks read the explainer only (no index): titles (the explainer's, the tours', the views', the
 * `### heading` line of a tour note, group and concept labels), tour summaries, tour notes, flow and sequence
 * step labels and summaries, and the summaries and details of nodes, edges and concepts. Code spans (`...`) are
 * left out of the word checks, so a backticked identifier never counts as a long word, a filler word or an
 * absolute. Every finding names the element, the field, a short quote and a fix.
 *
 * Markdown fields and plain fields follow the viewer: it renders markdown in a tour `summary`, a step `note` (and
 * its `### title` line) and a `detail`; everything else (titles, labels, summaries of elements and steps) is shown
 * as plain text, where `**`, `__`, `# ` or `[text](link)` would show as-is (`markdown-in-plain`).
 *
 * The thresholds and the word lists live here, in one place (`LINT_LIMITS`, `FILLER_WORDS`, `ABSOLUTE_WORDS`).
 */
import type { Explainer } from "@xpl/core";

export type LintRule =
  | "tour-summary"
  | "note-heading"
  | "code-title"
  | "placeholder-title"
  | "long-sentence"
  | "long-average"
  | "bare-it"
  | "filler-word"
  | "absolute-word"
  | "repeats-summary"
  | "flow-label-code"
  | "markdown-in-plain";

/** The rules in the order the count line lists them, with a short name for people. */
export const LINT_RULES: Record<LintRule, string> = {
  "tour-summary": "tour without a summary",
  "note-heading": 'note without a "### title" line',
  "code-title": "title that looks like code",
  "placeholder-title": "placeholder title",
  "long-sentence": "sentence over 25 words",
  "long-average": "field with long sentences on average",
  "bare-it": 'sentence that starts with a bare "It" or "This"',
  "filler-word": "marketing or filler word",
  "absolute-word": "absolute word that needs evidence",
  "repeats-summary": "note that repeats a summary",
  "flow-label-code": "flow step label written as code",
  "markdown-in-plain": "markdown in a plain-text field",
};

export type LintElementKind =
  "explainer" | "tour" | "tour-step" | "view" | "step" | "node" | "edge" | "concept";

export interface LintFinding {
  rule: LintRule;
  /** `(explainer)`, a tour id, `tour:x/t1` for a tour step, a view id, a step id, a node, edge or concept id. */
  elementId: string;
  kind: LintElementKind;
  /** For a flow or sequence step: its view. */
  view?: string;
  /** `title`, `summary`, `note`, `note heading`, `label` or `detail`. */
  field: string;
  /** A short excerpt of the text the finding is about. */
  quote: string;
  /** What is wrong. */
  message: string;
  /** How to fix it. */
  hint: string;
}

export interface LintResult {
  findings: LintFinding[];
  /** How many non-empty texts were checked. */
  checked: number;
}

export const LINT_LIMITS = {
  /** A sentence longer than this many words is a finding. */
  sentenceWords: 25,
  /** A field whose sentences (two or more) average more words than this is a finding. */
  averageWords: 20,
  /** A tour summary of more sentences than this is a finding (the skill asks for 2-4). */
  summarySentences: 4,
  /** Quotes are cut to about this many characters. */
  quoteChars: 72,
  /**
   * A note sentence repeats a summary sentence when this share of its content words (stop words left out) is in
   * that summary sentence...
   */
  repeatShare: 0.8,
  /** ...and it has at least this many content words (a shorter one must match the whole summary sentence). */
  repeatMinWords: 4,
};

/**
 * Marketing and filler words, each with what to write instead. Matched as whole words, case-insensitively,
 * outside code spans. A phrase may contain spaces or hyphens.
 */
export const FILLER_WORDS: Readonly<Record<string, string>> = {
  seamless: "drop it, or say what works without extra steps",
  seamlessly: "drop it, or say what works without extra steps",
  robust: "say what it copes with (bad input, retries, ...)",
  leverage: 'write "use"',
  leverages: 'write "uses"',
  leveraged: 'write "used"',
  leveraging: 'write "using"',
  utilize: 'write "use"',
  utilizes: 'write "uses"',
  elegant: "drop it",
  elegantly: "drop it",
  powerful: "say what it does",
  simply: "drop it",
  just: 'drop it, or write "only" or "right" if that is what you mean',
  basically: "drop it",
  essentially: "drop it",
  obviously: "drop it",
  delve: 'write "look at"',
  "delve into": 'write "look at"',
  crucial: "say why it matters",
  pivotal: "say why it matters",
  comprehensive: "say what it covers",
  "cutting-edge": "drop it",
  "state-of-the-art": "drop it",
  "best-in-class": "drop it",
  "world-class": "drop it",
  effortless: "drop it, or say what the reader does not have to do",
  effortlessly: "drop it",
  streamline: 'write "simplify", or say what gets shorter',
  streamlined: 'write "simpler", or say what got shorter',
  streamlines: 'write "simplifies", or say what gets shorter',
  blazing: "give the number, or drop it",
  blazingly: "give the number, or drop it",
  intuitive: "say what makes it easy",
  holistic: "drop it",
  empower: 'write "let"',
  empowers: 'write "lets"',
  unlock: 'write "allow" or "enable"',
  unlocks: 'write "allows" or "enables"',
  supercharge: "say what gets faster",
  "game-changer": "drop it",
  plethora: 'write "many"',
  myriad: 'write "many"',
  tapestry: "drop it",
  realm: 'write "area"',
  showcase: 'write "show"',
  showcases: 'write "shows"',
  boasts: 'write "has"',
  facilitate: 'write "help" or "let"',
  facilitates: 'write "helps" or "lets"',
  harness: 'write "use"',
  "under the hood": 'write "inside", or name the part',
  "it's worth noting": "drop it and state the fact",
  "it is worth noting": "drop it and state the fact",
  "in a nutshell": "drop it",
};

/** Absolute words: each is a claim about every case, which needs evidence (or a narrower word). */
export const ABSOLUTE_WORDS: readonly string[] = [
  "all",
  "every",
  "everything",
  "everywhere",
  "never",
  "always",
  "only",
  "everyone",
  "anything",
  "consistent",
  "consistently",
  "guaranteed",
  "guarantees",
];

/**
 * Idioms that contain an absolute word but claim nothing about every case ("does not match at all"). Matched as
 * whole phrases, case-insensitively; their words are not counted as absolutes. Some are idioms only in some
 * places: `end`, only before punctuation or the end of the text ("after all." but not "after all callers"), and
 * `connector`, also before a word such as "when" or "for" ("not at all for IPv6" but not "at all times").
 */
export const ABSOLUTE_IDIOMS: readonly { phrase: string; only?: "end" | "connector" }[] = [
  { phrase: "at all", only: "connector" },
  { phrase: "after all", only: "end" },
  { phrase: "all along", only: "end" },
  { phrase: "above all", only: "end" },
  { phrase: "first of all", only: "end" },
  { phrase: "all in all", only: "end" },
  { phrase: "all of a sudden" },
  { phrase: "once and for all" },
  { phrase: "all right" },
  { phrase: "for all I know" },
];

/** An absolute word after one of these is not a claim about every case ("not all", "if every"). */
const NOT_ABSOLUTE_AFTER = new Set(["not", "if", "unless", "whether", "when", "almost", "nearly"]);

/** Brand and product words in camelCase that are not code identifiers. */
const CAMEL_WORDS = new Set(["iOS", "macOS", "iPadOS", "iPhone", "iPad", "eBay", "jQuery", "npm"]);

/** "only" before one of these words states a condition ("only when the port is valid"), not an absolute claim. */
const CONDITION_AFTER_ONLY = new Set([
  "when",
  "if",
  "after",
  "before",
  "once",
  "while",
  "until",
  "with",
  "for",
  "in",
  "on",
]);

/**
 * Markdown that a plain-text field would show as-is (the viewer renders markdown only in tour summaries, step notes,
 * the `### title` line of a note, and `detail`). Each needs the shape of real markup, so code does not match:
 * `**kwargs` and `2**8` have no closing pair, `__init__` has no space inside, `xs[0](y)` has no URL or path.
 */
const MARKDOWN_MARKS: readonly { name: string; pattern: RegExp }[] = [
  { name: "**bold**", pattern: /(?<![\w*])\*\*(?=\S)[^*\n]*?\S\*\*(?![\w*])/ },
  { name: "__bold__", pattern: /(?<!\w)__(?=\S)[^_\n]*\s[^_\n]*?\S__(?!\w)/ },
  { name: "# heading", pattern: /^ {0,3}#{1,6}[ \t]+\S/m },
  {
    name: "[text](link)",
    pattern:
      /\[[^\]\n]*[A-Za-z][^\]\n]*\]\((?:https?:\/\/|mailto:|\.{0,2}\/|#|[\w.-]+\.[A-Za-z]{2,}(?:[/#?][^)\s]*)?\))[^)\s]*\)/,
  },
];

/** A title that says nothing: `Fix 1`, `Note`, `Step 3`, `Part 2:`, `TODO`, or a bare number. */
const PLACEHOLDER =
  /^(?:(?:fix|note|step|part|section|change|item|point|slide|topic|tour|todo|tbd|untitled|title|heading|misc|details?|more|other)\s*#?\d*|#?\d+)\s*[.:]?$/i;

/** `Fix 1:` / `Note:` at the start of a note without a heading: the viewer may make a title of it. */
const PLACEHOLDER_PREFIX =
  /^\s*((?:fix|note|step|part|section|change|item|point|todo|tbd)\s*#?\d*)\s*:/i;

/** Code values that make no title on their own. */
const CODE_LITERALS = new Set([
  "None",
  "null",
  "nil",
  "undefined",
  "true",
  "false",
  "True",
  "False",
  "NaN",
]);

const HEADING = /^ {0,3}#{1,6}[ \t]+(.*?)(?:[ \t]+#+)?[ \t]*$/;

/** Abbreviations whose period does not end a sentence. */
const ABBREVIATIONS = new Set(["e.g", "i.e", "etc", "vs", "cf", "approx", "incl", "esp", "resp"]);

// ─── Text helpers ───────────────────────────────────────────────────────────────────────────────

const OPEN = "\uE000";
const CLOSE = "\uE001";

/** Text with its code spans replaced by placeholders, and the spans to restore them. */
interface Masked {
  text: string;
  spans: string[];
}

/** Drops fenced code blocks and replaces inline code spans by placeholders that count as one word. */
function mask(markdown: string): Masked {
  const spans: string[] = [];
  const noFences = markdown.replace(
    /^ {0,3}(```|~~~)[^\n]*\n[\s\S]*?(?:^ {0,3}\1[^\n]*$|(?![\s\S]))/gm,
    "",
  );
  const text = noFences.replace(/(`+)([\s\S]*?[^`])\1(?!`)/g, (span) => {
    spans.push(span);
    return `${OPEN}${spans.length - 1}${CLOSE}`;
  });
  return { text, spans };
}

/** The masked text with its code spans back in. */
function unmask(text: string, spans: readonly string[]): string {
  return text.replace(
    new RegExp(`${OPEN}(\\d+)${CLOSE}`, "g"),
    (_, i: string) => spans[Number(i)] ?? "",
  );
}

/** The masked text without its code spans (for word checks). */
function withoutCode(text: string): string {
  return text.replace(new RegExp(`${OPEN}\\d+${CLOSE}`, "g"), " ");
}

/** Plain text of markdown: links become their text, emphasis marks and backticks go. */
function plainText(text: string): string {
  return text
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\*+/g, "")
    .replace(/`/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * The sentences of a masked text: paragraphs and list items are split apart, then each at `.`, `!` or `?`
 * followed by white space (not after `e.g.`, `i.e.`, `etc.`, ...). Heading lines are left out (titles are checked
 * on their own).
 */
function sentences(masked: string): string[] {
  const blocks: string[] = [];
  let current: string[] = [];
  const flush = () => {
    if (current.length > 0) blocks.push(current.join(" "));
    current = [];
  };
  for (const raw of masked.split("\n")) {
    const line = raw.trim();
    if (line === "" || HEADING.test(raw)) {
      flush();
      continue;
    }
    const item = /^(?:[-*+]|\d+[.)])\s+(.*)$/.exec(line);
    if (item) {
      flush();
      current.push(item[1]!.replace(/^\[[ xX]\]\s+/, ""));
    } else {
      current.push(line.replace(/^>\s?/, ""));
    }
  }
  flush();
  const out: string[] = [];
  for (const block of blocks) {
    let start = 0;
    const end = /[.!?]+["')\]*_]*(?=\s|$)/g;
    for (let m = end.exec(block); m; m = end.exec(block)) {
      const before = /([A-Za-z.]+)\.*$/.exec(
        block.slice(start, m.index + 1).replace(/[.!?]+$/, ""),
      );
      const word = (before?.[1] ?? "").toLowerCase();
      if (m[0].startsWith(".") && ABBREVIATIONS.has(word.replace(/\.$/, ""))) continue;
      const sentence = block.slice(start, m.index + m[0].length).trim();
      if (sentence) out.push(sentence);
      start = m.index + m[0].length;
    }
    const rest = block.slice(start).trim();
    if (rest) out.push(rest);
  }
  return out;
}

/** Words of a masked sentence: tokens with a letter or digit; a code span counts as one word. */
function words(masked: string): string[] {
  return masked
    .split(/\s+/)
    .filter((token) => new RegExp(`[\\p{L}\\p{N}${OPEN}]`, "u").test(token));
}

/** `text` cut to about `max` characters around `at` (a character index), with ellipses where cut. */
function excerpt(text: string, at = 0, max = LINT_LIMITS.quoteChars): string {
  const flat = text.replace(/\s+/g, " ").trim();
  if (flat.length <= max) return flat;
  let start = Math.max(0, Math.min(at - Math.floor(max / 3), flat.length - max));
  // start at a word boundary
  if (start > 0) {
    const space = flat.indexOf(" ", start);
    start = space !== -1 && space < at ? space + 1 : start;
  }
  const end = Math.min(flat.length, start + max);
  return `${start > 0 ? "…" : ""}${flat.slice(start, end).trim()}${end < flat.length ? "…" : ""}`;
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** A whole-word, case-insensitive matcher for a word or phrase (`-` and `'` belong to words). */
function wordPattern(phrase: string): RegExp {
  const body = phrase.split(/\s+/).map(escapeRegExp).join("\\s+");
  return new RegExp(`(?<![\\p{L}\\p{N}_'-])${body}(?![\\p{L}\\p{N}_'-])`, "giu");
}

const FILLER_PATTERNS = Object.keys(FILLER_WORDS)
  // longer phrases first, so "delve into" wins over "delve"
  .sort((a, b) => b.length - a.length)
  .map((phrase) => ({ phrase, pattern: wordPattern(phrase) }));
const ABSOLUTE_PATTERNS = ABSOLUTE_WORDS.map((word) => ({ word, pattern: wordPattern(word) }));
const BEFORE_END = String.raw`(?=\s*(?:[,.;:!?)]|$))`;
const BEFORE_CONNECTOR = String.raw`(?=\s*(?:[,.;:!?)]|$|(?:when|if|unless|for|in|on|and|but|or|because|until|since|with|to|by|so|then|yet|here|there|now)(?![\p{L}\p{N}_'-])))`;
const IDIOM_PATTERNS = ABSOLUTE_IDIOMS.map(
  ({ phrase, only }) =>
    new RegExp(
      wordPattern(phrase).source +
        (only === "end" ? BEFORE_END : only === "connector" ? BEFORE_CONNECTOR : ""),
      "giu",
    ),
);

/** `text` with the absolute idioms blanked out (same length, so indexes still point into `text`). */
function withoutIdioms(text: string): string {
  let out = text;
  for (const pattern of IDIOM_PATTERNS) {
    pattern.lastIndex = 0;
    out = out.replace(pattern, (idiom) => " ".repeat(idiom.length));
  }
  return out;
}

/** Words after "It"/"This" that make the sentence start with a verb (with "It"/"This" as a vague subject). */
const VERBS = new Set([
  "is",
  "was",
  "has",
  "had",
  "does",
  "did",
  "can",
  "could",
  "will",
  "would",
  "should",
  "must",
  "may",
  "might",
  "isn't",
  "doesn't",
  "can't",
  "won't",
]);
/** Adverbs that may stand between "It" and its verb ("It also calls ..."). */
const ADVERBS = new Set([
  "also",
  "then",
  "now",
  "only",
  "still",
  "first",
  "always",
  "never",
  "just",
  "simply",
  "usually",
  "often",
  "already",
  "again",
  "finally",
  "really",
]);

/**
 * Is `word` (as written, after "It" or "This") a verb? Auxiliaries, lowercase -s forms (calls, stores, means; not
 * class, status, bus) and, after "It" only, -ed forms ("It returned"; "This cached value" is an adjective).
 */
function looksLikeVerb(word: string, subject: string): boolean {
  if (VERBS.has(word.toLowerCase())) return true;
  if (word !== word.toLowerCase()) return false; // "This Request ...": a name
  if (/^[a-z]{2,}(?<!ss|us|is|ys|os|as)s$/.test(word)) return true;
  return subject === "It" && /^[a-z]{3,}ed$/.test(word);
}

/** "It" or "This" when the sentence starts with that word and a verb ("It calls", "This is", "It's"), else undefined. */
function bareSubject(masked: string): string | undefined {
  const text = withoutCode(masked).replace(/^[\s"'(*_]+/, "");
  if (/^(?:It|This)['’]s\s/.test(text)) return text.startsWith("It") ? "It" : "This";
  const m = /^(It|This)\s+([A-Za-z']+)(?:\s+([A-Za-z']+))?/.exec(text);
  if (!m) return undefined;
  const [, subject, second, third] = m;
  if (looksLikeVerb(second!, subject!)) return subject;
  if (ADVERBS.has(second!.toLowerCase()) && third !== undefined && looksLikeVerb(third, subject!)) {
    return subject;
  }
  return undefined;
}

/**
 * Why `title` looks like code, or undefined: a call (`f(`), an identifier with `_`, a dotted name (`a.b`), a
 * `#` inside a name, operators or brackets of code, a code keyword first (`return x`), or one camelCase /
 * PascalCase identifier. Backticks are ignored (their content counts). `PR #3472`, `e.g.` and `Node.js` are fine.
 */
export function codeLike(title: string): string | undefined {
  const text = plainText(title);
  if (text === "") return undefined;
  if (/[\p{L}\p{N}_$]\(/u.test(text)) return "a call";
  if (/[A-Za-z0-9]_+[A-Za-z0-9]|(?:^|[^\w])_+[A-Za-z]/.test(text)) return "an identifier with _";
  const dotted = /(?<![\w.])([A-Za-z_$][\w$]*)\.([A-Za-z_$][\w$]*)/g;
  for (let m = dotted.exec(text); m; m = dotted.exec(text)) {
    const pair = `${m[1]}.${m[2]}`.toLowerCase();
    if (pair === "e.g" || pair === "i.e") continue;
    if (/^[A-Z][a-z]+$/.test(m[1]!) && m[2] === "js") continue; // Node.js, Vue.js
    return "a dotted name";
  }
  if (/\w#\w|(?:^|\s)#[A-Za-z_]/.test(text)) return "a # inside a name";
  if (/===|!==|==|!=|=>|::|&&|\|\||\[["'\d]|[{}]/.test(text)) return "code operators or brackets";
  if (
    /^(?:return|raise|throw|await|yield|except|catch|def|function|const|let|var)\s+\S/.test(text)
  ) {
    return "a code keyword";
  }
  // one identifier: with _ or $, lowerCamelCase (parseAccept), or PascalCase of three parts or more
  // (ServerErrorMiddleware); two-part PascalCase words are often names of things (WebSocket, GitHub)
  if (/^[A-Za-z_$][\w$]*$/.test(text) && !CAMEL_WORDS.has(text)) {
    if (
      /[_$]/.test(text) ||
      /^[a-z]+[A-Z]/.test(text) ||
      (text.match(/[a-z][A-Z]/g) ?? []).length >= 2
    ) {
      return "a single identifier";
    }
  }
  if (CODE_LITERALS.has(text)) return "a code literal";
  return undefined;
}

/**
 * Why a title or a label looks like code (see `codeLike`). Code in backticks inside a title with at least two
 * plain words around it is a deliberate mention ("How `Host.matches` reads the header"): only the plain words
 * count then. A title that is all code, backticked or not, is checked whole.
 */
export function codeLikeTitle(title: string): string | undefined {
  const masked = mask(title);
  const rest = withoutCode(masked.text);
  if (masked.spans.length > 0 && words(rest).length >= 2) return codeLike(rest);
  return codeLike(title);
}

/** Words that carry no content, left out when two sentences are compared. */
const STOP_WORDS = new Set(
  (
    "a an the is are was were be been being of to in on at by for with and or but so as it its it's this that " +
    "these those than then now from into not no do does did has have had can will would may might must there " +
    "here which who what when where how also only just still each one same"
  ).split(" "),
);

/** The content words of a sentence, code included (without backticks and punctuation), lowercase. */
function contentWords(masked: string, spans: readonly string[]): string[] {
  return plainText(unmask(masked, spans))
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .split(" ")
    .filter((w) => w !== "" && !STOP_WORDS.has(w));
}

/**
 * Does note sentence `a` repeat summary sentence `b`? The same content words (normalized), or at least
 * `repeatShare` of a's content words (and `repeatMinWords` of them) found in b.
 */
function repeats(a: readonly string[], b: readonly string[]): boolean {
  if (a.length === 0 || b.length === 0) return false;
  if (a.join(" ") === b.join(" ")) return true;
  const setA = new Set(a);
  if (setA.size < LINT_LIMITS.repeatMinWords) return false;
  const setB = new Set(b);
  let common = 0;
  for (const w of setA) if (setB.has(w)) common++;
  return common / setA.size >= LINT_LIMITS.repeatShare;
}

// ─── The checks ─────────────────────────────────────────────────────────────────────────────────

interface Where {
  elementId: string;
  kind: LintElementKind;
  view?: string;
  field: string;
}

class Linter {
  readonly findings: LintFinding[] = [];
  checked = 0;

  add(where: Where, rule: LintRule, quote: string, message: string, hint: string): void {
    this.findings.push({ rule, ...where, quote, message, hint });
  }

  /** Filler and absolute words of a masked text (code spans left out): one finding per rule and field. */
  words(where: Where, masked: Masked): void {
    const text = withoutCode(masked.text);
    const quoteAt = (index: number) =>
      excerpt(unmask(masked.text, masked.spans).replace(/\n/g, " "), index);
    const fillers: { phrase: string; index: number }[] = [];
    const taken: [number, number][] = [];
    for (const { phrase, pattern } of FILLER_PATTERNS) {
      pattern.lastIndex = 0;
      for (let m = pattern.exec(text); m; m = pattern.exec(text)) {
        const from = m.index;
        const to = m.index + m[0].length;
        if (taken.some(([a, b]) => from < b && to > a)) continue;
        taken.push([from, to]);
        fillers.push({ phrase, index: from });
      }
    }
    if (fillers.length > 0) {
      fillers.sort((a, b) => a.index - b.index);
      const unique = [...new Set(fillers.map((f) => f.phrase))];
      this.add(
        where,
        "filler-word",
        quoteAt(fillers[0]!.index),
        `${unique.map((w) => `"${w}"`).join(", ")}: marketing or filler`,
        unique.map((w) => `"${w}": ${FILLER_WORDS[w]}`).join("; "),
      );
    }
    const absolutes: { word: string; index: number }[] = [];
    const plainWords = withoutIdioms(text);
    for (const { word, pattern } of ABSOLUTE_PATTERNS) {
      pattern.lastIndex = 0;
      for (let m = pattern.exec(plainWords); m; m = pattern.exec(plainWords)) {
        if (word === "only") {
          const next = /^\s+([A-Za-z]+)/.exec(text.slice(m.index + m[0].length))?.[1];
          if (next !== undefined && CONDITION_AFTER_ONLY.has(next.toLowerCase())) continue;
        }
        const before = /([A-Za-z]+)\s+$/.exec(text.slice(0, m.index))?.[1];
        if (before !== undefined && NOT_ABSOLUTE_AFTER.has(before.toLowerCase())) continue;
        absolutes.push({ word: m[0].toLowerCase(), index: m.index });
      }
    }
    if (absolutes.length > 0) {
      absolutes.sort((a, b) => a.index - b.index);
      const unique = [...new Set(absolutes.map((a) => a.word))];
      this.add(
        where,
        "absolute-word",
        quoteAt(absolutes[0]!.index),
        `${unique.map((w) => `"${w}"`).join(", ")}: an absolute claim that needs evidence`,
        "check every case in the code and anchor it, or narrow the claim (name the places, add the condition)",
      );
    }
  }

  /** A title: code-like, placeholder, filler and absolute words. */
  title(where: Where, title: unknown): void {
    if (typeof title !== "string" || title.trim() === "") return;
    this.checked++;
    const why = codeLikeTitle(title);
    if (why !== undefined) {
      this.add(
        where,
        "code-title",
        excerpt(title),
        `looks like code (${why})`,
        'name what happens in plain words ("The router picks the first match"); keep identifiers in the text below',
      );
    }
    if (PLACEHOLDER.test(plainText(title))) {
      this.add(
        where,
        "placeholder-title",
        excerpt(title),
        "a placeholder, not a title",
        'say what this part is about ("Matching drops rejected types")',
      );
    }
    this.words(where, mask(title));
  }

  /**
   * A field the viewer shows as plain text: markdown marks in it (outside code spans) would show as-is. `count`:
   * count the field as checked (when no other check reads it).
   */
  plain(where: Where, value: unknown, count = false): void {
    if (typeof value !== "string" || value.trim() === "") return;
    if (count) this.checked++;
    const text = withoutCode(mask(value).text);
    const found = MARKDOWN_MARKS.map(({ name, pattern }) => ({ name, match: pattern.exec(text) }))
      .filter((f): f is { name: string; match: RegExpExecArray } => f.match !== null)
      .sort((a, b) => a.match.index - b.match.index);
    if (found.length === 0) return;
    const first = found[0]!.match[0].trim();
    const at = Math.max(0, value.indexOf(first));
    this.add(
      where,
      "markdown-in-plain",
      excerpt(value, at),
      `markdown (${found.map((f) => f.name).join(", ")}) in a field the viewer shows as plain text: the marks show as-is`,
      "write it as plain text; markdown works in tour summaries, step notes and details",
    );
  }

  /** Prose: sentence length, bare "It"/"This", filler and absolute words. */
  prose(where: Where, value: unknown): Masked | undefined {
    if (typeof value !== "string" || value.trim() === "") return undefined;
    this.checked++;
    const masked = mask(value);
    const list = sentences(masked.text);
    const counts = list.map((s) => words(s).length);
    list.forEach((sentence, i) => {
      if (counts[i]! > LINT_LIMITS.sentenceWords) {
        this.add(
          where,
          "long-sentence",
          excerpt(unmask(sentence, masked.spans)),
          `${counts[i]} words (more than ${LINT_LIMITS.sentenceWords})`,
          "split it: one fact per sentence, aim for 15-20 words",
        );
      }
      const subject = bareSubject(sentence);
      if (subject !== undefined) {
        this.add(
          where,
          "bare-it",
          excerpt(unmask(sentence, masked.spans)),
          `starts with a bare "${subject}"`,
          `name the subject ("The router ...", "ServerErrorMiddleware ..."): a reader who jumps here does not know what "${subject}" is`,
        );
      }
    });
    const counted = counts.filter((n) => n > 0);
    if (counted.length >= 2) {
      const average = counted.reduce((a, b) => a + b, 0) / counted.length;
      if (average > LINT_LIMITS.averageWords) {
        this.add(
          where,
          "long-average",
          excerpt(unmask(list[0]!, masked.spans)),
          `${counted.length} sentences, ${average.toFixed(1)} words on average (more than ${LINT_LIMITS.averageWords})`,
          "shorten the sentences: one fact each, aim for 15-20 words",
        );
      }
    }
    this.words(where, masked);
    return masked;
  }
}

const list = <T>(value: unknown): readonly T[] => (Array.isArray(value) ? (value as T[]) : []);
const str = (value: unknown): string | undefined => (typeof value === "string" ? value : undefined);
const record = (value: unknown): Record<string, unknown> =>
  typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};

/** Stored summaries by element id: nodes, edges, concepts and sequence/flow steps. */
function storedSummaries(explainer: Explainer): Map<string, string> {
  const out = new Map<string, string>();
  const take = (item: unknown) => {
    const { id, summary } = record(item);
    if (typeof id === "string" && typeof summary === "string" && summary.trim() !== "") {
      out.set(id, summary);
    }
  };
  for (const node of list(explainer.nodes)) take(node);
  for (const edge of list(explainer.edges)) take(edge);
  for (const concept of list(explainer.concepts)) take(concept);
  for (const view of list(explainer.views)) for (const step of list(record(view).steps)) take(step);
  return out;
}

/** The checks of `xpl lint` on one explainer, in document order (see the file comment). */
export function lintExplainer(explainer: Explainer): LintResult {
  const lint = new Linter();
  const summaries = storedSummaries(explainer);

  const explainerTitle: Where = { elementId: "(explainer)", kind: "explainer", field: "title" };
  lint.title(explainerTitle, explainer.title);
  lint.plain(explainerTitle, explainer.title);

  for (const tourValue of list(explainer.tours)) {
    const tour = record(tourValue);
    const tourId = str(tour.id) ?? "(tour)";
    const at = (field: string): Where => ({ elementId: tourId, kind: "tour", field });
    lint.title(at("title"), tour.title);
    lint.plain(at("title"), tour.title);
    // `summary` is optional (and newer than tours): read it defensively
    const summary = tour.summary;
    if (typeof summary === "string" && summary.trim() !== "") {
      const masked = lint.prose(at("summary"), summary);
      const count = masked ? sentences(masked.text).length : 0;
      if (count > LINT_LIMITS.summarySentences) {
        lint.add(
          at("summary"),
          "tour-summary",
          excerpt(summary),
          `${count} sentences (more than ${LINT_LIMITS.summarySentences})`,
          "keep the summary to 2-4 sentences; move the rest into the steps",
        );
      }
    } else {
      lint.add(
        at("summary"),
        "tour-summary",
        excerpt(str(tour.title) ?? tourId),
        "no summary: readers see the summary first, under the tour title",
        "add 2-4 sentences: what this is and why it matters; for a change: what behaves differently, the risk, the tests",
      );
    }
    for (const stepValue of list(tour.steps)) {
      const step = record(stepValue);
      const note = str(step.note);
      if (note === undefined || note.trim() === "") continue;
      const where: Where = {
        elementId: `${tourId}/${str(step.id) ?? "?"}`,
        kind: "tour-step",
        field: "note",
      };
      const lines = note.split("\n");
      const first = lines.findIndex((line) => line.trim() !== "");
      const heading = HEADING.exec(lines[first] ?? "");
      let body = note;
      if (heading && heading[1]!.trim() !== "") {
        lint.title({ ...where, field: "note heading" }, heading[1]);
        body = lines.slice(first + 1).join("\n");
      } else {
        const prefix = PLACEHOLDER_PREFIX.exec(note);
        lint.add(
          where,
          "note-heading",
          excerpt(note),
          'no "### title" line: the viewer has to make a title from the text' +
            (prefix ? `, and the note starts with "${prefix[1]}:", a placeholder` : ""),
          'start the note with "### <plain title>", a short phrase that says what happens here' +
            (prefix ? ` (instead of "${prefix[1]}:")` : ""),
        );
      }
      const masked = lint.prose(where, body);
      if (masked === undefined) continue;
      // say it once: a note sentence that repeats the summary of something the step focuses
      const noteSentences = sentences(masked.text).map((s) => ({
        text: s,
        words: contentWords(s, masked.spans),
      }));
      for (const focus of list<unknown>(step.focus)) {
        if (typeof focus !== "string") continue;
        const summary = summaries.get(focus);
        if (summary === undefined) continue;
        const other = mask(summary);
        const summaryWords = sentences(other.text).map((s) => contentWords(s, other.spans));
        const repeated = noteSentences.find((s) => summaryWords.some((w) => repeats(s.words, w)));
        if (repeated) {
          lint.add(
            where,
            "repeats-summary",
            excerpt(unmask(repeated.text, masked.spans)),
            `repeats the summary of ${focus}, which the reader sees next to the note`,
            "say something the summary does not (why it matters here, what to look at), or drop the sentence",
          );
        }
      }
    }
  }

  for (const viewValue of list(explainer.views)) {
    const view = record(viewValue);
    const viewId = str(view.id) ?? "(view)";
    const viewTitle: Where = { elementId: viewId, kind: "view", field: "title" };
    lint.title(viewTitle, view.title);
    lint.plain(viewTitle, view.title);
    if (view.type !== "sequence" && view.type !== "flow") continue;
    for (const stepValue of list(view.steps)) {
      const step = record(stepValue);
      const stepId = str(step.id) ?? "?";
      const at = (field: string): Where => ({
        elementId: stepId,
        kind: "step",
        view: viewId,
        field,
      });
      const label = str(step.label);
      if (view.type === "flow" && label !== undefined && label.trim() !== "") {
        const why = codeLikeTitle(label);
        if (why !== undefined) {
          lint.add(
            at("label"),
            "flow-label-code",
            excerpt(label),
            `a flow stage written as code (${why})`,
            'name the stage in plain words ("Check the port", "Pick a handler"); the code shows the call',
          );
        }
      }
      lint.plain(at("label"), step.label, true);
      lint.prose(at("summary"), step.summary);
      lint.plain(at("summary"), step.summary);
    }
  }

  const element = (kind: "node" | "edge" | "concept", value: unknown) => {
    const item = record(value);
    const id = str(item.id) ?? `(${kind})`;
    // the labels of groups and concepts are titles a person chose; other labels name code
    const titled = kind === "concept" || id.startsWith("grp:");
    if (titled) lint.title({ elementId: id, kind, field: "label" }, item.label);
    lint.plain({ elementId: id, kind, field: "label" }, item.label, !titled);
    lint.prose({ elementId: id, kind, field: "summary" }, item.summary);
    lint.plain({ elementId: id, kind, field: "summary" }, item.summary);
    lint.prose({ elementId: id, kind, field: "detail" }, item.detail);
  };
  for (const node of list(explainer.nodes)) element("node", node);
  for (const edge of list(explainer.edges)) element("edge", edge);
  for (const concept of list(explainer.concepts)) element("concept", concept);

  return { findings: lint.findings, checked: lint.checked };
}
