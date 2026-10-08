import { useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { derivedEdgeMap, processFlow, type SequenceView as SequenceViewData } from "@xpl/core";
import { viewReverseIndex } from "../derive.js";
import { sharedActor } from "../layout/flowLayout.js";
import { describeElement } from "../details.js";
import { renderInline } from "../markdown.js";
import { looksLikeCode } from "../readerWords.js";
import { stepTitle } from "../stepTitle.js";
import { useDerived, useStore, useViewerState } from "../hooks.js";
import {
  aroundFlow,
  codeFirstView,
  topicElements,
  topicMatches,
  workspaceMap,
  workspaceView,
} from "../workspace.js";
import { CodeArea } from "./CodeArea.js";
import { Details, TopicFacts } from "./Details.js";
import { ErrorBoundary } from "./ErrorBoundary.js";
import { FlowDiagram } from "./FlowDiagram.js";
import { GraphView } from "./GraphView.js";
import { Guide } from "./Guide.js";
import { RelatedFiles } from "./RelatedFiles.js";
import { SequenceView } from "./SequenceView.js";
import { Splitter } from "./Splitter.js";
import { ZoomTrail } from "./ZoomTrail.js";

/** `showSource`: open with the code shown (back from Present, where the code was on the slide). */
export function Workspace({ showSource: startWithSource = false }: { showSource?: boolean } = {}) {
  const store = useStore();
  const state = useViewerState();
  const derived = useDerived();
  const [sourceOpen, setSourceOpen] = useState(startWithSource);
  /** The guide section scrolled to (Guide), for the breadcrumb: where the reader is, not what was clicked. */
  const [reading, setReading] = useState<string | undefined>(undefined);
  const columns = useRef<HTMLDivElement>(null);
  const map = useMemo(
    () => workspaceMap(state),
    [state.model, state.selection, state.viewId, state.expanded],
  );
  const flow = workspaceView(state, "flow") as SequenceViewData | undefined;
  const mapMatches = useMemo(
    () =>
      state.cursor
        ? viewReverseIndex(map.view, state.model, map.graph, derivedEdgeMap(map.graph)).lookup(
            state.cursor.file,
            state.cursor.fromLine,
          )
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
  const readingStep =
    state.perspective === "guide" && reading
      ? tour?.steps.find((s) => s.id === reading)
      : undefined;
  // The topic panel follows the diagram on screen: a box picked on the Map that the Flow does not show is
  // not this Flow's topic (the panel says so, and shows the Flow's own title).
  const onScreen = useMemo(() => {
    if (!active || (state.perspective !== "map" && state.perspective !== "flow")) return true;
    const model = state.model;
    const topics = topicElements([active], model);
    // drawn itself, inside a box that is drawn, or around one
    const shows = (id: string) =>
      topicMatches(id, topics, model) ||
      [...topics].some(
        (topic) => model.hasNode(topic) && model.hasNode(id) && model.subtreeContains(id, topic),
      );
    if (state.perspective === "map") {
      return (
        map.graph.edges.some((edge) => edge.id === active) ||
        map.graph.nodes.some((node) => shows(node.id))
      );
    }
    return (
      !flow ||
      flow.steps.some((step) => step.id === active || shows(step.from) || shows(step.to)) ||
      flow.participants.some(shows)
    );
  }, [active, state.perspective, state.model, map.graph, flow]);
  // A box that holds the whole flow (ky, around a flow of ky's calls) is not what this flow is about: the
  // panel names the flow on screen, not the box picked before the tab changed.
  const wholeFlow =
    !!active && state.perspective === "flow" && !!flow && aroundFlow(active, flow, state.model);
  const diagramTitle = state.perspective === "map" ? map.view.title : flow?.title;
  // A flow whose every box is done by one part (the steps of one function) names it here, once.
  const flowOwner = useMemo(
    () => (flow ? sharedActor(processFlow(flow)) : undefined),
    [flow, state.model],
  );
  // Boxes on this map that open a map of their own: reachable without the topic list.
  const insides =
    state.perspective === "map"
      ? map.graph.nodes.filter((node) => store.canZoomInto(node.id)).slice(0, 3)
      : [];
  const code = state.perspective === "code";
  // The steps of one function: the code is the main pane, the flow a narrow outline beside it.
  const codeFirst = state.perspective === "flow" && flow?.type === "flow" && codeFirstView(flow);
  // Its width: the reader drags the bar between them (or uses the arrow keys); kept per flow.
  const [outlineWidth, setOutlineWidth] = useOutlineWidth(codeFirst ? flow?.id : undefined);
  // The topic column names the picked element (not in the guide while its section is the topic).
  const topicShown =
    !!info && onScreen && !wholeFlow && !(state.perspective === "guide" && appliedStep);
  const showSource = code || sourceOpen || codeFirst;
  useEffect(() => {
    if (!showSource) columns.current?.scrollTo({ top: 0, behavior: "instant" });
  }, [showSource, state.perspective]);

  useEffect(() => {
    if (state.openSeq > 0 && state.openedFile) setSourceOpen(true);
  }, [state.openSeq, state.openedFile]);

  // "Who calls it" in the code: the callers are listed in the topic column. Beside the code on a screen too
  // narrow for three columns that column is folded away: it then opens over the code, until closed.
  const context = useRef<HTMLElement>(null);
  const [contextOpen, setContextOpen] = useState(false);
  useEffect(() => {
    const aside = context.current;
    if (state.callersSeq === 0 || !aside) return;
    const folded = getComputedStyle(aside).display === "none";
    if (folded) setContextOpen(true);
    requestAnimationFrame(() => {
      const list = aside.querySelector<HTMLElement>('[data-testid="callers"]');
      list?.scrollIntoView({ block: "nearest" });
      if (folded) list?.querySelector<HTMLElement>("button")?.focus({ preventScroll: true });
    });
  }, [state.callersSeq]);
  // (it gives the code back when the reader goes to a caller, or elsewhere)
  useEffect(() => setContextOpen(false), [state.perspective, showSource, state.openSeq]);

  return (
    <main
      className={`workspace${showSource ? " has-source" : ""}${codeFirst ? " is-code-first" : ""}${contextOpen ? " is-context-open" : ""}`}
      data-perspective={state.perspective}
      style={
        codeFirst && outlineWidth !== undefined
          ? ({ "--outline-width": `${outlineWidth}px` } as CSSProperties)
          : undefined
      }
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
            ← <span className="nav-word">Back</span>
          </button>
          <button
            type="button"
            className="btn"
            aria-label="Forward"
            disabled={!state.canGoForward}
            onClick={() => store.forward()}
          >
            <span className="nav-word">Forward</span> →
          </button>
        </div>
        <nav className="workspace-breadcrumb" aria-label="Current topic">
          <button className="link" onClick={() => store.setPerspective("guide")}>
            {state.explainer.title}
          </button>
          <span aria-hidden="true">/</span>
          {/* Polite live region: a screen reader hears what a click or a scroll brought on screen. */}
          <span data-testid="breadcrumb-topic" aria-live="polite">
            {readingStep
              ? stepTitle(readingStep, state.model)
              : appliedStep
                ? stepTitle(appliedStep, state.model)
                : (info?.title ?? tour?.title ?? "Overview")}
          </span>
        </nav>
        {/* A double-click that changed the tab says so (always mounted, so a screen reader hears it). */}
        <p className="switch-notice" role="status" data-testid="switch-notice">
          {state.switchNotice}
        </p>
        {active && state.perspective !== "guide" && (
          <button className="btn" onClick={() => store.readExplanation()}>
            Read its explanation
          </button>
        )}
        {!code && !codeFirst && (
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
                <Guide onReading={setReading} returningFromPresent={startWithSource} />
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
                      {state.perspective === "flow" && flowOwner && (
                        <p className="caption-owner" data-testid="caption-owner">
                          The steps of <code>{state.model.label(flowOwner)}</code>
                        </p>
                      )}
                      {insides.length > 0 && (
                        <p className="caption-insides" data-testid="caption-insides">
                          {insides.map((node) => (
                            <button
                              key={node.id}
                              type="button"
                              className="link"
                              onClick={() => store.zoomInto(node.id)}
                            >
                              Inside {state.model.label(node.id)} →
                            </button>
                          ))}
                        </p>
                      )}
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
                        pins={map.view.layout}
                        selection={[...state.selection, ...map.related]}
                        matches={mapMatches}
                        related={map.related}
                        order={map.view.include}
                        present={map.generated}
                        reader
                      />
                    </div>
                  ) : flow?.type === "sequence" ? (
                    <div className="workspace-diagram">
                      <SequenceView
                        view={flow}
                        resetKey={`${flow.id}:${state.stepSeq}`}
                        model={state.model}
                        selection={state.selection}
                        matches={derived.matches}
                        related={derived.selection.related}
                      />
                    </div>
                  ) : flow ? (
                    <FlowDiagram key={flow.id} view={flow} outline={codeFirst} />
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
        {codeFirst && showSource && (
          <Splitter
            orientation="col"
            label="Resize the flow and the code"
            value={outlineWidth ?? defaultOutlineWidth()}
            min={OUTLINE_MIN}
            max={outlineMax()}
            onResize={(delta) =>
              setOutlineWidth((width) =>
                Math.round(clampWidth((width ?? defaultOutlineWidth()) + delta)),
              )
            }
          />
        )}
        {showSource && (
          <section className="workspace-source" aria-label="Source code">
            <CodeArea tree="collapsible" />
          </section>
        )}
        <aside
          className="workspace-context"
          aria-label="Topic context"
          ref={context}
          onKeyDown={(event) => {
            if (event.key === "Escape" && contextOpen) {
              event.stopPropagation();
              setContextOpen(false);
            }
          }}
        >
          {contextOpen && (
            <button
              type="button"
              className="context-close"
              data-testid="context-close"
              aria-label="Close the topic panel"
              title="Close (Esc)"
              onClick={() => setContextOpen(false)}
            >
              ×
            </button>
          )}
          {/* In the guide, the open section is the topic: its summary would say it again. A box picked from
              a section (a member chip, a call) is another topic, and gets its summary here. */}
          {info && !onScreen && diagramTitle && (
            <section className="topic-summary" data-testid="topic-summary">
              <p className="eyebrow">{state.perspective === "map" ? "This map" : "This flow"}</p>
              <h2>{diagramTitle}</h2>
              <p data-testid="topic-off-view">
                {info.title}, which you picked, is not in this{" "}
                {state.perspective === "map" ? "map" : "flow"}.
              </p>
            </section>
          )}
          {info && wholeFlow && diagramTitle && (
            <section className="topic-summary" data-testid="topic-summary">
              <p className="eyebrow">This flow</p>
              <h2>{diagramTitle}</h2>
              {flow?.scope?.question && <p>{flow.scope.question}</p>}
              <p data-testid="topic-around-flow">It all happens inside {info.title}.</p>
            </section>
          )}
          {info && topicShown && (
            <section className="topic-summary" data-testid="topic-summary">
              {/* While a step is applied the breadcrumb names the step: this is the box picked in it. */}
              <p className="eyebrow">{appliedStep ? "Picked" : "Current topic"}</p>
              <h2 className={looksLikeCode(info.title) ? "is-code" : undefined}>{info.title}</h2>
              {info.summary && (
                <p dangerouslySetInnerHTML={{ __html: renderInline(info.summary) }} />
              )}
              <TopicFacts
                key={`${state.perspective === "map" ? map.view.id : state.perspective}:${info.id}`}
                id={info.id}
                graph={state.perspective === "map" ? map.graph : undefined}
              />
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
              <Details
                reader
                untitled={!(state.perspective === "guide" && appliedStep)}
                factsAbove={topicShown}
              />
            </details>
          )}
        </aside>
      </div>
    </main>
  );
}

/** The narrowest a code-first outline gets, px; the code keeps at least `CODE_MIN`. */
const OUTLINE_MIN = 260;
const CODE_MIN = 420;
/** Below this width the page lays the columns out its own way (one column on a phone): no bar. */
const outlineMax = () => Math.max(OUTLINE_MIN, window.innerWidth - CODE_MIN);
const clampWidth = (width: number) => Math.min(outlineMax(), Math.max(OUTLINE_MIN, width));
/** The width the stylesheet gives the outline before anyone drags: 360px, 420px on a wide screen. */
const defaultOutlineWidth = () => (window.innerWidth >= 1680 ? 420 : 360);

/**
 * The width of a code-first flow's outline, per flow, remembered in this browser (localStorage, when it can
 * be used: a private window or blocked storage just forgets). Undefined until the reader resizes it: the
 * stylesheet's default.
 */
function useOutlineWidth(
  viewId: string | undefined,
): [number | undefined, (update: (width: number | undefined) => number) => void] {
  const key = viewId ? `xpl.outline-width.${viewId}` : undefined;
  const read = (): number | undefined => {
    if (!key) return undefined;
    try {
      const stored = Number(window.localStorage.getItem(key));
      return stored > 0 ? clampWidth(stored) : undefined;
    } catch {
      return undefined;
    }
  };
  const [width, setWidth] = useState<{ key: string | undefined; value: number | undefined }>(
    () => ({ key, value: read() }),
  );
  const value = width.key === key ? width.value : read();
  const update = (change: (width: number | undefined) => number) => {
    const next = change(value);
    setWidth({ key, value: next });
    if (!key) return;
    try {
      window.localStorage.setItem(key, String(next));
    } catch {
      // storage unavailable: the width lasts as long as the page
    }
  };
  return [value, update];
}
