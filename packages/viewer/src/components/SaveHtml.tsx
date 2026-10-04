import { useEffect, useRef, useState } from "react";
import type { ReadinessReport, ViewerBundle } from "@xpl/core";
import { useStore } from "../hooks.js";
import { htmlFileName, prepareHtmlSave, savedPage, snapshotReadiness } from "../saveHtml.js";

/** Author inspection at the export boundary; source checks never imply prose approval. */
export function SaveHtml({
  onClose,
  onDownload,
}: {
  onClose: () => void;
  onDownload: (name: string, html: string) => void;
}) {
  const store = useStore();
  const dialog = useRef<HTMLDialogElement>(null);
  const [report, setReport] = useState<ReadinessReport>();
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(true);
  const [note, setNote] = useState("");
  const scope = store.getState().serverMode ? "workspace" : "embedded-snapshot";
  const inspect = (bundle: ViewerBundle, decisionNote = note) => {
    const checked = snapshotReadiness(bundle, { scope, decisionNote });
    setReport(checked);
    return checked;
  };
  useEffect(() => {
    dialog.current?.showModal();
    let active = true;
    prepareHtmlSave(store)
      .then((bundle) => {
        if (active) {
          const previousNote = bundle.exportInfo?.report.decisionNote ?? "";
          setNote(previousNote);
          setReport(snapshotReadiness(bundle, { scope, decisionNote: previousNote }));
        }
      })
      .catch((cause: unknown) => {
        if (active) setError(String(cause instanceof Error ? cause.message : cause));
      })
      .finally(() => {
        if (active) setBusy(false);
      });
    return () => {
      active = false;
    };
  }, [store, scope]);

  const save = async (draft: boolean) => {
    setBusy(true);
    setError("");
    try {
      // Recheck at the click: the repository or in-memory edits may have changed while this dialog was open.
      const bundle = await prepareHtmlSave(store);
      const checked = inspect(bundle);
      if (!checked.ready && !draft) return;
      const name = htmlFileName(bundle.explainer).replace(/\.draft(?=\.html?$)/i, "");
      onDownload(
        draft ? name.replace(/\.html?$/i, ".draft.html") : name,
        savedPage(bundle, { scope, draft, decisionNote: note }),
      );
      onClose();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };

  return (
    <dialog
      ref={dialog}
      className="save-html-dialog"
      aria-labelledby="save-html-title"
      onCancel={onClose}
    >
      <h2 id="save-html-title">Save as HTML</h2>
      <p>
        {scope === "workspace"
          ? "Checks the current workspace before saving."
          : "Checks only the embedded source snapshot. This offline page cannot check whether the repository changed later."}
      </p>
      <p>
        Source links and required text are checked. Prose claims and complete runtime coverage need
        author judgment.
      </p>
      {busy && <p role="status">Checking readiness…</p>}
      {error && <p role="alert">{error}</p>}
      {report && (
        <>
          <p data-testid="readiness-summary">
            <strong>{report.ready ? "Ready" : "Not ready"}</strong>: {report.errors} errors,{" "}
            {report.warnings} warnings.
          </p>
          <ul className="readiness-findings">
            {report.findings.map((finding, i) => (
              <li key={i}>
                <strong>
                  {finding.severity}: {finding.elementId}.{finding.field} ({finding.code})
                </strong>
                <p>
                  {finding.message} {finding.hint}
                </p>
              </li>
            ))}
          </ul>
          <label htmlFor="save-html-note">
            Author decision about warnings or omissions (optional)
          </label>
          <textarea
            id="save-html-note"
            value={note}
            onChange={(event) => setNote(event.target.value)}
          />
        </>
      )}
      <div className="save-html-actions">
        <button type="button" className="btn" onClick={onClose}>
          Cancel
        </button>
        <button
          type="button"
          className="btn"
          data-testid="save-html-draft"
          disabled={busy || !report}
          onClick={() => void save(true)}
        >
          Save draft preview
        </button>
        <button
          type="button"
          className="btn"
          data-testid="save-html-ready"
          disabled={busy || !report?.ready}
          onClick={() => void save(false)}
        >
          Save ready HTML
        </button>
      </div>
    </dialog>
  );
}
