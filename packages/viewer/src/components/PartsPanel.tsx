/**
 * "On this map": the parts of the diagram on screen, in words, in the topic column while nothing is picked
 * (and under the diagram on a phone, where it is the easier thing to read). Each row is an element of the
 * diagram (`data-part-id`): a click picks it (its code shows, as for a click on the diagram), and a caret in its code marks
 * the row as it marks the box.
 */
import { useMemo } from "react";
import type { DerivedGraph, GraphView, SequenceView } from "@xpl/core";
import { viewReverseIndex } from "../derive.js";
import { useStore, useViewerState } from "../hooks.js";
import { renderInline } from "../markdown.js";
import { mapParts, stepParts } from "../parts.js";

export interface PartsPanelProps {
  /** The map on screen (with its derived graph), or the flow or sequence on screen. */
  view: GraphView | SequenceView;
  graph?: DerivedGraph | undefined;
  /** For a map: the elements the caret's code belongs to (Workspace computes them for the map). */
  matches?: readonly string[];
}

export function PartsPanel({ view, graph, matches }: PartsPanelProps) {
  const store = useStore();
  const state = useViewerState();
  const model = state.model;
  const map = useMemo(
    () => (view.type === "graph" && graph ? mapParts(graph, view, model) : undefined),
    [view, graph, model],
  );
  const steps = useMemo(
    () => (view.type !== "graph" ? stepParts(view, model) : undefined),
    [view, model],
  );
  // a flow's own caret lookup (a map's comes in `matches`)
  const reverse = useMemo(
    () => (view.type !== "graph" ? viewReverseIndex(view, model) : undefined),
    [view, model],
  );
  const lit = new Set<string>(
    matches ??
      (state.cursor && reverse ? reverse.lookup(state.cursor.file, state.cursor.fromLine) : []),
  );
  const row = (id: string) => `parts-row${lit.has(id) ? " is-match" : ""}`;
  const pick = (id: string) => store.click(id);
  const summary = (text: string | undefined) =>
    text ? (
      <span className="parts-summary" dangerouslySetInnerHTML={{ __html: renderInline(text) }} />
    ) : null;

  return (
    <section className="parts-panel" data-testid="parts-panel" aria-labelledby="parts-title">
      <p className="eyebrow" id="parts-title">
        {map ? "On this map" : view.type === "flow" ? "Steps of this flow" : "Steps, in order"}
      </p>
      <p className="parts-hint">
        {map ? "Pick a box or an arrow to see its code." : "Pick a step to see its code."}
      </p>
      {map && (
        <>
          <ul className="parts-list" aria-label="Boxes">
            {map.boxes.map((box) => (
              <li
                key={box.id}
                style={box.depth ? { paddingLeft: `${box.depth * 14}px` } : undefined}
              >
                <button
                  type="button"
                  className={row(box.id)}
                  data-part-id={box.id}
                  onClick={() => pick(box.id)}
                >
                  <span className="parts-name">{box.label}</span>
                  {box.kind && <span className="parts-kind">{box.kind}</span>}
                  {summary(box.summary)}
                  {(box.uses > 0 || box.usedBy > 0) && (
                    <span className="parts-links">
                      {[
                        box.uses > 0 && `uses ${box.uses}`,
                        box.usedBy > 0 && `used by ${box.usedBy}`,
                      ]
                        .filter(Boolean)
                        .join(" · ")}
                    </span>
                  )}
                </button>
              </li>
            ))}
          </ul>
          {map.arrows.length > 0 && (
            <>
              <h3 className="parts-heading">Arrows with words</h3>
              <ul className="parts-list" aria-label="Arrows with words">
                {map.arrows.map((arrow) => (
                  <li key={arrow.id}>
                    <button
                      type="button"
                      className={row(arrow.id)}
                      data-part-id={arrow.id}
                      onClick={() => pick(arrow.id)}
                    >
                      <span className="parts-ends">
                        {arrow.from} → {arrow.to}
                      </span>
                      <span className="parts-name">{arrow.label}</span>
                      {summary(arrow.summary)}
                    </button>
                  </li>
                ))}
              </ul>
            </>
          )}
          {map.outside > 0 && (
            <p className="parts-outside">
              {map.outside === 1
                ? "1 dashed box stands for code outside this map."
                : `${map.outside} dashed boxes stand for code outside this map.`}{" "}
              Pick a box to see its dashed arrows.
            </p>
          )}
        </>
      )}
      {steps && (
        <ol className="parts-list is-steps" aria-label="Steps">
          {steps.map((step) => (
            <li key={step.id}>
              <button
                type="button"
                className={row(step.id)}
                data-part-id={step.id}
                onClick={() => pick(step.id)}
              >
                <span className="parts-number" aria-hidden="true">
                  {step.number}
                </span>
                <span className="parts-name">{step.label}</span>
                {step.from && step.to && (
                  <span className="parts-ends">
                    {step.from === step.to ? step.from : `${step.from} → ${step.to}`}
                  </span>
                )}
                {summary(step.summary)}
              </button>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}
