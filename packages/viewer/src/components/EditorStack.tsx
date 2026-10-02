/**
 * The code side of both modes: one read-only CodeMirror editor per file in the current focus (the
 * primary file first), each under a file header. A pane keeps its editor while the file stays in the
 * focus, so the code does not flicker when the selection changes; decorations, scrolling and the caret
 * are pushed into the live editor instead.
 */
import type { EditorView } from "@codemirror/view";
import {
  shortSha,
  splitLines,
  type AnchorRole,
  type ChangedFile,
  type FileLanguage,
  type FocusRange,
} from "@xpl/core";
import { memo, useEffect, useMemo, useRef, type CSSProperties } from "react";
import type { PaneSpec } from "../derive.js";
import { changeAt, changeOf, fileDiff, languageOfPath, needsBase, paneDiff } from "../diff.js";
import {
  applyDiff,
  applyFocus,
  setLineWrapping,
  createReadOnlyEditor,
  firstFocusLine,
  placeCaret,
  scrollToLine,
} from "../editor.js";
import { useDerived, useStore, useViewerState } from "../hooks.js";
import { roleWords } from "../readerWords.js";
import type { Cursor } from "../store.js";

export function EditorStack() {
  const store = useStore();
  const state = useViewerState();
  const derived = useDerived();
  const { panes, overflow } = derived;

  const change = changeOf(state.explainer);
  // Server mode: fetch what the panes need (the code before the change too: a "before" pane, and the
  // removed lines a changed file shows between its own).
  useEffect(() => {
    for (const pane of panes) {
      if (pane.side === "base") void store.ensureBaseFile(pane.file);
      else {
        void store.ensureFile(pane.file);
        if (state.showChanges && needsBase(change, pane.file)) void store.ensureBaseFile(pane.file);
      }
    }
  }, [panes, store, change, state.showChanges]);

  if (panes.length === 0) {
    return (
      <div className="editor-stack is-empty">
        <div className="empty-hint">
          <h2>No code on screen</h2>
          <p>
            Click a box, an arrow, a step or a concept and its code shows up here, highlighted and
            with everything else dimmed. Or pick a file in the tree.
          </p>
          <p>
            You can also click into the code: the diagram elements that explain that line light up.
          </p>
        </div>
      </div>
    );
  }

  const present = state.mode === "present";
  // Read mode and Present are for readers: plain words on the panes.
  const reader = present || state.perspective !== "explore";
  return (
    <div className="editor-stack">
      {panes.map((pane, i) => {
        const info = state.model.index.file(pane.file);
        const base = pane.side === "base";
        const changed = changeAt(change, pane.file);
        const text = base ? state.baseFiles[pane.file] : state.files[pane.file];
        return (
          <EditorPane
            key={`${base ? "base" : "head"}:${pane.file}`}
            pane={pane}
            wantLines={
              present
                ? paneLines(pane) + (state.showChanges ? removedInFocus(pane, changed) : 0)
                : undefined
            }
            reader={reader}
            shrink={paneShrink(i)}
            language={info?.language ?? languageOfPath(pane.file)}
            lines={info && !base ? info.lines : text !== undefined ? splitLines(text).length : 0}
            text={text}
            error={base ? state.baseErrors[pane.file] : state.fileErrors[pane.file]}
            cursor={!base && state.cursor?.file === pane.file ? state.cursor : undefined}
            focusToken={derived.selection}
            openToken={
              state.openedFile === pane.file && state.openedBase === base ? state.openSeq : 0
            }
            changed={changed}
            baseSha={change ? shortSha(change.base) : undefined}
            baseText={changed && !base ? state.baseFiles[pane.file] : undefined}
            baseError={changed && !base ? state.baseErrors[pane.file] : undefined}
            showChanges={state.showChanges}
          />
        );
      })}
      {overflow.length > 0 && (
        <div className="overflow" role="note">
          {overflow.length} more file{overflow.length === 1 ? "" : "s"} in the focus:{" "}
          {overflow.map((file, i) => (
            <span key={file}>
              {i > 0 && ", "}
              <button type="button" className="link" onClick={() => store.openFile(file)}>
                {file}
              </button>
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

/** Lines covered by the ranges, overlaps counted once. */
export function focusedLineCount(ranges: readonly FocusRange[]): number {
  const spans = ranges
    .map((r) => [r.range.startLine, r.range.endLine] as const)
    .sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  let total = 0;
  let end = 0;
  for (const [from, to] of spans) {
    const start = Math.max(from, end + 1);
    if (to >= start) total += to - start + 1;
    end = Math.max(end, to);
  }
  return total;
}

/**
 * A pane in a talk is as tall as its focus (3 to 12 lines) plus a line of context; a file that was only
 * opened gets 6 lines.
 */
export function paneLines(pane: PaneSpec): number {
  if (!pane.focused) return 6;
  return Math.min(12, Math.max(3, focusedLineCount(pane.ranges))) + 1;
}

/**
 * Present: the removed lines a changed file shows between the lines of a pane's focus (they take rows too),
 * so that the pane is tall enough for both; at most 8.
 */
function removedInFocus(pane: PaneSpec, changed: ChangedFile | undefined): number {
  if (!changed || changed.status === "added" || pane.side === "base" || !pane.focused) return 0;
  const first = firstFocusLine(pane.ranges) ?? 0;
  const last = Math.max(...pane.ranges.map((r) => r.range.endLine));
  let count = 0;
  for (const block of fileDiff(changed).removed) {
    if (block.at >= first && block.at <= last) count += block.to - block.from + 1;
  }
  return Math.min(8, count);
}

/**
 * flex-shrink of the i-th pane: 0 for the first, then 1, 100, 10000, ...: when the column is too short the
 * last pane gives way first (down to its minimum), then the one above it, and the first pane never does.
 */
export function paneShrink(index: number): number {
  return index === 0 ? 0 : 100 ** Math.min(index - 1, 6);
}

interface PaneProps {
  pane: PaneSpec;
  /**
   * Present mode only: how many lines of code the pane wants to show (its focus plus context). `shrink` is
   * its flex-shrink: 0 for the first pane, more for each one below, so the first pane keeps its focus in view.
   */
  wantLines: number | undefined;
  shrink: number;
  /** A reader view: plain words for the roles ("called here"), no language and line count. */
  reader: boolean;
  language: FileLanguage;
  lines: number;
  text: string | undefined;
  error: string | undefined;
  cursor: Cursor | undefined;
  /** Changes when the selection changes: scroll to the first range again. */
  focusToken: unknown;
  /** Changes when the file is opened again explicitly. */
  openToken: number;
  /** The file's entry in the explainer's change record, when the change touched it. */
  changed: ChangedFile | undefined;
  /** `85c3b74`: the base commit of the change, for the "Before" label. */
  baseSha: string | undefined;
  /** A head pane of a changed file: the code before the change (for the removed lines), when loaded. */
  baseText: string | undefined;
  baseError: string | undefined;
  /** The "Show changes" toggle. */
  showChanges: boolean;
}

const ROLE_ORDER: AnchorRole[] = ["definition", "call-site", "usage", "config", "test"];

const EditorPane = memo(function EditorPane({
  pane,
  wantLines,
  shrink,
  reader,
  language,
  lines,
  text,
  error,
  cursor,
  focusToken,
  openToken,
  changed,
  baseSha,
  baseText,
  baseError,
  showChanges,
}: PaneProps) {
  const store = useStore();
  const base = pane.side === "base";
  const baseLines = useMemo(
    () => (baseText !== undefined ? splitLines(baseText) : undefined),
    [baseText],
  );
  const diff = useMemo(
    () => (showChanges ? paneDiff(pane.side, changed, baseLines, baseError) : null),
    [showChanges, pane.side, changed, baseLines, baseError],
  );
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView | null>(null);
  /** Counts editors created; lets the caret effect tell "just created" from "moved later". */
  const generation = useRef(0);
  const caretApplied = useRef(0);
  const wrap = wantLines !== undefined;
  // (read when an editor is created: it starts wrapped or not, the effect below follows changes)
  const wrapRef = useRef(wrap);
  wrapRef.current = wrap;

  // The editor itself: created once the text is there, rebuilt only when file or text change.
  useEffect(() => {
    const parent = host.current;
    if (text === undefined || !parent) return;
    const editor = createReadOnlyEditor(
      parent,
      text,
      language,
      // The lines of a "before" pane are lines of the old code: the caret there looks nothing up.
      base ? undefined : { onCursor: (from, to) => store.setCursor(pane.file, from, to) },
      wrapRef.current,
    );
    view.current = editor;
    generation.current += 1;
    return () => {
      editor.destroy();
      view.current = null;
    };
  }, [pane.file, text, language, store, base]);

  // Present wraps long lines (nobody scrolls sideways in a talk); elsewhere code runs on as written.
  useEffect(() => {
    if (view.current) setLineWrapping(view.current, wrap);
  }, [wrap, text]);

  // Decorations follow the focus, and the change.
  useEffect(() => {
    const editor = view.current;
    if (editor) applyFocus(editor, { ranges: pane.ranges, dim: pane.dim });
  }, [pane.ranges, pane.dim, text, pane.file, language]);
  useEffect(() => {
    const editor = view.current;
    if (editor) applyDiff(editor, diff);
  }, [diff, text, pane.file, language]);

  // Scroll to the range the step is about when the focus changes (or the file is opened again): the first
  // one in the step's order (`pane.lead`), else the lowest.
  useEffect(() => {
    const editor = view.current;
    if (!editor) return;
    const first = pane.lead ?? firstFocusLine(pane.ranges);
    // Lines the change removed just above that line are part of what to see: leave room for them.
    const above =
      diff?.removed
        ?.filter((block) => block.place === "before" && block.at === first)
        .reduce((sum, block) => sum + (block.text ? block.count : 1), 0) ?? 0;
    const margin = (wantLines !== undefined ? 22 : 44) + above * editor.defaultLineHeight;
    if (first !== undefined) scrollToLine(editor, first, margin);
    else if (openToken > 0) scrollToLine(editor, 1);
    // `pane.ranges` belongs to this very `focusToken`; the token is what says "the focus changed". (The
    // diff is applied by the effect above in the same commit; turning it on or off does not scroll.)
  }, [focusToken, openToken, text, pane.file, language, wantLines !== undefined]);

  // The caret follows the store (window.__xpl.setCursor, anchor clicks); a real click already is the store.
  useEffect(() => {
    const editor = view.current;
    if (!editor || !cursor) return;
    // A freshly created editor only gets its position back (scrolling belongs to the focus effect
    // above, unless the file was just opened on purpose); a later move is shown where it happens.
    const fresh = caretApplied.current !== generation.current;
    caretApplied.current = generation.current;
    placeCaret(editor, cursor.fromLine, cursor.toLine, !fresh || openToken > 0);
  }, [cursor, text, pane.file, language, openToken]);

  const roles = ROLE_ORDER.filter((role) => pane.ranges.some((r) => r.role === role));
  const stale = pane.ranges.filter((r) => r.status === "drifted" || r.status === "moved");
  // A "before" pane of a renamed file shows the path it had then.
  const shown =
    base && changed?.status === "renamed" && changed.oldPath ? changed.oldPath : pane.file;
  const slash = shown.lastIndexOf("/");
  const status =
    changed && (!base || changed.status === "deleted") ? changeLabel(changed) : undefined;
  return (
    <section
      className={
        "pane" +
        (pane.focused ? " is-focused" : "") +
        (pane.opened ? " is-opened" : "") +
        (base ? " is-base" : "")
      }
      data-file={pane.file}
      data-side={base ? "base" : "head"}
      style={
        wantLines !== undefined
          ? ({ "--pane-lines": wantLines, "--pane-shrink": shrink } as CSSProperties)
          : undefined
      }
    >
      <header className="pane-header">
        {base && (
          <span
            className="pane-side"
            data-testid="pane-before"
            title="The code before the change, read-only. Its line numbers are the old ones."
          >
            Before{baseSha ? ` (base ${baseSha})` : ""}
          </span>
        )}
        <span className="pane-file" title={shown}>
          {slash !== -1 && <span className="dir">{shown.slice(0, slash + 1)}</span>}
          <b>{shown.slice(slash + 1)}</b>
        </span>
        {status && (
          <span
            className={`pane-change is-${changed!.status}`}
            data-testid="pane-change"
            title={status.title}
          >
            {status.text}
          </span>
        )}
        {!reader && (
          <span className="pane-meta">
            {language} · {lines} lines
          </span>
        )}
        {changed && !base && changed.status !== "deleted" && (
          <button
            type="button"
            className="pane-toggle"
            data-testid="show-changes"
            aria-pressed={showChanges}
            title={
              showChanges
                ? "Hide what the change added and removed: show the code as it is"
                : "Mark the lines the change added and show the lines it removed"
            }
            onClick={() => store.setShowChanges(!showChanges)}
          >
            Show changes
          </button>
        )}
        <span className="pane-roles">
          {roles.map((role) => (
            <span key={role} className={`role role-${role}`} data-role={role}>
              {reader ? roleWords(role) : role}
            </span>
          ))}
          {stale.some((r) => r.status === "drifted") && (
            <span className="badge status-drifted" title="An anchor in this file drifted">
              drifted
            </span>
          )}
        </span>
        {pane.opened && !pane.focused && (
          <button
            type="button"
            className="pane-close"
            aria-label={`Close ${pane.file}`}
            title="Close"
            onClick={() => store.closeOpenedFile()}
          >
            ×
          </button>
        )}
      </header>
      <div className="pane-body">
        {text === undefined ? (
          <div className={"pane-message" + (error ? " is-error" : "")}>
            {error
              ? `${base ? "Code before the change unavailable" : "Source unavailable"}: ${error}`
              : "Loading…"}
          </div>
        ) : (
          <div className="editor-host" ref={host} />
        )}
      </div>
    </section>
  );
});

/** What the change did to a file, in a pane's header: "New file", "Changed", "Renamed from old/path". */
function changeLabel(file: ChangedFile): { text: string; title: string } {
  switch (file.status) {
    case "added":
      return { text: "New file", title: "This change adds the file" };
    case "modified":
      return { text: "Changed", title: "This change edits the file" };
    case "renamed":
      return {
        text: `Renamed from ${file.oldPath ?? "?"}`,
        title: `This change moves ${file.oldPath ?? "the file"} here`,
      };
    case "deleted":
      return { text: "Removed", title: "This change removes the file" };
  }
}
