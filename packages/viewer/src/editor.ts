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
  Compartment,
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
  gutter,
  gutterLineClass,
  GutterMarker,
  lineNumbers,
  ViewPlugin,
  WidgetType,
  type DecorationSet,
  type ViewUpdate,
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
    case "toml":
      // No CodeMirror mode is installed for TOML (a legacy mode would be a new dependency): plain text.
      return [];
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
    fontSize: "var(--code-font-size, 12.5px)",
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

// ─── The change: what it added, rewrote and removed ─────────────────────────────────────────────

/**
 * What the change did to the file a pane shows (diff.ts computes it from the hunks):
 *
 * - a pane of the code as it is now: `lines` are the lines the change added (`added`) or rewrote (`changed`),
 *   and `removed` the base lines it took out, shown between the head lines where they were, read-only;
 * - a pane of the code before the change: `gone` are the base lines it removes or rewrites.
 *
 * Classes: `xpl-add` / `xpl-chg` on head lines, `xpl-gone` on base lines, `xpl-removed` on the block of removed
 * lines; a narrow gutter (`xpl-diff-gutter`) says the same with + and − for people who do not see colour.
 */
export interface PaneDiff {
  lines?: ReadonlyMap<number, "added" | "changed">;
  removed?: readonly RemovedLines[];
  gone?: ReadonlySet<number>;
}

/** Base lines the change removed, placed above (`before`) or below (`after`) head line `at`. */
export interface RemovedLines {
  at: number;
  place: "before" | "after";
  /** Base line number of the first of them. */
  from: number;
  /** Their text; undefined while the code before the change is not loaded (or not in the page). */
  text: readonly string[] | undefined;
  /** How many lines (also when `text` is missing). */
  count: number;
  /** Why the text is missing, when it is. */
  missing?: string;
}

export const setDiff = StateEffect.define<PaneDiff | null>();

/** The removed lines, as a read-only block between the lines of the code. */
class RemovedWidget extends WidgetType {
  constructor(readonly block: RemovedLines) {
    super();
  }
  override eq(other: WidgetType): boolean {
    if (!(other instanceof RemovedWidget)) return false;
    const a = this.block;
    const b = other.block;
    return (
      a.at === b.at &&
      a.place === b.place &&
      a.from === b.from &&
      a.count === b.count &&
      a.missing === b.missing &&
      (a.text === b.text || (a.text?.join("\n") ?? "") === (b.text?.join("\n") ?? ""))
    );
  }
  toDOM(): HTMLElement {
    const { block } = this;
    const dom = document.createElement("div");
    dom.className = "xpl-removed";
    dom.setAttribute("data-removed-from", String(block.from));
    dom.setAttribute("data-at", `${block.place}:${block.at}`);
    dom.setAttribute("data-removed-count", String(block.count));
    const to = block.from + block.count - 1;
    dom.title =
      block.count === 1
        ? `Removed by this change (line ${block.from} before the change)`
        : `Removed by this change (lines ${block.from}–${to} before the change)`;
    if (block.text) {
      for (const text of block.text) {
        const line = document.createElement("div");
        line.className = "xpl-removed-line";
        line.textContent = text === "" ? "\u200b" : text;
        // the hanging indent of a wrapped code line (see `hangingIndent`); one row looks the same either way
        const columns = indentColumns(text) + 2;
        line.style.paddingLeft = `calc(8px + ${columns}ch)`;
        line.style.textIndent = `-${columns}ch`;
        dom.append(line);
      }
    } else {
      const line = document.createElement("div");
      line.className = "xpl-removed-line is-note";
      line.textContent = `${block.count} line${block.count === 1 ? "" : "s"} removed${block.missing ? ` (${block.missing})` : ""}`;
      dom.append(line);
    }
    return dom;
  }
  override get estimatedHeight(): number {
    return -1;
  }
  override ignoreEvent(): boolean {
    return false;
  }
}

class DiffMarker extends GutterMarker {
  constructor(
    readonly text: string,
    readonly kind: string,
    readonly title: string,
  ) {
    super();
    // the cell is tinted too (styles.css): a line in the focus keeps the focus colour, the cell says "changed"
    this.elementClass = `xpl-diff-${kind}`;
  }
  override readonly elementClass: string;
  override eq(other: GutterMarker): boolean {
    return other instanceof DiffMarker && other.kind === this.kind;
  }
  override toDOM(): Node {
    const span = document.createElement("span");
    span.className = `xpl-diff-mark is-${this.kind}`;
    span.textContent = this.text;
    span.title = this.title;
    return span;
  }
}
const ADDED_MARKER = new DiffMarker("+", "added", "Added by this change");
const CHANGED_MARKER = new DiffMarker(
  "+",
  "changed",
  "Rewritten by this change (the old lines are shown above it)",
);
const GONE_MARKER = new DiffMarker("−", "gone", "Removed or rewritten by this change");
const REMOVED_MARKER = new DiffMarker("−", "removed", "Removed by this change");
const SPACER_MARKER = new DiffMarker("+", "spacer", "");

interface Diffed {
  decorations: DecorationSet;
  markers: RangeSet<GutterMarker>;
}

const NO_DIFF: Diffed = { decorations: Decoration.none, markers: RangeSet.empty };

