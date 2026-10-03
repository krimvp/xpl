/**
 * An SVG canvas with pan (drag), zoom (wheel, buttons, + / - keys) and fit-to-view. Content is drawn in
 * its own coordinates (0..width, 0..height); this component owns the viewport transform.
 *
 * The first view follows one rule (viewport.ts `frameView`): the fit, unless the diagram is too big to read
 * when fitted; then what the step is about (`focus`, with its neighbours when there is room) at a readable
 * zoom, a "+N more" cue for focused elements left out, and a badge that offers "Fit all" (and, once
 * everything is fitted, "Readable size" to come back). The Fit button, the 0 key and "Fit all" always fit all
 * of it, however small. Zooming keeps the selection where it is, and the selection (`keepInView`) is panned
 * into view when it changes or the pane is resized.
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
  boxInView,
  clamp,
  fitTransform,
  frameView,
  MAX_ZOOM,
  MIN_ZOOM,
  rawFitScale,
  READABLE_FLOOR,
  reveal,
  settle,
  unionBox,
  type Box,
  type Focus,
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
 * A flow starts no smaller than this (its smallest text, 13 units, comes out at 11px): a flow too big for
 * that starts on its focus. "Fit all" still shows all of it.
 */
export const FLOW_READABLE_ZOOM = 11 / 13;
/**
 * Present starts a flow at the zoom that shows its whole width, up to this (the flow's 13-unit text at 16px
 * on a wide screen) and down to `FLOW_READABLE_ZOOM` (11px): a flow is read from the back of the room.
 */
