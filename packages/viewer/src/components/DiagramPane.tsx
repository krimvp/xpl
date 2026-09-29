/** The diagram of the current view (graph or sequence) under a caption with its title and question. */
import { useDerived, useViewerState } from "../hooks.js";
import { ErrorBoundary } from "./ErrorBoundary.js";
import { GraphView } from "./GraphView.js";
import { SequenceView } from "./SequenceView.js";

export function DiagramPane() {
  const state = useViewerState();
  const derived = useDerived();
  const view = derived.view.view;
  if (!view) {
    return (
      <div className="diagram">
        <div className="diagram-message">
          This explainer has no views yet. Ask Claude to explain something.
        </div>
      </div>
    );
  }
  const question = view.scope?.question;
  return (
    <div className="diagram" data-view-id={view.id} data-view-type={view.type}>
      <div className="diagram-caption">
        <span className="caption-title">{view.title}</span>
        {question && <span className="caption-question">{question}</span>}
      </div>
      <div className="diagram-body">
        <ErrorBoundary
          key={view.id}
          fallback={(error) => (
            <div className="diagram-message is-error">
              This view could not be drawn: {error.message}
            </div>
          )}
        >
          {view.type === "graph" && derived.view.graph ? (
            <GraphView
              viewId={view.id}
              graph={derived.view.graph}
              selection={state.selection}
              matches={derived.matches}
              related={derived.selection.related}
            />
          ) : view.type === "sequence" ? (
            <SequenceView
              view={view}
              model={state.model}
              selection={state.selection}
              matches={derived.matches}
              related={derived.selection.related}
            />
          ) : (
            <div className="diagram-message">
              This viewer cannot draw views of type "{String((view as { type?: unknown }).type)}".
            </div>
          )}
        </ErrorBoundary>
      </div>
    </div>
  );
}
