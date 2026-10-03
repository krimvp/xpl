/**
 * Present mode: a tour played step by step (ARCHITECTURE.md section 6). Every step has already been
 * applied by the store (its view, its focus as the selection, the code override and editor options);
 * this lays it out for a room: the diagram and, under it, a large caption (the step's title and note) on
 * the left, the code on the right with the file tree out of the way. The step counter, the arrows and
 * the tour picker are in the header (Header.tsx). A tour with a flow step gives the diagram more of the
 * width, for all of its steps (a flow is tall and branches sideways; the code beside it wraps its long
 * lines): the screen is split once per tour, so it does not jump between a map step and a flow step.
 *
 * The caption keeps one height and one type size for the whole tour: as tall as its tallest step needs,
 * measured off-screen, so the diagram above it does not jump from step to step. The diagram keeps a
 * minimum (`DIAGRAM_MIN`); when the captions do not fit what is left, their type gets smaller first, and
 * only at the smallest size does a caption scroll.
 *
 * Keys live in App.tsx (arrows, PageUp/PageDown, Space, Home/End, Esc). Clicking around the diagram is
 * a detour: the selection follows the click and the header says so; the next arrow key applies the
 * next step again (← and Esc go back to the step that was interrupted).
 */
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { TourStep } from "@xpl/core";
import { CodeArea } from "../components/CodeArea.js";
import { DiagramPane } from "../components/DiagramPane.js";
import { useStore, useViewerState } from "../hooks.js";
import { renderInline, renderMarkdown } from "../markdown.js";
import { stepNumber } from "../modes.js";
import { stepText } from "../stepTitle.js";
import { captionCap, captionFit } from "./caption.js";

/** A note body longer than this (characters of markdown): the tour's captions start one size smaller. */
const LONG_NOTE = 280;

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
  // One type size for the tour: a tour with a long note is set a little smaller throughout.
  const long = useMemo(
    () =>
      tour?.steps.some((other) => (stepText(other, state.model).body?.length ?? 0) > LONG_NOTE) ??
      false,
    [tour, state.model],
  );
  // One split for the tour: the widest diagram column any of its steps needs.
  const wide = tour?.steps.some((other) => state.model.view(other.view)?.type === "flow") ?? false;

  // One caption height for the tour: the tallest step's, measured on hidden copies of every caption, at the
  // largest type size that leaves the diagram its room.
  const left = useRef<HTMLElement>(null);
  const measure = useRef<HTMLDivElement>(null);
  const [fit, setFit] = useState<{ size: number; height: number; cap: number } | undefined>();
  const [width, setWidth] = useState(0);
  const [height, setHeight] = useState(0);
  useLayoutEffect(() => {
    const element = left.current;
    if (!element) return;
    const observer = new ResizeObserver(() => {
      setWidth(element.clientWidth);
      setHeight(element.clientHeight);
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, [tour?.id]);
  useLayoutEffect(() => {
    const box = measure.current;
    const copies = box?.children;
    if (!box || !copies || copies.length === 0 || height === 0) return setFit(undefined);
    const bar = left.current?.querySelector<HTMLElement>(".diagram-caption")?.offsetHeight ?? 0;
    // (+2: the diagram pane's border)
    const cap = captionCap(height, bar + 2);
    const tallestAt = (size: number) => {
      box.dataset.size = String(size);
      let tallest = 0;
      for (const copy of copies) tallest = Math.max(tallest, (copy as HTMLElement).offsetHeight);
      return tallest;
    };
    setFit({ ...captionFit(tallestAt, cap, long), cap });
  }, [tour, width, state.model, height, long]);

  // Keyboard focus: on the slide when the talk starts, back on the Present button when it ends.
  const slide = useRef<HTMLElement>(null);
  const started = step !== undefined;
  useEffect(() => {
    if (started) slide.current?.focus({ preventScroll: true });
  }, [started]);
  useEffect(
    () => () => {
      requestAnimationFrame(() =>
        document.querySelector<HTMLElement>('[data-testid="mode-present"]')?.focus(),
      );
    },
    [],
  );
  // The code's scrolling areas can be reached with the keyboard, and say which file they show.
  useEffect(() => {
    const code = slide.current?.querySelector(".present-right");
    if (!code) return;
    const label = () => {
      for (const scroller of code.querySelectorAll<HTMLElement>(".cm-scroller")) {
        if (scroller.getAttribute("tabindex") === "0") continue;
        scroller.tabIndex = 0;
        const name = scroller.querySelector(".cm-content")?.getAttribute("aria-label");
        scroller.setAttribute("aria-label", name ?? "Source code");
      }
    };
    label();
    const observer = new MutationObserver(label);
    observer.observe(code, { childList: true, subtree: true });
    return () => observer.disconnect();
  }, [started]);
  // "Fit all" and the zoom buttons stay off the picture until the mouse moves (a talk is driven by keys).
  const [pointer, setPointer] = useState(false);
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const onMove = () => {
      setPointer(true);
      clearTimeout(timer);
      timer = setTimeout(() => setPointer(false), 3000);
    };
    window.addEventListener("pointermove", onMove, { passive: true });
    return () => {
      clearTimeout(timer);
      window.removeEventListener("pointermove", onMove);
    };
  }, []);

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
      ref={slide}
      tabIndex={-1}
      aria-label={`${tour.title}: step ${stepNumber(index)} of ${count}`}
      data-tour={tour.id}
      data-step={stepNumber(index)}
      data-step-id={step.id}
      data-view-type={store.view()?.type}
      data-split={wide ? "wide" : undefined}
      data-pointer={pointer ? "moved" : undefined}
    >
      <section className="present-left" aria-label="Diagram and caption" ref={left}>
        <DiagramPane />
        <footer
          className="tour-caption"
          aria-label="Caption"
          data-testid="tour-caption"
          data-size={fit?.size ?? (long ? 1 : 0)}
          style={fit ? { height: fit.height, maxHeight: fit.cap } : undefined}
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
    <div className="tour-caption">
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
