/**
 * Present mode: a tour played step by step (ARCHITECTURE.md section 6). Every step has already been
 * applied by the store (its view, its focus as the selection, the code override and editor options);
 * this lays it out for a room: the diagram and, under it, a large caption with the step counter and
 * the note (markdown) on the left, the code on the right with the file tree out of the way.
 *
 * Keys live in App.tsx (arrows, PageUp/PageDown, Space, Home/End, Esc). Clicking around the diagram is
 * a detour: the selection follows the click and the caption says so; the next arrow key applies the
 * next step again.
 */
import { useMemo } from "react";
import { CodeArea } from "../components/CodeArea.js";
import { DiagramPane } from "../components/DiagramPane.js";
import { useStore, useViewerState } from "../hooks.js";
import { renderMarkdown } from "../markdown.js";
import { stepNumber } from "../modes.js";

export function PresentMode() {
  const store = useStore();
  const state = useViewerState();
  const tour = store.currentTour();
  const index = state.tour?.step ?? 0;
  const step = tour?.steps[index];
  const count = tour?.steps.length ?? 0;
  const note = step?.note?.trim() ? step.note : undefined;
  const noteHtml = useMemo(() => (note ? renderMarkdown(note) : ""), [note]);

  if (!tour || !step) {
    return (
      <main className="present-empty" data-testid="present">
        <h2>{tour ? `“${tour.title}” has no steps yet` : "There is no tour to present"}</h2>
        <p>
          Leave Present and open the Tours panel: select something in a view and add it as the first
          step. Claude can also write a tour: run <code>/code-explainer make tour</code>.
        </p>
        <button type="button" className="btn is-primary" onClick={() => store.exitPresent()}>
          Back to Explore
        </button>
      </main>
    );
  }

  const detour = state.applied === undefined;
  // What the step asked for, not what a detour left of it: the tree must not pop in and out.
  const tree = step.editor?.hideFileTree === false ? "open" : "hidden";

  return (
    <main
      className="present"
      data-testid="present"
      data-tour={tour.id}
      data-step={stepNumber(index)}
      data-step-id={step.id}
    >
      <section className="present-left" aria-label="Diagram and caption">
        <DiagramPane />
        <footer className="tour-caption" aria-label="Caption">
          <div className="tour-nav">
            <button
              type="button"
              className="tour-btn"
              data-testid="tour-prev"
              aria-label="Previous step"
              title="Previous step (←, Page Up)"
              disabled={index === 0}
              onClick={() => store.prevStep()}
            >
              ‹
            </button>
            <span className="tour-counter" data-testid="tour-counter" aria-live="polite">
              {stepNumber(index)} / {count}
            </span>
            <button
              type="button"
              className="tour-btn"
              data-testid="tour-next"
              aria-label="Next step"
              title="Next step (→, Page Down, Space)"
              disabled={index >= count - 1}
              onClick={() => store.nextStep()}
            >
              ›
            </button>
            {detour ? (
              <p
                className="tour-detour"
                role="status"
                data-testid="tour-detour"
                title="A click took the screen off the tour: an arrow key applies the next step again"
              >
                Exploring ·{" "}
                <button type="button" className="link" onClick={() => store.goToStep(index)}>
                  Back to step {stepNumber(index)}
                </button>
              </p>
            ) : (
              <span className="tour-keys" aria-hidden="true">
                ← → step · Esc leave
              </span>
            )}
          </div>
          <div className="tour-progress" aria-hidden="true">
            <span style={{ width: `${(stepNumber(index) / count) * 100}%` }} />
          </div>
          {note && (
            <div
              className="tour-note markdown"
              data-testid="tour-note"
              dangerouslySetInnerHTML={{ __html: noteHtml }}
            />
          )}
        </footer>
      </section>
      <section className="present-right" aria-label="Code">
        <CodeArea tree={tree} />
      </section>
    </main>
  );
}
