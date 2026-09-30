import { useEffect, useRef } from "react";
import type { TourStep } from "@xpl/core";
import { useStore, useViewerState } from "../hooks.js";
import { renderMarkdown } from "../markdown.js";

export function sectionTitle(step: TourStep, label: (id: string) => string): string {
  const title = step.note
    ?.split("\n")
    .find((line) => line.trim())
    ?.replace(/^#+\s*/, "")
    .replace(/[*`]/g, "");
  return title && title.length <= 100
    ? title.split(": ")[0]!
    : step.focus.map(label).slice(0, 2).join(" · ") || "Overview";
}

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
        <p>Choose a topic below, or use the system map to explore its implementation.</p>
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
              Explore this topic
            </button>
          </section>
        ))}
        {state.model.views.length === 0 && <p>This explainer has no topics yet.</p>}
      </div>
    );

  const title = (step: TourStep) => sectionTitle(step, (id) => state.model.label(id));
  return (
    <div className="guide-layout" data-testid="guide">
      <nav className="guide-contents" aria-label="Guide contents">
        <p className="eyebrow">In this explanation</p>
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
        <p className="eyebrow">Guided explanation</p>
        <h2>{tour.title}</h2>
        <p className="guide-intro">
          Read the story, then switch to a map, process flow or source code without losing your
          topic.
        </p>
        {tour.steps.map((step, index) => (
          <section
            className={`guide-section${step.id === active ? " is-active" : ""}`}
            data-section-id={step.id}
            key={step.id}
          >
            <span className="section-number">Section {index + 1}</span>
            <h3>{title(step)}</h3>
            {step.note && (
              <div
                className="markdown"
                dangerouslySetInnerHTML={{ __html: renderMarkdown(step.note) }}
              />
            )}
            {step.focus.map((id) => {
              const element = state.model.element(id);
              const item =
                element?.type === "node"
                  ? element.node
                  : element?.type === "concept"
                    ? element.concept
                    : element?.type === "edge"
                      ? element.edge
                      : element?.type === "step"
                        ? element.step
                        : undefined;
              return item?.summary ? (
                <p key={id}>
                  <strong>{state.model.label(id)}</strong> — {item.summary}
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
                <figure
                  className="guide-mini"
                  key={id}
                  aria-label={`Interaction: ${element.step.label}`}
                >
                  <figcaption>This interaction</figcaption>
                  <div className="guide-mini-row">
                    <button
                      className="guide-mini-node"
                      onClick={() => store.select([element.step.from])}
                    >
                      {state.model.label(element.step.from)}
                    </button>
                    <button
                      className="guide-mini-link"
                      onClick={() => store.previewStep(tour.id, index)}
                    >
                      {element.step.label}
                      <span aria-hidden="true">→</span>
                    </button>
                    <button
                      className="guide-mini-node"
                      onClick={() => store.select([element.step.to])}
                    >
                      {state.model.label(element.step.to)}
                    </button>
                  </div>
                </figure>
              ) : members.length > 0 ? (
                <figure className="guide-mini" key={id}>
                  <figcaption>{element?.type === "concept" ? "Applies to" : "Contains"}</figcaption>
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
              <button
                className="btn"
                onClick={() => {
                  store.previewStep(tour.id, index);
                  store.setPerspective("map");
                }}
              >
                Show in system map
              </button>
              <button
                className="btn"
                onClick={() => {
                  store.previewStep(tour.id, index);
                  store.setPerspective("flow");
                }}
              >
                Follow the process
              </button>
              <button
                className="btn"
                onClick={() => {
                  store.previewStep(tour.id, index);
                  store.setPerspective("code");
                }}
              >
                Open code & files
              </button>
            </div>
          </section>
        ))}
      </div>
    </div>
  );
}
