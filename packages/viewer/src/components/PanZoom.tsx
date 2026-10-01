/**
 * An SVG canvas with pan (drag), zoom (wheel, buttons, + / - keys) and fit-to-view. Content is drawn in
 * its own coordinates (0..width, 0..height); this component owns the viewport transform.
 *
 * The first view is the fit, unless the diagram is too big to read when fitted (fit scale below
 * `READABLE_FLOOR`): then it starts at a readable zoom, looking at the top-left corner or at `startBox`, and
 * a badge says so and offers "Fit all" (and, once everything is fitted, "Readable size" to come back). The
 * Fit button and the 0 key always fit all of it. See viewport.ts for the maths.
 *
 * A drag never turns into a click: pointer capture only starts once the pointer has moved a few
 * pixels, so a plain click still reaches the element under it. A click on the empty background calls
 * `onBackgroundClick`.
 */
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from "react";
import {
  clamp,
  MAX_ZOOM,
  MIN_ZOOM,
  rawFitScale,
  READABLE_FLOOR,
  readableFit,
  scrollDown,
  startView,
  type Box,
  type Transform,
} from "../viewport.js";

const FIT_PADDING = 24;
/** Fitting never blows a small diagram up by more than this (a talk allows more: `maxFitZoom`). */
const MAX_FIT_ZOOM = 1.25;
/** In Present the diagram is enlarged more, and fitted closer to the edge: it is read from further away. */
export const PRESENT_MAX_FIT_ZOOM = 1.6;
export const PRESENT_FIT_PADDING = 10;
/**
 * In Present a diagram never starts smaller than this: the smallest diagram text (12 units: badges, frame
 * labels, the owner line of a flow box) comes out at 12px or more. A diagram that does not fit at this zoom
 * starts on its focus, and "Fit all" shows the rest.
 */
export const PRESENT_READABLE_ZOOM = 1;
/**
 * A flow never gets smaller than this, not even for "Fit all" (its smallest text, 13 units, stays at 11px):
 * a flow too tall for that is fitted to its width and scrolls. Read mode starts flows at this zoom too. (When
 * even the width does not fit at this zoom, as in Present's narrow pane, Fit shows all of it anyway.)
 */
export const FLOW_READABLE_ZOOM = 11 / 13;
const DRAG_THRESHOLD = 4;

function zoomAt(t: Transform, factor: number, px: number, py: number): Transform {
  const k = clamp(t.k * factor, MIN_ZOOM, MAX_ZOOM);
  const ratio = k / t.k;
  return { k, x: px - (px - t.x) * ratio, y: py - (py - t.y) * ratio };
}

/**
 * What the viewport does when the diagram or the pane changes: `start` re-applies the first view (the
 * initial state), `fit` keeps fitting all of it (after Fit), `free` leaves the viewport to the user.
 */
type Follow = "start" | "fit" | "free";

export interface PanZoomProps {
  /** Size of the content in its own coordinates. */
  width: number;
  height: number;
  /** A new key resets the viewport to its first view (another view, another diagram). */
  resetKey: string;
  onBackgroundClick?: () => void;
  /** Extra text for screen readers. */
  label: string;
  /** How far fitting may enlarge a small diagram (default 1.25). */
  maxFitZoom?: number;
  /** Room fitting leaves around the diagram, in px (default 24). */
  fitPadding?: number;
  /**
   * The smallest zoom the first view may have (default `READABLE_FLOOR`, and then the readable zoom is
   * `READABLE_ZOOM`): a diagram whose fit is smaller starts at this zoom on `startBox` instead.
   */
  readableZoom?: number;
  /**
   * The smallest zoom "Fit" may use. A diagram that would fit only below it is fitted to its width instead,
   * from the top, and the mouse wheel scrolls it up and down (text stays readable). When even the width
   * does not fit at this zoom, Fit shows all of it anyway. Default: no floor.
   */
  fitFloor?: number;
  /**
   * Drawn over the diagram, outside its transform (the current one is passed in): what must stay in sight
   * while the diagram moves, such as the participant names of a sequence.
   */
  overlay?: (t: Transform, size: { w: number; h: number }) => ReactNode;
  /**
   * What to look at first when the diagram is too big to fit at a readable size (a box in the content's
   * coordinates: the selection, the first box of the view). Read when the first view is set, not on every
   * render, so a click that changes the selection does not move the viewport. Default: the top-left corner.
   */
  startBox?: Box | undefined;
  children: ReactNode;
}

