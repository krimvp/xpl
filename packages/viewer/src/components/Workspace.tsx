import { useEffect, useMemo, useRef, useState } from "react";
import { buildReverseIndex, derivedEdgeMap, viewCandidates, type SequenceView } from "@xpl/core";
import { describeElement } from "../details.js";
import { useDerived, useStore, useViewerState } from "../hooks.js";
import { workspaceMap, workspaceView } from "../workspace.js";
import { CodeArea } from "./CodeArea.js";
import { Details } from "./Details.js";
import { ErrorBoundary } from "./ErrorBoundary.js";
import { FlowDiagram } from "./FlowDiagram.js";
import { GraphView } from "./GraphView.js";
import { Guide, sectionTitle } from "./Guide.js";
import { RelatedFiles } from "./RelatedFiles.js";

export function Workspace() {
  const store = useStore();
  const state = useViewerState();
  const derived = useDerived();
  const [sourceOpen, setSourceOpen] = useState(false);
  const columns = useRef<HTMLDivElement>(null);
  const map = useMemo(() => workspaceMap(state), [state.model, state.selection, state.viewId]);
  const flow = workspaceView(state, "flow") as SequenceView | undefined;
  const mapMatches = useMemo(
    () =>
      state.cursor
        ? buildReverseIndex(viewCandidates(map.view, state.model, map.graph), state.model, {
            derivedEdges: derivedEdgeMap(map.graph),
          }).lookup(state.cursor.file, state.cursor.fromLine)
        : [],
    [map, state.model, state.cursor],
  );
  const active = state.selection[state.selection.length - 1];
  const info = active ? describeElement(active, state.model, derived.view) : undefined;
  const tour = store.currentTour() ?? state.model.tours[0];
  const code = state.perspective === "code";
  const showSource = code || sourceOpen;
  useEffect(() => {
    if (!showSource) columns.current?.scrollTo({ top: 0, behavior: "instant" });
  }, [showSource, state.perspective]);

  useEffect(() => {
    if (state.openSeq > 0 && state.openedFile) setSourceOpen(true);
  }, [state.openSeq, state.openedFile]);

  return (
    <main
      className={`workspace${showSource ? " has-source" : ""}`}
      data-perspective={state.perspective}
    >
      <div className="workspace-location">
        <div className="navigation-history" aria-label="Navigation history">
          <button
            type="button"
            className="btn"
            aria-label="Back"
            disabled={!state.canGoBack}
            onClick={() => store.back()}
          >
            ← Back
          </button>
          <button
            type="button"
            className="btn"
            aria-label="Forward"
            disabled={!state.canGoForward}
            onClick={() => store.forward()}
          >
            Forward →
          </button>
        </div>
        <nav className="workspace-breadcrumb" aria-label="Current topic">
          <button className="link" onClick={() => store.setPerspective("guide")}>
            {state.explainer.title}
          </button>
          <span aria-hidden="true">/</span>
          <span>{info?.title ?? tour?.title ?? "Overview"}</span>
        </nav>
        {active && state.perspective !== "guide" && (
          <button className="btn" onClick={() => store.readExplanation()}>
            Read its explanation
          </button>
        )}
        {!code && (
          <button
            className="btn"
            aria-expanded={sourceOpen}
            onClick={() => setSourceOpen((open) => !open)}
          >
            {sourceOpen ? "Hide source" : "Show source"}
          </button>
        )}
      </div>
      <div className="workspace-columns" ref={columns}>
        {!code && (
          <section className="workspace-primary" aria-label="Explanation">
            <ErrorBoundary
              key={state.perspective}
              fallback={(error) => (
                <p role="alert">Could not show this perspective: {error.message}</p>
              )}
            >
              {state.perspective === "guide" ? (
                <Guide />
              ) : (
                <>
                  <div className="workspace-caption">
                    <div>
                      <p className="eyebrow">
                        {state.perspective === "map" ? "System map" : "Process flow"}
                      </p>
                      <h2>
                        {state.perspective === "map"
                          ? map.view.title
                          : (flow?.title ?? "Guide path")}
                      </h2>
                    </div>
                    <select
                      aria-label="Choose a topic"
                      value={state.perspective === "map" ? map.view.id : (flow?.id ?? "")}
                      onChange={(event) => store.setView(event.target.value)}
                    >
                      {state.model.views
                        .filter((view) =>
                          state.perspective === "map"
                            ? view.type === "graph"
                            : view.type !== "graph",
                        )
                        .map((view) => (
                          <option key={view.id} value={view.id}>
                            {view.title}
                          </option>
                        ))}
                      {state.perspective === "map" && map.generated && (
                        <option value={map.view.id}>System map</option>
                      )}
                      {state.perspective === "flow" && !flow && (
                        <option value="">Guide path</option>
                      )}
                    </select>
                  </div>
                  {state.perspective === "map" ? (
                    <div className="workspace-diagram">
                      <GraphView
                        viewId={map.view.id}
                        resetKey={`${map.view.id}:${state.stepSeq}`}
                        graph={map.graph}
                        selection={[...state.selection, ...map.related]}
                        matches={mapMatches}
                        related={map.related}
                        order={map.view.include}
                        present={map.generated}
                      />
                    </div>
                  ) : flow ? (
                    <FlowDiagram view={flow} />
                  ) : (
                    <div className="guide-path">
                      <p>
                        This explainer has no authored execution flow. These are the guide's reading
                        stages, not inferred runtime transitions.
                      </p>
                      {tour?.steps.map((step, index) => (
                        <button
                          className={`guide-path-stage${state.applied?.stepId === step.id ? " is-active" : ""}`}
                          key={step.id}
                          onClick={() => store.previewStep(tour.id, index)}
                        >
                          <span>{index + 1}</span>
                          {sectionTitle(step, (id) => state.model.label(id))}
                        </button>
                      ))}
                      {!tour && <p>Choose a component in the system map to inspect its source.</p>}
                    </div>
                  )}
                </>
              )}
            </ErrorBoundary>
          </section>
        )}
        {showSource && (
          <section className="workspace-source" aria-label="Source code">
            <CodeArea tree="collapsible" />
          </section>
        )}
        <aside className="workspace-context" aria-label="Topic context">
          {info && (
            <section className="topic-summary">
              <p className="eyebrow">Current topic</p>
              <h2>{info.title}</h2>
              <p>{info.summary}</p>
              {state.perspective === "guide" && (
                <div className="section-actions">
                  <button className="btn" onClick={() => store.setPerspective("map")}>
                    System map
                  </button>
                  <button className="btn" onClick={() => store.setPerspective("flow")}>
                    Process flow
                  </button>
                </div>
              )}
            </section>
          )}
          <RelatedFiles onOpen={() => setSourceOpen(true)} />
          <details className="workspace-inspector">
            <summary>Source references & details</summary>
            <Details />
          </details>
        </aside>
      </div>
    </main>
  );
}
