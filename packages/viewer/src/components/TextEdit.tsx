import type { UserEdit } from "@xpl/core";
import type { AuthorDraft } from "../store.js";
import { useStore, useViewerState } from "../hooks.js";

/** Author text stays a draft until Save; source stays read-only; evidence has its own explicit editor. */
export function TextEdit({ collection, id }: { collection: UserEdit["collection"]; id: string }) {
  const store = useStore();
  const state = useViewerState();
  const captured = state.textDrafts[id];
  if (!captured || "anchors" in captured.edit.after)
    return (
      <button
        type="button"
        className="btn"
        data-testid="text-edit"
        disabled={!!captured || state.editBusy || !!state.readOnlyGuide}
        onClick={() => {
          const item =
            collection === "nodes"
              ? state.model.node(id)
              : collection === "edges"
                ? state.model.edge(id)
                : state.model.concept(id);
          if (!item) return;
          store.captureEdit(collection, id, {
            label: item.label,
            summary: item.summary ?? null,
            detail: item.detail ?? null,
            ...(collection === "concepts"
              ? { related: state.model.concept(id)?.related ?? null }
              : {}),
          });
        }}
      >
        Edit text{collection === "concepts" ? " and related elements" : ""}
      </button>
    );
  return <TextDraft captured={captured} />;
}

function TextDraft({ captured }: { captured: AuthorDraft }) {
  const store = useStore();
  const state = useViewerState();
  const values = captured.edit.after;
  const setValues = (next: Record<string, unknown>) =>
    store.updateEditDraft(captured.edit.id, next);
  const onClose = () => store.cancelEdit(captured.edit.id);
  const error = state.editError;
  const changed = Object.fromEntries(
    Object.entries(values).filter(
      ([key, value]) => JSON.stringify(value) !== JSON.stringify(captured.edit.before[key]),
    ),
  );
  const dirty = Object.keys(changed).length > 0;
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
    } catch {
      // The store retains the failed draft and its error across navigation.
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
          <button type="submit" className="btn" disabled={!dirty} data-testid="text-save">
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