export const PRESENT_FLOW_MAX_ZOOM = 16 / 13;
const DRAG_THRESHOLD = 4;
/** Room kept between the selection and the pane's edge when it is panned into view, px. */
const REVEAL_MARGIN = 32;

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
   * The zoom a first view that cannot show all of the diagram is drawn at (default `READABLE_ZOOM`, and
   * then a diagram that fits at `READABLE_FLOOR` or more starts fitted). With it, a diagram that fits at
   * this zoom (or `readableMin`) or more starts fitted.
   */
  readableZoom?: number;
  /**
   * With this, a diagram too big to read whole starts at the zoom that shows its whole width, kept between
   * `readableMin` and `readableZoom` (a wide pane shows a narrow diagram larger, a narrow one shows less of
   * it). It is also the floor: a diagram that fits whole at `readableMin` or more starts fitted.
   */
  readableMin?: number;
  /**
   * Drawn over the diagram, outside its transform (the current one is passed in): what must stay in sight
   * while the diagram moves, such as the participant names of a sequence.
   */
  overlay?: (t: Transform, size: { w: number; h: number }) => ReactNode;
  /** More controls at the end of the zoom toolbar (a map's Key). */
  tools?: ReactNode;
  /**
   * What the first view frames when the diagram is too big to fit at a readable size (boxes in the content's
   * coordinates: the step's elements and their neighbours, or the first box of the view). Read when the
   * first view is set, not on every render, so a click that changes the selection does not move the
   * viewport. Default: the top-left corner.
   */
  focus?: Focus | undefined;
  /**
   * The selection, in the content's coordinates: when it changes, or the pane is resized, the view pans just
   * enough to show it (when it is out of sight), and the zoom buttons zoom about it.
   */
  keepInView?: Box | undefined;
  /**
   * Room kept between the selection and the pane's edge when it is panned into view, px (default 32). With it,
   * the selection is kept that far in (nearer the middle) on every change: the outline beside the code of a
   * code-first flow follows the caret.
   */
  revealMargin?: number;
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
  readableMin,
  overlay,
  tools,
  focus,
  keepInView,
  revealMargin,
  children,
}: PanZoomProps) {
  const wrap = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ w: 0, h: 0 });
  const [t, setT] = useState<Transform>({ k: 1, x: 0, y: 0 });
  /** Focused elements the first view leaves out ("+N more"); 0 once the user moves the view. */
  const [more, setMore] = useState(0);
  const follow = useRef<Follow>("start");
  const start = useRef<Focus | undefined>(focus);
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
      ...(readableZoom !== undefined
        ? { whole: readableMin ?? readableZoom, readable: readableZoom, readableMin }
        : {}),
    }),
    [fitPadding, maxFitZoom, readableZoom, readableMin],
  );
  const floor = readableZoom !== undefined ? (readableMin ?? readableZoom) : READABLE_FLOOR;

  /** All of the diagram in the pane, however small that makes it. */
  const fitAll = useCallback(() => {
    const next = fitTransform(size, { width, height }, options);
    if (next) setT(next);
  }, [size, width, height, options]);

  /** The first view: the fit, or for a diagram too big to read whole, a readable frame of the focus. */
  const showStart = useCallback(() => {
    const next = frameView(size, { width, height }, start.current, options);
    if (!next) return;
    setT(next.transform);
    setMore(next.hidden);
  }, [size, width, height, options]);

  // Read the caller's focus before the effect below uses it.
  useLayoutEffect(() => {
    start.current = focus;
  });

  useLayoutEffect(() => {
    if (lastReset.current !== resetKey) {
      lastReset.current = resetKey;
      follow.current = "start";
    }
    if (follow.current === "start") showStart();
    else if (follow.current === "fit") fitAll();
  }, [showStart, fitAll, resetKey]);

  // The selection stays in sight: after it changes, and after the pane changes size (Show source narrows
  // it). Runs after the effect above, so it corrects the view that effect set.
  const keep = keepInView
    ? `${keepInView.x},${keepInView.y},${keepInView.width},${keepInView.height}`
    : "";
  const keepRef = useRef(keepInView);
  keepRef.current = keepInView;
  useLayoutEffect(() => {
    const box = keepRef.current;
    if (!box || size.w <= 0 || size.h <= 0) return;
    setT((cur) =>
      revealMargin !== undefined
        ? reveal(cur, size, box, revealMargin)
        : boxInView(cur, size, box)
          ? cur
          : reveal(cur, size, box, REVEAL_MARGIN),
    );
  }, [keep, size, resetKey, revealMargin]);

  // (the wheel listener is installed once: it reads the current pane and diagram size from here)
  const sizeRef = useRef(size);
  sizeRef.current = size;
  const contentRef = useRef({ width, height, padding: fitPadding });
  contentRef.current = { width, height, padding: fitPadding };

  // Wheel = zoom about the pointer. React attaches wheel listeners as passive, so use a native one.
  useEffect(() => {
    const el = wrap.current;
    if (!el) return;
    const onWheel = (event: WheelEvent) => {
      event.preventDefault();
      const rect = el.getBoundingClientRect();
      const delta = event.deltaMode === 1 ? event.deltaY * 16 : event.deltaY;
      // a trackpad pinch arrives as a wheel with ctrlKey and small deltas
      const factor = Math.exp(-delta * (event.ctrlKey ? 0.01 : 0.0018));
      follow.current = "free";
      setMore(0);
      const { width: w, height: h, padding } = contentRef.current;
      setT((cur) =>
        settle(
          zoomAt(cur, factor, event.clientX - rect.left, event.clientY - rect.top),
          sizeRef.current,
          { width: w, height: h },
          padding,
        ),
      );
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, []);

  /** Zoom about the selection when it is in sight, else about the middle of the pane. */
  const zoomBy = (factor: number) => {
    follow.current = "free";
    setMore(0);
    setT((cur) => {
      const box = keepRef.current;
      const about =
        box && boxInView(cur, size, box)
          ? {
              x: cur.x + (box.x + box.width / 2) * cur.k,
              y: cur.y + (box.y + box.height / 2) * cur.k,
            }
          : { x: size.w / 2, y: size.h / 2 };
      return settle(zoomAt(cur, factor, about.x, about.y), size, { width, height }, fitPadding);
    });
  };

  const fitEverything = () => {
    follow.current = "fit";
    setMore(0);
    fitAll();
  };

  /** "+N more": all of the focused elements in view, at whatever zoom that takes. */
  const showFocus = () => {
    const all = unionBox(start.current?.boxes ?? []);
    if (!all) return;
    const fitted = fitTransform(size, all, { padding: fitPadding, maxZoom: maxFitZoom });
    if (!fitted) return;
    follow.current = "free";
    setMore(0);
    setT({ k: fitted.k, x: fitted.x - all.x * fitted.k, y: fitted.y - all.y * fitted.k });
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
    setMore(0);
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
        setMore(0);
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
  const allInSight = big && Math.abs(t.k - clamp(raw, MIN_ZOOM, maxFitZoom)) < 0.005;

  return (
    <div
      ref={wrap}
      className="panzoom"
      tabIndex={0}
      role="group"
      aria-label={label}
      data-zoom={t.k.toFixed(3)}
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
            allInSight
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
          {allInSight ? "Readable size" : "Fit all"}
        </button>
      )}
      {more > 0 && (
        <button
          type="button"
          className="pz-more"
          data-testid="pz-more"
          title="Part of what this step is about is out of sight. Show all of it."
          onPointerDown={(event) => event.stopPropagation()}
          onClick={showFocus}
        >
          +{more} more
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
        {tools}
      </div>
    </div>
  );
}
