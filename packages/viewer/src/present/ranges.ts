/**
 * Two places in one file that a step focuses, far apart (a call site and the helper it calls, a check and
 * the enum it orders by): one pane scrolled to the first would never show the second. A talk shows each
 * place in a pane of its own, stacked like the panes of two files; reading, a pane says "range 1 / 2" and
 * steps between them (RangeStepper).
 */
import type { FocusRange } from "@xpl/core";
import type { PaneSpec } from "../derive.js";

/** Ranges whose gap is at most this many lines are one place. */
const NEAR_LINES = 6;
/** ... unless together they would be taller than this many lines (a talk pane shows about 12). */
const PLACE_LINES = 16;
/** A file is split into at most this many panes. */
const MAX_PLACES = 3;

/** One place in a file: the ranges in it, first line to last. */
export interface Place {
  from: number;
  to: number;
  ranges: FocusRange[];
}

/** The places a pane's ranges make, top to bottom: ranges near each other (and overlapping ones) together. */
export function rangePlaces(ranges: readonly FocusRange[]): Place[] {
  const sorted = [...ranges].sort(
    (a, b) => a.range.startLine - b.range.startLine || a.range.endLine - b.range.endLine,
  );
  const places: Place[] = [];
  for (const r of sorted) {
    const last = places[places.length - 1];
    const { startLine, endLine } = r.range;
    if (
      last &&
      startLine - last.to - 1 <= NEAR_LINES &&
      (Math.max(last.to, endLine) - last.from + 1 <= PLACE_LINES || startLine <= last.to + 1)
    ) {
      last.to = Math.max(last.to, endLine);
      last.ranges.push(r);
    } else places.push({ from: startLine, to: endLine, ranges: [r] });
  }
  return places;
}

/** Which place holds `line` (the pane's lead): its index, else 0. */
export function placeOf(places: readonly Place[], line: number | undefined): number {
  if (line === undefined) return 0;
  const at = places.findIndex((place) => line >= place.from && line <= place.to);
  return at === -1 ? 0 : at;
}

/** A pane of a talk: one place of a file, `part` of `parts` (absent when the file has one place). */
export type TalkPane = PaneSpec & { part?: number; parts?: number };

/**
 * The panes of a talk: a focused file whose ranges make places far apart becomes one pane per place, the
 * place the step leads with first, then the others top to bottom (at most `MAX_PLACES`; the last takes the
 * rest). Each pane has only its own ranges, so it is as tall as they need and says what they are.
 */
export function talkPanes(panes: readonly PaneSpec[]): TalkPane[] {
  return panes.flatMap((pane): TalkPane[] => {
    if (!pane.focused || pane.opened || pane.ranges.length < 2) return [pane];
    let places = rangePlaces(pane.ranges);
    if (places.length < 2) return [pane];
    if (places.length > MAX_PLACES) {
      const rest = places.slice(MAX_PLACES - 1);
      places = [
        ...places.slice(0, MAX_PLACES - 1),
        {
          from: rest[0]!.from,
          to: rest[rest.length - 1]!.to,
          ranges: rest.flatMap((p) => p.ranges),
        },
      ];
    }
    const lead = placeOf(places, pane.lead);
    const ordered = [places[lead]!, ...places.filter((_, i) => i !== lead)];
    return ordered.map((place, i) => ({
      ...pane,
      ranges: place.ranges,
      lead: i === 0 && pane.lead !== undefined ? pane.lead : place.from,
      part: i + 1,
      parts: ordered.length,
    }));
  });
}
