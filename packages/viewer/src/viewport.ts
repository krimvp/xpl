/**
 * Where a diagram sits in its pane: the maths of PanZoom, without the DOM (so the unit tests can check it).
 *
 * A diagram is drawn in its own units and the pane shows it through a transform `{ k, x, y }` (scale, then
 * translate). *Fit* is the transform that shows all of it. That is the right first view for a diagram that
 * fits at a readable size, and the wrong one for a big diagram: fitted, a view of seventeen boxes with groups
 * comes out at 0.4 and no label can be read. One rule (`frameView`) places the first view of every diagram,
 * live or still: all of it when it reads well, else what the step is about (its focus, with the neighbours
 * of the focus when there is room), at a readable zoom. PanZoom offers "Fit all" to get the overview.
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

/** Below this fit scale the whole diagram is too small to read: the first view is framed instead. */
export const READABLE_FLOOR = 0.6;
/** The zoom a framed first view is drawn at: 13px labels come out at about 10px. */
export const READABLE_ZOOM = 0.75;
/** A frame may be drawn at down to this share of the readable zoom, to get the whole focus in. */
export const FRAME_SHRINK = 0.7;

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

/** What a step is about, as boxes of the diagram (in its coordinates): the first view frames these. */
export interface Focus {
  /** The elements the step names, in order: each is shown whole, or counted as "more". */
  boxes: readonly Box[];
  /** Their direct neighbours (the other ends of their edges): shown with them when there is room. */
  neighbours?: readonly Box[];
  /**
   * What of the first box must be in view when all of it cannot be: the heart of it (a sequence step frames
   * its label, not the tail of a long arrow).
   */
  core?: Box | undefined;
}

export interface FrameOptions extends FitOptions {
  /** All of the diagram is shown when it fits at this zoom or more (default `READABLE_FLOOR`). */
  whole?: number;
  /** The zoom a frame is drawn at, or less to fit (default `READABLE_ZOOM`). */
  readable?: number;
  /**
   * With this, the readable zoom follows the pane: the zoom that shows the diagram's whole width, kept
   * between `readableMin` and `readable`. A wide pane shows a narrow diagram larger, a narrow pane shows
   * less of it, and the text never gets smaller than `readableMin` allows.
   */
  readableMin?: number;
  /** A frame of several boxes may go down to this share of the readable zoom (default `FRAME_SHRINK`). */
  shrink?: number;
  /**
   * The focus itself (every box the step names) may be drawn down to this zoom, below the floor
   * `readableMin` / `shrink` set for a frame with neighbours: all of what the step is about at a smaller size
   * reads better than half of it at a large one. No single focus box is drawn larger than the pane either,
   * down to this zoom. Default: the frame's floor (no lower).
   */
  focusMin?: number;
}

export interface FramedView {
  transform: Transform;
  /** The diagram is too big to be read whole: the first view shows part of it. */
  partial: boolean;
  /** How many of the focus boxes are not wholly in view (the view says "+N more"). */
  hidden: number;
  /** How many of the focus' neighbours the frame takes in. */
  context: number;
}

/**
 * Where along one axis a window of `visible` units begins, in diagram units: at the start of the diagram,
 * unless `anchor` (a span that must be seen) does not fit into the first `visible` units; then the window
 * moves just far enough to show it (centred when it is smaller than the window, else aligned to its start),
 * but never past the end of the diagram.
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

/** True when `box` (diagram units) is wholly inside the pane under `t` (a pixel of slack). */
export function boxInView(t: Transform, size: Size, box: Box): boolean {
  const left = t.x + box.x * t.k;
  const top = t.y + box.y * t.k;
  return (
    left >= -1 &&
    top >= -1 &&
    left + box.width * t.k <= size.w + 1 &&
    top + box.height * t.k <= size.h + 1
  );
}

/**
 * The first view of a diagram: one rule for the live canvases, Present and the Guide's still pictures.
 *
 * 1. All of it, when it fits at `whole` or more (its text stays readable).
 * 2. Else the focus with as many of its neighbours as fit with it (nearest first), when the focus fits at
 *    `shrink` × the readable zoom or more (or `focusMin`: then the neighbours only come in at the zoom the
 *    focus needs); else as many of the focus boxes as fit, from the first. A frame is drawn at the readable
 *    zoom when it fits at that, else smaller (down to the `shrink` share), and is placed as the first window
 *    of the diagram when it is in it (the start of a diagram matters most).
 * 3. Else the first focus box at the readable zoom (its `core` when it is bigger than the pane), or the
 *    top-left corner when there is no focus.
 *
 * The focus boxes left out are counted (`hidden`). When all of the diagram fits at the zoom a frame would
 * have, it is shown whole instead. An axis on which the diagram fits the pane at the chosen zoom is centred.
 */
