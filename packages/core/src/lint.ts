/**
 * `xpl lint`: deterministic checks of the text a reader sees in an explainer. They apply the plain-language and
 * structure rules of the skill (reference/writing.md), after Orwell and ASD-STE100: a summary first, plain titles,
 * short summaries, notes and paragraphs, short sentences in the active voice that name their subject, no "we", no
 * words of the tool in a tour, no marketing or wordy phrases, no absolute claims without evidence, say it once,
 * top-down order.
 *
 * The text checks read the explainer only (no index): titles (the explainer's, the tours', the views', the
 * `### heading` line of a tour note, group and concept labels), tour summaries, tour notes, flow and sequence
 * step labels and summaries, and the summaries and details of nodes, edges and concepts. Placeholder checks
 * walk every authored string, including frame and transition labels, audience and technology. Code spans (`...`) are
 * left out of the word checks, so a backticked identifier never counts as a long word, a filler word or an
 * absolute. Every finding names the element, the field, a short quote and a fix.
 *
 * Markdown fields and plain fields follow the viewer: it renders markdown in a tour `summary`, a step `note` (and
 * its `### title` line) and a `detail`, and inline markdown (code spans, bold, emphasis) in the `summary` of
 * elements and steps. Titles and labels are plain text, where `**`, `__`, `# ` or `[text](link)` would show as-is
 * (`markdown-in-plain`). A summary is one or two sentences next to the code: a `# heading` there shows as-is and a
 * link leads away from the code (`markdown-in-summary`).
 *
 * Order checks look at each tour as a whole: the first step shows the big picture (not a test, a concept alone or
 * an edge case), a small map is covered by the steps, and a tour has at most `LINT_LIMITS.tourSteps` steps.
 * Structure checks look at the explainer as a whole: every view is on a tour step or opened by a box, there are few
 * concepts, and no tour copies a note of another.
 *
 * Reader checks look at what the viewer will show: a step it has to title itself (`untitled-step`), changed files
 * no step shows the code of (`change-not-shown`), more far-apart places of a step in one file than a slide has panes for (`far-ranges`), a talk note set in
 * small type (`long-talk-note`), maps too big or too crowded for a picture (`big-map`, `crowded-map`), sequences with
 * too many lifelines (`many-participants`), and a
 * system map with no visible arrows (`system-map-no-edges`). Map counts need the index: pass an
 * `ExplainerModel` to get them (`xpl lint` does when there is an index).
 *
 * The rules are meant not to fight: example values in code spans are not code names, an absolute word next to its
 * evidence (anchors) passes, box names match by word stems, and a hint names the limit a fix could trip.
 *
 * A `TODO` left in any of these texts (or in a view's `scope.question`, which the viewer shows under its title) is
 * the one error-level finding (`todo-left`): `xpl draft` fills every text a person must write with `TODO: ...`.
 *
 * The thresholds and the word lists live here, in one place (`LINT_LIMITS`, `FILLER_WORDS`, `ABSOLUTE_WORDS`,
 * `TOOL_WORDS`).
 */
import { deriveGraph, type DerivedGraph } from "./graph.js";
import { collectAnchors, isBaseAnchor } from "./anchors.js";
import { codeFocus } from "./focus.js";
import { isTestFile } from "./index-model.js";
import { parseId } from "./ids.js";
import type { Explainer, GraphView } from "./schema.js";
import type { ExplainerModel } from "./model.js";
function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

export type LintRule =
  | "todo-left"
  | "tour-summary"
  | "tour-first-step"
  | "tour-covers-map"
  | "tour-length"
  | "tour-ends"
  | "unused-view"
  | "many-concepts"
  | "duplicate-step"
  | "note-heading"
  | "connector-start"
  | "code-title"
  | "placeholder-title"
  | "long-title"
  | "long-sentence"
  | "long-average"
  | "bare-it"
  | "abstract-subject"
  | "filler-word"
  | "passive-voice"
  | "we-voice"
  | "dash-chain"
  | "tool-word"
  | "absolute-word"
  | "repeats-summary"
  | "long-note"
  | "long-summary"
  | "long-detail"
  | "code-heavy"
  | "flow-label-code"
  | "markdown-in-plain"
  | "markdown-in-summary"
  | "untitled-step"
  | "change-not-shown"
  | "far-ranges"
  | "many-ranges"
  | "many-diagrams"
  | "long-talk-note"
  | "big-map"
  | "many-participants"
  | "crowded-map"
  | "system-map-no-edges"
  | "map-box";

/** The rules in the order the count line lists them, with a short name for people. */
export const LINT_RULES: Record<LintRule, string> = {
  "todo-left": "TODO placeholder left in the text",
  "tour-summary": "tour without a summary",
  "tour-first-step": "tour that does not start with the big picture",
  "tour-covers-map": "map box the tour never visits",
  "tour-length": "tour with too many steps",
  "tour-ends": "tour that does not end on the map with where next",
  "unused-view": "diagram no tour step shows and no box opens",
  "many-concepts": "explainer with too many concepts",
  "duplicate-step": "tour step copied from another tour",
  "note-heading": 'note without a "### title" line',
  "connector-start": 'note that opens with "So", "But", "And", "Also" or "Then"',
  "code-title": "title that looks like code",
  "placeholder-title": "placeholder title",
  "long-title": "title over 12 words",
  "long-sentence": "sentence over 25 words",
  "long-average": "field with long sentences on average",
  "bare-it": 'sentence that starts with a bare "It", "This", "They" or "There is"',
  "abstract-subject":
    'sentence whose subject is an action, not the code ("Graph derivation combines")',
  "filler-word": "marketing or filler word",
  "passive-voice": "field with passive clauses that hide who acts",
  "we-voice": 'text that says "we" or "our"',
  "dash-chain": "sentence with two or more dashes",
  "tool-word": "word of the tool (node, edge, anchor, stub)",
  "absolute-word": "absolute word that needs evidence",
  "repeats-summary": "note that repeats a summary",
  "long-note": "note that is too long to take in at a glance",
  "long-summary": "element summary over 2 sentences or 45 words",
  "long-detail": "detail paragraph over 80 words",
  "code-heavy": "text that leans on code names instead of ideas",
  "flow-label-code": "flow step label written as code",
  "markdown-in-plain": "markdown in a title or label",
  "markdown-in-summary": "heading or link in a summary",
  "untitled-step": "tour step whose title the viewer has to make up",
  "change-not-shown": "changed file no tour step shows",
  "far-ranges": "step with two far-apart ranges in one file",
  "many-ranges": "step with no code of its own that shows more ranges than a step holds",
  "many-diagrams": "tour that uses more diagrams than its budget",
  "long-talk-note": "talk note set in small type",
  "big-map": "map with too many boxes for a tour",
  "many-participants": "sequence with too many participants for a tour",
  "crowded-map": "map with too many arrows",
  "system-map-no-edges": "system map with no visible arrows",
  "map-box": "box on a map of summaries with a long label or sentence",
};

export type LintElementKind =
  "explainer" | "tour" | "tour-step" | "view" | "step" | "frame" | "node" | "edge" | "concept";

export interface LintFinding {
  rule: LintRule;
  /** `error` for `todo-left` (text nobody wrote yet); absent for the other rules, which are warnings. */
  severity?: "error";
  /** `(explainer)`, a tour id, `tour:x/t1` for a tour step, or a view, step, frame, node, edge or concept id. */
  elementId: string;
  kind: LintElementKind;
  /** For a flow or sequence step: its view. For `tour-covers-map`: the map. */
  view?: string;
  /**
   * `title`, `summary`, `note`, `note heading`, `label` or `detail`; for the order checks `steps` (the tour as a
   * whole) or `focus` (what the first step focuses). Nested authored text uses its path (`next[0].label`).
   */
  field: string;
  /** A short excerpt of the text the finding is about. */
  quote: string;
  /** What is wrong. */
  message: string;
  /** How to fix it. */
  hint: string;
  /** `tour-covers-map`: the ids of the boxes the tour never visits. */
  ids?: string[];
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
  /**
   * A tour summary of fewer or more sentences than these is a finding: the skill asks for the answer first, then
   * up to four reasons (a change: the behaviour, the risk and the tests).
   */
  summaryMinSentences: 2,
  summarySentences: 5,
  /** Quotes are cut to about this many characters. */
  quoteChars: 72,
  /**
   * A note sentence repeats a summary sentence when this share of its content words (stop words left out) is in
   * that summary sentence...
   */
  repeatShare: 0.8,
  /** ...and it has at least this many content words (a shorter one must match the whole summary sentence). */
  repeatMinWords: 4,
  /** A note body (the text under its `### title`) of more words than this is a finding (the skill: 1-3 sentences). */
  noteWords: 50,
  /**
   * The summary of a node, edge, concept, flow or sequence step says what the thing is for: at most this many
   * sentences...
   */
  elementSummarySentences: 2,
  /** ...and this many words (`long-summary`). */
  elementSummaryWords: 45,
  /** A paragraph (or list item) of a `detail` of more words than this is a finding (`long-detail`). */
  detailParagraphWords: 80,
  /**
   * A field with at least this many passive clauses is a finding (`passive-voice`); one is often fine, except in
   * the first sentence of a summary, which is half of it.
   */
  passiveClauses: 2,
  /**
   * A box on a map that draws its summary (`boxText: "summary"`, the explain map) takes a label of at most this
   * many words (the skill: 2-5)...
   */
  mapLabelWords: 5,
  /** ...and a summary of at most this many characters, code marks left out (the skill: about 120; `map-box`). */
  mapSummaryChars: 130,
  /** A title or note heading of more words than this is a finding (`long-title`; the skill asks for about 8). */
  titleWords: 12,
  /** `tour-ends` checks tours of at least this many steps (a short tour may stop where its point is). */
  tourEndsSteps: 5,
  /** An explainer of more concepts than this is a finding (`many-concepts`; the skill asks for 0-3). */
  concepts: 5,
  /** `duplicate-step` compares notes of at least this many different content words (a short note may recur). */
  duplicateMinWords: 8,
  /** Different code names (code spans) a note body may use... */
  noteCodeNames: 3,
  /** ...a note on an architecture map (a view with a box that has a `role`): the idea first, the code on the right... */
  architectureCodeNames: 1,
  /** ...and the tour summary, which a manager reads (the skill: one or two). */
  summaryCodeNames: 2,
  /** A tour of more steps than this is a finding (the skill asks for 5-9, up to 12 for a change). */
  tourSteps: 12,
  /** `tour-covers-map` checks graph views of at most this many boxes (a bigger map is a reference, not a stop). */
  mapBoxes: 10,
  /** The viewer makes a title of a note's first sentence up to this many characters (`MAX_SENTENCE_TITLE`). */
  titleSentenceChars: 80,
  /** Ranges of one step in one file further apart than this many lines are separate places in that file... */
  farRangeLines: 40,
  /** ...and a slide shows at most this many places of a file, one pane each (viewer `MAX_PLACES`). */
  placesPerFile: 3,
  /** A tour step holds at most this many code ranges (SKILL.md: "at most 2 code ranges"), derived ones too. */
  stepRanges: 2,
  /** A tour that follows a path uses at most this many maps and flows or sequences (SKILL.md's budget table). */
  tourMaps: 1,
  tourPaths: 1,
  /** Present sets a note body over this many characters in its smaller caption size (viewer `LONG_NOTE`). */
  talkNoteChars: 280,
  /** A map a tour shows has at most this many boxes (`big-map`)... */
  tourMapBoxes: 8,
  /** ...and at most this many arrows per box (`crowded-map`). */
  edgesPerBox: 2,
  /** A sequence a tour shows has at most this many participants (`many-participants`; SKILL.md "3-6"). */
  sequenceParticipants: 6,
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
  supercharge: "say what gets faster",
  "game-changer": "drop it",
  plethora: 'write "many"',
  myriad: 'write "many"',
  tapestry: "drop it",
  "the realm of": 'write "area", or name it',
  showcase: 'write "show"',
  showcases: 'write "shows"',
  boasts: 'write "has"',
  facilitate: 'write "help" or "let"',
  facilitates: 'write "helps" or "lets"',
  harness: 'write "use"', // the verb only: "the test harness" passes (FILLER_ONLY_BEFORE)
  "under the hood": 'write "inside", or name the part',
  "it's worth noting": "drop it and state the fact",
  "it is worth noting": "drop it and state the fact",
  "in a nutshell": "drop it",
  // wordy phrases (Orwell: never use a long word or phrase where a short one will do)
  "in order to": 'write "to"',
  "a number of": 'write "some", or give the number',
  "is able to": 'write "can"',
  "are able to": 'write "can"',
  "make use of": 'write "use"',
  "makes use of": 'write "uses"',
  "prior to": 'write "before"',
  "due to the fact that": 'write "because"',
  "in the event that": 'write "if"',
  "with respect to": 'write "about"',
  "with regard to": 'write "about"',
  regarding: 'write "about"',
  "note that": "drop it and state the fact",
  "keep in mind": "drop it and state the fact",
  "at this point in time": 'write "now"',
  numerous: 'write "many"',
  utilized: 'write "used"',
  utilizing: 'write "using"',
  commence: 'write "start"',
  commences: 'write "starts"',
  terminate: 'write "end" or "stop"',
  terminates: 'write "ends" or "stops"',
  obtain: 'write "get"',
  obtains: 'write "gets"',
  // weak intensifiers
  very: "drop it, or give the number",
  really: "drop it",
  actually: "drop it",
  extremely: "drop it, or give the number",
  truly: "drop it",
  // stale metaphors (Orwell: never use a figure of speech you are used to seeing in print)
  "heavy lifting": "say what work it does",
  "the heart of": 'name the part ("the main loop of")',
  "the brain of": 'name the part ("the part that decides")',
  "at its core": "drop it",
  "in essence": "drop it",
  "boils down to": 'write "is" or "comes to"',
  "first-class": "say what it can do",
  "out of the box": 'write "by default", or "with no setup"',
  "battle-tested": "say where it has run, or drop it",
  "moving parts": 'write "parts", or name them',
  "deep dive": 'write "a closer look", or "in detail"',
  "bells and whistles": "name the features, or drop it",
  // tics of machine-written text
  ultimately: "drop it",
  notably: "drop it and state the fact",
  importantly: "drop it, or say why it matters",
  nuanced: "say what the cases are",
  "the landscape of": "name what you mean",
  // vague verbs of writing.md 2b ("a verb that says what it does", "keep"); code verbs such as render,
  // dispatch, emit and persist are real API words, so lint leaves them to the writer, and so are "provides" and
  // "supplies" (a React provider, "the app supplies the work"), which read fine in the showcase guides
  manages: "say what it does with it",
  manage: "say what it does with it",
  "takes care of": "say what it does with it",
  "deals with": "say what it does with it",
  preserve: 'write "keep"',
  preserves: 'write "keeps"',
  preserved: 'write "kept"',
  preserving: 'write "keeping"',
  retain: 'write "keep"',
  retains: 'write "keeps"',
  explicitly: 'say who chooses ("you pass ...")',
  various: 'name them, or write "several"',
  "a variety of": 'write "several", or name them',
  additionally: 'write "also", or drop it',
  furthermore: 'write "also", or drop it',
  moreover: 'write "also", or drop it',
  "in other words": "drop it and say it once",
  "it is important to": "drop it and state the fact",
  "needless to say": "drop it",
  straightforward: "drop it",
  effectively: "drop it",
  robustly: "say what it copes with",
};