export function PanZoom({
  width,
  height,
  resetKey,
  onBackgroundClick,
  label,
  maxFitZoom = MAX_FIT_ZOOM,
  fitPadding = FIT_PADDING,
  readableZoom,
  fitFloor,
  overlay,
  startBox,
  children,
}: PanZoomProps) {
  const wrap = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ w: 0, h: 0 });
  const [t, setT] = useState<Transform>({ k: 1, x: 0, y: 0 });
  const follow = useRef<Follow>("start");
  const start = useRef<Box | undefined>(startBox);
  const lastReset = useRef(resetKey);
  const drag = useRef<{ x: number; y: number; moved: boolean; id: number } | null>(null);
  const suppressClick = useRef(false);

  useLayoutEffect(() => {
    const el = wrap.current;
    if (!el) return;
    const measure = () => setSize({ w: el.clientWidth, h: el.clientHeight });
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  const options = useMemo(
    () => ({
      padding: fitPadding,
      maxZoom: maxFitZoom,
      ...(readableZoom !== undefined ? { floor: readableZoom, readable: readableZoom } : {}),
    }),
    [fitPadding, maxFitZoom, readableZoom],
  );
  const floor = readableZoom ?? READABLE_FLOOR;

  /** True while a width fit is on screen: the wheel scrolls the diagram instead of zooming it. */
  const widthFit = useRef(false);
  const [scrolling, setScrolling] = useState(false);

  /** All of the diagram in the pane (or all of its width, when all of it would be too small to read). */
  const fitAll = useCallback(() => {
    const next = readableFit(size, { width, height }, options, fitFloor);
    if (!next) return;
    widthFit.current = next.width;
    setScrolling(next.width);
    setT(next.transform);
  }, [size, width, height, options, fitFloor]);

  /** The first view: the fit, or for a diagram too big to read whole, a readable zoom on its start. */
  const showStart = useCallback(() => {
    const next = startView(size, { width, height }, start.current, options);
    widthFit.current = false;
    setScrolling(false);
    if (next) setT(next.transform);
  }, [size, width, height, options]);

  // Read the caller's start box before the effect below uses it.
  useLayoutEffect(() => {
    start.current = startBox;
  });

  useLayoutEffect(() => {
    if (lastReset.current !== resetKey) {
      lastReset.current = resetKey;
      follow.current = "start";
    }
    if (follow.current === "start") showStart();
    else if (follow.current === "fit") fitAll();
  }, [showStart, fitAll, resetKey]);

  // Wheel = zoom about the pointer. React attaches wheel listeners as passive, so use a native one.
  useEffect(() => {
    const el = wrap.current;
    if (!el) return;
    const onWheel = (event: WheelEvent) => {
      event.preventDefault();
      const rect = el.getBoundingClientRect();
      const delta = event.deltaMode === 1 ? event.deltaY * 16 : event.deltaY;
      // A width fit scrolls (it is as wide as the pane and only too tall); a pinch still zooms.
      if (widthFit.current && !event.ctrlKey) {
        setT((cur) => scrollDown(cur, delta, sizeRef.current, { height: heightRef.current }, 0));
        return;
      }
      // a trackpad pinch arrives as a wheel with ctrlKey and small deltas
      const factor = Math.exp(-delta * (event.ctrlKey ? 0.01 : 0.0018));
      follow.current = "free";
      widthFit.current = false;
      setScrolling(false);
      setT((cur) => zoomAt(cur, factor, event.clientX - rect.left, event.clientY - rect.top));
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, []);
  // (the wheel listener is installed once: it reads the current pane and diagram size from here)
  const sizeRef = useRef(size);
  sizeRef.current = size;
  const heightRef = useRef(height);
  heightRef.current = height;

  const zoomBy = (factor: number) => {
    follow.current = "free";
    widthFit.current = false;
    setScrolling(false);
    setT((cur) => zoomAt(cur, factor, size.w / 2, size.h / 2));
  };

  const fitEverything = () => {
    follow.current = "fit";
    fitAll();
  };

  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    suppressClick.current = false;
    drag.current = { x: event.clientX, y: event.clientY, moved: false, id: event.pointerId };
  };
  const onPointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    if (!d) return;
    const dx = event.clientX - d.x;
    const dy = event.clientY - d.y;
    if (!d.moved) {
      if (Math.hypot(dx, dy) < DRAG_THRESHOLD) return;
      d.moved = true;
      wrap.current?.setPointerCapture(d.id);
      wrap.current?.classList.add("is-panning");
    }
    d.x = event.clientX;
    d.y = event.clientY;
    follow.current = "free";
    setT((cur) => ({ ...cur, x: cur.x + dx, y: cur.y + dy }));
  };
  const endDrag = (event: ReactPointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    drag.current = null;
    if (!d) return;
    wrap.current?.classList.remove("is-panning");
    if (d.moved) {
      suppressClick.current = true;
      setTimeout(() => (suppressClick.current = false), 0);
      if (wrap.current?.hasPointerCapture(d.id)) wrap.current.releasePointerCapture(d.id);
    }
    void event;
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.target instanceof HTMLElement && event.target.closest("button")) return;
    switch (event.key) {
      case "+":
      case "=":
        zoomBy(1.25);
        break;
      case "-":
      case "_":
        zoomBy(1 / 1.25);
        break;
      case "0":
        fitEverything();
        break;
      case "ArrowLeft":
      case "ArrowRight":
      case "ArrowUp":
      case "ArrowDown": {
        if (event.target !== event.currentTarget) return;
        const step = 60;
        const dx = event.key === "ArrowLeft" ? step : event.key === "ArrowRight" ? -step : 0;
        const dy = event.key === "ArrowUp" ? step : event.key === "ArrowDown" ? -step : 0;
        follow.current = "free";
        setT((cur) => ({ ...cur, x: cur.x + dx, y: cur.y + dy }));
        break;
      }
      default:
        return;
    }
    event.preventDefault();
  };

  // A diagram too big to fit at a readable size gets a badge: it starts zoomed in, so say that part of it is
  // out of sight and how to see all of it (and, once all of it is in sight, how to get back).
  const raw = rawFitScale(size, { width, height }, fitPadding);
  const big = raw > 0 && raw < floor;
  // After Fit: all of it in sight, or (a width fit) as much of it as stays readable.
  const allInSight = big && (scrolling || Math.abs(t.k - clamp(raw, MIN_ZOOM, maxFitZoom)) < 0.005);

  return (
    <div
      ref={wrap}
      className="panzoom"
      tabIndex={0}
      role="group"
      aria-label={label}
      data-zoom={t.k.toFixed(3)}
      data-fit={scrolling ? "width" : undefined}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
      onKeyDown={onKeyDown}
      onClick={(event) => {
        if (suppressClick.current) return;
        if (
          event.target === event.currentTarget ||
          (event.target as Element).classList?.contains("pz-svg")
        ) {
          onBackgroundClick?.();
        }
      }}
    >
      <svg className="pz-svg" width="100%" height="100%" role="presentation">
        <g transform={`translate(${t.x} ${t.y}) scale(${t.k})`}>{children}</g>
        {overlay?.(t, size)}
      </svg>
      {big && (
        <button
          type="button"
          className="pz-badge"
          data-testid="pz-badge"
          title={
            scrolling
              ? "The diagram is as wide as the view: scroll to see the rest of it. Go back to where it started."
              : allInSight
                ? `The whole diagram is in view at ${Math.round(t.k * 100)}%, too small to read comfortably. Zoom back to a readable size.`
                : "This diagram is too big to read at once, so it starts zoomed in and part of it is out of sight. Fit all of it in the view."
          }
          onPointerDown={(event) => event.stopPropagation()}
          onClick={() => {
            if (allInSight) {
              follow.current = "start";
              showStart();
            } else fitEverything();
          }}
        >
          {scrolling ? "Back to the start" : allInSight ? "Readable size" : "Fit all"}
        </button>
      )}
      <div className="pz-toolbar" onPointerDown={(event) => event.stopPropagation()}>
        <button type="button" aria-label="Zoom in" title="Zoom in (+)" onClick={() => zoomBy(1.25)}>
          +
        </button>
        <button
          type="button"
          aria-label="Zoom out"
          title="Zoom out (-)"
          onClick={() => zoomBy(1 / 1.25)}
        >
          &minus;
        </button>
        <button
          type="button"
          aria-label="Fit to view"
          title="Fit to view (0)"
          onClick={fitEverything}
        >
          Fit
        </button>
      </div>
    </div>
  );
}
