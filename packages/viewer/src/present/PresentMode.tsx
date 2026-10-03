/**
 * Present mode: a tour played step by step (ARCHITECTURE.md section 6). Every step has already been
 * applied by the store (its view, its focus as the selection, the code override and editor options);
 * this lays it out for a room: the diagram and, under it, a large caption (the step's title and note) on
 * the left, the code on the right with the file tree out of the way. The step counter, the arrows and
 * the tour picker are in the header (Header.tsx). A flow step gives the diagram more of the width (a flow
 * is tall and branches sideways; the code beside it wraps its long lines).
 *
 * The caption keeps one height for the whole tour: as tall as its tallest step needs (up to its cap), measured
 * off-screen, so the diagram above it does not jump from step to step.
 *
 * Keys live in App.tsx (arrows, PageUp/PageDown, Space, Home/End, Esc). Clicking around the diagram is
 * a detour: the selection follows the click and the header says so; the next arrow key applies the
 * next step again.
 */
import { useLayoutEffect, useMemo, useRef, useState } from "react";
import type { TourStep } from "@xpl/core";
import { CodeArea } from "../components/CodeArea.js";
import { DiagramPane } from "../components/DiagramPane.js";
import { useStore, useViewerState } from "../hooks.js";
import { renderInline, renderMarkdown } from "../markdown.js";
import { stepNumber } from "../modes.js";
import { stepText } from "../stepTitle.js";

/** A note body longer than this (characters of markdown) is set in the smaller caption size. */
const LONG_NOTE = 280;

/** The caption's height at most, as a share of the window's (`.tour-caption` max-height: 62vh). */
const CAPTION_CAP = 0.62;

export function PresentMode() {
  const store = useStore();
  const state = useViewerState();
  const tour = store.currentTour();
  const index = state.tour?.step ?? 0;
  const step = tour?.steps[index];
  const count = tour?.steps.length ?? 0;
  // The step's title (the heading of its note, its first sentence, cut short when long, else "Step N"), then the
  // rest of the note: the same title as in the guide, and nothing said twice.
  const text = step ? stepText(step, state.model) : undefined;
  const note = text?.body;
  const noteHtml = useMemo(() => (note ? renderMarkdown(note) : ""), [note]);
  // A long note is set a little smaller, so that it fits its box more often; what still does not fit
  // scrolls inside the caption (the step counter stays on top).
  const long = (note?.length ?? 0) > LONG_NOTE;

  // One caption height for the tour: the tallest step's, measured on hidden copies of every caption.
  const left = useRef<HTMLElement>(null);
  const measure = useRef<HTMLDivElement>(null);
  const [captionHeight, setCaptionHeight] = useState<number | undefined>(undefined);
  const [width, setWidth] = useState(0);
  const [height, setHeight] = useState(0);
  useLayoutEffect(() => {
    const element = left.current;
    if (!element) return;
    const observer = new ResizeObserver(() => {
      setWidth(element.clientWidth);
      setHeight(window.innerHeight);
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, [tour?.id]);
  useLayoutEffect(() => {
    const copies = measure.current?.children;
    if (!copies || copies.length === 0) return setCaptionHeight(undefined);
    let tallest = 0;
    for (const copy of copies) tallest = Math.max(tallest, (copy as HTMLElement).offsetHeight);
    // Never past the caption's own cap (a note longer than that scrolls inside it): the diagram keeps its room.
    // (62vh: the `max-height` of `.tour-caption` in styles.css)
    setCaptionHeight(Math.ceil(Math.min(tallest, window.innerHeight * CAPTION_CAP)));
  }, [tour, width, state.model, height]);

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
      <section className="present-left" aria-label="Diagram and caption" ref={left}>
        <DiagramPane />
        <footer
          className={"tour-caption" + (long ? " is-long" : "")}
          aria-label="Caption"
          data-testid="tour-caption"
          style={captionHeight ? { minHeight: captionHeight } : undefined}
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
        <div className="tour-caption-measure" ref={measure} aria-hidden="true">
          {tour.steps.map((other) => (
            <CaptionCopy key={other.id} step={other} />
          ))}
        </div>
      </section>
      <section className="present-right" aria-label="Code">
        <CodeArea tree={tree} />
      </section>
    </main>
  );
}

/** A hidden copy of a step's caption, the same size as the real one: what it would need, for one height. */
function CaptionCopy({ step }: { step: TourStep }) {
  const state = useViewerState();
  const text = stepText(step, state.model);
  const note = text.body;
  return (
    <div className={"tour-caption" + ((note?.length ?? 0) > LONG_NOTE ? " is-long" : "")}>
      <h2 className="tour-title">{text.title}</h2>
      {note && (
        <div
          className="tour-note markdown"
          dangerouslySetInnerHTML={{ __html: renderMarkdown(note) }}
        />
      )}
    </div>
  );
}