function decorateDiff(doc: Text, diff: PaneDiff): Diffed {
  const items: Range<Decoration>[] = [];
  const markers: Range<GutterMarker>[] = [];
  const total = doc.lines;
  for (let n = 1; n <= total; n++) {
    const mark = diff.lines?.get(n);
    const gone = diff.gone?.has(n);
    if (!mark && !gone) continue;
    const line = doc.line(n);
    const kind = mark === "added" ? "xpl-add" : mark === "changed" ? "xpl-chg" : "xpl-gone";
    items.push(Decoration.line({ class: kind }).range(line.from));
    markers.push(
      (mark === "added" ? ADDED_MARKER : mark === "changed" ? CHANGED_MARKER : GONE_MARKER).range(
        line.from,
      ),
    );
  }
  for (const block of diff.removed ?? []) {
    if (block.count <= 0) continue;
    const line = doc.line(Math.min(Math.max(1, block.at), total));
    const before = block.place === "before";
    items.push(
      Decoration.widget({
        widget: new RemovedWidget(block),
        block: true,
        side: before ? -1 : 1,
      }).range(before ? line.from : line.to),
    );
  }
  return {
    decorations: Decoration.set(items, true),
    markers: RangeSet.of(markers, true),
  };
}

const diffField = StateField.define<Diffed>({
  create: () => NO_DIFF,
  update(value, tr) {
    for (const effect of tr.effects) {
      if (effect.is(setDiff))
        return effect.value ? decorateDiff(tr.state.doc, effect.value) : NO_DIFF;
    }
    return value;
  },
  provide: (field) => EditorView.decorations.from(field, (value) => value.decorations),
});

/** The + and − column, only while a diff is shown. */
const diffGutter = new Compartment();
const diffGutterOn = gutter({
  class: "xpl-diff-gutter",
  markers: (view) => view.state.field(diffField).markers,
  widgetMarker: (_view, widget) => (widget instanceof RemovedWidget ? REMOVED_MARKER : null),
  initialSpacer: () => SPACER_MARKER,
});

/** Shows what the change did in this editor (null: the code as it is, with nothing marked). */
export function applyDiff(view: EditorView, diff: PaneDiff | null): void {
  const on = diff !== null;
  const wasOn = view.state.field(diffField) !== NO_DIFF;
  view.dispatch({
    effects: [
      setDiff.of(diff),
      ...(on !== wasOn ? [diffGutter.reconfigure(on ? diffGutterOn : [])] : []),
    ],
  });
}

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

/** Long lines wrap (Present: nobody scrolls sideways in a talk) or run on (elsewhere: code as written). */
const wrapping = new Compartment();

/** The columns of a line's leading whitespace (a tab counts 4). */
export function indentColumns(text: string): number {
  let columns = 0;
  for (const char of text) {
    if (char === " ") columns += 1;
    else if (char === "\t") columns += 4;
    else break;
  }
  return columns;
}

/**
 * A wrapped line keeps the shape of the code: its continuation starts under the line's own indentation
 * plus two columns, not at the left edge (a hanging indent, drawn with `text-indent` and `padding-left`).
 * Only the lines in view are decorated.
 */
const hangingIndent = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;
    constructor(view: EditorView) {
      this.decorations = this.build(view);
    }
    update(update: ViewUpdate) {
      if (update.docChanged || update.viewportChanged) this.decorations = this.build(update.view);
    }
    build(view: EditorView): DecorationSet {
      const items: Range<Decoration>[] = [];
      for (const { from, to } of view.visibleRanges) {
        for (let pos = from; pos <= to;) {
          const line = view.state.doc.lineAt(pos);
          const columns = indentColumns(line.text) + 2;
          items.push(
            Decoration.line({
              attributes: {
                style: `padding-left: calc(8px + ${columns}ch); text-indent: -${columns}ch`,
              },
            }).range(line.from),
          );
          pos = line.to + 1;
        }
      }
      return Decoration.set(items, true);
    }
  },
  { decorations: (plugin) => plugin.decorations },
);

const wrapped = [EditorView.lineWrapping, hangingIndent];

/** Turns line wrapping on or off in an editor made by `createReadOnlyEditor`. */
export function setLineWrapping(view: EditorView, on: boolean): void {
  view.dispatch({ effects: wrapping.reconfigure(on ? wrapped : []) });
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
  wrap = false,
): EditorView {
  const extensions: Extension[] = [
    wrapping.of(wrap ? wrapped : []),
    EditorState.readOnly.of(true),
    lineNumbers(),
    diffGutter.of([]),
    diffField,
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

/**
 * Scrolls so that `line` is near the top of the editor, `margin` px (default 44) below its edge. Lines the
 * change removed right above it (a block drawn before the line) are part of what to see: once they are drawn
 * (their height is only known then, a long line wraps), the editor scrolls up again if they are cut off.
 */
export function scrollToLine(view: EditorView, line: number, margin = 44): void {
  const doc = view.state.doc;
  const n = Math.min(Math.max(1, line), doc.lines);
  const target = doc.line(n);
  view.dispatch({
    effects: EditorView.scrollIntoView(target.from, { y: "start", yMargin: margin }),
  });
  if (view.state.field(diffField) === NO_DIFF) return;
  requestAnimationFrame(() => {
    if (!view.dom.isConnected) return;
    view.requestMeasure({
      read(v) {
        const block = v.contentDOM.querySelector<HTMLElement>(
          `.xpl-removed[data-at="before:${n}"]`,
        );
        if (!block) return 0;
        return block.getBoundingClientRect().top - v.scrollDOM.getBoundingClientRect().top - 6;
      },
      write(cut, v) {
        if (cut < 0) v.scrollDOM.scrollTop += cut;
      },
    });
  });
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