/** Fillers that are plain words before some next words: "in order to a fresh copy", "first-class functions". */
const FILLER_UNLESS_BEFORE: Readonly<Record<string, RegExp>> = {
  "in order to":
    /^\s+(?:a|an|the|each|its|their|this|these|that|those|every|one|your)(?![\p{L}\p{N}_'-])/iu,
  "first-class": /^[\s-]+(?:functions?|citizens?|values?|objects?|types?)(?![\p{L}\p{N}_'-])/iu,
  terminate:
    /^\s+(?:[\p{L}'-]+\s+){0,2}(?:process(?:es)?|subprocess(?:es)?|groups?|threads?|workers?|child(?:ren)?|connections?|sessions?|programs?|pods?|containers?|jobs?|tasks?|requests?)(?![\p{L}\p{N}_'-])/iu,
  terminates:
    /^\s+(?:[\p{L}'-]+\s+){0,2}(?:process(?:es)?|subprocess(?:es)?|groups?|threads?|workers?|child(?:ren)?|connections?|sessions?|programs?|pods?|containers?|jobs?|tasks?|requests?)(?![\p{L}\p{N}_'-])/iu,
};
/** Fillers only before these words: "harness the queue" (a verb) is filler, "the test harness starts" is not. */
const FILLER_ONLY_BEFORE: Readonly<Record<string, RegExp>> = {
  harness: /^\s+(?:the|its|their|this|these|those|a|an|your)(?![\p{L}\p{N}_'-])/iu,
};

/**
 * Words of the tool (xpl's own names for the parts of an explainer), each with the reader's word. A tour that
 * explains code says "box" and "arrow", not "node" and "edge". Matched in lower case only (so `Node.js` and an
 * `LLM` pass), as whole words, outside code spans, in every title, summary, note and detail. A word the explainer uses
 * in the label or id of a box or a concept, or in a path a view shows, is the code's own word there (a parser's
 * syntax nodes, `anchors.ts`), so it passes; so does a word of the guide's title, of a view's question or of a
 * linked file's path. Outside tours only the senses that belong to xpl count (`XPL_SENSE`, `CODE_TOOL_WORDS`), and
 * quoted text is the code's.
 */
export const TOOL_WORDS: Readonly<Record<string, string>> = {
  node: 'write "box" (on a map), or name the part',
  nodes: 'write "boxes" (on a map), or name the parts',
  edge: 'write "arrow", or say what it means ("calls", "imports")',
  edges: 'write "arrows", or say what they mean ("calls", "imports")',
  anchor: 'write "code link", or "the linked code"',
  anchors: 'write "code links", or "the linked code"',
  anchored: 'write "linked to the code"',
  evidence: 'name the code that shows it ("the test in `retry_test.go` shows ...")',
  upsert: 'write "add or update"',
  upserts: 'write "adds or updates"',
  llm: 'write "Claude", or drop it',
  provenance: 'say who wrote it ("you", "Claude")',
  stub: 'write "a box for code outside this map"',
  stubs: 'write "boxes for code outside this map"',
  ghost: 'write "a box for code outside this map", or "a removed file"',
  ghosts: 'write "boxes for code outside this map", or "removed files"',
  overlay: 'write "an arrow the author added"',
  overlays: 'write "arrows the author added"',
  "call-site": 'write "the code that calls it"',
  "call-sites": 'write "the code that calls it"',
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
  { phrase: "in all", only: "end" },
  { phrase: "all of a sudden" },
  { phrase: "once and for all" },
  { phrase: "all right" },
  { phrase: "for all I know" },
];

/** An absolute word after one of these is not a claim about every case ("not all", "if every"). */
const NOT_ABSOLUTE_AFTER = new Set(["not", "if", "unless", "whether", "when", "almost", "nearly"]);

/**
 * "all", "every" or "only" before a count in digits quotes a measured result ("all 22 new cases pass", "only 4 of
 * the 22 fail"), which the test run proves. Words between them: "of", "the", "these", "those", "its", "their",
 * "one". A count in words ("all three") still counts as a claim.
 */
const COUNTED = new Set(["all", "every", "only"]);
const COUNT_AFTER = /^\s+(?:(?:of|the|these|those|its|their|one)\s+){0,3}\d/i;

/** Brand and product words in camelCase that are not code identifiers. */
const CAMEL_WORDS = new Set(["iOS", "macOS", "iPadOS", "iPhone", "iPad", "eBay", "jQuery", "npm"]);

/**
 * "only" claims that nothing else does it when it starts a sentence or clause ("Only the router calls it"), follows
 * one of these words ("the only caller") or comes before "by" or "from" ("called only by tests"). After a verb it
 * narrows what one thing does ("compares only the host part"), which is a precise claim, not one about every case.
 */
const OWNER_BEFORE_ONLY = new Set(["the", "its", "their", "your", "our"]);

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

interface MarkdownMark {
  name: string;
  pattern: RegExp;
}

/**
 * Inline markup: the viewer renders it in summaries, and a title or label would show it as-is. Each needs the shape
 * of real markup, so code does not match: `**kwargs` and `2**8` have no closing pair, `__init__` has no space
 * inside.
 */
const EMPHASIS_MARKS: readonly MarkdownMark[] = [
  { name: "**bold**", pattern: /(?<![\w*])\*\*(?=\S)[^*\n]*?\S\*\*(?![\w*])/ },
  { name: "__bold__", pattern: /(?<!\w)__(?=\S)[^_\n]*\s[^_\n]*?\S__(?!\w)/ },
];

/**
 * Markup a summary should not hold either: a heading line (a summary is one or two sentences, and inline rendering
 * shows the `#`) and a link (a summary sits next to the code; it points at code with backticks). `xs[0](y)` has no
 * URL or path, so it is not a link.
 */
const BLOCK_MARKS: readonly MarkdownMark[] = [
  { name: "# heading", pattern: /^ {0,3}#{1,6}[ \t]+\S/m },
  {
    name: "[text](link)",
    pattern:
      /\[[^\]\n]*[A-Za-z][^\]\n]*\]\((?:https?:\/\/|mailto:|\.{0,2}\/|#|[\w.-]+\.[A-Za-z]{2,}(?:[/#?][^)\s]*)?\))[^)\s]*\)/,
  },
];

/** Markdown that a title or label would show as-is (titles and labels are plain text). */
const MARKDOWN_MARKS: readonly MarkdownMark[] = [...EMPHASIS_MARKS, ...BLOCK_MARKS];

/** The marks of `marks` found in `value` (code spans left out), in text order. */
function findMarks(value: string, marks: readonly MarkdownMark[]): { name: string; at: number }[] {
  const text = withoutCode(mask(value).text);
  return marks
    .map(({ name, pattern }) => ({ name, match: pattern.exec(text) }))
    .filter((f): f is { name: string; match: RegExpExecArray } => f.match !== null)
    .sort((a, b) => a.match.index - b.match.index)
    .map(({ name, match }) => ({ name, at: Math.max(0, value.indexOf(match[0].trim())) }));
}

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

/** `TODO` as a word (not `TODOs` in a name such as `TODO_LIST`, not inside code spans: those are masked first). */
const TODO_WORD = /(?<![\p{L}\p{N}_])TODO(?![\p{L}\p{N}_])/gu;

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

/** A row of a markdown table (a line that starts and ends with `|`; code spans are masked, so their `|` is not). */
const TABLE_ROW = /^\|.*\|$/;
/** The rule under a table's header row: `| --- | :-: |`. */
const TABLE_RULE = /^\|[\s:|-]+\|$/;

/**
 * The sentences of a masked text: paragraphs and list items are split apart, then each at `.`, `!` or `?`
 * followed by white space (not after `e.g.`, `i.e.`, `etc.`, ...). Heading lines are left out (titles are checked
 * on their own). Each cell of a table row is read on its own, so a row is never one long sentence; the rule
 * under the header row is left out.
 */
function sentences(masked: string): string[] {
  const out: string[] = [];
  for (const block of paragraphs(masked)) {
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

/**
 * The paragraphs of a masked text, each on one line: blocks between blank lines, each list item and each table
 * cell on its own; headings and the rule under a table's header row left out.
 */
function paragraphs(masked: string): string[] {
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
    if (TABLE_ROW.test(line)) {
      flush();
      if (!TABLE_RULE.test(line)) {
        for (const cell of line.slice(1, -1).split("|")) if (cell.trim()) blocks.push(cell.trim());
      }
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
  return blocks;
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

/** Fillers only at the start of a clause: "Note that ..." is filler, "a note that lists them" is not. */
const CLAUSE_START_FILLERS = new Set(["note that", "keep in mind"]);

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

/** What comes right before `index` in a masked text: the start of a clause, a word, or a code span. */
type Before = { kind: "start" } | { kind: "code" } | { kind: "word"; word: string };

function tokenBefore(text: string, index: number): Before {
  const head = text.slice(0, index).trimEnd();
  if (head === "" || /[.;:!?,(\[{"“—–-]$/.test(head)) return { kind: "start" };
  if (head.endsWith(CLOSE) || head.endsWith("`")) return { kind: "code" };
  const word = /([\p{L}\p{N}_'’.]+)$/u.exec(head)?.[1];
  return word === undefined ? { kind: "start" } : { kind: "word", word: word.toLowerCase() };
}

/** The word right after `index` (lowercase), or undefined (code, punctuation, the end). */
function wordAfter(text: string, index: number): string | undefined {
  return /^\s+([\p{L}\p{N}'’]+)/u.exec(text.slice(index))?.[1]?.toLowerCase();
}

/**
 * Words that open a clause: "only" after one of them claims that nothing else does it ("now only `URL` ..."). Not
 * "that" or "which": "a helper that only reads the header" narrows what one thing does.
 */
const CLAUSE_WORDS = new Set(
  "and but or so now then here there where because while since today yet".split(" "),
);

/**
 * Is this "only" a claim about every case? Yes at the start of a clause ("Only the router calls it", "now only
 * `URL` checks it"), after "the"/"its"/... ("the only caller") and before "by"/"from" ("called only by tests"). No
 * after a verb or a noun ("compares only the host part", "the host part only") or after "otherwise" (the other
 * branch of a condition): there it narrows the claim, which is what the rule asks for.
 */
function claimsOnly(text: string, from: number, to: number): boolean {
  const next = wordAfter(text, to);
  if (next === "by" || next === "from") return true;
  const before = tokenBefore(text, from);
  if (before.kind === "start") return true;
  if (before.kind === "code") return false;
  return OWNER_BEFORE_ONLY.has(before.word) || CLAUSE_WORDS.has(before.word);
}

/** Words before "all" that make it part of the claim ("of all", "now all", "calls all"), not a closing "all". */
const NOT_LIST_END = new Set(
  (
    "of for to in on at by with from into about after before above below over under through across between " +
    "is are was were be been being not now then and or but so that which who if when once while than as " +
    "has have had do does did can will would should must may might almost nearly also still since"
  ).split(" "),
);
/** Words after "all" that make it a quantifier of what follows ("all the routes", "all three", "all of them"). */
const QUANTIFIED_AFTER_ALL = new Set(
  "the of these those its their his her our your my two three four five six seven eight nine ten other".split(
    " ",
  ),
);

/**
 * Does this "all" close a list that names the cases ("URL, `TrustedHostMiddleware` and `Host.matches` all call
 * `parse_host_header`")? Then the sentence names every site, which is what the rule asks for. Needs an "and"
 * earlier in the clause, code or a name right before "all" (a code span, a dotted name, an identifier with `_`, or
 * a word with a capital inside or a capital that does not start the sentence), and a verb-like word after it (not
 * "the", a number or a plural noun). "each route and each endpoint all have ..." still counts: categories are not
 * named cases.
 */
function closesNamedList(text: string, from: number, to: number): boolean {
  const before = tokenBefore(text, from);
  if (before.kind === "start") return false;
  if (before.kind === "word") {
    if (NOT_LIST_END.has(before.word)) return false;
    const raw = /([\p{L}\p{N}_'’.]+)$/u.exec(text.slice(0, from).trimEnd())?.[1] ?? "";
    if (!/[._]|\p{Ll}\p{Lu}/u.test(raw) && !/^\p{Lu}/u.test(raw)) return false;
  }
  const next = wordAfter(text, to);
  if (next === undefined || QUANTIFIED_AFTER_ALL.has(next) || /^\d/.test(next)) return false;
  if (/[a-z]{3,}s$/.test(next) && !/(?:ss|us|is)$/.test(next)) return false; // "all routes"
  // the clause so far: a dot inside a name (`Host.matches`) does not end it
  const clause =
    text
      .slice(0, from)
      .split(/[.;:!?](?=\s|$)/)
      .at(-1) ?? "";
  return /(?<![\p{L}\p{N}_])and\s+\S/u.test(clause);
}

/** "outside everything", "around everything": a position (the outermost layer), not a claim about every case. */
const POSITION_BEFORE_EVERYTHING = new Set(["outside", "around"]);

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

/** A lowercase word in -s that may be a verb ("calls", "says"); not one in -ss, -us, -is, -os or -as (class, status). */
function inS(word: string): boolean {
  return /^[a-z]{3,}$/.test(word) && word.endsWith("s") && !/(?:ss|us|is|os|as)$/.test(word);
}

/**
 * Is `word` (as written, after "It" or "This") a verb? Auxiliaries, lowercase -s forms (calls, stores, means; not
 * class, status, bus) and, after "It" only, -ed forms ("It returned"; "This cached value" is an adjective).
 */
function looksLikeVerb(word: string, subject: string): boolean {
  if (VERBS.has(word.toLowerCase())) return true;
  if (word !== word.toLowerCase()) return false; // "This Request ...": a name
  if (NOUNS_IN_S.has(word)) return false; // "This series of calls ..."
  if (inS(word)) return true;
  return subject === "It" && /^[a-z]{3,}ed$/.test(word);
}

/** Nouns that end in -s like a verb: "This series", "This lens". */
const NOUNS_IN_S = new Set("series species news lens means".split(" "));

/** Plural auxiliaries and modals: "These are", "Those can". */
const PLURAL_VERBS = new Set(
  "are were have had do did can could will would should must may might aren't weren't don't can't won't".split(
    " ",
  ),
);

/**
 * The bare subject a sentence starts with, or undefined: "It" or "This" and a verb ("It calls", "This is",
 * "It's"), "They" and a word ("They check"), "These" or "Those" and an auxiliary ("These are"), or an empty
 * "There is" / "There are" (returned as that phrase). "These files hold ..." names its subject.
 */
function bareSubject(masked: string): string | undefined {
  const text = withoutCode(masked).replace(/^[\s"'(*_]+/, "");
  const there = /^There(?:['’]s|\s+(is|are|was|were|isn't|aren't))(?![\w'])/.exec(text);
  if (there) return `There ${there[1] ?? "is"}`;
  if (/^They(?:['’](?:re|ve|ll|d))?\s+[a-z]/.test(text)) return "They";
  const these = /^(These|Those)\s+([A-Za-z']+)/.exec(text);
  if (these && PLURAL_VERBS.has(these[2]!.toLowerCase())) return these[1];
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
 * Forms of "be" (and "get": "gets written") that make a passive with a past participle ("is written", "were not
 * shown"). "being" may follow one ("is being retried").
 */
const BE = "am|is|are|was|were|be|been|being|isn't|aren't|wasn't|weren't|get|gets|got|gotten";
/**
 * Up to two adverbs may stand between "be" and its participle ("is not shown", "is not yet written", "is quickly
 * loaded"): these, or any word in -ly.
 */
const PASSIVE_ADVERBS =
  "not|never|also|only|then|still|always|first|already|usually|often|now|later|again|automatically|both|each|all|yet|even|just";
const PASSIVE = new RegExp(
  String.raw`(?<![\p{L}\p{N}_'-])(?:${BE})\s+(?:being\s+)?(?:(?:${PASSIVE_ADVERBS}|[a-z]+ly)\s+){0,2}(?:(?:re|pre|co)-)?([a-z]+)(?![\p{L}\p{N}_'-])`,
  "giu",
);
/** Irregular past participles; regular ones end in -ed. */
const IRREGULAR_PARTICIPLES = new Set(
  (
    "built made kept shown drawn written given taken found held run seen sent read left put known thrown " +
    "chosen broken hidden bound brought caught fed told thought understood meant paid said sold shut split " +
    "spent stuck taught lost led laid hit cut dealt grown begun overridden overwritten rewritten redrawn " +
    "rebuilt rerun withheld forgotten forbidden driven ridden spoken stolen frozen woken torn worn sworn " +
    "shaken mistaken undertaken arisen fallen sought lent lit shed set reset preset done undone redone cast " +
    "spread spun upheld struck wound hung shut sped won"
  ).split(" "),
);
/** Words in -ed that are adjectives after "be" ("based on", "tired"), or not participles at all ("need"). */
const NOT_PARTICIPLES = new Set(
  (
    "based supposed interested tired concerned pleased detailed advanced experienced complicated " +
    "sophisticated dedicated varied need speed seed feed bleed breed embed hundred kindred naked wicked " +
    "sacred rugged shred unchanged indeed undefined unused unrelated unsupported unexpected untested " +
    "unnamed unsigned unchecked unhandled unresolved unaffected unmodified uncommitted untracked unsaved " +
    "outdated nested deprecated malformed"
  ).split(" "),
);

/** The passive clauses of a sentence (code spans left out): `be` + a past participle, as written. */
function passives(masked: string): string[] {
  const text = withoutCode(masked);
  const out: string[] = [];
  PASSIVE.lastIndex = 0;
  for (let m = PASSIVE.exec(text); m; m = PASSIVE.exec(text)) {
    const word = m[1]!;
    if (word !== word.toLowerCase() || NOT_PARTICIPLES.has(word)) continue;
    if (word === "started" && /^g/i.test(m[0])) continue; // "to get started"
    // "keeps the window from being resized": the subject is named, "being" is a gerund
    if (
      /^being\b/i.test(m[0]) &&
      /\b(?:from|without|of|for|after|before)\s+$/i.test(text.slice(0, m.index))
    )
      continue;
    if (IRREGULAR_PARTICIPLES.has(word) || /^[a-z]{2,}ed$/.test(word))
      out.push(m[0].replace(/\s+/g, " "));
  }
  return out;
}

/**
 * Nouns made of an action ("assembly", "setup") that a writer puts where the code should be: "Symbol assembly
 * assigns ids", not "`assembleSymbols` assigns ids". Besides these, words in -tion, -sion, -ment, -ance, -ence and
 * -ing count, except the concrete nouns of code in `CONCRETE_NOUNS`.
 */
const ACTION_NOUNS = new Set(
  (
    "assembly setup lookup dispatch discovery derivation removal retrieval renewal approval arrival " +
    "dismissal disposal reversal withdrawal refusal analysis synthesis"
  ).split(" "),
);
const ACTION_ENDING = /(?:tion|sion|ment|ance|ence|ing)$/;
/** Nouns of code with an action ending: "Each function returns", "The option sets". */
const CONCRETE_NOUNS = new Set(
  (
    "function option section session version extension collection connection transaction permission " +
    "partition position exception condition action application definition declaration expression " +
    "notification subscription instruction annotation mutation migration question selection region " +
    "station mention element argument document environment segment statement comment fragment moment " +
    "payment component department instance sentence reference sequence preference difference presence " +
    "distance balance interface evidence audience licence license fence " +
    "string thing ring ping king wing sibling ceiling padding heading building binding mapping setting " +
    "listing spring morning evening nothing something everything anything during ending meaning"
  ).split(" "),
);
/**
 * Whole names of mechanisms: "Rate limiting applies per user" names the thing, not an action that hides the code.
 * Only the two words together pass: "Job scheduling picks" or "Config loading reads" still hide the function.
 */
const MECHANISM_NAMES = new Set([
  "rate limiting",
  "load balancing",
  "dependency injection",
  "lazy loading",
  "error handling",
  "garbage collection",
  "connection pooling",
  "content negotiation",
  "server rendering",
  "code splitting",
  "tree shaking",
  "hot reloading",
  "change detection",
]);
/** First words that do not make a subject of the next: articles, owners, prepositions. */
const NOT_SUBJECT_START = new Set(
  (
    "the a an each every this that these those its their your our his her one no any some all both code " +
    "during while when if after before on in at for with from to by as once until unless since where " +
    "here there then now so but and or also"
  ).split(" "),
);
/** A finite verb in -s after a subject: "assigns", "uses"; not "status" or "class". */
function verbInS(word: string): boolean {
  return inS(word) && !NOUNS_IN_S.has(word);
}
function actionNoun(word: string): boolean {
  const w = word.toLowerCase();
  return ACTION_NOUNS.has(w) || (ACTION_ENDING.test(w) && w.length > 5 && !CONCRETE_NOUNS.has(w));
}

/**
 * The made-up subject a sentence starts with, or undefined: a word and a noun of an action ("Graph derivation
 * combines ..."), or one of `ACTION_NOUNS` alone ("Discovery uses git ..."), then a verb in -s. A sentence that
 * starts with a verb (a box summary: "Adds a job"), an article, an owner or code names its subject. One word in
 * -ing or -tion alone is often a thing ("Configuration holds", "Accepting boundaries produce"), so it passes.
 */
function abstractSubject(masked: string): string | undefined {
  const text = masked.replace(/^[\s"'(*_]+/, "");
  const two = /^([A-Z][a-z]+)\s+([a-z]+)\s+([a-z]+)(?![\p{L}\p{N}_'-])/u.exec(text);
  const one = /^([A-Z][a-z]+)\s+([a-z]+)(?![\p{L}\p{N}_'-])/u.exec(text);
  const first = (two ?? one)?.[1];
  if (first === undefined || NOT_SUBJECT_START.has(first.toLowerCase())) return undefined;
  if (verbInS(first.toLowerCase()) || /(?:ly|es)$/.test(first)) return undefined; // "Adds", "Finally"
  if (
    two &&
    actionNoun(two[2]!) &&
    verbInS(two[3]!) &&
    !MECHANISM_NAMES.has(`${two[1]} ${two[2]}`.toLowerCase())
  )
    return `${two[1]} ${two[2]}`;
  if (one && ACTION_NOUNS.has(one[1]!.toLowerCase()) && verbInS(one[2]!)) return one[1];
  return undefined;
}

/**
 * The main clause a sentence starts with: up to the first comma, semicolon, colon or dash, or the first word that
 * opens a clause of its own ("when the flag is set", "whose error is created"). A passive there hides who acts;
 * one in a condition after it often names a state.
 */
function mainClause(masked: string): string {
  const cut =
    /[,;:—–]|\s-{1,2}\s|(?<![\p{L}\p{N}_'-])(?:when|whenever|if|unless|after|before|once|until|while|whether|since|because|so|that|which|who|whose|where)(?![\p{L}\p{N}_'-])/iu.exec(
      masked,
    );
  return cut ? masked.slice(0, cut.index) : masked;
}

/** Dashes that join clauses: an em dash, or a spaced en dash or double hyphen. */
const DASH = /—|\s[–-]{1,2}\s/g;

/** "we", "our", "us", "let's" and their forms: the explainer speaking as a team the reader is not part of. */
const WE_WORDS =
  /(?<![\p{L}\p{N}_'’-])(?:we|we're|we've|we'll|we'd|our|ours|ourselves|us|let's|let’s)(?![\p{L}\p{N}_'’-])/giu;

/** Words before a quote that report what the code says: the quote is the code's words. */
const REPORTED =
  /(?:prints|logs|says|shows|returns|reads|writes|throws|raises|error|message|label|title|text|named|called|as)\s*$/i;

const QUOTE = /"[^"\n]*"|“[^”\n]*”/g;
/** A one-word quote followed by these is a value or a name, not a scare quote (`"us" or "eu"`, `"robust" when`). */
const VALUE_AFTER_QUOTE =
  /^\s*(?:$|[.,;:!?)\]]|(?:or|and|as|when|if|for|in|to|is|are|was)(?![\p{L}\p{N}_'-]))/iu;

/**
 * Quoted text (a comment, an error message, a value) is the code's words, not the explainer's: a quote of two words
 * or more, one after a word that reports it (`prints "done"`), one in a list of quotes (`"a", "b"`), or one before
 * punctuation, the end, or a word such as "or", "and", "when" (`the mode "robust" when ...`). A one-word quote before
 * the word it modifies is a scare quote, the writer's own word (`The pool "manages" its connections`), and stays
 * checked.
 */
function withoutQuotes(text: string): string {
  return text.replace(QUOTE, (q, at: number) => {
    const after = text.slice(at + q.length);
    const value =
      /\s/.test(q.slice(1, -1).trim()) ||
      REPORTED.test(text.slice(0, at)) ||
      VALUE_AFTER_QUOTE.test(after) ||
      /["”],\s*$/.test(text.slice(0, at)) ||
      /^,\s*["“]/.test(after);
    return value ? " ".repeat(q.length) : q;
  });
}

/** Every quote masked, whatever its length: for checks that never read quoted words (we-voice, absolute words). */
function withoutAnyQuotes(text: string): string {
  return text.replace(QUOTE, (q) => " ".repeat(q.length));
}

/**
 * Tool words that are also everyday words of code (a list node, an edge server, a regex anchor): checked in tours
 * only, where the reader follows the guide. Element summaries and details describe code, which may have nodes and
 * edges of its own.
 */
const TOUR_ONLY_TOOL_WORDS = new Set([
  "node",
  "nodes",
  "edge",
  "edges",
  "anchor",
  "anchors",
  "anchored",
]);
/**
 * Outside tours, a text describes code, and these are everyday words of code too (an SQL upsert, an LLM client, npm
 * provenance, a call site): checked in tours only.
 */
const CODE_TOOL_WORDS = new Set([
  "upsert",
  "upserts",
  "llm",
  "provenance",
  "call-site",
  "call-sites",
]);
/**
 * Outside tours, the other tool words count only where they mean xpl's parts: a stub box, a ghost arrow, an
 * authored overlay, anchor evidence. A gRPC stub, an error overlay or the evidence of a court case pass.
 */
const XPL_SENSE: Readonly<Record<string, { before?: RegExp; after?: RegExp }>> = {
  stub: { after: /^[\s-]*(?:box|boxes|arrows?|policy|policies|maps?|mode)\b/i },
  ghost: { after: /^[\s-]*(?:box|boxes|arrows?|policy|policies|maps?)\b/i },
  overlay: { before: /\b(?:authored|edge|arrow|stored)[\s-]+$/i },
  evidence: { before: /\b(?:source|anchor|code-link|answer)[\s-]+$/i },
};
const xplSense = (word: string) => XPL_SENSE[word.replace(/s$/, "")];
/**
 * Words of a diagram: a sentence with one of them talks about the guide's map. The nouns with a determiner only:
 * "maps its methods" is a verb, and code draws boxes of its own ("draws a box around the error").
 */
const MAP_WORDS = /\b(?:(?:this|the|a|each|its) (?:map|diagram)|boxes|arrows?)\b/i;
/** The sentence of `text` that holds `index`. */
function plainSentenceAt(text: string, index: number): string {
  const start = Math.max(text.lastIndexOf(". ", index), text.lastIndexOf("\n", index)) + 1;
  const stop = text.slice(index).search(/\.(?:\s|$)|\n/);
  return text.slice(start, stop < 0 ? text.length : index + stop);
}
/** A test double is a stub too: "stub" passes in a text about tests. */
const TEST_CONTEXT = /\b(?:tests?|testing|mocks?|fakes?|fixtures?|spy|spies)\b/i;

const TOOL_PATTERNS = Object.keys(TOOL_WORDS).map((word) => ({
  word,
  pattern: new RegExp(wordPattern(word).source, "gu"),
}));
/** Words around "edge" that make it plain English: an edge case, the leading edge. */
const EDGE_AFTER = /^[\s-]*cases?(?![\p{L}])/u;
const EDGE_BEFORE = new Set(["leading", "trailing", "cutting", "rising", "falling", "sharp"]);

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

/** A word without its plural or possessive ending: "servers" -> "server", "classes" -> "class", "ky's" -> "ky". */
function stem(word: string): string {
  const w = word.toLowerCase().replace(/['’]s$/, "");
  if (w.length > 4 && w.endsWith("ies")) return `${w.slice(0, -3)}y`;
  if (w.length > 4 && /(?:ss|x|ch|sh)es$/.test(w)) return w.slice(0, -2);
  if (w.length > 3 && /[^su]s$/.test(w)) return w.slice(0, -1);
  return w;
}

/** The stems of the words of `text` (letters, digits and `_`; `nodes.findEdge` is two words). */
function stems(text: string): string[] {
  return (text.match(/[\p{L}\p{N}_]+(?:['’]s)?/gu) ?? []).map(stem);
}

/**
 * Does `text` name `name`? Its words, in order, with the same stems, case-insensitive: "web server" names "Web
 * servers", "findEdge" names "findEdge" and "the parsers" names "Parser". Backticks do not matter.
 */
function names(text: string, name: string): boolean {
  // a short code name (`` `Pop` ``, see `namesOf`) names the part only as code, in backticks
  if (name.startsWith("`")) return text.includes(name);
  const want = stems(name);
  if (want.length === 0) return false;
  const have = stems(text);
  for (let i = 0; i + want.length <= have.length; i++) {
    if (want.every((w, j) => have[i + j] === w)) return true;
  }
  return false;
}

/**
 * The evidence next to a text, for `absolute-word`. `anchored`: the text belongs to an element with anchors (the
 * code that proves the claim is one click away). `names`: the names of the anchored parts a tour step focuses; a
 * claim in a sentence that names one of them points at its evidence.
 */
interface Evidence {
  anchored?: boolean;
  names?: readonly string[];
  /**
   * The text is a tour's, in an explainer of a change: a claim about what the change changes ("only download
   * progress changes") has the diff as its evidence, which the explainer holds and `change-not-shown` puts on the
   * tour, file by file.
   */
  change?: boolean;
}

/** "a job that", "an input that fails": the absolute word describes an example input, not the code. */
const HYPOTHETICAL_BEFORE =
  /(?<![\p{L}])(?:a|an|any)\s+(?:job|input|request|message|task|item|value|event|record|entry|user|payload|row|key|file)s?\s+(?:that|which|who)\s+(?:[\p{L}-]+\s+)?$/iu;

/** Words that make a sentence about what a change changes. */
const CHANGE_WORDS = /\b(?:chang(?:e|es|ed|ing)|unchanged|differ(?:s|ent|ently)?)\b/i;

/** The sentence around `index` in a masked text, its code back in. */
function sentenceAt(text: string, spans: readonly string[], index: number): string {
  const starts = [...text.slice(0, index).matchAll(/[.!?]\s|\n\s*\n/g)];
  const start = starts.length > 0 ? starts.at(-1)!.index! + 1 : 0;
  const end = /[.!?](?:\s|$)|\n\s*\n/.exec(text.slice(index));
  return unmask(text.slice(start, end ? index + end.index : undefined), spans);
}

/** Is the sentence around `index` (in a masked text) its own evidence: it names one of `names`, or a change. */
function provedBy(
  text: string,
  spans: readonly string[],
  index: number,
  evidence: Evidence,
): boolean {
  const list = evidence.names ?? [];
  if (list.length === 0 && !evidence.change) return false;
  const sentence = sentenceAt(text, spans, index);
  if (evidence.change && CHANGE_WORDS.test(sentence)) return true;
  return list.some((name) => names(sentence, name));
}

// ─── The checks ─────────────────────────────────────────────────────────────────────────────────

interface ProseOptions {
  evidence?: Evidence;
  /**
   * How many more sentences the field may hold (a tour summary has a cap): when there is no room, a long sentence
   * is to be shortened, not split, so that one fix does not trip `tour-summary`.
   */
  sentenceRoom?: number;
  /**
   * The text is the summary of an element or a step, which sits next to its label: "It" may start sentence 2 when
   * sentence 1 names the thing, and one passive in sentence 1 is a finding.
   */
  summary?: boolean;
}

interface Where {
  elementId: string;
  kind: LintElementKind;
  view?: string;
  field: string;
}

class Linter {
  readonly findings: LintFinding[] = [];
  checked = 0;

  /**
   * @param ownWords stems of the words in the labels and ids of the explainer's boxes and concepts and of what its
   *   views show: a tool word among them is the code's own word (`tool-word`).
   */
  constructor(
    private readonly ownWords: ReadonlySet<string> = new Set(),
    /** The labels of the guide's boxes and concepts, lower case: `abstract-subject` lets a text start with one. */
    private readonly labels: readonly string[] = [],
  ) {}

  /** Does `phrase` ("Rate limiting") start like a label of the guide ("Rate limiter", "rate limiting")? */
  private namesLabel(phrase: string): boolean {
    const want = phrase.toLowerCase().split(/\s+/);
    const close = (a: string, b: string) => a.slice(0, 5) === b.slice(0, 5);
    return this.labels.some((label) => {
      const have = label.split(/\s+/);
      return want.every((w, i) => have[i] !== undefined && close(w, have[i]!));
    });
  }

  add(where: Where, rule: LintRule, quote: string, message: string, hint: string): void {
    this.findings.push({ rule, ...where, quote, message, hint });
  }

  /**
   * Filler and absolute words of a masked text: one finding per rule and field. The code spans stay as
   * placeholders, which no word pattern matches, so code is left out and the word before a match can be code.
   */
  words(where: Where, masked: Masked, evidence: Evidence = {}): void {
    const text = masked.text;
    // the index into the masked text, moved to the same place in the text with its code back in
    const quoteAt = (index: number) =>
      excerpt(
        unmask(text, masked.spans).replace(/\n/g, " "),
        unmask(text.slice(0, index), masked.spans).length,
      );
    const fillers: { phrase: string; index: number }[] = [];
    const taken: [number, number][] = [];
    // quoted text (an error message, a log line) is the code's words: same length, so indexes stay valid
    const unquoted = withoutQuotes(text);
    for (const { phrase, pattern } of FILLER_PATTERNS) {
      pattern.lastIndex = 0;
      for (let m = pattern.exec(unquoted); m; m = pattern.exec(unquoted)) {
        const from = m.index;
        const to = m.index + m[0].length;
        if (taken.some(([a, b]) => from < b && to > a)) continue;
        if (CLAUSE_START_FILLERS.has(phrase) && tokenBefore(text, from).kind !== "start") continue;
        const key = phrase.toLowerCase();
        if (FILLER_UNLESS_BEFORE[key]?.test(text.slice(to))) continue;
        const onlyBefore = FILLER_ONLY_BEFORE[key];
        if (onlyBefore && !onlyBefore.test(text.slice(to))) continue;
        taken.push([from, to]);
        fillers.push({ phrase, index: from });
      }
    }
    this.weVoice(where, text, quoteAt);
    this.toolWords(where, text, quoteAt);
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
    // a quoted word is the code's (a test name, a value), not a claim of the guide
    const plainWords = withoutAnyQuotes(withoutIdioms(text));
    for (const { word, pattern } of ABSOLUTE_PATTERNS) {
      pattern.lastIndex = 0;
      for (let m = pattern.exec(plainWords); m; m = pattern.exec(plainWords)) {
        const end = m.index + m[0].length;
        if (COUNTED.has(word) && COUNT_AFTER.test(text.slice(end))) continue;
        if (word === "only") {
          const next = /^\s+([A-Za-z]+)/.exec(text.slice(end))?.[1];
          if (next !== undefined && CONDITION_AFTER_ONLY.has(next.toLowerCase())) continue;
          if (!claimsOnly(text, m.index, end)) continue;
        }
        if (word === "all" && closesNamedList(text, m.index, end)) continue;
        if (word === "everything") {
          const before = tokenBefore(text, m.index);
          if (before.kind === "word" && POSITION_BEFORE_EVERYTHING.has(before.word)) continue;
        }
        const before = /([A-Za-z]+)\s+$/.exec(text.slice(0, m.index))?.[1];
        if (before !== undefined && NOT_ABSOLUTE_AFTER.has(before.toLowerCase())) continue;
        // an input made up to show a case ("a job that fails every attempt")
        if (HYPOTHETICAL_BEFORE.test(text.slice(0, m.index))) continue;
        if (evidence.anchored || provedBy(text, masked.spans, m.index, evidence)) continue;
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
        `${unique.map((w) => `"${w}"`).join(", ")}: an absolute claim that needs evidence` +
          (unique.includes("only")
            ? ' ("only" that opens a clause, follows "the" or comes before "by" says nothing else does it)'
            : ""),
        where.kind === "tour-step"
          ? "check every case in the code, then name the part the step focuses in the same sentence, by its box label in plain words (its anchors are the evidence; a code name counts toward code-heavy); or narrow the claim (name the places, add the condition)"
          : "check every case in the code and anchor it (an element with anchors may say it), or narrow the claim (name the places, add the condition)",
      );
    }
  }

  /** `we-voice`: "we", "our", "us" or "let's" outside code spans and quotes ("US" is a place). */
  private weVoice(where: Where, text: string, quoteAt: (index: number) => string): void {
    // quoted text is never the guide's voice: "us" may be a region code, "we" a word the code prints
    const plain = withoutAnyQuotes(text);
    // "US" is a place; "us" after a number is microseconds ("1000 us")
    const found = [...plain.matchAll(WE_WORDS)].filter(
      (m) =>
        m[0] !== "US" && !(m[0].toLowerCase() === "us" && /\d\s*$/.test(plain.slice(0, m.index))),
    );
    if (found.length === 0) return;
    const unique = [...new Set(found.map((m) => m[0].toLowerCase().replace("’", "'")))];
    this.add(
      where,
      "we-voice",
      quoteAt(found[0]!.index!),
      `${unique.map((w) => `"${w}"`).join(", ")}: the guide speaks as a team the reader is not part of`,
      'name who does it ("the runner retries", "the authors chose ..."), or write to the reader as "you"',
    );
  }

  /**
   * `tool-word`: xpl's own words in reader text, unless the explainer's boxes or concepts name the code that way.
   * Tours speak about the guide, so every tool word counts there; other texts describe code, where only the senses
   * that belong to xpl count (`XPL_SENSE`). Quoted text is the code's.
   */
  private toolWords(where: Where, text: string, quoteAt: (index: number) => string): void {
    const found: { word: string; index: number }[] = [];
    const tour = where.kind === "tour" || where.kind === "tour-step";
    const plain = withoutQuotes(text);
    for (const { word, pattern } of TOOL_PATTERNS) {
      if (this.ownWords.has(stem(word))) continue;
      if (!tour && (TOUR_ONLY_TOOL_WORDS.has(word) || CODE_TOOL_WORDS.has(word))) continue;
      if (word.startsWith("stub") && TEST_CONTEXT.test(text)) continue;
      const sense = tour ? undefined : xplSense(word);
      pattern.lastIndex = 0;
      for (let m = pattern.exec(plain); m; m = pattern.exec(plain)) {
        if (
          sense &&
          !(sense.before?.test(plain.slice(0, m.index)) ?? false) &&
          !(sense.after?.test(plain.slice(m.index + m[0].length)) ?? false) &&
          // "the stubs show code outside this map": the sentence is about the map, so it means xpl's part
          !(sense.after && MAP_WORDS.test(plainSentenceAt(plain, m.index)))
        )
          continue;
        if (word.startsWith("edge")) {
          const before = tokenBefore(text, m.index);
          if (EDGE_AFTER.test(text.slice(m.index + m[0].length))) continue;
          if (before.kind === "word" && EDGE_BEFORE.has(before.word)) continue;
        }
        found.push({ word, index: m.index });
      }
    }
    if (found.length === 0) return;
    found.sort((a, b) => a.index - b.index);
    const unique = [...new Set(found.map((f) => f.word))];
    this.add(
      where,
      "tool-word",
      quoteAt(found[0]!.index),
      unique.length === 1
        ? `"${unique[0]}": a word of the tool, not of the code`
        : `${unique.map((w) => `"${w}"`).join(", ")}: words of the tool, not of the code`,
      unique.map((w) => `"${w}": ${TOOL_WORDS[w]}`).join("; "),
    );
  }

  /**
   * `TODO` (as a word, outside code spans) left in a text: `xpl draft` puts `TODO: <what to write>` in every text a
   * person must write. One error-level finding per field.
   */
  todos(where: Where, value: unknown): void {
    if (typeof value !== "string" || !value.includes("TODO")) return;
    const masked = mask(value);
    const found = [...masked.text.matchAll(TODO_WORD)];
    if (found.length === 0) return;
    const text = unmask(masked.text, masked.spans).replace(/\n/g, " ");
    const at = unmask(masked.text.slice(0, found[0]!.index), masked.spans).length;
    this.findings.push({
      rule: "todo-left",
      severity: "error",
      ...where,
      quote: excerpt(text, at),
      message: `${plural(found.length, "TODO placeholder")} left: text nobody has written yet`,
      hint: "write what the TODO asks for, check it against the code, and remove the TODO",
    });
  }

  /** A title: code-like, placeholder, filler and absolute words. */
  title(where: Where, title: unknown, evidence?: Evidence): void {
    if (typeof title !== "string" || title.trim() === "") return;
    this.checked++;
    // a draft's TODO names the code it asks about (todo-left reports it): judged once it is written
    const why = /\bTODO\b/.test(title) ? undefined : codeLikeTitle(title);
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
    const masked = mask(title);
    const count = words(masked.text).length;
    // a draft's TODO title is hint text (todo-left reports it), judged once it is written
    if (count > LINT_LIMITS.titleWords && !/\bTODO\b/.test(title)) {
      this.add(
        where,
        "long-title",
        excerpt(title),
        `${count} words (a title takes at most ${LINT_LIMITS.titleWords})`,
        "keep a title near 8 words that state one fact; put the rest in the text below",
      );
    }
    if (masked.text.search(TODO_WORD) < 0) this.words(where, masked, evidence);
  }

  /**
   * A title or a label, which the viewer shows as plain text: markdown marks in it (outside code spans) would show
   * as-is. `count`: count the field as checked (when no other check reads it).
   */
  plain(where: Where, value: unknown, count = false): void {
    if (typeof value !== "string" || value.trim() === "") return;
    if (count) {
      this.checked++;
    }
    const found = findMarks(value, MARKDOWN_MARKS);
    if (found.length === 0) return;
    this.add(
      where,
      "markdown-in-plain",
      excerpt(value, found[0]!.at),
      `markdown (${found.map((f) => f.name).join(", ")}) in a ${where.field}, which the viewer shows as plain text: the marks show as-is`,
      "write it as plain text (backticks around code are fine); markdown works in summaries, step notes and details",
    );
  }

  /**
   * `long-summary`: the summary of an element or a step over `elementSummarySentences` sentences or
   * `elementSummaryWords` words. A draft's TODO is judged once it is written.
   */
  summaryLength(where: Where, value: unknown): void {
    if (typeof value !== "string" || value.trim() === "" || /\bTODO\b/.test(value)) return;
    const masked = mask(value);
    const count = sentences(masked.text).length;
    const wordCount = words(masked.text).length;
    if (
      count <= LINT_LIMITS.elementSummarySentences &&
      wordCount <= LINT_LIMITS.elementSummaryWords
    ) {
      return;
    }
    this.add(
      where,
      "long-summary",
      excerpt(value),
      `${plural(count, "sentence")}, ${wordCount} words (a summary takes at most ${LINT_LIMITS.elementSummarySentences} sentences and ${LINT_LIMITS.elementSummaryWords} words)`,
      "say what the part is for in 1-2 sentences; move the cases into `detail`, a concept or a tour step. " +
        "Rewrite the summary whole when the code changes: do not append a sentence per change",
    );
  }

  /** `long-detail`: a paragraph (or list item) of a `detail` over `detailParagraphWords` words. */
  detailLength(where: Where, value: unknown): void {
    if (typeof value !== "string" || value.trim() === "" || /\bTODO\b/.test(value)) return;
    const masked = mask(value);
    const long = paragraphs(masked.text)
      .map((text) => ({ text, count: words(text).length }))
      .filter((p) => p.count > LINT_LIMITS.detailParagraphWords);
    if (long.length === 0) return;
    const longest = Math.max(...long.map((p) => p.count));
    this.add(
      where,
      "long-detail",
      excerpt(unmask(long[0]!.text, masked.spans)),
      long.length === 1
        ? `a paragraph of ${longest} words (more than ${LINT_LIMITS.detailParagraphWords})`
        : `${long.length} paragraphs of more than ${LINT_LIMITS.detailParagraphWords} words (the longest: ${longest})`,
      "give each paragraph one point (a blank line between them), or make a list",
    );
  }

  /**
   * The `summary` of an element or a step: inline markdown (code spans, bold, emphasis) is fine, a heading line or
   * a link is not.
   */
  summaryMarks(where: Where, value: unknown): void {
    if (typeof value !== "string" || value.trim() === "") return;
    const found = findMarks(value, BLOCK_MARKS);
    if (found.length === 0) return;
    const names = found.map((f) => f.name);
    this.add(
      where,
      "markdown-in-summary",
      excerpt(value, found[0]!.at),
      `${names.map((n) => (n === "# heading" ? "a heading line" : "a link")).join(" and ")} in a summary: ` +
        "the viewer shows a summary inline, next to the code, where a # shows as-is and a link leads away",
      "keep a summary to one or two plain sentences (code spans, bold and emphasis are fine); " +
        "put headings and links in the `detail`",
    );
  }

  /** Prose: sentence length, bare "It"/"This", filler and absolute words. */
  prose(where: Where, value: unknown, opts: ProseOptions = {}): Masked | undefined {
    if (typeof value !== "string" || value.trim() === "") return undefined;
    this.checked++;
    const masked = mask(value);
    // a draft's text (todo-left reports it) is judged once it is written
    if (masked.text.search(TODO_WORD) >= 0) return masked;
    const list = sentences(masked.text);
    const counts = list.map((s) => words(s).length);
    let dashed = false;
    list.forEach((sentence, i) => {
      if (counts[i]! > LINT_LIMITS.sentenceWords) {
        this.add(
          where,
          "long-sentence",
          excerpt(unmask(sentence, masked.spans)),
          `${counts[i]} words (more than ${LINT_LIMITS.sentenceWords})`,
          opts.sentenceRoom !== undefined && opts.sentenceRoom <= 0
            ? `shorten it (drop a detail, the steps can carry it) rather than split it: this field already has the most sentences tour-summary allows (${list.length})`
            : "split it: one fact per sentence, aim for 15-20 words",
        );
      }
      let subject = bareSubject(sentence);
      if (subject === "It" && i > 0 && opts.summary && bareSubject(list[0]!) === undefined) {
        subject = undefined; // the first sentence names the thing (or starts with a verb next to its label)
      }
      // a box or concept named so ("Rate limiting") is the subject the text should have
      const found = subject === undefined ? abstractSubject(sentence) : undefined;
      const action = found !== undefined && !this.namesLabel(found) ? found : undefined;
      if (action !== undefined) {
        this.add(
          where,
          "abstract-subject",
          excerpt(unmask(sentence, masked.spans)),
          `"${action}" names an action, not the code that does it`,
          'make the code the subject ("`assembleSymbols` assigns ids", not "Symbol assembly assigns ids")' +
            (opts.summary ? ', or start a box summary with the verb ("Assigns ids ...")' : ""),
        );
      }
      const dashes = withoutCode(sentence).match(DASH)?.length ?? 0;
      if (dashes >= 2 && !dashed) {
        dashed = true;
        this.add(
          where,
          "dash-chain",
          excerpt(unmask(sentence, masked.spans)),
          `${dashes} dashes in one sentence`,
          "split it into sentences, or use commas: one fact per sentence",
        );
      }
      if (subject !== undefined && subject.startsWith("There ")) {
        this.add(
          where,
          "bare-it",
          excerpt(unmask(sentence, masked.spans)),
          `starts with an empty "${subject}"`,
          'make the thing the subject: "Each worker has one queue", not "There is one queue per worker"',
        );
      } else if (subject !== undefined) {
        this.add(
          where,
          "bare-it",
          excerpt(unmask(sentence, masked.spans)),
          `starts with a bare "${subject}"`,
          `name the subject ("The router ...", "ServerErrorMiddleware ..."): a reader who jumps here does not know what "${subject}" is`,
        );
      }
    });
    const passive = list.flatMap((sentence) => passives(sentence));
    const firstPassive = opts.summary && list.length > 0 ? passives(mainClause(list[0]!)) : [];
    const passiveHint =
      'name who does it: "The CLI writes the accepted changes", not "Accepted changes are written"; ' +
      'for a state, use a plain verb ("is on", "runs only on Linux")';
    if (passive.length < LINT_LIMITS.passiveClauses && firstPassive.length > 0) {
      this.add(
        where,
        "passive-voice",
        excerpt(unmask(list[0]!, masked.spans)),
        `a passive clause ("${firstPassive[0]}") in the first sentence of a summary: who does it?`,
        passiveHint,
      );
    } else if (passive.length >= LINT_LIMITS.passiveClauses) {
      const shown = [...new Set(passive)].slice(0, 3);
      this.add(
        where,
        "passive-voice",
        excerpt(
          unmask(
            list.find((sentence) => passives(sentence).length > 0)!,
            masked.spans,
          ),
        ),
        `${passive.length} passive clauses (${shown.map((p) => `"${p}"`).join(", ")}${passive.length > 3 ? ", ..." : ""}): who does it?`,
        passiveHint,
      );
    }
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
    this.words(where, masked, opts.evidence);
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

// ─── Order checks ───────────────────────────────────────────────────────────────────────────────

/** What the order checks need to know about the explainer, by id. */
interface Lookup {
  nodes: Map<string, Record<string, unknown>>;
  views: Map<string, Record<string, unknown>>;
  /** Flow and sequence steps. */
  steps: Map<string, Record<string, unknown>>;
  edges: Map<string, Record<string, unknown>>;
  concepts: Map<string, Record<string, unknown>>;
}

function lookup(explainer: Explainer): Lookup {
  const byId = (items: unknown, into = new Map<string, Record<string, unknown>>()) => {
    for (const value of list(items)) {
      const item = record(value);
      const id = str(item.id);
      if (id !== undefined && !into.has(id)) into.set(id, item);
    }
    return into;
  };
  const steps = new Map<string, Record<string, unknown>>();
  for (const view of list(explainer.views)) byId(record(view).steps, steps);
  return {
    nodes: byId(explainer.nodes),
    views: byId(explainer.views),
    steps,
    edges: byId(explainer.edges),
    concepts: byId(explainer.concepts),
  };
}

/** The members of a group, as stored. */
function membersOf(id: string, at: Lookup): string[] {
  return list<unknown>(at.nodes.get(id)?.members).filter((m): m is string => typeof m === "string");
}

/**
 * Is `inner` the same as `outer` or inside it? A symbol is inside its file, its directories and its parent symbols;
 * a file inside its directories; anything inside the repo; a member (and what is inside it) inside its group.
 */
function within(inner: string, outer: string, at: Lookup, seen = new Set<string>()): boolean {
  if (inner === outer) return true;
  const o = parseId(outer);
  if (o.type === "repo") return true;
  if (o.type === "group") {
    if (seen.has(outer)) return false;
    seen.add(outer);
    return membersOf(outer, at).some((member) => within(inner, member, at, seen));
  }
  const i = parseId(inner);
  const innerPath =
    i.type === "symbol" ? i.file : i.type === "file" || i.type === "dir" ? i.path : "";
  if (innerPath === "") return false;
  if (o.type === "dir") return innerPath.startsWith(`${o.path}/`);
  if (o.type === "file") return i.type === "symbol" && i.file === o.path;
  if (o.type === "symbol") {
    return i.type === "symbol" && i.file === o.file && i.path.startsWith(`${o.path}.`);
  }
  return false;
}

/** The boxes a tour step shows: its focus, the ends of a focused step or edge, the related ids of a concept. */
function shownBy(focus: string, at: Lookup): string[] {
  const out = [focus];
  const step = at.steps.get(focus) ?? at.edges.get(focus);
  if (step) {
    for (const end of [step.from, step.to]) if (typeof end === "string") out.push(end);
  }
  const parsed = parseId(focus);
  if (parsed.type === "derived-edge") out.push(parsed.from, parsed.to);
  for (const related of list<unknown>(at.concepts.get(focus)?.related)) {
    if (typeof related === "string") out.push(related);
  }
  return out;
}

/** The names a note may use for a box: its label, and for code its symbol path or file name. */
function namesOf(id: string, at: Lookup): string[] {
  const names: string[] = [];
  const label = str(at.nodes.get(id)?.label);
  if (label !== undefined && label.trim() !== "") names.push(label.trim());
  const parsed = parseId(id);
  if (parsed.type === "symbol") {
    const last = parsed.path.split(".");
    names.push(parsed.path, last.slice(-2).join("."));
    // the method name alone ("findEdge" for nodes.findEdge), when it is long enough not to be a common word;
    // a short one ("Pop") only in backticks
    if (last.length > 1)
      names.push(last.at(-1)!.length >= 4 ? last.at(-1)! : `\`${last.at(-1)!}\``);
  } else if (parsed.type === "file" || parsed.type === "dir") {
    const base = parsed.path.slice(parsed.path.lastIndexOf("/") + 1);
    names.push(base);
    const bare = base.replace(/\.[^.]+$/, "");
    if (parsed.type === "file" && bare.length >= 4) names.push(bare);
  }
  return [...new Set(names)].filter((name) => name !== "");
}

/** The label a person sees for a box: its stored label, else the symbol path or file name from the id. */
function labelOf(id: string, at: Lookup): string {
  return namesOf(id, at)[0] ?? id;
}

/** Is this a test: an id in a test file (`isTestFile`), or a group whose members are all tests? */
function isTest(id: string, at: Lookup, seen = new Set<string>()): boolean {
  const parsed = parseId(id);
  if (parsed.type === "symbol") return isTestFile(parsed.file);
  if (parsed.type === "file") return isTestFile(parsed.path);
  if (parsed.type === "dir") return isTestFile(`${parsed.path}/x`);
  if (parsed.type === "group" && !seen.has(id)) {
    seen.add(id);
    const members = membersOf(id, at);
    return members.length > 0 && members.every((member) => isTest(member, at, seen));
  }
  return false;
}

/** Does concept `id` light up a box or lifeline of `view` (one of its `related` ids is in the picture)? */
function lightsUp(id: string, view: Record<string, unknown> | undefined, at: Lookup): boolean {
  if (view === undefined) return false;
  const shown = list<unknown>(view.type === "graph" ? view.include : view.participants).filter(
    (box): box is string => typeof box === "string",
  );
  return list<unknown>(at.concepts.get(id)?.related).some(
    (related) =>
      typeof related === "string" &&
      shown.some((box) => within(related, box, at) || within(box, related, at)),
  );
}

/** Words of a step title that mark what belongs at the end of a tour. */
const LATE_WORDS = /\b(?:edge|corner)[ -]cases?\b|\bgotchas?\b|\bopen questions?\b/i;

/** A graph view with at least one box that has a `role`: a system map, or the inside of one service. */
function isArchitectureView(view: Record<string, unknown> | undefined, at: Lookup): boolean {
  if (view === undefined || view.type !== "graph") return false;
  return list<unknown>(view.include).some(
    (id) => typeof id === "string" && typeof at.nodes.get(id)?.role === "string",
  );
}

/** Code values that name no code: `null`, `Infinity`, `-1` (see `isLiteral`). */
const LITERAL_WORDS = new Set([...CODE_LITERALS, "Infinity", "-Infinity", "NULL", "nullptr"]);

/**
 * Is a code span an example value rather than the name of a piece of code? Numbers (`503`, `-1`, `1.5`, `0x1f`,
 * `10_000`, `30s`, `5%`), `null`, `true`, `Infinity` and the like, quoted strings (`"utf-8"`, `'a'`), and URLs or
 * route paths (`/admin/*`, `users/{id}`, `lots/of/:fun`). The skill asks for concrete inputs (writing.md section
 * 4, explain-change.md section 4), so they do not count as code names.
 */
export function isLiteral(span: string): boolean {
  const text = span.replace(/^`+|`+$/g, "").trim();
  if (text === "" || LITERAL_WORDS.has(text)) return true;
  // a number, with a sign, a fraction, digit groups, an exponent, a base prefix or a short unit (10ms, 2x, 5%)
  if (/^[-+]?(?:0[xob][\da-f_]+|\d[\d_,]*(?:\.\d+)?(?:e[-+]?\d+)?)(?:[a-z]{1,3}|%)?$/i.test(text)) {
    return true;
  }
  if (/^(["'])[^"'\n]*\1$/.test(text)) return true; // a quoted string
  if (/^[a-z][a-z+.-]*:\/\//i.test(text)) return true; // a URL
  // a path or a route: one word that starts with `/`, or has a `{param}`, a `:param` or a `*` segment
  if (!/[\s(]/.test(text) && /^\/|\{[^}]*\}|(?:^|\/):\w+|(?:^|\/)\*+(?:$|\/)/.test(text))
    return true;
  return !/[\p{L}\p{N}]/u.test(text); // punctuation alone (`-`, `/`, `*`)
}

/** A sentence that says which files a map leaves off ("Two helper files, `is.ts` and `types.ts`, are left off"). */
const LEFT_OFF =
  /\b(?:left (?:off|out)|leaves? (?:off|out)|off (?:the|this) map|not on (?:the|this) map)\b/i;

/** A code span that names a file (`is.ts`, `src/types.ts`): one word with an extension. */
const FILE_NAME = /^`+[\w./-]+\.[A-Za-z]\w{0,5}`+$/;

/**
 * The code names of a masked text that `code-heavy` counts: its different code spans, without example values
 * (`isLiteral`) and without the file names in a sentence that lists what a map leaves off (the skill asks for
 * that list).
 */
function countedCodeNames(masked: Masked): string[] {
  const exempt = new Set<number>();
  for (const sentence of sentences(masked.text)) {
    if (!LEFT_OFF.test(withoutCode(sentence))) continue;
    for (const m of sentence.matchAll(new RegExp(`${OPEN}(\\d+)${CLOSE}`, "g"))) {
      const index = Number(m[1]);
      if (FILE_NAME.test(masked.spans[index]!.trim())) exempt.add(index);
    }
  }
  const names = masked.spans
    .filter((span, i) => !exempt.has(i) && !isLiteral(span))
    .map((span) => span.trim());
  return [...new Set(names)];
}

/**
 * `code-heavy`: a text that names more different pieces of code (code spans) than `limit`. A reader who does not
 * know the code learns the idea from plain words; the code is one click away. Example values do not count.
 */
function codeHeavy(
  lint: Linter,
  where: Where,
  text: string,
  masked: Masked,
  limit: number,
  what: string,
): void {
  // a draft's placeholder lists names as hints for the writer: judge the text once it is written
  if (/\bTODO\b/.test(text)) return;
  const names = countedCodeNames(masked);
  if (names.length <= limit) return;
  lint.add(
    where,
    "code-heavy",
    excerpt(text.trim()),
    `${names.length} code names (${names.slice(0, 4).join(", ")}${names.length > 4 ? ", ..." : ""}); ${what} takes at most ${limit}`,
    "say what happens in everyday words first (what the part is for, what it keeps or decides); name only the one piece of code the reader should open. " +
      "Example values (`503`, `-1`, `/admin/*`) do not count; a box you name for tour-covers-map counts when you name it by its label in plain words, without backticks",
  );
}

/** The title of a note: its `### heading` line, else its first line. */
function noteTitle(note: unknown): string {
  if (typeof note !== "string") return "";
  const line = note.split("\n").find((l) => l.trim() !== "") ?? "";
  return (HEADING.exec(line)?.[1] ?? line).trim();
}

/** The first sentence of a note's body (after its `###` title). */
function firstSentence(note: unknown): string {
  if (typeof note !== "string") return "";
  const body = note.replace(/^\s*###[^\n]*\n/, "").trim();
  return /^[^\n]*?[.!?](?:\s|$)|^[^\n]*/.exec(body)?.[0] ?? "";
}

/**
 * Words of a last step that points on: where next, what to read next, what the tour left out. "Next" alone counts in
 * the title only ("Read next"); in the first sentence it must point on ("read ... next"), not order ("the next job").
 */
const WHERE_NEXT =
  /\b(?:further|see also|other guides?|where to go|what to read|read on|read more|more to read|beyond (?:this|the) (?:tour|guide)|not on (?:this|the) tour|elsewhere|left out|not cover(?:s|ed)?|did not (?:open|show|cover)|from here|(?:read|open|see|look at|try)\b[^.]{0,40}\bnext)\b/i;
const NEXT_WORD = /\bnext\b/i;

/** `tour-first-step`, `tour-length`, `tour-ends` and `tour-covers-map` for one tour (see `LINT_RULES`). */
function orderChecks(
  lint: Linter,
  tourId: string,
  tour: Record<string, unknown>,
  at: Lookup,
  change: boolean,
): void {
  const where: Where = { elementId: tourId, kind: "tour", field: "steps" };
  const steps = list<unknown>(tour.steps).map(record);
  const focusOf = (step: Record<string, unknown>) =>
    list<unknown>(step.focus).filter((id): id is string => typeof id === "string");
  const viewOf = (step: Record<string, unknown>) => at.views.get(str(step.view) ?? "");

  const usesMap = steps.some((step) => viewOf(step)?.type === "graph");
  // the first step shows the big picture
  const first = steps[0];
  if (first !== undefined) {
    const reasons: string[] = [];
    const focus = focusOf(first);
    const main = focus.filter((id) => parseId(id).type !== "concept");
    if (main.length > 0 && main.every((id) => isTest(id, at))) reasons.push("it focuses a test");
    const late = LATE_WORDS.exec(noteTitle(first.note));
    if (late) reasons.push(`its title says "${late[0]}"`);
    const view = viewOf(first);
    if (view !== undefined && view.type !== "graph" && usesMap) {
      reasons.push(`it opens on the ${String(view.type)} ${str(view.id)}, not on the map`);
    }
    // a concept alone is fine when the picture lights up the boxes it relates to (the key idea, on the map)
    if (focus.length > 0 && main.length === 0 && !focus.some((id) => lightsUp(id, view, at))) {
      reasons.push("it focuses only a concept, and nothing in its picture lights up");
    }
    if (reasons.length > 0) {
      lint.add(
        where,
        "tour-first-step",
        excerpt(noteTitle(first.note) || focus.join(", ")),
        `the first step (${str(first.id) ?? "?"}) does not show the big picture: ${reasons.join("; ")}`,
        "start with the big picture: a step on the map that focuses the main box and says what the whole thing does; " +
          "tests, edge cases and open questions come last",
      );
    }
  }

  // the last step goes back to the map and says where next; a talk and a change end on their own point (the risk)
  const last = steps.at(-1);
  if (
    last !== undefined &&
    steps.length >= LINT_LIMITS.tourEndsSteps &&
    usesMap &&
    !change &&
    !isTalk(tour)
  ) {
    const view = viewOf(last);
    const onMap = view?.type === "graph";
    // its title or first sentence says so: "Where to go next", "Read next: ...", "What this tour left out"
    const start = `${noteTitle(last.note)} ${firstSentence(last.note)}`;
    if (!onMap || !(WHERE_NEXT.test(start) || NEXT_WORD.test(noteTitle(last.note)))) {
      lint.add(
        where,
        "tour-ends",
        excerpt(noteTitle(last.note) || (str(last.id) ?? "")),
        onMap
          ? `the last step (${str(last.id) ?? "?"}) is on the map, but its title and first sentence do not say where to go next`
          : `the last step (${str(last.id) ?? "?"}) is ${view ? `on the ${String(view.type)} ${str(view.id)}` : "on no diagram"}, not on the map`,
        'end on the map with where next: title the last step "Where to go next" (or start it with "Read next:"), and name the boxes the tour did not open or the next guide to read',
      );
    }
  }

  // a tour that follows a path answers one question: one map and one flow or sequence (SKILL.md's budget table). A
  // change, a talk and an architecture tour have budgets of their own.
  const views = [
    ...new Map(
      steps.flatMap((step) => {
        const view = viewOf(step);
        return view ? [[str(view.id) ?? "", view] as const] : [];
      }),
    ).values(),
  ];
  const paths = views.filter((view) => view.type === "sequence" || view.type === "flow");
  const graphs = views.filter((view) => view.type === "graph");
  if (
    paths.length > 0 &&
    !change &&
    !isTalk(tour) &&
    !graphs.some((view) => isArchitectureView(view, at)) &&
    (paths.length > LINT_LIMITS.tourPaths || graphs.length > LINT_LIMITS.tourMaps)
  ) {
    lint.add(
      where,
      "many-diagrams",
      excerpt(views.map((view) => str(view.id) ?? "?").join(", ")),
      `${plural(views.length, "diagram")} (${plural(graphs.length, "map")}, ${plural(paths.length, "flow or sequence", "flows or sequences")}): a tour that follows a path uses at most ${LINT_LIMITS.tourMaps} map and ${LINT_LIMITS.tourPaths} flow or sequence`,
      "keep the diagram that answers the question and show the rest in its steps' code, or split the tour in two (one per question)",
    );
  }

  if (steps.length > LINT_LIMITS.tourSteps) {
    lint.add(
      where,
      "tour-length",
      excerpt(str(tour.title) ?? tourId),
      `${steps.length} steps (more than ${LINT_LIMITS.tourSteps})`,
      "split the tour (one tour per part or question), or merge steps that make the same point",
    );
  }

  // a small map: every box is visited by a step, or at least named in the text
  const shown = steps.flatMap((step) => focusOf(step).flatMap((id) => shownBy(id, at)));
  const text = [str(tour.summary) ?? "", ...steps.map((step) => str(step.note) ?? "")]
    .join("\n")
    .replace(/`/g, "");
  const maps = [...new Set(steps.map((step) => str(step.view)))]
    .map((id) => at.views.get(id ?? ""))
    .filter((view) => view?.type === "graph");
  for (const view of maps) {
    const boxes = list<unknown>(view!.include).filter((id): id is string => typeof id === "string");
    if (boxes.length === 0 || boxes.length > LINT_LIMITS.mapBoxes) continue;
    const missed = boxes.filter(
      (box) =>
        !shown.some((id) => within(id, box, at) || within(box, id, at)) &&
        !namesOf(box, at).some((name) => names(text, name)),
    );
    if (missed.length === 0) continue;
    const labels = missed.map((box) => labelOf(box, at));
    lint.findings.push({
      rule: "tour-covers-map",
      ...where,
      view: str(view!.id),
      quote: excerpt(labels.join(", ")),
      message:
        `${plural(missed.length, "box", "boxes")} of the map ${str(view!.id)} (${boxes.length} boxes) ` +
        `never ${missed.length === 1 ? "comes" : "come"} up: no step focuses ${missed.length === 1 ? "it" : "them"}, no note names ${missed.length === 1 ? "it" : "them"}`,
      hint: 'give each box a step, name it in a note and say why the tour skips it, or take it off the map. A plain-word name counts ("web server" for "Web servers")',
      ids: missed,
    });
  }
}

// ─── Reader checks: what the viewer will show ───────────────────────────────────────────────────

/**
 * Does this element (or flow / sequence step) carry anchors of its own? An edge with `via` counts: the index
 * references of its hops are its code (validate checks that each hop has them, or anchors).
 */
function hasAnchors(item: Record<string, unknown>): boolean {
  return list(item.anchors).length > 0 || list(item.via).length > 0;
}

/** Any element by id: a node, an edge, a concept or a flow / sequence step. */
function elementOf(id: string, at: Lookup): Record<string, unknown> | undefined {
  return at.nodes.get(id) ?? at.edges.get(id) ?? at.concepts.get(id) ?? at.steps.get(id);
}

/**
 * The names of what a tour step shows with its code (`Evidence.names`): every element it focuses when the step has
 * `code` ranges, else the focused elements with anchors and the focused code (symbols, files). Their labels, and
 * for code the symbol path or file name.
 */
function evidenceNames(step: Record<string, unknown>, at: Lookup): string[] {
  const code = list(step.code).length > 0;
  const out: string[] = [];
  for (const id of list<unknown>(step.focus)) {
    if (typeof id !== "string") continue;
    const item = elementOf(id, at);
    const type = parseId(id).type;
    if (!code && !(item && hasAnchors(item)) && type !== "symbol" && type !== "file") continue;
    out.push(...namesOf(id, at));
    const label = str(item?.label);
    if (label !== undefined && label.trim() !== "") out.push(label.trim());
  }
  return [...new Set(out)];
}

/** Is this tour a talk (its id or title says talk, presentation, demo or slides)? Present shows it. */
function isTalk(tour: Record<string, unknown>): boolean {
  return /\b(?:talks?|present(?:ation)?|demo|slides?)\b/i.test(
    `${str(tour.id) ?? ""} ${str(tour.title) ?? ""}`.replace(/[:_-]/g, " "),
  );
}

/**
 * Would the viewer make a title of this note without a heading (`stepTitle.ts` in the viewer)? Its first sentence
 * (not a list, a quote, a table or code) of at most `titleSentenceChars` characters, markdown marks left out.
 */
function sentenceTitle(note: string): boolean {
  const text = note.trimStart();
  if (/^(?:[-+>|]|\*\s|\d+[.)]\s|```|~~~)/.test(text)) return false;
  const paragraph = text.split(/\n[ \t]*\n/)[0]!;
  let end = paragraph.length;
  let inCode = false;
  for (let i = 0; i < paragraph.length; i++) {
    const c = paragraph[i]!;
    if (c === "`") inCode = !inCode;
    if (inCode || (c !== "." && c !== "!" && c !== "?")) continue;
    if (c === "." && /(?:^|[\s(])(?:e\.g|i\.e|etc|vs|cf)$/i.test(paragraph.slice(0, i))) continue;
    let after = i + 1;
    while (after < paragraph.length && /["')\]*]/.test(paragraph[after]!)) after++;
    if (after === paragraph.length || /\s/.test(paragraph[after]!)) {
      end = after;
      break;
    }
  }
  const title = plainText(paragraph.slice(0, end)).replace(/\.(["')\]*]*)$/, "$1");
  return title !== "" && title.length <= LINT_LIMITS.titleSentenceChars;
}

interface LineRange {
  file: string;
  startLine: number;
  endLine: number;
}

/** The resolved ranges of anchors (base anchors left out: they show in a pane of their own). */
function anchorRanges(anchors: unknown): LineRange[] {
  const out: LineRange[] = [];
  for (const value of list<unknown>(anchors)) {
    const anchor = record(value);
    if (isBaseAnchor(anchor)) continue;
    const range = record(record(anchor.resolved).range);
    const file = str(anchor.file);
    if (record(anchor.resolved).status === "missing") continue;
    if (file && typeof range.startLine === "number" && typeof range.endLine === "number") {
      out.push({ file, startLine: range.startLine, endLine: range.endLine });
    }
  }
  return out;
}

/**
 * `far-ranges`: a tour step whose code (its `code` ranges, else the anchors of what it focuses) makes more than
 * `placesPerFile` places in one file, places being ranges more than `farRangeLines` lines apart. Present shows each
 * place of a file in a pane of its own, up to `placesPerFile`; the last pane holds the rest, far apart, and opens at
 * the first of them. (Read steps through the places of a pane one by one, any number.)
 */
function farRanges(lint: Linter, where: Where, step: Record<string, unknown>, at: Lookup): void {
  let ranges = anchorRanges(step.code);
  if (ranges.length === 0) {
    ranges = list<unknown>(step.focus).flatMap((id) =>
      typeof id === "string" ? anchorRanges(elementOf(id, at)?.anchors) : [],
    );
  }
  const byFile = new Map<string, LineRange[]>();
  for (const range of ranges) byFile.set(range.file, [...(byFile.get(range.file) ?? []), range]);
  for (const [file, inFile] of byFile) {
    const sorted = [...inFile].sort((a, b) => a.startLine - b.startLine);
    const places: { from: number; to: number }[] = [];
    for (const range of sorted) {
      const last = places[places.length - 1];
      if (last && range.startLine - last.to <= LINT_LIMITS.farRangeLines)
        last.to = Math.max(last.to, range.endLine);
      else places.push({ from: range.startLine, to: range.endLine });
    }
    if (places.length > LINT_LIMITS.placesPerFile) {
      const rest = places.slice(LINT_LIMITS.placesPerFile - 1);
      lint.add(
        { ...where, field: "code" },
        "far-ranges",
        `${file}:${places.map((p) => `${p.from}-${p.to}`).join(", ")}`,
        `the ranges in ${file} are ${places.length} places over ${LINT_LIMITS.farRangeLines} lines apart: a slide shows ${LINT_LIMITS.placesPerFile} panes of one file, so its last pane holds ${rest.map((p) => `${p.from}-${p.to}`).join(" and ")}, ${rest[1]!.from - rest[0]!.to} lines apart, and opens at the first`,
        `keep the places the note is about (at most ${LINT_LIMITS.placesPerFile} in one file), or split the step in two; ranges close together are one place`,
      );
      return;
    }
  }
}

/**
 * `many-ranges`: a tour step with no `code` shows the code of what it focuses. A box with no anchors of its own
 * falls back to its code (`codeFocus`: a folder's files, a group's members). More ranges than a step holds are a
 * list to scroll, not the code the note is about. Anchors an author wrote on the focus are judged as written.
 */
function manyRanges(
  lint: Linter,
  where: Where,
  step: Record<string, unknown>,
  at: Lookup,
  model: ExplainerModel,
): void {
  if (list(step.code).length > 0) return;
  const focus = list<unknown>(step.focus).filter(
    (id): id is string => typeof id === "string" && list(elementOf(id, at)?.anchors).length === 0,
  );
  const ranges = codeFocus(focus, model);
  if (ranges.length <= LINT_LIMITS.stepRanges) return;
  const files = [...new Set(ranges.map((r) => r.file))];
  lint.add(
    { ...where, field: "code" },
    "many-ranges",
    excerpt(files.join(", ")),
    `no \`code\`, so the step shows the code of what it focuses: ${plural(ranges.length, "range")} in ${plural(files.length, "file")} (a step holds at most ${LINT_LIMITS.stepRanges})`,
    `give the step \`code\` with the ${LINT_LIMITS.stepRanges} ranges the note is about, or focus a smaller box`,
  );
}

/**
 * The files a tour step shows code of: its ranges, and what it focuses (a symbol or a file, and the members, ends
 * and anchors of what it focuses); `dirs`: the folders it focuses, which show the files in them as boxes only.
 */
function filesShown(
  step: Record<string, unknown>,
  at: Lookup,
): { files: Set<string>; dirs: string[] } {
  const files = new Set<string>();
  const dirs: string[] = [];
  for (const anchor of list<unknown>(step.code)) {
    const file = str(record(anchor).file);
    if (file) files.add(file);
  }
  const visit = (id: string, seen: Set<string>) => {
    if (seen.has(id)) return;
    seen.add(id);
    const parsed = parseId(id);
    if (parsed.type === "symbol") files.add(parsed.file);
    else if (parsed.type === "file") files.add(parsed.path);
    else if (parsed.type === "dir") dirs.push(`${parsed.path}/`);
    for (const anchor of list<unknown>(elementOf(id, at)?.anchors)) {
      const file = str(record(anchor).file);
      if (file) files.add(file);
    }
    for (const member of membersOf(id, at)) visit(member, seen);
  };
  for (const focus of list<unknown>(step.focus)) {
    if (typeof focus !== "string") continue;
    const seen = new Set<string>();
    for (const id of shownBy(focus, at)) visit(id, seen);
  }
  return { files, dirs };
}

/**
 * Why a changed file needs no code on a step, when it has none: docs (`readme`, `*.md`), a test, a lock file, or
 * a rename with no edits. A note that names it is enough; any other changed file needs a step that shows its code.
 */
function nameIsEnough(file: Record<string, unknown>, path: string): string | undefined {
  const base = path.slice(path.lastIndexOf("/") + 1).toLowerCase();
  if (
    /\.(md|mdx|markdown|rst|txt|adoc)$/.test(base) ||
    /^(readme|changelog|changes|license|licence|contributing|authors)\b/.test(base) ||
    path.startsWith("docs/")
  )
    return "docs";
  if (isTestFile(path)) return "test";
  if (/^(package-lock\.json|npm-shrinkwrap\.json|pnpm-lock\.yaml|go\.sum|.*\.lock)$/.test(base))
    return "lock file";
  if (file.status === "renamed" && list(file.hunks).length === 0) return "rename";
  return undefined;
}

/**
 * `change-not-shown`: the changed files of a change explainer that no tour step shows the code of (its ranges, or
 * what it focuses). A reviewer reads the tour, not the file list, and a file named in a note is still unseen. Docs,
 * tests, lock files and renames may instead be named in a tour text (by file name, or by path when two changed
 * files share a name).
 */
function changeChecks(lint: Linter, explainer: Explainer, at: Lookup): void {
  const change = record(explainer.change);
  const changed = list<unknown>(change.files)
    .map(record)
    .flatMap((file) => {
      const path = str(file.path);
      return path === undefined ? [] : [{ path, nameable: nameIsEnough(file, path) }];
    });
  if (changed.length === 0) return;
  const files = new Set<string>();
  const dirs: string[] = [];
  const text: string[] = [];
  for (const tourValue of list(explainer.tours)) {
    const tour = record(tourValue);
    text.push(str(tour.summary) ?? "");
    for (const stepValue of list(tour.steps)) {
      const step = record(stepValue);
      const shown = filesShown(step, at);
      for (const file of shown.files) files.add(file);
      dirs.push(...shown.dirs);
      text.push(str(step.note) ?? "");
    }
  }
  const prose = text.join("\n");
  const baseName = (path: string) => path.slice(path.lastIndexOf("/") + 1);
  const named = (path: string) =>
    prose.includes(path) ||
    (changed.filter((other) => baseName(other.path) === baseName(path)).length === 1 &&
      prose.includes(baseName(path)));
  const code: string[] = [];
  const other: string[] = [];
  for (const { path, nameable } of changed) {
    if (files.has(path)) continue;
    if (nameable === undefined) code.push(path);
    else if (!named(path) && !dirs.some((dir) => path.startsWith(dir)))
      other.push(`${path} (${nameable})`);
  }
  const missed = [...code, ...other];
  if (missed.length === 0) return;
  const parts = [
    ...(code.length > 0
      ? [
          `no step shows the code of ${code.join(", ")} (naming a code file in a note is not enough)`,
        ]
      : []),
    ...(other.length > 0 ? [`no step shows or names ${other.join(", ")}`] : []),
  ];
  lint.findings.push({
    rule: "change-not-shown",
    elementId: "(explainer)",
    kind: "explainer",
    field: "change",
    quote: excerpt(missed.join(", ")),
    message: `${plural(missed.length, "changed file")} of ${changed.length} ${missed.length === 1 ? "is" : "are"} on no tour step: ${parts.join("; ")}`,
    hint: "show each code file on a step: a range of it in the step's `code`, or a symbol of it in its focus (a one-line change is a one-line range). Docs, tests, lock files and renames may instead be named in a note that says why the tour skips them",
    ids: [...code, ...other.map((entry) => entry.slice(0, entry.lastIndexOf(" (")))],
  });
}

/**
 * The map checks: `big-map` (a graph view a tour shows with more than `tourMapBoxes` boxes), `many-participants` (a
 * sequence view a tour shows with more than `sequenceParticipants` participants), `crowded-map` (more
 * arrows than `edgesPerBox` per box, with the ids of the least used drawn edges to hide), and `system-map-no-edges`
 * (an architecture map with a non-component role, at least two boxes and no visible edges or stubs). The box and
 * arrow counts come from the index when there is one (`model`; the rows of a table are not boxes), else from the
 * view's `include` (and no edge checks).
 */
function mapChecks(
  lint: Linter,
  explainer: Explainer,
  at: Lookup,
  model: ExplainerModel | undefined,
): void {
  const toured = new Set(
    list(explainer.tours).flatMap((tour) =>
      list(record(tour).steps).map((step) => str(record(step).view)),
    ),
  );
  for (const view of at.views.values()) {
    if (view.type !== "sequence" || !toured.has(str(view.id))) continue;
    const count = list(view.participants).length;
    if (count <= LINT_LIMITS.sequenceParticipants) continue;
    const viewId = str(view.id) ?? "(view)";
    lint.add(
      { elementId: viewId, kind: "view", field: "participants" },
      "many-participants",
      excerpt(str(view.title) ?? viewId),
      `${count} participants (more than ${LINT_LIMITS.sequenceParticipants}) on a sequence a tour shows: the lifelines get too narrow to read`,
      "fold a helper that one participant calls into that participant's lifeline, or leave out the calls that do not change the answer (and say so in a note)",
    );
  }
  const graphs = [...at.views.values()].filter((view) => view.type === "graph");
  for (const view of graphs) {
    const viewId = str(view.id) ?? "(view)";
    const where: Where = { elementId: viewId, kind: "view", field: "include" };
    let graph: DerivedGraph | undefined;
    try {
      graph = model ? deriveGraph(view as unknown as GraphView, model) : undefined;
    } catch {
      graph = undefined;
    }
    // a table of a data-model view is one box, whatever rows it has
    const boxes = graph
      ? graph.nodes.filter((node) => node.row === undefined).length
      : list(view.include).length;
    if (toured.has(viewId) && boxes > LINT_LIMITS.tourMapBoxes) {
      lint.add(
        where,
        "big-map",
        excerpt(str(view.title) ?? viewId),
        `${boxes} boxes (more than ${LINT_LIMITS.tourMapBoxes}) on a map a tour shows: a guide picture or a slide of it is too small to read`,
        "show fewer boxes: put boxes that work together in a group, leave helpers off the map (and say so in a note), or open the detail on a map of its own (`opens`)",
      );
    }
    if (graph && graph.edges.length > LINT_LIMITS.edgesPerBox * Math.max(boxes, 1)) {
      const most = LINT_LIMITS.edgesPerBox * Math.max(boxes, 1);
      const extra = graph.edges.length - most;
      const hide = graph.edges
        .filter((edge) => !edge.stored)
        .sort((a, b) => a.count - b.count || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
        .slice(0, extra)
        .map((edge) => edge.id);
      lint.findings.push({
        rule: "crowded-map",
        ...where,
        field: "hidden",
        quote: excerpt(str(view.title) ?? viewId),
        message: `${graph.edges.length} arrows on ${plural(boxes, "box", "boxes")} (more than ${LINT_LIMITS.edgesPerBox} per box): the arrows cross and hide each other`,
        hint:
          hide.length > 0
            ? `hide the least used ones: add ${hide.length === 1 ? "this id" : "these ids"} to the view's "hidden" (the ids are in --json): ${hide.slice(0, 4).join(", ")}${hide.length > 4 ? ", ..." : ""}`
            : 'drop some stored edges, or narrow "edgeKinds"',
        ids: hide,
      });
    }
    if (
      graph &&
      record(view.scope).root === "repo" &&
      record(view.scope).depth === 1 &&
      graph.nodes.length >= 2 &&
      graph.edges.length === 0 &&
      graph.stubs.length === 0 &&
      graph.nodes.some((node) => node.role !== undefined && node.role !== "component")
    ) {
      lint.add(
        where,
        "system-map-no-edges",
        excerpt(str(view.title) ?? viewId),
        `system map ${str(view.title) ?? viewId} has ${plural(graph.nodes.length, "box", "boxes")} and no arrows`,
        "check whether the map misses arrows the code shows; add only arrows a code link backs",
      );
    }
  }
}

/**
 * The shape of the explainer as a whole: `unused-view` (a view no tour step shows and no box opens, when there is
 * a tour), `many-concepts` (more than `LINT_LIMITS.concepts`), `duplicate-step` (a note copied into another tour).
 */
function structureChecks(lint: Linter, explainer: Explainer): void {
  const tours = list<unknown>(explainer.tours).map(record);
  const steps = tours.flatMap((tour) =>
    list<unknown>(tour.steps).map((step) => ({
      tourId: str(tour.id) ?? "(tour)",
      step: record(step),
    })),
  );
  if (tours.length > 0) {
    const used = new Set<string>();
    for (const { step } of steps) if (typeof step.view === "string") used.add(step.view);
    for (const node of list<unknown>(explainer.nodes)) {
      const opens = str(record(node).opens);
      if (opens !== undefined) used.add(opens);
    }
    for (const view of list<unknown>(explainer.views).map(record)) {
      const id = str(view.id);
      if (id === undefined || used.has(id)) continue;
      lint.add(
        { elementId: id, kind: "view", field: "tours" },
        "unused-view",
        excerpt(str(view.title) ?? id),
        "no tour step shows this view and no box opens it",
        "show it on a tour step, open it from a box (`opens`), or drop it: a reader reaches a diagram from the tour or from a box",
      );
    }
  }

  const concepts = list<unknown>(explainer.concepts)
    .map((concept) => str(record(concept).id))
    .filter((id): id is string => id !== undefined);
  if (concepts.length > LINT_LIMITS.concepts) {
    const focused = new Set(steps.flatMap(({ step }) => list<unknown>(step.focus)));
    const unfocused = concepts.filter((id) => !focused.has(id));
    lint.findings.push({
      rule: "many-concepts",
      elementId: "(explainer)",
      kind: "explainer",
      field: "concepts",
      quote: excerpt(unfocused.join(", ") || concepts.join(", ")),
      message: `${concepts.length} concepts (more than ${LINT_LIMITS.concepts}); ${unfocused.length} of them no tour step focuses`,
      hint: "keep the few ideas a reader needs (the skill asks for 0-3): merge concepts that make the same point, turn a case into a `detail` line, or drop the ones no step uses",
      ids: unfocused,
    });
  }

  // say it once: a note copied from a step of another tour
  const seen: { id: string; tourId: string; words: string[] }[] = [];
  for (const { tourId, step } of steps) {
    const note = str(step.note);
    if (note === undefined || /\bTODO\b/.test(note)) continue;
    const masked = mask(note);
    const words = contentWords(masked.text, masked.spans);
    const id = `${tourId}/${str(step.id) ?? "?"}`;
    if (new Set(words).size >= LINT_LIMITS.duplicateMinWords) {
      const copy = seen.find(
        (other) =>
          other.tourId !== tourId && repeats(words, other.words) && repeats(other.words, words),
      );
      if (copy) {
        lint.add(
          { elementId: id, kind: "tour-step", field: "note" },
          "duplicate-step",
          excerpt(noteTitle(note) || note),
          `the same note as ${copy.id}`,
          `say it once: keep the step in one tour, and let this tour say what it adds (or point the reader to ${copy.tourId})`,
        );
      }
    }
    seen.push({ id, tourId, words });
  }
}

/** Structural metadata is not authored prose. New string fields are checked unless explicitly structural. */
const STRUCTURAL_TEXT_FIELDS = new Set([
  "schema",
  "id",
  "kind",
  "type",
  "role",
  "layout",
  "stubs",
  "anchors",
  "code",
  "provenance",
  "index",
  "change",
  "commit",
  "url",
  "parent",
  "members",
  "related",
  "from",
  "to",
  "via",
  "opens",
  "edge",
  "view",
  "root",
  "entryPoints",
  "include",
  "hidden",
  "edgeKinds",
  "excludeFiles",
  "boxText",
  "render",
  "participants",
  "fromStep",
  "toStep",
  "step",
  "focus",
  "primary",
]);

/** Walk all authored strings, including nested frame/transition labels and future schema text fields. */
function placeholderChecks(lint: Linter, explainer: Explainer): void {
  const kinds: Record<string, LintElementKind> = {
    nodes: "node",
    edges: "edge",
    concepts: "concept",
    views: "view",
    tours: "tour",
    frames: "frame",
  };
  function walk(value: unknown, where: Where): void {
    if (typeof value === "string") {
      lint.todos(where, value);
    } else if (Array.isArray(value)) {
      value.forEach((item, i) => walk(item, { ...where, field: `${where.field}[${i}]` }));
    } else if (value && typeof value === "object") {
      const item = record(value);
      const id = str(item.id);
      const owner =
        id === undefined
          ? where
          : {
              ...where,
              elementId: where.kind === "tour-step" ? `${where.elementId}/${id}` : id,
              field: "",
              ...(where.kind === "view" ? { view: id } : {}),
            };
      for (const [key, child] of Object.entries(item)) {
        if (STRUCTURAL_TEXT_FIELDS.has(key)) continue;
        // Repository names come from package/git identity, even when the model uses one as a box label.
        if (owner.kind === "explainer" && owner.field === "repo" && key === "name") continue;
        const kind =
          key === "steps"
            ? owner.kind === "tour"
              ? "tour-step"
              : "step"
            : (kinds[key] ?? owner.kind);
        walk(child, { ...owner, kind, field: owner.field ? `${owner.field}.${key}` : key });
      }
    }
  }
  walk(explainer, { elementId: "(explainer)", kind: "explainer", field: "" });
}

/** First words that show a box sentence does not start with a verb ("This file …", "The dispatcher …"). */
const NOT_VERB_START = new Set(["this", "the", "a", "an", "it", "these", "its", "here"]);
/** Verbs too vague to say what a part does for the project. */
const VAGUE_START = new Set(["contains", "includes", "has", "handles", "manages"]);

/**
 * `map-box`: the explain map's box rules, on every box a graph view draws with its summary (`boxText: "summary"`):
 * a label of at most `mapLabelWords` words, and a sentence of at most `mapSummaryChars` characters that starts with
 * a verb (not with an article, "This" or the file's own name). TODOs wait.
 */
function mapBoxChecks(lint: Linter, explainer: Explainer): void {
  const drawn = new Set<string>();
  for (const view of list(explainer.views)) {
    const v = record(view);
    if (v.type !== "graph" || v.boxText !== "summary") continue;
    for (const id of list(v.include)) if (typeof id === "string") drawn.add(id);
  }
  for (const value of list(explainer.nodes)) {
    const node = record(value);
    const id = str(node.id);
    if (id === undefined || !drawn.has(id)) continue;
    const label = str(node.label);
    const own =
      id
        .replace(/^(?:file|dir):/, "")
        .split("/")
        .pop() ?? "";
    if (label !== undefined && !/\bTODO\b/.test(label)) {
      const count = words(mask(label).text).length;
      const bare = label.replace(/`/g, "").trim();
      if (label.includes("`") || /\.\w{1,5}$/.test(bare) || bare === own)
        lint.add(
          { elementId: id, kind: "node", field: "label" },
          "map-box",
          excerpt(label),
          "a file name: name what it does in 2-5 everyday words",
          'name what the part does for the project ("Job queue", not `queue.rs`)',
        );
      else if (count > LINT_LIMITS.mapLabelWords)
        lint.add(
          { elementId: id, kind: "node", field: "label" },
          "map-box",
          excerpt(label),
          `${count} words (more than ${LINT_LIMITS.mapLabelWords}): a box on a map that shows summaries takes a label of 2-5 plain words`,
          'name what the part does for the project in 2-5 everyday words ("Job queue", not `queue.rs`)',
        );
    }
    const summary = str(node.summary);
    if (summary === undefined || summary.trim() === "" || /\bTODO\b/.test(summary)) continue;
    const plain = summary.replace(/`/g, "").trim();
    const first = plain.split(/\s+/)[0]!.replace(/[,:;]$/, "");
    const file = own;
    const lower = first.toLowerCase();
    const labelFirst = label?.replace(/`/g, "").trim().split(/\s+/)[0]?.toLowerCase();
    const problems: string[] = [];
    if (plain.length > LINT_LIMITS.mapSummaryChars)
      problems.push(`${plain.length} characters (more than ${LINT_LIMITS.mapSummaryChars})`);
    // the skill's box sentences start with a verb in the present, third person: Keeps, Runs, Answers, Is, Has
    if (VAGUE_START.has(lower))
      problems.push(
        `it starts with "${first}": say what it does for the project ("Keeps …", "Answers …")`,
      );
    else if (/(?:ing|ed)$/.test(lower) && lower.length >= 4)
      problems.push(`it starts with "${first}", not a verb in the present`);
    else if (labelFirst !== undefined && lower === labelFirst && !/s$/.test(lower))
      problems.push(`it starts with "${first}", the label, not a verb`);
    else if (
      NOT_VERB_START.has(lower) ||
      summary.trimStart().startsWith("`") ||
      first === file ||
      (file.includes(".") && first === file.slice(0, file.lastIndexOf("."))) ||
      !/s$/.test(lower) ||
      /ss$/.test(lower)
    )
      problems.push(`it starts with "${first}", not a verb`);
    if (problems.length === 0) continue;
    lint.add(
      { elementId: id, kind: "node", field: "summary" },
      "map-box",
      excerpt(summary),
      `${problems.join("; ")}: the box shows this sentence under its label`,
      'write one sentence of about 120 characters at most that starts with a verb and says what it does for the project ("Keeps jobs in order until a worker takes one.")',
    );
  }
}

/** The checks of `xpl lint` on one explainer, in document order (see the file comment). */
export function lintExplainer(explainer: Explainer, model?: ExplainerModel): LintResult {
  // the code's own words: the labels and ids of boxes and concepts, and the boxes and lifelines views show
  const own = [...list(explainer.nodes), ...list(explainer.concepts)].flatMap((item) => [
    str(record(item).label) ?? "",
    str(record(item).id) ?? "",
  ]);
  for (const view of list(explainer.views)) {
    for (const id of [...list(record(view).include), ...list(record(view).participants)]) {
      if (typeof id === "string") own.push(id);
    }
    // the question a view answers is the reader's: "How does the error overlay work?"
    own.push(str(record(record(view).scope).question) ?? "");
  }
  // and the guide's title, and every file it links to (`src/client/overlay.ts`)
  own.push(str(explainer.title) ?? "");
  for (const site of collectAnchors(explainer)) {
    if (typeof site.anchor.file === "string") own.push(site.anchor.file);
  }
  const labels = [...list(explainer.nodes), ...list(explainer.concepts)]
    .map((item) => str(record(item).label)?.toLowerCase() ?? "")
    .filter((label) => label !== "");
  const lint = new Linter(new Set(own.flatMap((text) => stems(text))), labels);
  const summaries = storedSummaries(explainer);
  const byId = lookup(explainer);

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
    const most = LINT_LIMITS.summarySentences;
    const range = `${LINT_LIMITS.summaryMinSentences}-${most} sentences`;
    if (typeof summary === "string" && summary.trim() !== "") {
      const room = most - sentences(mask(summary).text).length;
      const masked = lint.prose(at("summary"), summary, {
        sentenceRoom: room,
        evidence: { change: explainer.change !== undefined },
      });
      const count = masked ? sentences(masked.text).length : 0;
      if (masked)
        codeHeavy(
          lint,
          at("summary"),
          summary,
          masked,
          LINT_LIMITS.summaryCodeNames,
          "the summary",
        );
      if (count > most) {
        lint.add(
          at("summary"),
          "tour-summary",
          excerpt(summary),
          `${count} sentences (more than ${most})`,
          `keep the summary to ${range}; move the rest into the steps (two sentences joined into one over ${LINT_LIMITS.sentenceWords} words is a long-sentence finding)`,
        );
      } else if (count < LINT_LIMITS.summaryMinSentences) {
        lint.add(
          at("summary"),
          "tour-summary",
          excerpt(summary),
          `${plural(count, "sentence")} (fewer than ${LINT_LIMITS.summaryMinSentences})`,
          `write ${range}: the answer first, then up to four reasons; for a change: what behaves differently, the risk, the tests`,
        );
      }
    } else {
      lint.add(
        at("summary"),
        "tour-summary",
        excerpt(str(tour.title) ?? tourId),
        "no summary: readers see the summary first, under the tour title",
        `add ${range}: the answer first, then up to four reasons; for a change: what behaves differently, the risk, the tests`,
      );
    }
    orderChecks(lint, tourId, tour, byId, explainer.change !== undefined);
    const talk = isTalk(tour);
    list<unknown>(tour.steps).forEach((stepValue, index) => {
      const step = record(stepValue);
      const where: Where = {
        elementId: `${tourId}/${str(step.id) ?? "?"}`,
        kind: "tour-step",
        field: "note",
      };
      const note = str(step.note);
      // a draft's step (its note a TODO) is judged once it is written, like code-heavy and long-note
      if (!/\bTODO\b/.test(note ?? "")) {
        farRanges(lint, where, step, byId);
        if (model) manyRanges(lint, where, step, byId, model);
      }
      if (note === undefined || note.trim() === "") {
        lint.add(
          where,
          "untitled-step",
          `step ${index + 1}`,
          `no note: the viewer can only call it "Step ${index + 1}"`,
          'write a note that starts with "### <plain title>", a short phrase that says what happens here',
        );
        return;
      }
      const evidence: Evidence = {
        names: evidenceNames(step, byId),
        change: explainer.change !== undefined,
      };
      const lines = note.split("\n");
      const first = lines.findIndex((line) => line.trim() !== "");
      const heading = HEADING.exec(lines[first] ?? "");
      let body = note;
      if (heading && heading[1]!.trim() !== "") {
        // a heading is a title, checked like the body: a claim in it names the part that proves it
        lint.title({ ...where, field: "note heading" }, heading[1], evidence);
        body = lines.slice(first + 1).join("\n");
      } else if (!sentenceTitle(note)) {
        lint.add(
          where,
          "untitled-step",
          excerpt(note),
          `no "### title" line, and the first sentence is too long to be a title (over ${LINT_LIMITS.titleSentenceChars} characters) or is not a sentence: ` +
            'the viewer shows it cut short, or "Step N"',
          'start the note with "### <plain title>", a short phrase that says what happens here',
        );
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
      const masked = lint.prose(where, body, { evidence });
      if (masked === undefined) return;
      const opener = heading
        ? /^[\s"'(*_]*(So|But|And|Also|Then)(?=[\s,])/.exec(sentences(masked.text)[0] ?? "")
        : null;
      if (opener) {
        lint.add(
          where,
          "connector-start",
          excerpt(body.trim()),
          `the note starts with "${opener[1]}", which leans on the heading or the step before`,
          'state the fact on its own: "The map needs an index first", not "So the map needs an index first"',
        );
      }
      if (talk && body.trim().length > LINT_LIMITS.talkNoteChars && !/\bTODO\b/.test(body)) {
        lint.add(
          where,
          "long-talk-note",
          excerpt(body.trim()),
          `${body.trim().length} characters under the title (more than ${LINT_LIMITS.talkNoteChars}): Present sets this caption in its smaller type, and it may scroll`,
          "in a talk, say one thing per step in one or two short sentences; the speaker says the rest",
        );
      }
      const bodyWords = words(masked.text).length;
      if (bodyWords > LINT_LIMITS.noteWords && !/\bTODO\b/.test(body)) {
        lint.add(
          where,
          "long-note",
          excerpt(body.trim()),
          `${bodyWords} words (more than ${LINT_LIMITS.noteWords})`,
          "keep the one point of this step in 1-3 short sentences; move details into the summary or detail of a box",
        );
      }
      const architecture = isArchitectureView(byId.views.get(str(step.view) ?? ""), byId);
      codeHeavy(
        lint,
        where,
        body,
        masked,
        architecture ? LINT_LIMITS.architectureCodeNames : LINT_LIMITS.noteCodeNames,
        architecture ? "a note on an architecture map" : "a note",
      );
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
    });
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
      if (
        view.type === "flow" &&
        label !== undefined &&
        label.trim() !== "" &&
        !/\bTODO\b/.test(label)
      ) {
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
      lint.prose(at("summary"), step.summary, {
        evidence: { anchored: hasAnchors(step) },
        summary: true,
      });
      lint.summaryMarks(at("summary"), step.summary);
      lint.summaryLength(at("summary"), step.summary);
    }
  }

  const element = (kind: "node" | "edge" | "concept", value: unknown) => {
    const item = record(value);
    const id = str(item.id) ?? `(${kind})`;
    // the labels of groups and concepts are titles a person chose; other labels name code
    const titled = kind === "concept" || id.startsWith("grp:");
    // an element with anchors carries its evidence: the reader opens the code from the text
    const evidence: Evidence = { anchored: hasAnchors(item) };
    if (titled) lint.title({ elementId: id, kind, field: "label" }, item.label, evidence);
    lint.plain({ elementId: id, kind, field: "label" }, item.label, !titled);
    lint.prose({ elementId: id, kind, field: "summary" }, item.summary, {
      evidence,
      summary: true,
    });
    lint.summaryMarks({ elementId: id, kind, field: "summary" }, item.summary);
    lint.summaryLength({ elementId: id, kind, field: "summary" }, item.summary);
    lint.prose({ elementId: id, kind, field: "detail" }, item.detail, { evidence });
    lint.detailLength({ elementId: id, kind, field: "detail" }, item.detail);
  };
  for (const node of list(explainer.nodes)) element("node", node);
  for (const edge of list(explainer.edges)) element("edge", edge);
  for (const concept of list(explainer.concepts)) element("concept", concept);

  structureChecks(lint, explainer);
  mapBoxChecks(lint, explainer);
  mapChecks(lint, explainer, byId, model);
  changeChecks(lint, explainer, byId);
  placeholderChecks(lint, explainer);

  return { findings: lint.findings, checked: lint.checked };
}
