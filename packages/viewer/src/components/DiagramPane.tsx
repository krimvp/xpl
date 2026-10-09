/**
 * The diagram of the current view (graph or sequence) under a caption with its title and question. (The
 * stub and edge-kind toggles of a graph view are in the header's Edit menu, with the other author tools.)
 */
import { useDerived, useViewerState } from "../hooks.js";
import { ErrorBoundary } from "./ErrorBoundary.js";
import { GraphView } from "./GraphView.js";
import { GraphAuthor } from "./GraphAuthor.js";
import { FlowDiagram } from "./FlowDiagram.js";
import { ExpandInPlaceAction } from "./ExpandInPlaceAction.js";
import { FoldBackAction } from "./FoldBackAction.js";
import { SequenceView } from "./SequenceView.js";
import { ZoomTrail } from "./ZoomTrail.js";
import { codeFirstView } from "../workspace.js";

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
  const present = state.mode === "present";
  // Each tour step starts the diagram over, even in the same view: it looks at the step's focus.
  const resetKey = `${view.id}#${state.stepSeq}`;
  return (
    <div className="diagram" data-view-id={view.id} data-view-type={view.type}>
      <div className="diagram-caption">
        <ZoomTrail viewId={view.id} />
        <span className="caption-title">{view.title}</span>
        {question && <span className="caption-question">{question}</span>}
        {view.type === "graph" && derived.view.graph && (
          <>
            <ExpandInPlaceAction nodes={derived.view.graph.nodes} />
            <FoldBackAction visibleIds={derived.view.graph.nodes.map((node) => node.id)} />
          </>
        )}
        {view.type === "graph" && <GraphAuthor key={view.id} view={view} />}
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
              resetKey={resetKey}
              graph={derived.view.graph}
              pins={view.layout}
              selection={state.selection}
              matches={derived.matches}
              related={derived.selection.related}
              order={Array.isArray(view.include) ? view.include : undefined}
              present={present}
            />
          ) : view.type === "flow" ? (
            <FlowDiagram view={view} outline={!present && codeFirstView(view)} />
          ) : view.type === "sequence" ? (
            <SequenceView
              view={view}
              resetKey={resetKey}
              model={state.model}
              selection={state.selection}
              matches={derived.matches}
              related={derived.selection.related}
              present={present}
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
