/**
 * The title of a tour step, the same wherever a step is named: the guide's contents and section headings,
 * the guide path in Flow, the tour editor, the Present caption and the breadcrumb.
 *
 * - A note may start with a markdown heading line (`### Plain title`, the contract with the skill). That
 *   whole line is the title; the body is the rest of the note.
 * - A note without a heading: its first sentence is the title when it has at most `MAX_SENTENCE_TITLE`
 *   characters, and the body is the rest of the note.
 * - Otherwise the title is the first sentence cut at a word boundary to about `SHORT_TITLE` characters, with
 *   "…" (`shortTitle`), and the body is the whole note; a step without a note is "Step N". Never the label of
 *   what the step focuses: that is often code (`codeFocus([id], model)`), and several steps share a focus.
 *
 * Either way the title is not printed again in the body: each thing is said once.
 */
import type { ExplainerModel, TourStep } from "@xpl/core";

/** A first sentence longer than this does not make a title. */
export const MAX_SENTENCE_TITLE = 80;

/** A title cut from a long first sentence keeps about this many characters (then "…"). */
export const SHORT_TITLE = 60;

const HEADING = /^ {0,3}#{1,6}[ \t]+(.*?)(?:[ \t]+#+)?[ \t]*$/;

/**
 * Markdown a title is shown without: links keep their text, emphasis and code marks go. A code span keeps
 * what is inside it as written ("`*`" stays "*").
 */
const plain = (text: string) =>
  text
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/(`+)(.*?)\1|[*`]+/g, (_mark, ticks: string | undefined, code: string | undefined) =>
      ticks ? code! : "",
    )
    .replace(/\s+/g, " ")
    .trim();

/** Short words whose period does not end a sentence. */
const ABBREVIATION = /(?:^|[\s(])(?:e\.g|i\.e|etc|vs|cf)$/i;
/** What may follow the stop of a sentence and still belong to it: closing quotes, brackets, emphasis. */
const CLOSERS = /["')\]*]/;

/** A note, split for display: the title it gives the step (if any) and the markdown to print under it. */
export interface NoteParts {
  /** Plain text (for lists, menus, the breadcrumb). */
  title?: string;
  /** The same title as markdown, for the places that render it (code spans stay code). */
  titleMarkdown?: string;
  /** Where the title came from. */
  from?: "heading" | "sentence";
  body?: string;
}

/**
 * The index just past the first sentence of `text`: after its `.`, `!` or `?` and any closing marks, where
 * a space or the end follows. A stop inside a code span, inside a word ("foo.bar", "3.5") or after an
 * abbreviation ("e.g.") does not count. Undefined when the text is one unfinished sentence.
 */
function sentenceEnd(text: string): number | undefined {
  let inCode = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (c === "`") inCode = !inCode;
    if (inCode || (c !== "." && c !== "!" && c !== "?")) continue;
    if (c === "." && ABBREVIATION.test(text.slice(0, i))) continue;
    let end = i + 1;
    while (end < text.length && CLOSERS.test(text[end]!)) end++;
    if (end === text.length || /\s/.test(text[end]!)) return end;
  }
  return undefined;
}

/** The note's title and body (see the file comment); empty for a missing or blank note. */
export function noteParts(note: string | undefined): NoteParts {
  if (typeof note !== "string" || !note.trim()) return {};
  const lines = note.split("\n");
  const first = lines.findIndex((line) => line.trim() !== "");
  const heading = HEADING.exec(lines[first]!);
  const headingTitle = heading ? plain(heading[1]!) : "";
  if (headingTitle) {
    const titled = {
      title: headingTitle,
      titleMarkdown: heading![1]!.trim(),
      from: "heading",
    } as const;
    const body = lines.slice(first + 1).join("\n");
    return body.trim() ? { ...titled, body } : titled;
  }
  const text = lines.slice(first).join("\n").trimStart();
  // A list, a quote, a table or a code block does not open with a sentence that could be a title.
  if (/^(?:[-+>|]|\*\s|\d+[.)]\s|```|~~~)/.test(text)) return { body: note };
  const paragraph = text.split(/\n[ \t]*\n/)[0]!;
  const end = sentenceEnd(paragraph) ?? paragraph.length;
  // The title drops a final period (a heading has none); a question or an exclamation keeps its mark.
  const dropStop = (sentence: string) => sentence.replace(/\.(["')\]*]*)$/, "$1");
  const titleMarkdown = dropStop(paragraph.slice(0, end).replace(/\s+/g, " ").trim());
  const title = dropStop(plain(paragraph.slice(0, end)));
  if (!title || title.length > MAX_SENTENCE_TITLE) return { body: note };
  const titled = { title, titleMarkdown, from: "sentence" } as const;
  const body = text.slice(end).trim();
  return body ? { ...titled, body } : titled;
}

/** The title the note gives the step: its heading, else its first sentence when short; else undefined. */
export function noteTitle(step: Pick<TourStep, "note">): string | undefined {
  return noteParts(step.note).title;
}

type Names = Pick<ExplainerModel, "tours">;

/**
 * The first sentence of a note without a title, cut at a word boundary to at most `SHORT_TITLE` characters plus
 * "…" (list marks, quote marks and markdown left out). Undefined when the note opens with code or has no words.
 */
export function shortTitle(note: string | undefined): string | undefined {
  if (typeof note !== "string") return undefined;
  const text = note.trim();
  if (/^(?:```|~~~)/.test(text)) return undefined;
  const firstLine = text.split("\n")[0]!.replace(/^(?:[-+*>]|\d+[.)])\s+/, "");
  const end = sentenceEnd(firstLine) ?? firstLine.length;
  const sentence = plain(firstLine.slice(0, end)).replace(/\.$/, "");
  if (!/[\p{L}\p{N}]/u.test(sentence)) return undefined;
  if (sentence.length <= SHORT_TITLE) return sentence;
  const cut = sentence.slice(0, SHORT_TITLE + 1);
  const space = cut.lastIndexOf(" ");
  return `${(space > SHORT_TITLE / 2 ? cut.slice(0, space) : cut.slice(0, SHORT_TITLE)).replace(/[\s,;:.\u2013\u2014-]+$/u, "")}…`;
}

/** "Step N": the step's place in its tour (the first tour that holds it, by identity, else by id). */
function numbered(step: TourStep, model: Names): string {
  const tours = model.tours ?? [];
  for (const same of [(s: TourStep) => s === step, (s: TourStep) => s.id === step.id]) {
    for (const tour of tours) {
      const index = Array.isArray(tour.steps) ? tour.steps.findIndex(same) : -1;
      if (index !== -1) return `Step ${index + 1}`;
    }
  }
  return "Step";
}

/** The title of `step` (see the file comment). */
export function stepTitle(step: TourStep, model: Names): string {
  return noteTitle(step) ?? shortTitle(step.note) ?? numbered(step, model);
}

/**
 * What a step shows: its title (always; `titleMarkdown` when the note gave it) and the part of its note that
 * the title does not already say.
 */
export function stepText(
  step: TourStep,
  model: Names,
): { title: string; titleMarkdown?: string; body?: string } {
  const parts = noteParts(step.note);
  return {
    title: parts.title ?? stepTitle(step, model),
    ...(parts.titleMarkdown !== undefined ? { titleMarkdown: parts.titleMarkdown } : {}),
    ...(parts.body !== undefined ? { body: parts.body } : {}),
  };
}
