/**
 * An SVG canvas with pan (drag), zoom (wheel, buttons, + / - keys) and fit-to-view. Content is drawn in
 * its own coordinates (0..width, 0..height); this component owns the viewport transform.
 *
 * A drag never turns into a click: pointer capture only starts once the pointer has moved a few
 * pixels, so a plain click still reaches the element under it. A click on the empty background calls
 * `onBackgroundClick`.
 */
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from "react";

interface Transform {
  k: number;
  x: number;
  y: number;
}

const MIN_ZOOM = 0.1;
const MAX_ZOOM = 4;
const FIT_PADDING = 24;
/** Fitting never blows a small diagram up by more than this. */
const MAX_FIT_ZOOM = 1.25;
const DRAG_THRESHOLD = 4;

const clamp = (value: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, value));

function zoomAt(t: Transform, factor: number, px: number, py: number): Transform {
  const k = clamp(t.k * factor, MIN_ZOOM, MAX_ZOOM);
  const ratio = k / t.k;
  return { k, x: px - (px - t.x) * ratio, y: py - (py - t.y) * ratio };
}

export interface PanZoomProps {
  /** Size of the content in its own coordinates. */
  width: number;
  height: number;
  /** A new key resets the viewport to "fit" (another view, another diagram). */
  resetKey: string;
  onBackgroundClick?: () => void;
  /** Extra text for screen readers. */
  label: string;
  children: ReactNode;
}

export function PanZoom({
  width,
  height,
  resetKey,
  onBackgroundClick,
  label,
  children,
}: PanZoomProps) {
  const wrap = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ w: 0, h: 0 });
  const [t, setT] = useState<Transform>({ k: 1, x: 0, y: 0 });
  /** The user moved or zoomed the viewport: keep it when the content changes. */
  const touched = useRef(false);
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

  const fit = useCallback(() => {
    if (size.w === 0 || size.h === 0 || width === 0 || height === 0) return;
    const k = clamp(
      Math.min((size.w - 2 * FIT_PADDING) / width, (size.h - 2 * FIT_PADDING) / height),
      MIN_ZOOM,
      MAX_FIT_ZOOM,
    );
    setT({
      k,
      x: (size.w - width * k) / 2,
      y: Math.max(FIT_PADDING / 2, (size.h - height * k) / 2),
    });
  }, [size.w, size.h, width, height]);

  useLayoutEffect(() => {
    if (lastReset.current !== resetKey) {
      lastReset.current = resetKey;
      touched.current = false;
    }
    if (!touched.current) fit();
  }, [fit, resetKey]);

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
      touched.current = true;
      setT((cur) => zoomAt(cur, factor, event.clientX - rect.left, event.clientY - rect.top));
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, []);

  const zoomBy = (factor: number) => {
    touched.current = true;
    setT((cur) => zoomAt(cur, factor, size.w / 2, size.h / 2));
  };

  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
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
    touched.current = true;
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
        touched.current = false;
        fit();
        break;
      case "ArrowLeft":
      case "ArrowRight":
      case "ArrowUp":
      case "ArrowDown": {
        if (event.target !== event.currentTarget) return;
        const step = 60;
        const dx = event.key === "ArrowLeft" ? step : event.key === "ArrowRight" ? -step : 0;
        const dy = event.key === "ArrowUp" ? step : event.key === "ArrowDown" ? -step : 0;
        touched.current = true;
        setT((cur) => ({ ...cur, x: cur.x + dx, y: cur.y + dy }));
        break;
      }
      default:
        return;
    }
    event.preventDefault();
  };

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
      </svg>
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
          onClick={() => {
            touched.current = false;
            fit();
          }}
        >
          Fit
        </button>
      </div>
    </div>
  );
}
