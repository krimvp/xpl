/**
 * CodeMirror 6 editors: read-only, syntax highlighted in colours that follow the page theme (CSS
 * variables), with the focus decorations of section 6:
 *
 *   xpl-hl, xpl-hl-<role>   line decorations for the lines of a focus range (a line can carry several
 *                           roles); xpl-site marks the exact call / usage expression when the range has columns
 *   xpl-dim                 every other line of a focused file
 *   data-line="<n>"         on every line, for tests and tooling
 *
 * The caret and selection stay live (read-only is not "not editable"): every caret or selection change
 * is reported as a range of lines, which the store turns into a reverse lookup.
 */
import { go } from "@codemirror/lang-go";
import { javascript } from "@codemirror/lang-javascript";
import { json } from "@codemirror/lang-json";
import { python } from "@codemirror/lang-python";
import { yaml } from "@codemirror/lang-yaml";
import { defaultHighlightStyle, HighlightStyle, syntaxHighlighting } from "@codemirror/language";
import {
  EditorSelection,
  EditorState,
  RangeSet,
  StateEffect,
  StateField,
  type Extension,
  type Range,
  type Text,
} from "@codemirror/state";
import {
  Decoration,
  drawSelection,
  EditorView,
  gutterLineClass,
  GutterMarker,
  lineNumbers,
  type DecorationSet,
} from "@codemirror/view";
import type { AnchorRole, FileLanguage, FocusRange } from "@xpl/core";

/** CodeMirror language support for an `IndexedFile.language`. */
export function languageSupport(language: FileLanguage): Extension {
  switch (language) {
    case "typescript":
      return javascript({ typescript: true });
    case "tsx":
      return javascript({ typescript: true, jsx: true });
    case "javascript":
      return javascript({ jsx: true });
    case "python":
      return python();
    case "go":
      return go();
    case "yaml":
      return yaml();
    case "json":
      return json();
    case "text":
      return [];
  }
}

// ─── Theme: CodeMirror's default highlight style, re-coloured through CSS variables ─────────────

/** The default style's colours (designed for white) -> the variables styles.css defines per theme. */
const SYNTAX_COLORS: Record<string, string> = {
  "#404740": "var(--syn-meta)",
  "#708": "var(--syn-keyword)",
  "#219": "var(--syn-atom)",
  "#164": "var(--syn-number)",
  "#a11": "var(--syn-string)",
  "#e40": "var(--syn-string-special)",
  "#00f": "var(--syn-definition)",
  "#30a": "var(--syn-local)",
  "#085": "var(--syn-type)",
  "#167": "var(--syn-class)",
  "#256": "var(--syn-special)",
  "#00c": "var(--syn-property)",
  "#940": "var(--syn-comment)",
  "#f00": "var(--syn-invalid)",
};

const themedHighlight = HighlightStyle.define(
  defaultHighlightStyle.specs.map((spec) =>
    spec.color && SYNTAX_COLORS[spec.color] ? { ...spec, color: SYNTAX_COLORS[spec.color]! } : spec,
  ),
);

const baseTheme = EditorView.theme({
  "&": { color: "var(--code-fg)", backgroundColor: "var(--code-bg)", height: "100%" },
  "&.cm-focused": { outline: "none" },
  ".cm-scroller": {
    fontFamily: "var(--font-mono)",
    fontSize: "12.5px",
    lineHeight: "1.6",
    overflow: "auto",
  },
  ".cm-content": { caretColor: "var(--code-fg)", padding: "6px 0" },
  ".cm-line": { padding: "0 12px 0 8px" },
  ".cm-gutters": {
    backgroundColor: "var(--code-gutter-bg)",
    color: "var(--code-gutter-fg)",
    border: "none",
    borderRight: "1px solid var(--border)",
  },
  ".cm-lineNumbers .cm-gutterElement": { padding: "0 10px 0 12px", minWidth: "2.6em" },
  ".cm-cursor, .cm-dropCursor": { borderLeftColor: "var(--code-fg)", borderLeftWidth: "2px" },
  "&.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground, .cm-selectionBackground":
    { background: "var(--code-selection)" },
});

// ─── Focus decorations ──────────────────────────────────────────────────────────────────────────

/** What a pane shows: the focus ranges of its file and whether the other lines are dimmed. */
export interface PaneFocus {
  ranges: readonly FocusRange[];
  dim: boolean;
}

export const setFocus = StateEffect.define<PaneFocus>();

class LineClassMarker extends GutterMarker {
  constructor(readonly elementClass: string) {
    super();
  }
  override eq(other: GutterMarker): boolean {
    return other instanceof LineClassMarker && other.elementClass === this.elementClass;
  }
}
const DIM_MARKER = new LineClassMarker("xpl-gutter-dim");
const HL_MARKER = new LineClassMarker("xpl-gutter-hl");

interface Decorated {
  decorations: DecorationSet;
  gutter: RangeSet<GutterMarker>;
}

const NO_DECORATIONS: Decorated = { decorations: Decoration.none, gutter: RangeSet.empty };

