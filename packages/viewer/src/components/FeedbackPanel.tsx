/** Questions and answers are feedback history; guide changes still require explicit revision review. */
import { useEffect, useRef, useState } from "react";
import {
  artifactIdentity,
  feedbackContextReason,
  hashText,
  type FeedbackKind,
  type FeedbackAnswer,
  type AnswerReference,
} from "@xpl/core";
import { useStore, useViewerState } from "../hooks.js";
import { messageOf } from "../data.js";

function AnswerEvidence({
  answer,
  reference,
}: {
  answer: FeedbackAnswer;
  reference: AnswerReference;
}) {
  const store = useStore();
  const [recorded, setRecorded] = useState(false);
  const [error, setError] = useState("");
  return (
    <div className="answer-evidence">
      <button
        className="btn"
        type="button"
        onClick={async () => {
          const base = reference.side === "base";
          if (base) await store.ensureBaseFile(reference.file);
          else await store.ensureFile(reference.file);
          const state = store.getState();
          const text = (base ? state.baseFiles : state.files)[reference.file];
          const source = answer.sources.find(
            (s) => s.file === reference.file && s.side === reference.side,
          );
          if (text === undefined || !source || hashText(text) !== source.hash) {
            setRecorded(true);
            setError(
              "Current source differs or is unavailable. These highlighted lines are the recorded answer evidence.",
            );
            return;
          }
          store.setPerspective("code");
          store.openFile(reference.file, reference.fromLine, base ? "base" : undefined);
          store.setCursor(reference.file, reference.fromLine, reference.toLine, reference.side);
          store.closeFeedback();
        }}
      >
        {reference.file}:{reference.fromLine}–{reference.toLine} ({reference.side})
      </button>
      {error && <p role="status">{error}</p>}
      <pre aria-label={recorded ? "Highlighted recorded source" : "Recorded source excerpt"}>
        {recorded ? <mark>{reference.quote}</mark> : reference.quote}
      </pre>
    </div>
  );
}

