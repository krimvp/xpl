import { useEffect, useMemo, useRef, useState } from "react";
import { buildReverseIndex, derivedEdgeMap, viewCandidates, type SequenceView } from "@xpl/core";
import { describeElement } from "../details.js";
import { renderInline } from "../markdown.js";
import { stepTitle } from "../stepTitle.js";
import { useDerived, useStore, useViewerState } from "../hooks.js";
import { workspaceMap, workspaceView } from "../workspace.js";
import { CodeArea } from "./CodeArea.js";
import { Details } from "./Details.js";
import { ErrorBoundary } from "./ErrorBoundary.js";
import { FlowDiagram } from "./FlowDiagram.js";
import { GraphView } from "./GraphView.js";
import { Guide } from "./Guide.js";
import { RelatedFiles } from "./RelatedFiles.js";
import { ZoomTrail } from "./ZoomTrail.js";

export function Workspace() {
  const store = useStore();
  const state = useViewerState();
  const derived = useDerived();
  const [sourceOpen, setSourceOpen] = useState(false);
  const columns = useRef<HTMLDivElement>(null);
  const map = useMemo(
    () => workspaceMap(state),
    [state.model, state.selection, state.viewId, state.expanded],
  );
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
  // While a guide section (a tour step) is on screen, "you are here" is that section, by its title.
  const appliedStep = state.applied
    ? state.model.tour(state.applied.tourId)?.steps.find((s) => s.id === state.applied!.stepId)
    : undefined;
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
          <span data-testid="breadcrumb-topic">
            {appliedStep
              ? stepTitle(appliedStep, state.model)
              : (info?.title ?? tour?.title ?? "Overview")}
          </span>
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
              // A diagram that fails does not take the other views down with it: another view starts over.
              key={
                state.perspective === "guide"
                  ? "guide"
                  : `${state.perspective}:${state.perspective === "map" ? map.view.id : (flow?.id ?? "")}`
              }
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
                      <p className="eyebrow">{state.perspective === "map" ? "Map" : "Flow"}</p>
                      <ZoomTrail
                        viewId={state.perspective === "map" ? map.view.id : (flow?.id ?? "")}
                      />
                      <h2>
                        {state.perspective === "map"
                          ? map.view.title
                          : (flow?.title ?? "The guide's steps")}
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
                        <option value={map.view.id}>Map</option>
                      )}
                      {state.perspective === "flow" && !flow && (
                        <option value="">The guide's steps</option>
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
                        reader
                      />
                    </div>
                  ) : flow ? (
                    <FlowDiagram key={flow.id} view={flow} />
                  ) : (
                    <div className="guide-path">
                      <p>
                        This explainer has no flow diagram. Here are the guide's steps, in reading
                        order.
                      </p>
                      {tour?.steps.map((step, index) => (
                        <button
                          className={`guide-path-stage${state.applied?.stepId === step.id ? " is-active" : ""}`}
                          key={step.id}
                          onClick={() => store.previewStep(tour.id, index)}
                        >
                          <span>{index + 1}</span>
                          {stepTitle(step, state.model)}
                        </button>
                      ))}
                      {!tour && <p>Pick a box on the map to see its code.</p>}
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
          {/* In the guide, the open section is the topic: its summary would say it again. A box picked from
              a section (a member chip, a call) is another topic, and gets its summary here. */}
          {info && !(state.perspective === "guide" && appliedStep) && (
            <section className="topic-summary" data-testid="topic-summary">
              <p className="eyebrow">Current topic</p>
              <h2>{info.title}</h2>
              {info.summary && (
                <p dangerouslySetInnerHTML={{ __html: renderInline(info.summary) }} />
              )}
              {state.perspective === "guide" && (
                <div className="section-actions">
                  <button className="btn" onClick={() => store.setPerspective("map")}>
                    Show on the map
                  </button>
                  <button className="btn" onClick={() => store.setPerspective("flow")}>
                    Show in the flow
                  </button>
                </div>
              )}
            </section>
          )}
          <RelatedFiles onOpen={() => setSourceOpen(true)} />
          {active && (
            <details className="workspace-inspector">
              <summary>Where this is in the code</summary>
              <Details reader />
            </details>
          )}
        </aside>
      </div>
    </main>
  );
}
