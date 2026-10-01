import { useEffect, useRef } from "react";
import type { ExplainerModel, TourStep } from "@xpl/core";
import { useStore, useViewerState } from "../hooks.js";
import { renderInline, renderMarkdown } from "../markdown.js";
import { stepText, stepTitle } from "../stepTitle.js";

export function Guide() {
  const store = useStore();
  const state = useViewerState();
  const tour = store.currentTour() ?? state.model.tours[0];
  const body = useRef<HTMLDivElement>(null);
  const initialized = useRef(false);
  const active =
    state.applied && state.applied.tourId === tour?.id ? state.applied.stepId : undefined;

  useEffect(() => {
    if (
      !initialized.current &&
      tour &&
      !state.applied &&
      state.selection.length === 0 &&
      !state.canGoBack &&
      !state.canGoForward
    ) {
      initialized.current = true;
      store.previewStep(tour.id, state.tour?.step ?? 0);
    }
  }, [
    store,
    tour,
    state.applied,
    state.selection.length,
    state.tour?.step,
    state.canGoBack,
    state.canGoForward,
  ]);

  useEffect(() => {
    const section =
      active &&
      body.current?.querySelector<HTMLElement>(`[data-section-id="${CSS.escape(active)}"]`);
    if (!section || !body.current) return;
    const scroller =
      getComputedStyle(body.current).overflowY === "auto"
        ? body.current
        : body.current.closest<HTMLElement>(".workspace-columns");
    if (!scroller) return;
    const at = section.getBoundingClientRect(),
      viewport = scroller.getBoundingClientRect();
    if (at.top < viewport.top || at.bottom > viewport.bottom)
      scroller.scrollTop += at.top - viewport.top - 24;
  }, [active]);

  if (!tour)
    return (
      <div className="guide-fallback">
        <p className="eyebrow">Start here</p>
        <h2>{state.explainer.title}</h2>
        <p>Choose a topic below, or open the map to see the parts of the code.</p>
        {state.model.views.map((view) => (
          <section className="guide-section" key={view.id}>
            <h3>{view.title}</h3>
            <p>{view.scope?.question}</p>
            {state.model.concepts.map((concept) => (
              <p key={concept.id}>
                <button className="link" onClick={() => store.select([concept.id])}>
                  {concept.label}
                </button>{" "}
                — {concept.summary}
              </p>
            ))}
            <button
              className="btn"
              onClick={() => {
                store.setView(view.id);
                store.setPerspective(view.type === "graph" ? "map" : "flow");
              }}
            >
              Show this topic
            </button>
          </section>
        ))}
        {state.model.views.length === 0 && <p>This explainer has no topics yet.</p>}
      </div>
    );

  const title = (step: TourStep) => stepTitle(step, state.model);
  const summary =
    typeof tour.summary === "string" && tour.summary.trim() ? tour.summary : undefined;
  return (
    <div className="guide-layout" data-testid="guide">
      <nav className="guide-contents" aria-label="Guide contents">
        <p className="eyebrow">In this guide</p>
        {state.model.tours.length > 1 && (
          <select
            aria-label="Choose a guide"
            value={tour.id}
            onChange={(event) => store.previewStep(event.target.value, 0)}
          >
            {state.model.tours.map((item) => (
              <option key={item.id} value={item.id}>
                {item.title}
              </option>
            ))}
          </select>
        )}
        {tour.steps.map((step, index) => (
          <button
            key={step.id}
            type="button"
            aria-current={step.id === active ? "step" : undefined}
            onClick={() => store.previewStep(tour.id, index)}
          >
            <span>{index + 1}</span>
            {title(step)}
          </button>
        ))}
      </nav>
      <div className="guide-body" ref={body}>
        <h2>{tour.title}</h2>
        {/* The summary comes first: what this is and why it matters, before any detail. */}
        {summary && (
          <div
            className="guide-summary markdown"
            data-testid="tour-summary"
            dangerouslySetInnerHTML={{ __html: renderMarkdown(summary) }}
          />
        )}
        {tour.steps.map((step, index) => (
          <GuideSection
            key={step.id}
            step={step}
            index={index}
            tourId={tour.id}
            active={step.id === active}
          />
        ))}
      </div>
    </div>
  );
}

