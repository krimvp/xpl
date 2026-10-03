/**
 * "‹ range 1 / 2 ›" in a pane's header: the places of a file the focus is about, when they are far apart
 * (present/ranges.ts), so that the second one is not missed below the first. Looks and works like the
 * change stepper next to it; n / p in the code step through the places when the file has no changes to
 * step through. In a talk each place has a pane of its own, and the header just says which one it is.
 */
import type { EditorView } from "@codemirror/view";
import type { FocusRange } from "@xpl/core";
import { useEffect, useMemo, useRef, useState, type RefObject } from "react";
import { scrollToLine } from "../editor.js";
import { placeOf, rangePlaces } from "../present/ranges.js";

export function RangeStepper({
  ranges,
  lead,
  view,
  focusToken,
  keys,
  part,
}: {
  ranges: readonly FocusRange[];
  /** The line the pane scrolls to first: its place is the one shown. */
  lead: number | undefined;
  view: RefObject<EditorView | null>;
  /** Changes when the focus changes: back to the lead place. */
  focusToken: unknown;
  /** n / p step through the places (the file has no changes for them to step through). */
  keys: boolean;
  /** A talk's pane showing one place of the file: `[1, 2]`. */
  part?: readonly [number, number];
}) {
  const places = useMemo(() => rangePlaces(ranges), [ranges]);
  const [at, setAt] = useState(() => placeOf(places, lead));
  useEffect(() => setAt(placeOf(places, lead)), [focusToken, places, lead]);
  const go = (next: number) => {
    const editor = view.current;
    const place = places[next];
    if (!editor || !place) return;
    scrollToLine(editor, place.from);
    setAt(next);
  };
  // n / p in the code, unless the change stepper has them
  const self = useRef<HTMLSpanElement>(null);
  const goRef = useRef(go);
  goRef.current = go;
  const atRef = useRef(at);
  atRef.current = at;
  useEffect(() => {
    const pane = self.current?.closest(".pane");
    if (!pane || !keys || places.length < 2) return;
    const onKeyDown = (event: Event) => {
      const key = event as KeyboardEvent;
      if (key.ctrlKey || key.metaKey || key.altKey || key.defaultPrevented) return;
      if (!(key.target as HTMLElement).closest(".cm-content")) return;
      if (key.key !== "n" && key.key !== "p") return;
      key.preventDefault();
      const next = atRef.current + (key.key === "n" ? 1 : -1);
      if (next >= 0 && next < places.length) goRef.current(next);
    };
    pane.addEventListener("keydown", onKeyDown);
    return () => pane.removeEventListener("keydown", onKeyDown);
  }, [keys, places.length]);

  if (part) {
    return (
      <span
        className="pane-hunks pane-ranges"
        data-testid="pane-ranges"
        title="The step shows two places in this file: each has a pane of its own"
      >
        <span>
          range {part[0]} / {part[1]}
        </span>
      </span>
    );
  }
  if (places.length < 2) return null;
  return (
    <span className="pane-hunks pane-ranges" data-testid="pane-ranges" ref={self}>
      <button
        type="button"
        aria-label="Previous range"
        title={`Previous place in this file${keys ? " (p)" : ""}`}
        disabled={at <= 0}
        onClick={() => go(at - 1)}
      >
        ‹
      </button>
      <span aria-live="polite" title={`Lines ${places[at]!.from}-${places[at]!.to}`}>
        range {at + 1} / {places.length}
      </span>
      <button
        type="button"
        aria-label="Next range"
        title={`Next place in this file${keys ? " (n)" : ""}`}
        disabled={at >= places.length - 1}
        onClick={() => go(at + 1)}
      >
        ›
      </button>
    </span>
  );
}
