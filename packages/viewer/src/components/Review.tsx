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
        throw new Error("Select at least one stored item.");
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
      <h2 id="review-title">Record author review</h2>
      <p>
        Inspect the explanation and linked code before recording. This is your judgment of the
        captured snapshot. A name is self-reported; anchors do not verify prose or complete runtime
        coverage.
      </p>
      <label>
        Reviewer name (self-reported)
        <input value={reviewer} onChange={(e) => setReviewer(e.target.value)} />
      </label>
      <label>
        Content scope
        <select
          aria-label="Content scope"
          value={content}
          onChange={(e) => setContent(e.target.value as "all" | "selected")}
        >
          <option value="all">All stored explanation content</option>
          <option value="selected">Selected stored items</option>
        </select>
      </label>
      {content === "selected" && (
        <label>
          Stored items
          <select
            aria-label="Stored items"
            multiple
            value={ids}
            onChange={(e) => setIds([...e.target.selectedOptions].map((o) => o.value))}
          >
            {records.map((r) => (
              <option key={r.id} value={r.id}>
                {r.id}
              </option>
            ))}
          </select>
        </label>
      )}
      <p>
        Selected items include their own anchors and nested steps, without other items' prose or
        dependency coverage.
      </p>
      <label>
        Source scope
        <select
          aria-label="Source scope"
          value={source}
          onChange={(e) => setSource(e.target.value as ReviewScope["source"])}
        >
          <option value="anchored">Attached anchor evidence</option>
          <option value="repository">All indexed repository files</option>
        </select>
      </label>
      <label>
        Additional whole source files (one indexed path per line)
        <textarea value={files} onChange={(e) => setFiles(e.target.value)} />
      </label>
      <label>
        Named omissions (one per line)
        <textarea value={omissions} onChange={(e) => setOmissions(e.target.value)} />
      </label>
      <button type="button" className="btn" disabled={busy} onClick={() => void inspect()}>
        Inspect current snapshot
      </button>
      {busy && <p role="status">Checking snapshot…</p>}
      {inspection?.bundle.sourceWarning && <p role="status">{inspection.bundle.sourceWarning}</p>}
      {error && <p role="alert">{error}</p>}
      {current && (
        <div data-testid="review-inspection">
          <p>
            <strong>{inspection.bundle.explainer.title}</strong>.{" "}
            {content === "all" ? "All stored explanation content" : ids.join(", ")};{" "}
            {source === "repository" ? "all indexed source files" : "attached anchor evidence"}.
          </p>
          <p>
            Source snapshot: {inspection.bundle.index.commit}.{" "}
            {state.serverMode
              ? "Source will be checked again at write time."
              : "Only embedded source is available; later repository changes cannot be detected."}
          </p>
          <p>
            Record only after checking the captured claims and linked evidence and naming important
            omissions.
          </p>
          <details>
            <summary>Read captured explanation content</summary>
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
                  <h4>{r.id}</h4>
                  {prose(r).map((text, i) => (
                    <p key={i}>{text}</p>
                  ))}
                </article>
              ))}
          </details>
          <details>
            <summary>Read available captured source</summary>
            <p>
              Only attached anchors and explicitly scoped files are fingerprinted. Other available
              source gives context.
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
        <p>Scope changed. Inspect the current snapshot before recording.</p>
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
          className="btn"
          disabled={busy || !current || !reviewer.trim()}
          onClick={() => void record()}
        >
          Record inspected review
        </button>
      </div>
    </dialog>
  );
}
