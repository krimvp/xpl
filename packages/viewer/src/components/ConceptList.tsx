import { useViewerState, useDerived, useStore } from "../hooks.js";

/** Every concept of the explainer. Click selects (shift adds); matches for the editor caret get `is-match`. */
export function ConceptList() {
  const store = useStore();
  const state = useViewerState();
  const derived = useDerived();
  const concepts = state.model.concepts;
  const selected = new Set(state.selection);
  const matched = new Set(derived.matches);
  return (
    <section className="concepts" aria-label="Concepts">
      <h2 className="panel-title">
        Concepts <span className="count">{concepts.length}</span>
      </h2>
      {concepts.length === 0 ? (
        <p className="empty">
          No concepts yet. Concepts capture cross-cutting ideas such as a retry policy.
        </p>
      ) : (
        <ul className="concept-list">
          {concepts.map((concept) => {
            const anchors = concept.anchors ?? [];
            const counts = (["drifted", "missing"] as const)
              .map(
                (status) =>
                  [status, anchors.filter((a) => a.resolved?.status === status).length] as const,
              )
              .filter(([, count]) => count > 0);
            const classes =
              "concept" +
              (selected.has(concept.id) ? " is-selected" : "") +
              (matched.has(concept.id) ? " is-match" : "");
            return (
              <li key={concept.id} className={classes} data-element-id={concept.id}>
                <button
                  type="button"
                  aria-pressed={selected.has(concept.id)}
                  onClick={(event) =>
                    store.click(concept.id, event.shiftKey || event.metaKey || event.ctrlKey)
                  }
                >
                  <span className="concept-title">{concept.label}</span>
                  {counts.length > 0 && (
                    <span className="concept-badges">
                      {counts.map(([status, count]) => (
                        <span key={status} className={`badge status-${status}`}>
                          {count} {status}
                        </span>
                      ))}
                    </span>
                  )}
                  {concept.summary && <span className="concept-summary">{concept.summary}</span>}
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
