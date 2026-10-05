import { useEffect, useState } from "react";
import type { UserEdit, ArtifactIdentity } from "@xpl/core";
import { useStore, useViewerState } from "../hooks.js";
import { messageOf } from "../data.js";

/** Author text stays a draft until Save; source and evidence are read-only here. */
export function TextEdit({ collection, id }: { collection: UserEdit["collection"]; id: string }) {
  const store = useStore();
  const state = useViewerState();
  const [captured, setCaptured] = useState<{ edit: UserEdit; version: ArtifactIdentity }>();
  if (!captured)
    return (
      <button
        type="button"
        className="btn"
        data-testid="text-edit"
        disabled={state.editBusy}
        onClick={() => {
          const item =
            collection === "nodes"
              ? state.model.node(id)
              : collection === "edges"
                ? state.model.edge(id)
                : state.model.concept(id);
          if (!item) return;
          setCaptured(
            store.captureEdit(collection, id, {
              label: item.label,
              summary: item.summary ?? null,
              detail: item.detail ?? null,
              ...(collection === "concepts"
                ? { related: state.model.concept(id)?.related ?? null }
                : {}),
            }),
          );
        }}
      >
        Edit text{collection === "concepts" ? " and related elements" : ""}
      </button>
    );
  return (
    <TextDraft
      captured={captured}
      onClose={() => {
        store.cancelEdit();
        setCaptured(undefined);
      }}
    />
  );
}

function TextDraft({
  captured,
  onClose,
}: {
  captured: { edit: UserEdit; version: ArtifactIdentity };
  onClose(): void;
}) {
  const store = useStore();
  const state = useViewerState();
  const [values, setValues] = useState(captured.edit.after);
  const [error, setError] = useState("");
  const changed = Object.fromEntries(
    Object.entries(values).filter(
      ([key, value]) => JSON.stringify(value) !== JSON.stringify(captured.edit.before[key]),
    ),
  );
  const dirty = Object.keys(changed).length > 0;
  useEffect(() => {
    store.setEditDraft(dirty);
    return () => store.setEditDraft(false);
  }, [store, dirty]);
  const related = values.related as string[] | null;
  const options = [
    ...new Set([
      ...(related ?? []),
      ...state.explainer.nodes.map((n) => n.id),
      ...state.explainer.edges.map((e) => e.id),
      ...state.explainer.concepts.filter((c) => c.id !== captured.edit.id).map((c) => c.id),
      ...state.model.index.index.files.map((f) => `file:${f.path}`),
      ...state.model.index.index.symbols.map((s) => `sym:${s.id}`),
    ]),
  ];
  const save = async () => {
    setError("");
    try {
      await store.saveEdits(
        [
          {
            ...captured.edit,
            before: Object.fromEntries(
              Object.keys(changed).map((key) => [key, captured.edit.before[key]]),
            ),
            after: changed,
          },
        ],
        captured.version,
      );
      onClose();
    } catch (cause) {
      setError(messageOf(cause));
    }
  };
  return (
    <form
      className="text-edit"
      aria-label="Edit explanation text"
      onSubmit={(event) => {
        event.preventDefault();
        void save();
      }}
    >
      <fieldset disabled={state.editBusy}>
        <label>
          Label
          <input
            aria-label="Label"
            value={String(values.label)}
            onChange={(event) => setValues({ ...values, label: event.target.value })}
          />
        </label>
        <label>
          Summary
          <textarea
            aria-label="Summary"
            rows={3}
            value={String(values.summary ?? "")}
            onChange={(event) => setValues({ ...values, summary: event.target.value || null })}
          />
        </label>
        <label>
          Detail (Markdown)
          <textarea
            aria-label="Detail"
            rows={4}
            value={String(values.detail ?? "")}
            onChange={(event) => setValues({ ...values, detail: event.target.value || null })}
          />
        </label>
        {captured.edit.collection === "concepts" && (
          <label>
            Related elements
            <select
              aria-label="Related elements"
              multiple
              size={5}
              value={related ?? []}
              onChange={(event) => {
                const ids = [...event.target.selectedOptions].map((option) => option.value);
                setValues({ ...values, related: ids.length ? ids : null });
              }}
            >
              {options.map((id) => (
                <option key={id} value={id}>
                  {state.model.label(id)} ({id})
                </option>
              ))}
            </select>
          </label>
        )}
        <p role="status">
          {state.editBusy ? "Saving…" : dirty ? "Unsaved text draft" : "No changes"}
        </p>
        {error && <p role="alert">{error}</p>}
        <div className="actions">
          <button
            type="submit"
            className="btn"
            disabled={!dirty || !String(values.label).trim()}
            data-testid="text-save"
          >
            Save text
          </button>
          <button type="button" className="btn" onClick={onClose}>
            Cancel
          </button>
        </div>
      </fieldset>
    </form>
  );
}
