/**
 * Present mode: a tour played step by step (ARCHITECTURE.md section 6). Every step has already been
 * applied by the store (its view, its focus as the selection, the code override and editor options);
 * this lays it out for a room: the diagram and, under it, a large caption (the step's title and note) on
 * the left, the code on the right with the file tree out of the way. The step counter, the arrows and
 * the tour picker are in the header (Header.tsx). A flow step gives the diagram more of the width (a flow
 * is tall and branches sideways; the code beside it wraps its long lines).
 *
 * Keys live in App.tsx (arrows, PageUp/PageDown, Space, Home/End, Esc). Clicking around the diagram is
 * a detour: the selection follows the click and the header says so; the next arrow key applies the
 * next step again.
 */
import { useMemo } from "react";
import { CodeArea } from "../components/CodeArea.js";
import { DiagramPane } from "../components/DiagramPane.js";
import { useStore, useViewerState } from "../hooks.js";
import { renderInline, renderMarkdown } from "../markdown.js";
import { stepNumber } from "../modes.js";
import { stepText } from "../stepTitle.js";

/** A note body longer than this (characters of markdown) is set in the smaller caption size. */
const LONG_NOTE = 280;

export function PresentMode() {
  const store = useStore();
  const state = useViewerState();
  const tour = store.currentTour();
  const index = state.tour?.step ?? 0;
  const step = tour?.steps[index];
  const count = tour?.steps.length ?? 0;
  // The step's title (the heading of its note, its short first sentence, else what it focuses), then the
  // rest of the note: the same title as in the guide, and nothing said twice.
  const text = step ? stepText(step, state.model) : undefined;
  const note = text?.body;
  const noteHtml = useMemo(() => (note ? renderMarkdown(note) : ""), [note]);
  // A long note is set a little smaller, so that it fits its box more often; what still does not fit
  // scrolls inside the caption (the step counter stays on top).
  const long = (note?.length ?? 0) > LONG_NOTE;

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

  // What the step asked for, not what a detour left of it: the tree must not pop in and out.
  const tree = step.editor?.hideFileTree === false ? "open" : "hidden";

  return (
    <main
      className="present"
      data-testid="present"
      data-tour={tour.id}
      data-step={stepNumber(index)}
      data-step-id={step.id}
      data-view-type={store.view()?.type}
    >
      <section className="present-left" aria-label="Diagram and caption">
        <DiagramPane />
        <footer
          className={"tour-caption" + (long ? " is-long" : "")}
          aria-label="Caption"
          data-testid="tour-caption"
        >
          {text!.titleMarkdown !== undefined ? (
            <h2
              className="tour-title"
              data-testid="tour-title"
              dangerouslySetInnerHTML={{ __html: renderInline(text!.titleMarkdown) }}
            />
          ) : (
            <h2 className="tour-title" data-testid="tour-title">
              {text!.title}
            </h2>
          )}
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
