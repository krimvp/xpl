/** Save requests for the next explicit pass; capture and outcomes remain separate from author edits. */
import { useEffect, useRef, useState } from "react";
import { artifactIdentity, feedbackContextReason, type FeedbackKind } from "@xpl/core";
import { useStore, useViewerState } from "../hooks.js";
import { messageOf } from "../data.js";

export function FeedbackPanel({ onClose }: { onClose: () => void }) {
  const store = useStore();
  const state = useViewerState();
  const [kind, setKind] = useState<FeedbackKind>("explain");
  const [note, setNote] = useState("");
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const panel = useRef<HTMLElement>(null);
  const id = state.selection[0];
  const current = artifactIdentity(state.explainer, state.model.index.index);
  useEffect(() => {
    panel.current?.focus();
    void store
      .refreshFeedback()
      .catch((error) =>
        setMessage(
          `Could not read disk feedback: ${messageOf(error)}. Your browser feedback can still be exported.`,
        ),
      );
  }, [store]);
  return (
    <section
      ref={panel}
      tabIndex={-1}
      className="tour-panel feedback-panel"
      role="dialog"
      aria-label="Reader feedback"
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.stopPropagation();
          onClose();
        }
      }}
    >
      <header className="tp-head">
        <h2>Feedback for the next pass</h2>
        <button type="button" className="icon-btn" aria-label="Close feedback" onClick={onClose}>
          ×
        </button>
      </header>
      <p className="tp-intro">
        Saving feedback does not start generation. Export the JSON from a saved page, run{" "}
        <code>xpl feedback &lt;guide&gt; --import feedback.json</code> locally, then invoke{" "}
        <code>/code-explainer feedback</code> in your chosen agent.
      </p>
      <p>
        {id ? (
          <>
            Selected: <strong>{state.model.label(id)}</strong>
          </>
        ) : (
          "Select a box, arrow, concept or step to attach feedback."
        )}
        {state.cursor && (
          <>
            {" "}
            · {state.cursor.file}:{state.cursor.fromLine}–{state.cursor.toLine} (
            {state.cursor.side === "base" ? "before" : "current"} source)
          </>
        )}
      </p>
      <label>
        Request{" "}
        <select
          aria-label="Request kind"
          value={kind}
          onChange={(event) => setKind(event.target.value as FeedbackKind)}
        >
          <option value="correct">Correction</option>
          <option value="explain">Explanation</option>
          <option value="expand">Expansion</option>
        </select>
      </label>
      <label>
        What should change?
        <textarea
          className="feedback"
          aria-label="Feedback note"
          value={note}
          onChange={(event) => setNote(event.target.value)}
          rows={3}
          maxLength={5000}
        />
      </label>
      <div className="actions">
        <button
          className="btn is-primary"
          type="button"
          disabled={!id || busy}
          onClick={async () => {
            if (!id) return;
            setBusy(true);
            try {
              await store.requestExplain(id, note, kind);
              setNote("");
              setMessage(
                state.serverMode
                  ? "Saved to disk for the next explicit pass."
                  : "Saved in this browser. Export feedback JSON to carry it to your repository.",
              );
            } catch (error) {
              setMessage(
                `Disk save failed: ${messageOf(error)}. The request remains in this page; export it for retry.`,
              );
            } finally {
              setBusy(false);
            }
          }}
        >
          Save feedback
        </button>
        <button
          className="btn"
          type="button"
          disabled={state.feedback.length === 0}
          onClick={() => {
            const url = URL.createObjectURL(
              new Blob([store.feedbackJson()], { type: "application/json" }),
            );
            const link = document.createElement("a");
            link.href = url;
            link.download = "feedback.json";
            link.click();
            setTimeout(() => URL.revokeObjectURL(url), 1000);
          }}
        >
          Export feedback JSON
        </button>
      </div>
      {message && (
        <p role="status" className="note">
          {message}
        </p>
      )}
      {state.feedbackStorageError && (
        <p role="alert" className="note is-error">
          {state.feedbackStorageError}
        </p>
      )}
      <ul className="feedback-list">
        {state.feedback.map((request) => {
          const outdated = feedbackContextReason(request, current) ?? state.sourceWarning;
          return (
            <li key={request.id}>
              <strong>
                {request.kind}: {request.label ?? request.elementId}
              </strong>{" "}
              · {request.outcome.status}
              {outdated ? " · outdated context" : ""}
              {request.note && <p>{request.note}</p>}
              {request.range && (
                <p>
                  {request.range.file}:{request.range.fromLine}–{request.range.toLine} (
                  {request.range.side})
                </p>
              )}
              <p>{request.outcome.reason}</p>
              {outdated && <p>{outdated}</p>}
              <code>{request.id}</code>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
