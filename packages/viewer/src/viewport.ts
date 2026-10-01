/**
 * Where a diagram sits in its pane: the maths of PanZoom, without the DOM (so the unit tests can check it).
 *
 * A diagram is drawn in its own units and the pane shows it through a transform `{ k, x, y }` (scale, then
 * translate). *Fit* is the transform that shows all of it. That is the right first view for a diagram that
 * fits at a readable size, and the wrong one for a big diagram: fitted, a view of seventeen boxes with groups
 * comes out at 0.4 and no label can be read. A diagram whose fit scale is below `READABLE_FLOOR` therefore
 * starts *zoomed in* at `READABLE_ZOOM`, looking at its first corner (or at what the caller wants seen: the
 * selection, the first box of the view), and PanZoom offers "Fit all" to get the overview.
 */

import type { Box } from "./svg.js";

export interface Size {
  w: number;
  h: number;
}

export type { Box };

/** The pane's view of the diagram: scale `k`, then translate by (`x`, `y`) pane pixels. */
export interface Transform {
  k: number;
  x: number;
  y: number;
}

export const MIN_ZOOM = 0.1;
export const MAX_ZOOM = 4;

/** Below this fit scale the whole diagram is too small to read: the first view is zoomed in instead. */
export const READABLE_FLOOR = 0.6;
/** The zoom such a diagram starts at: 13px labels come out at about 10px. */
export const READABLE_ZOOM = 0.75;

export const clamp = (value: number, lo: number, hi: number): number =>
  Math.min(hi, Math.max(lo, value));

export interface FitOptions {
  /** Room left around the diagram, px. */
  padding: number;
  /** Fitting never enlarges a small diagram by more than this. */
  maxZoom: number;
}

/** The scale at which the whole diagram fits the pane, not yet bounded (0 when there is nothing to fit). */
export function rawFitScale(size: Size, content: Pick<Box, "width" | "height">, padding: number) {
  if (size.w <= 0 || size.h <= 0 || content.width <= 0 || content.height <= 0) return 0;
  return Math.min((size.w - 2 * padding) / content.width, (size.h - 2 * padding) / content.height);
}

/** Fit: all of the diagram, centred (a little above the middle when it is short: the top matters more). */
export function fitTransform(
  size: Size,
  content: Pick<Box, "width" | "height">,
  { padding, maxZoom }: FitOptions,
): Transform | undefined {
  const raw = rawFitScale(size, content, padding);
  if (raw <= 0) return undefined;
  const k = clamp(raw, MIN_ZOOM, maxZoom);
  return {
    k,
    x: (size.w - content.width * k) / 2,
    y: Math.max(padding / 2, (size.h - content.height * k) / 2),
  };
}

export interface StartOptions extends FitOptions {
  /** A fit scale below this makes the first view zoomed in (default `READABLE_FLOOR`). */
  floor?: number;
  /** The zoom of that first view (default `READABLE_ZOOM`). */
  readable?: number;
}

export interface StartView {
  transform: Transform;
  /** The diagram is too big to be read whole: the first view shows part of it, at the readable zoom. */
  partial: boolean;
}

/**
 * Where along one axis the first view begins, in diagram units: at the start of the diagram, unless `anchor`
 * (a span the caller wants seen) does not fit into the first `visible` units; then the window moves just
 * far enough to show it (centred when it is smaller than the window, else aligned to its start), but never
 * past the end of the diagram.
 */
function windowStart(
  anchor: { start: number; size: number } | undefined,
  visible: number,
  total: number,
): number {
  const last = Math.max(0, total - visible);
  if (!anchor || anchor.start + anchor.size <= visible) return 0;
  const wanted =
    anchor.size >= visible ? anchor.start : anchor.start + anchor.size / 2 - visible / 2;
  return clamp(wanted, 0, last);
}

/**
 * The first view of a diagram: `fitTransform`, unless the diagram cannot be fitted at a readable size, in
 * which case it is the readable zoom looking at the top-left corner, or at `anchor` when that would be out
 * of sight there. An axis on which the diagram fits the pane at that zoom is centred as in a fit.
 */
export function startView(
  size: Size,
  content: Pick<Box, "width" | "height">,
  anchor: Box | undefined,
  options: StartOptions,
): StartView | undefined {
  const fit = fitTransform(size, content, options);
  if (!fit) return undefined;
  const floor = options.floor ?? READABLE_FLOOR;
  const raw = rawFitScale(size, content, options.padding);
  if (raw >= floor) return { transform: fit, partial: false };

  const k = options.readable ?? READABLE_ZOOM;
  const { padding } = options;
  const axis = (
    pane: number,
    total: number,
    span: { start: number; size: number } | undefined,
  ): number => {
    if (total * k <= pane - 2 * padding) return (pane - total * k) / 2;
    return padding - windowStart(span, (pane - 2 * padding) / k, total) * k;
  };
  return {
    transform: {
      k,
      x: axis(size.w, content.width, anchor && { start: anchor.x, size: anchor.width }),
      y: axis(size.h, content.height, anchor && { start: anchor.y, size: anchor.height }),
    },
    partial: true,
  };
}

/** The smallest box that holds all of `boxes` (undefined for none). */
export function unionBox(boxes: readonly Box[]): Box | undefined {
  if (boxes.length === 0) return undefined;
  let x1 = Infinity;
  let y1 = Infinity;
  let x2 = -Infinity;
  let y2 = -Infinity;
  for (const box of boxes) {
    x1 = Math.min(x1, box.x);
    y1 = Math.min(y1, box.y);
    x2 = Math.max(x2, box.x + box.width);
    y2 = Math.max(y2, box.y + box.height);
  }
  return { x: x1, y: y1, width: x2 - x1, height: y2 - y1 };
}

export interface ReadableFit {
  transform: Transform;
  /** The fit shows the whole width from the top, not all of the diagram: the rest is scrolled to. */
  width: boolean;
}

/**
 * "Fit" for a diagram whose text must stay readable: all of it, when that keeps the zoom at `floor` or more
 * (or when no floor is given). Else, when its width fits at `floor` or more, the whole width, from the top:
 * the reader scrolls down for the rest. Else all of it anyway (no readable fit exists for this pane).
 */
export function readableFit(
  size: Size,
  content: Pick<Box, "width" | "height">,
  options: FitOptions,
  floor: number | undefined,
): ReadableFit | undefined {
  const fit = fitTransform(size, content, options);
  if (!fit) return undefined;
  if (floor === undefined || fit.k >= floor) return { transform: fit, width: false };
  const k = clamp((size.w - 2 * options.padding) / content.width, MIN_ZOOM, options.maxZoom);
  if (k < floor) return { transform: fit, width: false };
  return {
    transform: { k, x: (size.w - content.width * k) / 2, y: options.padding },
    width: true,
  };
}

/**
 * Moves the view `dy` pane pixels down the diagram (a wheel turn over a width fit), never past its top or
 * its bottom (with `padding` of room at either end).
 */
export function scrollDown(
  t: Transform,
  dy: number,
  size: Size,
  content: Pick<Box, "height">,
  padding: number,
): Transform {
  const top = padding;
  const bottom = Math.min(top, size.h - padding - content.height * t.k);
  return { ...t, y: clamp(t.y - dy, bottom, top) };
}