/**
 * One section of the guide: a tour step. Its title, then the rest of its note (the title is not said
 * twice), then what it shows: the interaction it focuses, the members of a group, what a concept applies
 * to. Each thing is said once: the summaries of the focused elements only stand in for a missing note.
 */
function GuideSection({
  step,
  index,
  tourId,
  active,
}: {
  step: TourStep;
  index: number;
  tourId: string;
  active: boolean;
}) {
  const store = useStore();
  const state = useViewerState();
  const { title, titleMarkdown, body } = stepText(step, state.model);
  const hasNote = typeof step.note === "string" && step.note.trim() !== "";
  const show = (perspective: "map" | "flow" | "code") => {
    store.previewStep(tourId, index);
    store.setPerspective(perspective);
  };
  return (
    <section className={`guide-section${active ? " is-active" : ""}`} data-section-id={step.id}>
      <span className="section-number">Step {index + 1}</span>
      {titleMarkdown !== undefined ? (
        <h3 dangerouslySetInnerHTML={{ __html: renderInline(titleMarkdown) }} />
      ) : (
        <h3>{title}</h3>
      )}
      {body && (
        <div
          className="markdown"
          data-testid="section-note"
          dangerouslySetInnerHTML={{ __html: renderMarkdown(body) }}
        />
      )}
      {!hasNote &&
        step.focus.map((id) => {
          const summary = summaryOf(id, state.model);
          return summary ? (
            <p key={id} data-testid="focus-summary">
              <strong>{state.model.label(id)}</strong> —{" "}
              <span dangerouslySetInnerHTML={{ __html: renderInline(summary) }} />
            </p>
          ) : null;
        })}
      {step.focus.map((id) => {
        const element = state.model.element(id);
        const members =
          element?.type === "node" && element.node.kind === "group"
            ? state.model.members(id)
            : element?.type === "concept"
              ? (element.concept.related ?? [])
              : [];
        return element?.type === "step" ? (
          <figure className="guide-mini" key={id} aria-label={`Interaction: ${element.step.label}`}>
            <figcaption>This call</figcaption>
            <div className="guide-mini-row">
              <button className="guide-mini-node" onClick={() => store.select([element.step.from])}>
                {state.model.label(element.step.from)}
              </button>
              <button className="guide-mini-link" onClick={() => store.previewStep(tourId, index)}>
                {element.step.label}
                <span aria-hidden="true">→</span>
              </button>
              <button className="guide-mini-node" onClick={() => store.select([element.step.to])}>
                {state.model.label(element.step.to)}
              </button>
            </div>
          </figure>
        ) : members.length > 0 ? (
          <figure className="guide-mini" key={id}>
            <figcaption>{element?.type === "concept" ? "Where this applies" : "Parts"}</figcaption>
            <div className="guide-mini-row">
              {members.map((member) => (
                <button
                  className="guide-mini-node"
                  key={member}
                  onClick={() => store.select([member])}
                >
                  {state.model.label(member)}
                </button>
              ))}
            </div>
          </figure>
        ) : null;
      })}
      <div className="section-actions">
        <button className="btn" onClick={() => show("map")}>
          Show on the map
        </button>
        <button className="btn" onClick={() => show("flow")}>
          Show in the flow
        </button>
        <button className="btn" onClick={() => show("code")}>
          Show the code
        </button>
      </div>
    </section>
  );
}

/** The summary of a node, concept, edge or sequence step (what stands in for a missing note). */
function summaryOf(id: string, model: ExplainerModel): string | undefined {
  const element = model.element(id);
  switch (element?.type) {
    case "node":
      return element.node.summary;
    case "concept":
      return element.concept.summary;
    case "edge":
      return element.edge.summary;
    case "step":
      return element.step.summary;
    default:
      return undefined;
  }
}
