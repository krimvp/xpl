/**
 * CodeMirror 6 editors: read-only, syntax highlighted in colours that follow the page theme (CSS
 * variables), with the focus decorations of section 6:
 *
 *   xpl-hl, xpl-hl-<role>   line decorations for the lines of a focus range (a line can carry several
 *                           roles); xpl-site marks the exact call / usage expression when the range has columns
 *   xpl-hl-drifted          also on the lines of a drifted anchor: its code changed after the text was written,
 *                           so the lines may not be what the text describes
 *   xpl-dim                 every other line of a focused file
 *   data-line="<n>"         on every line, for tests and tooling
 *
 * The caret and selection stay live (read-only is not "not editable"): every caret or selection change
 * is reported as a range of lines, which the store turns into a reverse lookup.
 */
import { go } from "@codemirror/lang-go";
import { java } from "@codemirror/lang-java";
import { javascript } from "@codemirror/lang-javascript";
import { json } from "@codemirror/lang-json";
import { python } from "@codemirror/lang-python";
import { yaml } from "@codemirror/lang-yaml";
import { defaultHighlightStyle, HighlightStyle, syntaxHighlighting } from "@codemirror/language";
import {
  closeSearchPanel,
  findNext,
  findPrevious,
  getSearchQuery,
  search,
  searchKeymap,
  SearchQuery,
  setSearchQuery,
} from "@codemirror/search";
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
  hoverTooltip,
  keymap,
  lineNumbers,
  type Panel,
  ViewPlugin,
  WidgetType,
  type DecorationSet,
  type ViewUpdate,
} from "@codemirror/view";
import type { AnchorRole, FileLanguage, FilePath, FocusRange, IndexModel } from "@xpl/core";

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
    case "java":
      return java();
    case "yaml":
      return yaml();
    case "json":
      return json();
    case "toml":
      // No CodeMirror mode is installed for TOML (a legacy mode would be a new dependency): plain text.
      return [];
    case "rust":
    case "ruby":
    case "php":
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
  // (a wrapped line's indentation with its first character: see `hangingIndent`)
  ".xpl-indent": { whiteSpace: "pre" },
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
  // The find panel (`findPanel`) and its matches, in the page's colours (dark mode too).
  ".cm-panels": { backgroundColor: "var(--panel-2)", color: "var(--fg)" },
  ".cm-panels.cm-panels-top": { borderBottom: "1px solid var(--border)" },
  ".xpl-find": {
    display: "flex",
    alignItems: "center",
    gap: "6px",
    padding: "5px 8px",
    fontFamily: "var(--font-ui)",
    fontSize: "12.5px",
  },
  ".xpl-find-field": {
    flex: "0 1 240px",
    minWidth: "80px",
    padding: "3px 8px",
    border: "1px solid var(--border-strong)",
    borderRadius: "6px",
    background: "var(--panel)",
    color: "var(--fg)",
    font: "inherit",
  },
  ".xpl-find-field:focus": { outline: "2px solid var(--accent)", outlineOffset: "-1px" },
  ".xpl-find-count": { minWidth: "6em", color: "var(--muted)", whiteSpace: "nowrap" },
  ".xpl-find-button": {
    minWidth: "24px",
    height: "24px",
    padding: "0 6px",
    border: "1px solid transparent",
    borderRadius: "6px",
    background: "transparent",
    color: "var(--muted)",
    font: "inherit",
    fontSize: "14px",
    lineHeight: "1",
    cursor: "pointer",
  },
  ".xpl-find-button:hover, .xpl-find-button:focus-visible": {
    borderColor: "var(--border-strong)",
    background: "var(--panel)",
    color: "var(--fg)",
  },
  ".cm-searchMatch": {
    backgroundColor: "var(--find-match, rgba(255, 196, 0, 0.3))",
    outline: "1px solid rgba(214, 160, 0, 0.6)",
  },
  ".cm-searchMatch.cm-searchMatch-selected": {
    backgroundColor: "var(--find-current, rgba(255, 140, 0, 0.5))",
  },
  // A name's actions (`symbolActions`), in the page's colours.
  ".cm-tooltip.cm-tooltip-hover": {
    backgroundColor: "var(--panel)",
    color: "var(--fg)",
    border: "1px solid var(--border)",
    borderRadius: "8px",
    boxShadow: "0 4px 14px rgba(0, 0, 0, 0.16)",
  },
  ".xpl-symbol-tip": {
    display: "flex",
    alignItems: "center",
    gap: "6px",
    padding: "4px 6px",
    fontFamily: "var(--font-ui)",
    fontSize: "12px",
  },
  ".xpl-symbol-tip code": { fontFamily: "var(--font-mono)", marginRight: "2px" },
  ".xpl-symbol-action": {
    font: "inherit",
    color: "var(--accent)",
    background: "transparent",
    border: "1px solid var(--border)",
    borderRadius: "6px",
    padding: "2px 8px",
    cursor: "pointer",
  },
  ".xpl-symbol-action:hover, .xpl-symbol-action:focus-visible": {
    backgroundColor: "var(--hover)",
  },
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
  // A range over the whole file (a file box, a file opened on its own) tints nothing: a tint on every line
  // says nothing about any of them. The pane header still names the role.
  const ranges = focus.ranges.filter(
    ({ range }) => !(range.startLine <= 1 && range.endLine >= lines && lines > 1),
  );
  const dim = focus.dim && ranges.length === focus.ranges.length;
  const drifted = new Set<number>();
  for (const { range, role, status } of ranges) {
    const to = Math.min(lines, range.endLine);
    for (let n = Math.max(1, range.startLine); n <= to; n++) {
      (roles[n] ??= new Set()).add(role);
      if (status === "drifted") drifted.add(n);
    }
  }
  const items: Range<Decoration>[] = [];
  const markers: Range<GutterMarker>[] = [];
  for (let n = 1; n <= lines; n++) {
    const line = doc.line(n);
    const set = roles[n];
    let className = "";
    if (set) {
      className = "xpl-hl " + [...set].map((role) => `xpl-hl-${role}`).join(" ");
      if (drifted.has(n)) className += " xpl-hl-drifted";
      markers.push(HL_MARKER.range(line.from));
    } else if (dim) {
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
  /** Changed character spans, keyed by the pane's own source line numbers. */
  words?: ReadonlyMap<number, { from: number; to: number }>;
}

/** Base lines the change removed, placed above (`before`) or below (`after`) head line `at`. */
export interface RemovedLines {
  at: number;
  place: "before" | "after";
  /** Base line number of the first of them. */
  from: number;
  /** Their text; undefined while the code before the change is not loaded (or not in the page). */
  text: readonly string[] | undefined;
  words?: ReadonlyMap<number, { from: number; to: number }>;
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
      a.words === b.words &&
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
      for (const [index, text] of block.text.entries()) {
        const line = document.createElement("div");
        line.className = "xpl-removed-line";
        if (text === "") line.textContent = "\u200b";
        else {
          const span = block.words?.get(block.from + index);
          if (span && span.to > span.from) {
            appendBreakable(line, text.slice(0, span.from));
            const marked = document.createElement("span");
            marked.className = "xpl-word-del";
            appendBreakable(marked, text.slice(span.from, span.to));
            line.append(marked);
            appendBreakable(line, text.slice(span.to));
          } else appendBreakable(line, text);
        }
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
    const word = diff.words?.get(n);
    if (word && word.to > word.from && word.to <= line.text.length) {
      items.push(
        Decoration.mark({ class: gone ? "xpl-word-del" : "xpl-word-add" }).range(
          line.from + word.from,
          line.from + word.to,
        ),
      );
    }
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
  onCursor(fromLine: number, toLine: number, fromCol?: number, toCol?: number): void;
  /** Names in the code the index knows: who calls them, where they are defined. */
  symbols?: SymbolHandlers;
}

// ─── Find (Ctrl/Cmd+F) ──────────────────────────────────────────────────────────────────────────

/** Matches counted before "N+" is shown instead (a count, not a scan of a huge file on every key). */
const FIND_COUNT_MAX = 999;

/** Where the selection is among the matches: "3 of 12", "12 matches", "No matches". */
export function findCountWords(state: EditorState, query: SearchQuery): string {
  if (!query.search || !query.valid) return "";
  const main = state.selection.main;
  let total = 0;
  let current = 0;
  const cursor = query.getCursor(state);
  for (let next = cursor.next(); !next.done; next = cursor.next()) {
    total++;
    if (next.value.from === main.from && next.value.to === main.to) current = total;
    if (total > FIND_COUNT_MAX) break;
  }
  if (total === 0) return "No matches";
  if (total > FIND_COUNT_MAX) return `${FIND_COUNT_MAX}+ matches`;
  return current > 0 ? `${current} of ${total}` : `${total} ${total === 1 ? "match" : "matches"}`;
}

/**
 * The find panel, in the page's colours: a field (Enter: next match, Shift+Enter: previous, Escape: close),
 * "3 of 12", previous / next and close. Read-only: it finds, it never replaces.
 */
function findPanel(view: EditorView): Panel {
  const dom = document.createElement("div");
  dom.className = "xpl-find";
  dom.setAttribute("role", "search");
  const field = document.createElement("input");
  field.type = "text";
  field.className = "xpl-find-field";
  field.placeholder = "Find in this file";
  field.setAttribute("aria-label", "Find in this file");
  field.setAttribute("main-field", "true");
  field.value = getSearchQuery(view.state).search;
  const count = document.createElement("span");
  count.className = "xpl-find-count";
  count.setAttribute("aria-live", "polite");
  const button = (text: string, label: string, run: () => void) => {
    const element = document.createElement("button");
    element.type = "button";
    element.className = "xpl-find-button";
    element.textContent = text;
    element.setAttribute("aria-label", label);
    element.title = label;
    element.addEventListener("click", run);
    return element;
  };
  const query = () => new SearchQuery({ search: field.value });
  field.addEventListener("input", () => {
    view.dispatch({ effects: setSearchQuery.of(query()) });
  });
  field.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      (event.shiftKey ? findPrevious : findNext)(view);
    } else if (event.key === "Escape") {
      event.preventDefault();
      closeSearchPanel(view);
      view.focus();
    }
  });
  dom.append(
    field,
    count,
    button("‹", "Previous match (Shift+Enter)", () => findPrevious(view)),
    button("›", "Next match (Enter)", () => findNext(view)),
    button("×", "Close (Escape)", () => {
      closeSearchPanel(view);
      view.focus();
    }),
  );
  const refresh = (state: EditorState) => {
    count.textContent = findCountWords(state, getSearchQuery(state));
  };
  refresh(view.state);
  return {
    dom,
    top: true,
    mount() {
      field.focus();
      field.select();
    },
    update(update) {
      for (const tr of update.transactions)
        for (const effect of tr.effects)
          if (effect.is(setSearchQuery) && effect.value.search !== field.value)
            field.value = effect.value.search;
      refresh(update.state);
    },
  };
}