function decorate(doc: Text, focus: PaneFocus): Decorated {
  const lines = doc.lines;
  const roles: (Set<AnchorRole> | undefined)[] = new Array<Set<AnchorRole> | undefined>(lines + 1);
  for (const { range, role } of focus.ranges) {
    const to = Math.min(lines, range.endLine);
    for (let n = Math.max(1, range.startLine); n <= to; n++) (roles[n] ??= new Set()).add(role);
  }
  const items: Range<Decoration>[] = [];
  const markers: Range<GutterMarker>[] = [];
  for (let n = 1; n <= lines; n++) {
    const line = doc.line(n);
    const set = roles[n];
    let className = "";
    if (set) {
      className = "xpl-hl " + [...set].map((role) => `xpl-hl-${role}`).join(" ");
      markers.push(HL_MARKER.range(line.from));
    } else if (focus.dim) {
      className = "xpl-dim";
      markers.push(DIM_MARKER.range(line.from));
    }
    items.push(
      Decoration.line({
        ...(className ? { class: className } : {}),
        attributes: { "data-line": String(n) },
      }).range(line.from),
    );
  }
  // The expression itself, for ranges that carry columns (reference sites).
  const site = Decoration.mark({ class: "xpl-site" });
  for (const { range, role } of focus.ranges) {
    if ((role !== "call-site" && role !== "usage") || !range.startCol || !range.endCol) continue;
    if (range.startLine < 1 || range.endLine > lines) continue;
    const first = doc.line(range.startLine);
    const last = doc.line(range.endLine);
    const from = Math.min(first.from + range.startCol - 1, first.to);
    const to = Math.min(last.from + range.endCol, last.to);
    if (to > from) items.push(site.range(from, to));
  }
  return { decorations: Decoration.set(items, true), gutter: RangeSet.of(markers, true) };
}

const focusField = StateField.define<Decorated>({
  create: () => NO_DECORATIONS,
  update(value, tr) {
    for (const effect of tr.effects) {
      if (effect.is(setFocus)) return decorate(tr.state.doc, effect.value);
    }
    return value;
  },
  provide: (field) => [
    EditorView.decorations.from(field, (value) => value.decorations),
    gutterLineClass.from(field, (value) => value.gutter),
  ],
});

// ─── Caret <-> store ────────────────────────────────────────────────────────────────────────────

/** The lines the main selection covers (a selection ending at the start of a line does not include it). */
export function selectionLines(state: EditorState): { from: number; to: number } {
  const main = state.selection.main;
  const from = state.doc.lineAt(main.from);
  const to = state.doc.lineAt(main.to);
  const excludesLast = !main.empty && main.to === to.from && to.number > from.number;
  return { from: from.number, to: excludesLast ? to.number - 1 : to.number };
}

export interface EditorHandlers {
  /** The caret or selection moved (also when the editor is focused again). */
  onCursor(fromLine: number, toLine: number): void;
}

/**
 * A read-only editor: the document cannot change, but the caret and selection still work. The caller
 * owns the view and must `destroy()` it.
 */
export function createReadOnlyEditor(
  parent: HTMLElement,
  doc: string,
  language: FileLanguage,
  handlers?: EditorHandlers,
): EditorView {
  const extensions: Extension[] = [
    EditorState.readOnly.of(true),
    lineNumbers(),
    drawSelection(),
    syntaxHighlighting(themedHighlight),
    baseTheme,
    focusField,
    languageSupport(language),
  ];
  if (handlers) {
    extensions.push(
      EditorView.updateListener.of((update) => {
        if (update.selectionSet || (update.focusChanged && update.view.hasFocus)) {
          const { from, to } = selectionLines(update.state);
          handlers.onCursor(from, to);
        }
      }),
    );
  }
  return new EditorView({ parent, state: EditorState.create({ doc, extensions }) });
}

/** Applies focus decorations. */
export function applyFocus(view: EditorView, focus: PaneFocus): void {
  view.dispatch({ effects: setFocus.of(focus) });
}

/** Scrolls so that `line` is near the top of the editor. */
export function scrollToLine(view: EditorView, line: number): void {
  const doc = view.state.doc;
  const target = doc.line(Math.min(Math.max(1, line), doc.lines));
  view.dispatch({ effects: EditorView.scrollIntoView(target.from, { y: "start", yMargin: 44 }) });
}

/**
 * Puts the caret (one line) or a selection (several) where the store says, unless it already is
 * there. Goes through a normal transaction, so the update listener reports it like a user's move.
 */
export function placeCaret(
  view: EditorView,
  fromLine: number,
  toLine: number,
  scroll: boolean,
): void {
  const doc = view.state.doc;
  const a = doc.line(Math.min(Math.max(1, fromLine), doc.lines));
  const b = doc.line(Math.min(Math.max(a.number, toLine), doc.lines));
  const now = selectionLines(view.state);
  if (now.from === a.number && now.to === b.number) return;
  view.dispatch({
    selection:
      a.number === b.number ? EditorSelection.cursor(a.from) : EditorSelection.range(a.from, b.to),
    scrollIntoView: scroll,
  });
}

/** Line of the first focus range (the one to scroll to), or undefined. */
export function firstFocusLine(ranges: readonly FocusRange[]): number | undefined {
  let first: number | undefined;
  for (const { range } of ranges) {
    if (first === undefined || range.startLine < first) first = range.startLine;
  }
  return first;
}