export function frameView(
  size: Size,
  content: Pick<Box, "width" | "height">,
  focus: Focus | undefined,
  options: FrameOptions,
): FramedView | undefined {
  const fit = fitTransform(size, content, options);
  if (!fit) return undefined;
  const { padding } = options;
  const raw = rawFitScale(size, content, padding);
  if (raw >= (options.whole ?? READABLE_FLOOR))
    return { transform: fit, partial: false, hidden: 0, context: 0 };

  const readable = options.readable ?? READABLE_ZOOM;
  const most =
    options.readableMin === undefined
      ? readable
      : clamp(
          (size.w - 2 * padding) / content.width,
          Math.min(options.readableMin, readable),
          readable,
        );
  // a frame shrinks to get more of the focus in, but never below the text size `readableMin` promises
  const least = Math.max(
    most * (options.shrink ?? FRAME_SHRINK),
    Math.min(options.readableMin ?? 0, most),
  );
  const boxes = focus?.boxes ?? [];

  const place = (k: number, target: Box | undefined, core?: Box): Transform => {
    const axis = (
      pane: number,
      total: number,
      span: { start: number; size: number } | undefined,
      fallback: { start: number; size: number } | undefined,
    ): number => {
      if (total * k <= pane - 2 * padding) return (pane - total * k) / 2;
      const visible = (pane - 2 * padding) / k;
      const use = span && fallback && span.size > visible ? fallback : span;
      return padding - windowStart(use, visible, total) * k;
    };
    return {
      k,
      x: axis(
        size.w,
        content.width,
        target && { start: target.x, size: target.width },
        core && { start: core.x, size: core.width },
      ),
      y: axis(
        size.h,
        content.height,
        target && { start: target.y, size: target.height },
        core && { start: core.y, size: core.height },
      ),
    };
  };
  const result = (transform: Transform, context: number): FramedView => {
    // A frame no larger than the whole diagram would be: the whole diagram reads as well.
    if (transform.k <= raw + 1e-9) return { transform: fit, partial: false, hidden: 0, context: 0 };
    return {
      transform,
      partial: true,
      hidden: boxes.filter((box) => !boxInView(transform, size, box)).length,
      context,
    };
  };
  /** The zoom `group` is framed at: the readable zoom, or as much smaller as it needs (undefined below `low`). */
  const zoomFor = (group: readonly Box[], low: number): number | undefined => {
    const union = unionBox(group);
    if (!union) return undefined;
    const k = Math.min(most, rawFitScale(size, union, padding) || most);
    return k >= low - 1e-9 ? k : undefined;
  };
  const frame = (group: readonly Box[], low = least): Transform | undefined => {
    const k = zoomFor(group, low);
    return k === undefined ? undefined : place(k, unionBox(group));
  };
  // The focus alone may go below the frame's floor, down to `focusMin` (all of it in view).
  const focusLeast = Math.min(least, options.focusMin ?? least);

  // The focus, then as many of its neighbours as fit, nearest first: down to the floor, and never smaller
  // than the focus alone needs.
  const focusZoom = zoomFor(boxes, focusLeast);
  if (boxes.length > 0 && focusZoom !== undefined) {
    const low = Math.min(least, focusZoom);
    const group = [...boxes];
    const centre = unionBox(boxes)!;
    const cx = centre.x + centre.width / 2;
    const cy = centre.y + centre.height / 2;
    const distance = (box: Box) =>
      Math.hypot(box.x + box.width / 2 - cx, box.y + box.height / 2 - cy);
    const near = [...(focus?.neighbours ?? [])].sort((a, b) => distance(a) - distance(b));
    let context = 0;
    for (const box of near) {
      if (!frame([...group, box], low)) continue;
      group.push(box);
      context++;
    }
    return result(frame(group, low)!, context);
  }
  // Else as many of the focus boxes as fit, from the first.
  for (let n = boxes.length - 1; n >= 1; n--) {
    const framed = frame(boxes.slice(0, n), focusLeast);
    if (framed) return result(framed, 0);
  }
  // Else the first box (too big for the pane even at `focusMin`): its core at the readable zoom.
  return result(place(most, boxes[0], focus?.core), 0);
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

/**
 * Keeps a diagram where it can be seen after a zoom or a resize: an axis on which all of it fits the pane is
 * centred, and on an axis on which it does not, no empty band is left between its edge and the pane's (it
 * stops `padding` from the edge). Zooming out never shrinks a diagram towards one corner.
 */
export function settle(
  t: Transform,
  size: Size,
  content: Pick<Box, "width" | "height">,
  padding: number,
): Transform {
  const axis = (pane: number, total: number, at: number): number => {
    const drawn = total * t.k;
    if (drawn <= pane - 2 * padding) return (pane - drawn) / 2;
    return clamp(at, pane - padding - drawn, padding);
  };
  if (size.w <= 0 || size.h <= 0) return t;
  return { k: t.k, x: axis(size.w, content.width, t.x), y: axis(size.h, content.height, t.y) };
}

/**
 * The view moved just enough to show `box` (diagram units) whole, at the same zoom, with `margin` px of
 * room: unchanged when it is already in view. A box larger than the pane is centred.
 */
export function reveal(t: Transform, size: Size, box: Box, margin: number): Transform {
  const axis = (pane: number, at: number, start: number, length: number): number => {
    const from = at + start * t.k;
    const to = from + length * t.k;
    if (to - from > pane - 2 * margin) return pane / 2 - (start + length / 2) * t.k;
    if (from < margin) return at + (margin - from);
    if (to > pane - margin) return at - (to - (pane - margin));
    return at;
  };
  return {
    k: t.k,
    x: axis(size.w, t.x, box.x, box.width),
    y: axis(size.h, t.y, box.y, box.height),
  };
}

/** The zoom a still picture is drawn at when the whole diagram is too small to read in it. */
export const SNAPSHOT_ZOOM = 0.85;
/** A still picture shows the whole diagram when its text comes out at about 10px or more (13-unit labels). */
export const SNAPSHOT_WHOLE = 10 / 13;
/** A still picture never shows a diagram smaller than this (to fit a focus and its neighbours in). */
export const SNAPSHOT_MIN_ZOOM = SNAPSHOT_ZOOM * FRAME_SHRINK;
/** Room around a still picture's diagram, px. */
const SNAPSHOT_PADDING = 10;

export interface SnapshotView {
  transform: Transform;
  /** The picture's height: `maxHeight`, or less for a short diagram (no empty band under it). */
  height: number;
  /** How many of the focus boxes are out of the picture. */
  hidden: number;
  /** Part of the diagram is out of the picture. */
  partial: boolean;
}

/**
 * Where a diagram sits in a still picture `width` px wide and at most `maxHeight` tall (the Guide's inline
 * diagram), by `frameView`: all of it when its text reads at about 10px or more (never enlarged), else the
 * focus and its neighbours at `SNAPSHOT_ZOOM` (down to `SNAPSHOT_MIN_ZOOM` to get them in). A picture that
 * would be cut at `maxHeight` but fits whole at `tallHeight` is drawn that tall instead; one that would still
 * cut a box the step names is drawn up to `namedHeight` tall, when that shows more of them (a step about
 * every part of a tall map shows all of it, not most of it). Undefined before the picture has a width.
 */
export function snapshotView(
  width: number,
  maxHeight: number,
  content: Pick<Box, "width" | "height">,
  focus: Focus | undefined,
  tallHeight = maxHeight,
  namedHeight = tallHeight,
): SnapshotView | undefined {
  const pad = SNAPSHOT_PADDING;
  const options = {
    padding: pad,
    maxZoom: 1,
    whole: SNAPSHOT_WHOLE,
    readable: SNAPSHOT_ZOOM,
  };
  let paneHeight = maxHeight;
  let framed = frameView({ w: width, h: paneHeight }, content, focus, options);
  if (!framed) return undefined;
  if (framed.partial && tallHeight > maxHeight) {
    // Taller, when that shows all of it, or more of the focus, or more around it.
    const tall = frameView({ w: width, h: tallHeight }, content, focus, options);
    if (tall && (!tall.partial || tall.hidden < framed.hidden || tall.context > framed.context)) {
      framed = tall;
      paneHeight = tallHeight;
    }
  }
  if (framed.hidden > 0 && namedHeight > paneHeight) {
    // Taller still, when that shows more of the boxes the step names.
    const named = frameView({ w: width, h: namedHeight }, content, focus, options);
    if (named && named.hidden < framed.hidden) {
      framed = named;
      paneHeight = namedHeight;
    }
  }
  const { transform } = framed;
  const height = Math.min(paneHeight, content.height * transform.k + 2 * pad);
  return {
    // a short picture: the diagram sits at the top of the padding (no band above it)
    transform: height < paneHeight ? { ...transform, y: pad } : transform,
    height,
    hidden: framed.hidden,
    partial: framed.partial,
  };
}