// ─── Names in the code ──────────────────────────────────────────────────────────────────────────

/** A name in the code that the index knows (`SymbolHandlers.resolve`). */
export interface CodeSymbol {
  /** `Ky.#calculateRetryDelay`. */
  label: string;
  /** Its definition is in a file this page can show, somewhere else than here. */
  canGo: boolean;
}

/**
 * What a reader can do with a name in the code: hovering it offers "Who calls it" and "Go to definition";
 * Ctrl/Cmd+click goes to the definition (or, when the page cannot show it, to who calls it); with the caret on
 * the name, F12 goes to the definition and Shift+F12 shows who calls it.
 */
export interface SymbolHandlers {
  resolve(line: number, word: string): CodeSymbol | undefined;
  callers(line: number, word: string): void;
  definition(line: number, word: string): void;
}

/** The name at a position: the word there and its line. */
function nameAt(
  state: EditorState,
  pos: number,
): { word: string; line: number; from: number; to: number } | undefined {
  const range = state.wordAt(pos);
  if (!range) return undefined;
  return {
    word: state.sliceDoc(range.from, range.to),
    line: state.doc.lineAt(pos).number,
    from: range.from,
    to: range.to,
  };
}

function symbolActions(handlers: SymbolHandlers): Extension {
  const act = (view: EditorView, pos: number, how: "callers" | "definition" | "best"): boolean => {
    const name = nameAt(view.state, pos);
    const symbol = name && handlers.resolve(name.line, name.word);
    if (!name || !symbol) return false;
    if (how === "callers" || (how === "best" && !symbol.canGo))
      handlers.callers(name.line, name.word);
    else handlers.definition(name.line, name.word);
    return true;
  };
  const button = (text: string, title: string, run: () => void) => {
    const element = document.createElement("button");
    element.type = "button";
    element.className = "xpl-symbol-action";
    element.textContent = text;
    element.title = title;
    element.addEventListener("click", run);
    return element;
  };
  return [
    hoverTooltip(
      (view, pos) => {
        const name = nameAt(view.state, pos);
        const symbol = name && handlers.resolve(name.line, name.word);
        if (!name || !symbol) return null;
        return {
          pos: name.from,
          end: name.to,
          above: true,
          create() {
            const dom = document.createElement("div");
            dom.className = "xpl-symbol-tip";
            dom.setAttribute("data-testid", "symbol-actions");
            const code = document.createElement("code");
            code.textContent = symbol.label;
            dom.append(
              code,
              button("Who calls it", "Show what calls it (Shift+F12)", () =>
                handlers.callers(name.line, name.word),
              ),
            );
            if (symbol.canGo)
              dom.append(
                button("Go to definition", "Open its code (F12, or Ctrl/Cmd+click the name)", () =>
                  handlers.definition(name.line, name.word),
                ),
              );
            return { dom };
          },
        };
      },
      { hoverTime: 400 },
    ),
    EditorView.domEventHandlers({
      mousedown(event, view) {
        if (event.button !== 0 || !(event.ctrlKey || event.metaKey)) return false;
        const pos = view.posAtCoords({ x: event.clientX, y: event.clientY });
        if (pos === null || !act(view, pos, "best")) return false;
        event.preventDefault();
        return true;
      },
    }),
    keymap.of([
      { key: "F12", run: (view) => act(view, view.state.selection.main.head, "best") },
      { key: "Shift-F12", run: (view) => act(view, view.state.selection.main.head, "callers") },
    ]),
  ];
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
const keepIndent = Decoration.mark({ class: "xpl-indent" });

/**
 * Where a wrapped line may break besides its spaces: after punctuation that is followed by more code
 * (`a.b`, `f(x`, `[i`, `a,b`, `=x`), so a long chain wraps at a dot or a bracket and never in the middle
 * of a name (the browser breaks inside a word only when a run has no such place at all). Drawn as a
 * zero-width space after the character (`.xpl-wbr` in styles.css): nothing is added to the text.
 */
const BREAK_AFTER = /[.,;:=([{|&?](?=[\w$#@"'`([{])/g;
const breakAfter = Decoration.mark({ class: "xpl-wbr" });

/** `text` appended to `parent` with a `<wbr>` at each place `BREAK_AFTER` finds (a removed line's text). */
function appendBreakable(parent: HTMLElement, text: string): void {
  let last = 0;
  for (const match of text.matchAll(BREAK_AFTER)) {
    const end = match.index + 1;
    parent.append(text.slice(last, end), document.createElement("wbr"));
    last = end;
  }
  parent.append(text.slice(last));
}

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
          // The indentation and the first character stay together: a long first word wraps (or breaks)
          // after them, never leaving the first row empty.
          const indent = line.text.length - line.text.trimStart().length;
          if (indent > 0 && indent < line.text.length)
            items.push(keepIndent.range(line.from, line.from + indent + 1));
          for (const match of line.text.matchAll(BREAK_AFTER)) {
            if (match.index > indent)
              items.push(breakAfter.range(line.from + match.index, line.from + match.index + 1));
          }
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
  label?: string,
): EditorView {
  const extensions: Extension[] = [
    wrapping.of(wrap ? wrapped : []),
    EditorState.readOnly.of(true),
    // Ctrl/Cmd+F finds in the file (read-only: the panel finds, it never replaces).
    search({ top: true, createPanel: findPanel }),
    keymap.of(searchKeymap),
    // An explicit tab stop on the code (it is one already, being editable): the scrolling area around it then
    // has focusable content, which checkers such as axe look for (scrollable-region-focusable).
    EditorView.contentAttributes.of({ tabindex: "0" }),
    ...(label
      ? [EditorView.contentAttributes.of({ "aria-label": label, "aria-readonly": "true" })]
      : []),
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
          const main = update.state.selection.main;
          const a = update.state.doc.line(from),
            b = update.state.doc.line(to);
          handlers.onCursor(
            from,
            to,
            main.empty ? undefined : main.from - a.from + 1,
            main.empty ? undefined : Math.min(b.length, main.to - b.from),
          );
        }
      }),
    );
    if (handlers.symbols) extensions.push(symbolActions(handlers.symbols));
  }
  return new EditorView({ parent, state: EditorState.create({ doc, extensions }) });
}

/** One stretch of what the change did in a pane: lines `from` to `to` (rows `rows`, removed lines included). */
export interface Hunk {
  from: number;
  to: number;
  rows: number;
}

/**
 * The changes in a pane, top to bottom: runs of added or rewritten lines with the removed lines next to them (a
 * head pane), or runs of removed lines (a "Before" pane). Each is where "next change" goes.
 */
export function paneHunks(diff: PaneDiff | null | undefined): Hunk[] {
  if (!diff) return [];
  // Every row the change touched, by the head (or base) line it sits at; removed lines count as rows there.
  const rows = new Map<number, number>();
  for (const line of diff.lines?.keys() ?? []) rows.set(line, (rows.get(line) ?? 0) + 1);
  for (const line of diff.gone ?? []) rows.set(line, (rows.get(line) ?? 0) + 1);
  for (const block of diff.removed ?? []) {
    rows.set(block.at, (rows.get(block.at) ?? 0) + Math.max(1, block.count));
  }
  const hunks: Hunk[] = [];
  for (const line of [...rows.keys()].sort((a, b) => a - b)) {
    const last = hunks[hunks.length - 1];
    if (last && line <= last.to + 1) {
      last.to = line;
      last.rows += rows.get(line)!;
    } else hunks.push({ from: line, to: line, rows: rows.get(line)! });
  }
  return hunks;
}

/**
 * Scrolls a change into view whole: its first line about a third of the way down, higher when the change is
 * too tall for that, never above the top edge.
 */
export function scrollToHunk(view: EditorView, hunk: Hunk): void {
  const height = view.scrollDOM.clientHeight;
  const tall = hunk.rows * view.defaultLineHeight;
  const margin = Math.max(22, Math.min(height / 3, height - tall - 22));
  scrollToLine(view, hunk.from, margin);
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
 * `scroll: "center"` (a jump: a caller row, go to definition) puts the line in the middle of the pane, with
 * the code around it; `true` scrolls just enough.
 */
export function placeCaret(
  view: EditorView,
  fromLine: number,
  toLine: number,
  scroll: boolean | "center",
  fromCol?: number,
  toCol?: number,
): void {
  const doc = view.state.doc;
  const a = doc.line(Math.min(Math.max(1, fromLine), doc.lines));
  const b = doc.line(Math.min(Math.max(a.number, toLine), doc.lines));
  const from = a.from + (fromCol === undefined ? 0 : Math.min(a.length, fromCol - 1));
  const to =
    toCol === undefined
      ? a.number === b.number
        ? from
        : b.to
      : b.from + Math.min(b.length, toCol);
  const now = view.state.selection.main;
  const lines = selectionLines(view.state);
  if (
    scroll !== "center" &&
    (fromCol === undefined && toCol === undefined
      ? lines.from === a.number && lines.to === b.number
      : now.from === from && now.to === to)
  )
    return;
  view.dispatch({
    selection: EditorSelection.range(from, to),
    ...(scroll === "center"
      ? { effects: EditorView.scrollIntoView(a.from, { y: "center" }) }
      : { scrollIntoView: scroll }),
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

/** A run of lines, `from` to `to`. */
export interface Span {
  from: number;
  to: number;
}

/**
 * The function a pane's "in X" chip names: the one that holds the code the pane is about, when its first line
 * is off screen. The code it is about: the first focus range on screen (from its first visible line), else the
 * first change on screen, else the top line. Context lines above the focus do not count: they are often the end
 * of the function before it. The caret, when it is on screen (after a jump to a caller, say), comes first: the
 * pane is about where the reader is. Undefined when that function's first line is on screen (it names itself).
 */
export function insideSymbol(
  index: Pick<IndexModel, "innermostSymbolAt">,
  file: FilePath,
  top: number,
  bottom: number,
  ranges: readonly Span[],
  hunks: readonly Span[],
  caret?: number,
): string | undefined {
  const firstOnScreen = (spans: readonly Span[]) =>
    spans
      .filter((span) => span.to >= top && span.from <= bottom)
      .map((span) => Math.max(span.from, top))
      .sort((a, b) => a - b)[0];
  const atCaret = caret !== undefined && caret >= top && caret <= bottom ? caret : undefined;
  const line = atCaret ?? firstOnScreen(ranges) ?? firstOnScreen(hunks) ?? top;
  const symbol = index.innermostSymbolAt(file, line);
  return symbol && symbol.range.startLine < top ? symbol.path : undefined;
}

/**
 * The change stepper's words: "12 changes", "change 2 / 12". A "Before" pane counts the places where lines were
 * removed (fewer than its head pane's changes, which also count pure additions): "removed in 7 places", "place 2 / 7".
 */
export function hunkWords(at: number, count: number, base: boolean): string {
  if (base)
    return at < 0
      ? `removed in ${count} ${count === 1 ? "place" : "places"}`
      : `place ${at + 1} / ${count}`;
  return at < 0 ? `${count} ${count === 1 ? "change" : "changes"}` : `change ${at + 1} / ${count}`;
}