export function FeedbackPanel({ onClose }: { onClose: () => void }) {
  const store = useStore();
  const state = useViewerState();
  const [kind, setKind] = useState<FeedbackKind>("explain");
  const [note, setNote] = useState("");
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const panel = useRef<HTMLElement>(null);
  const id =
    state.selection[state.selection.length - 1] ??
    (state.cursor ? `file:${state.cursor.file}` : undefined);
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
  useEffect(() => {
    void store.refreshAnswers();
    const timer = setInterval(() => void store.refreshAnswers(), 1000);
    return () => clearInterval(timer);
  }, [store]);
  const connected = state.connection.status === "connected";
  const act = async (action: () => Promise<void>) => {
    setBusy(true);
    try {
      await action();
    } catch (error) {
      setMessage(messageOf(error));
    } finally {
      setBusy(false);
    }
  };
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
        <h2>Questions and feedback</h2>
        <button type="button" className="icon-btn" aria-label="Close feedback" onClick={onClose}>
          ×
        </button>
      </header>
      <p className="tp-intro">
        Ask a question for a source-linked answer from the connected local worker. Answers never
        edit the guide. Saving for the next revision pass does not start generation. Offline, export
        the JSON, run <code>xpl feedback &lt;guide&gt; --import feedback.json</code> locally, then
        invoke <code>/code-explainer feedback</code> in your chosen agent.
      </p>
      <p>
        {id ? (
          <>
            Selected: <strong>{state.model.label(id)}</strong>
          </>
        ) : (
          "Select an element or code lines to attach feedback."
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
        {kind === "explain" ? "What would you like to know?" : "What should change?"}
        <textarea
          className="feedback"
          aria-label="Feedback note"
          value={note}
          disabled={busy}
          onChange={(event) => setNote(event.target.value)}
          rows={3}
          maxLength={5000}
        />
      </label>
      <div className="actions">
        {kind === "explain" && (
          <button
            className="btn is-primary"
            type="button"
            disabled={!id || !note.trim() || busy}
            onClick={() =>
              void act(async () => {
                if (!id) return;
                const reason = await store.askQuestion(id, note);
                setMessage(
                  reason
                    ? `Saved as pending feedback. ${reason} Export feedback JSON, import with xpl feedback <guide> --import feedback.json, then run /code-explainer feedback for the next explicit pass.`
                    : "Question submitted. Progress and the answer stay with this feedback.",
                );
                setNote("");
              })
            }
          >
            Ask a question
          </button>
        )}
        <button
          className="btn"
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
          Save for the next revision pass
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
      <label className="feedback-import">
        Import feedback JSON
        <input
          type="file"
          accept="application/json,.json"
          aria-label="Import feedback JSON"
          disabled={busy}
          onChange={(event) => {
            const file = event.currentTarget.files?.[0];
            event.currentTarget.value = "";
            if (file)
              void act(async () => {
                await store.importFeedback(JSON.parse(await file.text()));
                setMessage(
                  "Imported feedback. Existing request IDs, answers and newer outcomes are preserved.",
                );
              });
          }}
        />
      </label>
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
      {state.answerError && (
        <p className="note is-error" role="alert">
          Could not refresh live answers: {state.answerError} Your saved feedback remains available.
        </p>
      )}
      <ul className="feedback-list">
        {state.feedback.map((request) => {
          const outdated = feedbackContextReason(request, current) ?? state.sourceWarning;
          const jobs =
            state.answers?.jobs.filter((job) => job.selectedRequestIds.includes(request.id)) ?? [];
          return (
            <li key={request.id} data-request-id={request.id}>
              <strong>
                {request.kind}: {request.label ?? request.elementId}
              </strong>{" "}
              {request.answers?.length ? (
                <>
                  · <strong>Answered</strong>
                </>
              ) : null}
              {outdated ? " · outdated context" : ""}
              {request.note && <p>{request.note}</p>}
              {request.range && (
                <p>
                  {request.range.file}:{request.range.fromLine}–{request.range.toLine} (
                  {request.range.side})
                </p>
              )}
              <p>
                Revision:{" "}
                {request.outcome.status === "pending" ? "not yet reviewed" : request.outcome.status}
              </p>
              {request.outcome.reason !== "Awaiting an explicit revision pass." && (
                <p>{request.outcome.reason}</p>
              )}
              {outdated && <p>{outdated}</p>}
              <code>{request.id}</code>
              {request.kind === "explain" &&
                request.note &&
                !jobs.length &&
                !request.answers?.length && (
                  <button
                    className="btn"
                    disabled={busy}
                    onClick={() =>
                      void act(async () => {
                        try {
                          await store.answerRequest(request);
                          setMessage("Question submitted.");
                        } catch (error) {
                          setMessage(
                            `Question remains pending feedback. ${messageOf(error)} Run /code-explainer feedback for the next explicit pass; export JSON to carry this question offline.`,
                          );
                        }
                      })
                    }
                  >
                    Get an answer
                  </button>
                )}
              {jobs.map((job) => (
                <section
                  key={job.id}
                  className="answer-attempt"
                  data-job-state={job.state}
                  aria-label="Question progress"
                >
                  <strong>{job.state[0]!.toUpperCase() + job.state.slice(1)}</strong> · attempt{" "}
                  {job.attempt}
                  {job.progress.length > 0 && (
                    <p>{job.progress[job.progress.length - 1]!.message}</p>
                  )}
                  {job.contextReason && (
                    <p className="note is-error">Outdated context: {job.contextReason}</p>
                  )}
                  {job.error && <p role="alert">{job.error}</p>}
                  {["queued", "running"].includes(job.state) && (
                    <button
                      className="btn"
                      disabled={busy || !connected}
                      onClick={() => void act(() => store.controlAnswer(job, "cancel"))}
                    >
                      Cancel question
                    </button>
                  )}
                  {["failed", "interrupted"].includes(job.state) && (
                    <button
                      className="btn"
                      disabled={busy || !connected || !state.answers?.available}
                      onClick={() => void act(() => store.controlAnswer(job, "retry"))}
                    >
                      Retry question
                    </button>
                  )}
                </section>
              ))}
              {request.answers?.map((answer) => (
                <section key={answer.id} className="feedback-answer" aria-label="Answer">
                  <h3>Answer</h3>
                  <p className="answer-text">{answer.text}</p>
                  <details>
                    <summary>Answer snapshot</summary>
                    <p>
                      Explanation: <code>{answer.context.explainerHash}</code>
                    </p>
                    <p>
                      Source: <code>{answer.context.sourceHash}</code>
                    </p>
                  </details>
                  {answer.references.map((reference, i) => (
                    <AnswerEvidence key={i} answer={answer} reference={reference} />
                  ))}
                </section>
              ))}
            </li>
          );
        })}
      </ul>
    </section>
  );
}
