/**
 * The right side of Explore mode: one read-only CodeMirror editor per file in the current focus (the
 * primary file first), each under a file header. A pane keeps its editor while the file stays in the
 * focus, so the code does not flicker when the selection changes; decorations, scrolling and the caret
 * are pushed into the live editor instead.
 */
import type { EditorView } from "@codemirror/view";
import type { AnchorRole, FileLanguage } from "@xpl/core";
import { memo, useEffect, useRef } from "react";
import type { PaneSpec } from "../derive.js";
import {
  applyFocus,
  createReadOnlyEditor,
  firstFocusLine,
  placeCaret,
  scrollToLine,
} from "../editor.js";
import { useDerived, useStore, useViewerState } from "../hooks.js";
import type { Cursor } from "../store.js";

export function EditorStack() {
  const store = useStore();
  const state = useViewerState();
  const derived = useDerived();
  const { panes, overflow } = derived;

  // Server mode: fetch what the panes need.
  useEffect(() => {
    for (const pane of panes) void store.ensureFile(pane.file);
  }, [panes, store]);

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

  return (
    <div className="editor-stack">
      {panes.map((pane) => {
        const info = state.model.index.file(pane.file);
        return (
          <EditorPane
            key={pane.file}
            pane={pane}
            language={info?.language ?? "text"}
            lines={info?.lines ?? 0}
            text={state.files[pane.file]}
            error={state.fileErrors[pane.file]}
            cursor={state.cursor?.file === pane.file ? state.cursor : undefined}
            focusToken={derived.selection}
            openToken={state.openedFile === pane.file ? state.openSeq : 0}
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

interface PaneProps {
  pane: PaneSpec;
  language: FileLanguage;
  lines: number;
  text: string | undefined;
  error: string | undefined;
  cursor: Cursor | undefined;
  /** Changes when the selection changes: scroll to the first range again. */
  focusToken: unknown;
  /** Changes when the file is opened again explicitly. */
  openToken: number;
}

const ROLE_ORDER: AnchorRole[] = ["definition", "call-site", "usage", "config", "test"];

const EditorPane = memo(function EditorPane({
  pane,
  language,
  lines,
  text,
  error,
  cursor,
  focusToken,
  openToken,
}: PaneProps) {
  const store = useStore();
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView | null>(null);
  /** Counts editors created; lets the caret effect tell "just created" from "moved later". */
  const generation = useRef(0);
  const caretApplied = useRef(0);

  // The editor itself: created once the text is there, rebuilt only when file or text change.
  useEffect(() => {
    const parent = host.current;
    if (text === undefined || !parent) return;
    const editor = createReadOnlyEditor(parent, text, language, {
      onCursor: (from, to) => store.setCursor(pane.file, from, to),
    });
    view.current = editor;
    generation.current += 1;
    return () => {
      editor.destroy();
      view.current = null;
    };
  }, [pane.file, text, language, store]);

  // Decorations follow the focus.
  useEffect(() => {
    const editor = view.current;
    if (editor) applyFocus(editor, { ranges: pane.ranges, dim: pane.focused });
  }, [pane.ranges, pane.focused, text, pane.file, language]);

  // Scroll to the first range when the focus changes (or the file is opened again).
  useEffect(() => {
    const editor = view.current;
    if (!editor) return;
    const first = firstFocusLine(pane.ranges);
    if (first !== undefined) scrollToLine(editor, first);
    else if (openToken > 0) scrollToLine(editor, 1);
    // `pane.ranges` belongs to this very `focusToken`; the token is what says "the focus changed".
  }, [focusToken, openToken, text, pane.file, language]);

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
  const slash = pane.file.lastIndexOf("/");
  return (
    <section
      className={"pane" + (pane.focused ? " is-focused" : "") + (pane.opened ? " is-opened" : "")}
      data-file={pane.file}
    >
      <header className="pane-header">
        <span className="pane-file" title={pane.file}>
          {slash !== -1 && <span className="dir">{pane.file.slice(0, slash + 1)}</span>}
          <b>{pane.file.slice(slash + 1)}</b>
        </span>
        <span className="pane-meta">
          {language} · {lines} lines
        </span>
        <span className="pane-roles">
          {roles.map((role) => (
            <span key={role} className={`role role-${role}`}>
              {role}
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
            {error ? `Source unavailable: ${error}` : "Loading…"}
          </div>
        ) : (
          <div className="editor-host" ref={host} />
        )}
      </div>
    </section>
  );
});
