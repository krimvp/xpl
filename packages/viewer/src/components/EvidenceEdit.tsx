import { useState } from "react";
import { ANCHOR_ROLES, type Anchor, type AnchorRole } from "@xpl/core";
import { useStore, useViewerState } from "../hooks.js";

/** Evidence drafts use the same version, save queue and history as text edits. */
export function EvidenceEdit({
  collection,
  id,
}: {
  collection: "nodes" | "edges" | "concepts";
  id: string;
}) {
  const store = useStore();
  const state = useViewerState();
  const [role, setRole] = useState<AnchorRole>("usage");
  const captured = state.textDrafts[id];
  const item =
    collection === "nodes"
      ? state.model.node(id)
      : collection === "edges"
        ? state.model.edge(id)
        : state.model.concept(id);
  if (!item) return null;
  if (!captured || !("anchors" in captured.edit.after))
    return (
      <button
        className="btn"
        type="button"
        data-testid="evidence-edit"
        disabled={!!captured || state.editBusy || !!state.readOnlyGuide}
        onClick={() => {
          const draft = store.captureEdit(collection, id, { anchors: item.anchors });
          // Resolver metadata is a cache. Opening an editor alone is not a changed claim.
          store.updateEditDraft(id, draft.edit.before);
        }}
      >
        Edit evidence
      </button>
    );

  const anchors = captured.edit.after.anchors as Anchor[];
  const preview = store.previewEvidence(role);
  const cursor = state.cursor;
  const dirty = JSON.stringify(anchors) !== JSON.stringify(captured.edit.before.anchors);
  const stage = (next: Anchor[]) => store.updateEditDraft(id, { anchors: next });
  const save = async () => {
    try {
      await store.saveEdits([captured.edit], captured.version);
      store.cancelEdit(id);
    } catch {
      // Keep the inspected draft and the store's error until explicit cancellation or retry.
    }
  };
  return (
    <form
      className="text-edit evidence-edit"
      aria-label="Edit source evidence"
      onSubmit={(event) => {
        event.preventDefault();
        void save();
      }}
    >
      <h3>Source evidence</h3>
      <p>
        Source stays read-only. Select lines to check a replacement, then explicitly replace, remove
        or add evidence.
      </p>
      <fieldset disabled={state.editBusy}>
        <label>
          Evidence role
          <select
            aria-label="Evidence role"
            value={role}
            onChange={(event) => setRole(event.target.value as AnchorRole)}
          >
            {ANCHOR_ROLES.map((value) => (
              <option key={value}>{value}</option>
            ))}
          </select>
        </label>
        <div className="evidence-preview" data-testid="evidence-preview" role="status">
          {preview.ok && cursor ? (
            <>
              <strong>
                Checked {preview.anchor.at === "base" ? "base" : "head"}: {preview.anchor.file}
              </strong>
              <p>
                {preview.anchor.symbol
                  ? `symbol-relative to ${preview.anchor.symbol}`
                  : "file-relative"}
                , L{cursor.fromLine}
                {cursor.toLine !== cursor.fromLine ? `–${cursor.toLine}` : ""}
              </p>
              <pre>
                {(cursor.side === "base" ? state.baseFiles : state.files)[cursor.file]
                  ?.split(/\r?\n/)
                  .slice(cursor.fromLine - 1, cursor.toLine)
                  .join("\n")}
              </pre>
            </>
          ) : (
            <p>{preview.ok ? "Select source lines." : preview.error}</p>
          )}
        </div>
        <ul className="evidence-list">
          {anchors.map((anchor, position) => {
            const original = item.anchors.find(
              (a) =>
                a.hash === anchor.hash &&
                a.file === anchor.file &&
                a.symbol === anchor.symbol &&
                a.at === anchor.at &&
                JSON.stringify(a.span) === JSON.stringify(anchor.span),
            );
            const resolution = anchor.resolved ?? original?.resolved;
            const status = resolution?.status ?? "unchecked";
            return (
              <li key={position} data-status={status}>
                <button
                  type="button"
                  className="anchor-row"
                  onClick={() =>
                    store.openFile(anchor.file, resolution?.range.startLine, anchor.at)
                  }
                >
                  <code>
                    {anchor.file}
                    {anchor.symbol ? `#${anchor.symbol}` : ""}
                  </code>{" "}
                  · {anchor.at === "base" ? "base" : "head"} · {anchor.role}{" "}
                  {resolution && (
                    <span>
                      L{resolution.range.startLine}
                      {resolution.range.endLine !== resolution.range.startLine
                        ? `–${resolution.range.endLine}`
                        : ""}
                    </span>
                  )}
                  <span className={`badge status-${status}`}>{status}</span>
                </button>
                <div className="evidence-row-actions">
                  <button
                    type="button"
                    className="btn"
                    disabled={!preview.ok}
                    onClick={() => {
                      if (preview.ok)
                        stage(anchors.map((a, i) => (i === position ? preview.anchor : a)));
                    }}
                  >
                    Replace with selected lines
                  </button>
                  <button
                    type="button"
                    className="btn"
                    onClick={() => stage(anchors.filter((_, i) => i !== position))}
                  >
                    Remove evidence
                  </button>
                </div>
              </li>
            );
          })}
        </ul>
        <button
          type="button"
          className="btn"
          disabled={!preview.ok || anchors.length >= 64}
          onClick={() => {
            if (preview.ok) stage([...anchors, preview.anchor]);
          }}
        >
          Add selected evidence
        </button>
        <p>
          Repair or remove every invalid anchor on this element before saving. Undo cannot restore
          evidence that no longer resolves.
        </p>
        {state.editError && <p role="alert">{state.editError}</p>}
        <div className="actions">
          <p role="status">
            {state.editBusy ? "Saving…" : dirty ? "Unsaved evidence draft" : "No changes"}
          </p>
          <button type="submit" className="btn" disabled={!dirty}>
            Save evidence
          </button>
          <button type="button" className="btn" onClick={() => store.cancelEdit(id)}>
            Cancel
          </button>
        </div>
      </fieldset>
    </form>
  );
}
