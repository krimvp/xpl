import { useEffect, useRef, useState } from "react";
import {
  reviewFingerprint,
  reviewShapeIssues,
  type ReviewScope,
  type ReviewFingerprint,
  type ViewerBundle,
} from "@xpl/core";
import { useStore, useViewerState } from "../hooks.js";
import { prepareHtmlSave } from "../saveHtml.js";
import { snapshotTexts } from "../snapshot.js";

const lines = (text: string) => [
  ...new Set(
    text
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean),
  ),
];

// Show authored text from nested steps, frames and transitions without exposing patch metadata.
function prose(value: unknown): string[] {
  if (Array.isArray(value)) return value.flatMap(prose);
  if (!value || typeof value !== "object") return [];
  return Object.entries(value).flatMap(([key, entry]) =>
    ["title", "label", "summary", "detail", "note", "question", "audience", "tech"].includes(key) &&
    typeof entry === "string"
      ? [entry]
      : key === "anchors" || key === "provenance"
        ? []
        : prose(entry),
  );
}

/** A box, step or tour by its title, with its kind of record when it has none. */
function nameOf(record: { id: string; label?: string; title?: string }): string {
  return record.title ?? record.label ?? record.id;
}

/** An explicit author inspection, scoped to a captured content/evidence fingerprint. */
export function Review({ onClose }: { onClose: () => void }) {
  const store = useStore();
  const state = useViewerState();
  const stored = state.explainer.review;
  const prior = stored && reviewShapeIssues(stored).length === 0 ? stored : undefined;
  const dialog = useRef<HTMLDialogElement>(null);
  const [reviewer, setReviewer] = useState(prior?.reviewer ?? "");
  const [omissions, setOmissions] = useState(prior?.omissions.join("\n") ?? "");
  const [content, setContent] = useState<"all" | "selected">(
    prior?.scope.content === undefined || prior!.scope.content === "all" ? "all" : "selected",
  );
  const [ids, setIds] = useState<string[]>(
    Array.isArray(prior?.scope.content) ? prior!.scope.content : [],
  );
  const [source, setSource] = useState<ReviewScope["source"]>(prior?.scope.source ?? "anchored");
  const [files, setFiles] = useState(prior?.scope.files?.join("\n") ?? "");
  const captured = useRef<ViewerBundle>(undefined);
  const [inspection, setInspection] = useState<{
    bundle: ViewerBundle;
    scope: ReviewScope;
    fingerprint: ReviewFingerprint;
  }>();
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const scope: ReviewScope = {
    content: content === "all" ? "all" : ids,
    source,
    ...(lines(files).length ? { files: lines(files) } : {}),
  };
  const scopeKey = JSON.stringify(scope);
  const inspect = async () => {
    setBusy(true);
    setError("");
    setInspection(undefined);
    try {
      if (scope.content !== "all" && scope.content.length === 0)
        throw new Error("Choose at least one box, step or tour.");
      const bundle = await prepareHtmlSave(store, scope);
      if (state.serverMode) store.adoptExplainer(bundle.explainer, bundle);
      captured.current = bundle;
      setInspection({
        bundle,
        scope,
        fingerprint: reviewFingerprint(
          bundle.explainer,
          bundle.index,
          snapshotTexts(bundle),
          scope,
        ),
      });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };
  useEffect(() => {
    dialog.current?.showModal();
    void inspect();
  }, []);
  const current = inspection && JSON.stringify(inspection.scope) === scopeKey;
  const record = async (remove = false) => {
    const snapshot = captured.current;
    if (!snapshot || (!remove && (!current || !inspection))) return;
    setBusy(true);
    setError("");
    try {
      await store.recordReview(
        snapshot,
        remove
          ? null
          : {
              reviewer: reviewer.trim(),
              reviewedAt: new Date().toISOString(),
              scope: inspection!.scope,
              omissions: lines(omissions),
              fingerprint: inspection!.fingerprint,
            },
      );
      onClose();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
      setInspection(undefined);
    } finally {
      setBusy(false);
    }
  };
  const records = [
    ...state.explainer.nodes,
    ...state.explainer.edges,
    ...state.explainer.concepts,
    ...state.explainer.views,
    ...state.explainer.tours,
  ];
  return (
    <dialog
      ref={dialog}
      className="save-html-dialog review-dialog"
      aria-labelledby="review-title"
      onCancel={onClose}
    >
      <h2 id="review-title">Mark as reviewed</h2>
      <p>
        Read the text and its code before you record a review. The review says that you checked this
        version. xpl does not check your name or the truth of the text.
      </p>
      <div className="review-fields">
        <label>
          Your name (xpl does not check it)
          <input value={reviewer} onChange={(e) => setReviewer(e.target.value)} />
        </label>
        <label>
          What you reviewed
          <select
            aria-label="What you reviewed"
            value={content}
            onChange={(e) => setContent(e.target.value as "all" | "selected")}
          >
            <option value="all">The whole guide</option>
            <option value="selected">Some boxes, steps or tours</option>
          </select>
        </label>
        {content === "selected" && (
          <>
            <label>
              Which ones
              <select
                aria-label="Which ones"
                multiple
                value={ids}
                onChange={(e) => setIds([...e.target.selectedOptions].map((o) => o.value))}
              >
                {records.map((r) => (
                  <option key={r.id} value={r.id}>
                    {nameOf(r)}
                  </option>
                ))}
              </select>
            </label>
            <p>A box or step covers its own code links and steps, not the text of others.</p>
          </>
        )}
        <label>
          Which code
          <select
            aria-label="Which code"
            value={source}
            onChange={(e) => setSource(e.target.value as ReviewScope["source"])}
          >
            <option value="anchored">The code it links to</option>
            <option value="repository">Every indexed file</option>
          </select>
        </label>
        <label>
          Other files you read (one path per line)
          <textarea value={files} onChange={(e) => setFiles(e.target.value)} />
        </label>
        <label>
          What you left out (one per line)
          <textarea value={omissions} onChange={(e) => setOmissions(e.target.value)} />
        </label>
        <button type="button" className="btn" disabled={busy} onClick={() => void inspect()}>
          Show what I review
        </button>
      </div>
      {busy && <p role="status">Reading the guide and its code…</p>}
      {inspection?.bundle.sourceWarning && <p role="status">{inspection.bundle.sourceWarning}</p>}
      {error && <p role="alert">{error}</p>}
      {current && (
        <div data-testid="review-inspection">
          <p>
            <strong>{inspection.bundle.explainer.title}</strong>.{" "}
            {content === "all"
              ? "The whole guide"
              : records
                  .filter((r) => ids.includes(r.id))
                  .map(nameOf)
                  .join(", ")}
            ; {source === "repository" ? "every indexed file" : "the code it links to"}.
          </p>
          <p>
            Code at version {inspection.bundle.index.commit}.{" "}
            {state.serverMode
              ? "xpl checks the code again when it records the review."
              : "This page holds a copy of the code; it cannot see later changes."}
          </p>
          <p>Record the review after you read the text and its code, and name what you left out.</p>
          <details>
            <summary>Read the text</summary>
            {content === "all" && (
              <>
                <h3>{inspection.bundle.explainer.title}</h3>
                <p>{inspection.bundle.explainer.scope?.audience}</p>
              </>
            )}
            {[
              ...inspection.bundle.explainer.nodes,
              ...inspection.bundle.explainer.edges,
              ...inspection.bundle.explainer.concepts,
              ...inspection.bundle.explainer.views,
              ...inspection.bundle.explainer.tours,
            ]
              .filter((r) => content === "all" || ids.includes(r.id))
              .map((r) => (
                <article key={r.id}>
                  <h4>{nameOf(r)}</h4>
                  {prose(r).map((text, i) => (
                    <p key={i}>{text}</p>
                  ))}
                </article>
              ))}
          </details>
          <details>
            <summary>Read the code</summary>
            <p>
              xpl records a hash of the linked code and of the files you listed. Other code is here
              for context only.
            </p>
            {Object.entries(inspection.bundle.files).map(([path, text]) => (
              <details key={path}>
                <summary>{path}</summary>
                <pre>{text}</pre>
              </details>
            ))}
            {Object.entries(inspection.bundle.baseFiles ?? {}).map(([path, text]) => (
              <details key={path}>
                <summary>{path} (before)</summary>
                <pre>{text}</pre>
              </details>
            ))}
          </details>
        </div>
      )}
      {!current && !busy && !error && (
        <p>You changed what you review. Press &ldquo;Show what I review&rdquo; again.</p>
      )}
      <div className="save-html-actions">
        <button type="button" className="btn" disabled={busy} onClick={onClose}>
          Cancel
        </button>
        {state.explainer.review && (
          <button
            type="button"
            className="btn"
            disabled={busy || !captured.current}
            onClick={() => void record(true)}
          >
            Remove review
          </button>
        )}
        <button
          type="button"
          className="btn is-primary"
          disabled={busy || !current || !reviewer.trim()}
          aria-describedby={!reviewer.trim() ? "review-needs-name" : undefined}
          onClick={() => void record()}
        >
          Record review
        </button>
      </div>
      {!reviewer.trim() && (
        <p id="review-needs-name" className="note">
          Type your name to record the review.
        </p>
      )}
    </dialog>
  );
}
