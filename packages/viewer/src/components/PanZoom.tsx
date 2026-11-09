/**
 * An SVG canvas with pan (drag), zoom (wheel, buttons, + / - keys) and fit-to-view. Content is drawn in
 * its own coordinates (0..width, 0..height); this component owns the viewport transform.
 *
 * The first view follows one rule (viewport.ts `frameView`): the fit, unless the diagram is too big to read
 * when fitted; then what the step is about (`focus`, with its neighbours when there is room) at a readable
 * zoom, and a "+N more" cue for focused elements left out. One toolbar button fits: "Fit all", marked (and
 * counting the boxes out of sight) while part of a big diagram is out of sight, and "Readable size" once all
 * of a big diagram is fitted, to come back. The 0 key always fits all of it, however small. Zooming keeps the
 * selection where it is, and the selection (`keepInView`) is panned into view when it changes or the pane is
 * resized.
 *
 * A drag never turns into a click: pointer capture only starts once the pointer has moved a few
 * pixels, so a plain click still reaches the element under it. A click on the empty background calls
 * `onBackgroundClick`.
 */
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useId,
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
import { saveDiagramImage } from "../image.js";

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
/**
 * In Present, all of a flow step's focus (two boxes far apart, or a box taller than a short pane) is shown
 * down to this zoom (10px text) rather than half of it at 16px: neighbours still come in only at 16px.
 */
export const PRESENT_FLOW_FOCUS_ZOOM = 10 / 13;
/**
 * True inside Present (PresentMode provides it): the toolbar is out of sight until the mouse moves, so a
 * slide's first view takes the whole pane.
 */
export const Presenting = createContext(false);
/**
 * Present (D7): how many more pixels of width the diagram's pane needs for all of the diagram to read at the
 * 12px floor (`PRESENT_READABLE_ZOOM`), `Infinity` when more width alone would not do it (the diagram is too
 * tall at that zoom; a map may still turn when its pane gets wider). PresentMode widens the diagram column up
 * to a limit and keeps the widest width a step asked for.
 */
export const PresentRoom = createContext<((extra: number) => void) | undefined>(undefined);
/** Room kept between the floating toolbar and the diagram under it, px. */
const TOOLBAR_GAP = 6;
const DRAG_THRESHOLD = 4;
/** At this width or less (a phone) the first view fits the part of the pane that is on screen. */
const PHONE_WIDTH = 640;
/** A pane shorter than this, px, shows "Fit all" and "+N more" among the zoom buttons. */
const SHORT_PANE = 240;
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
  /** Fit preserves this scale and permits panning instead of shrinking text further. */
  minFitZoom?: number;
  /** With `minFitZoom`, a "Pan to explore" badge says so (default); false leaves it to the Fit all button. */
  panCue?: boolean;
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
   * The zoom the step's focus may go down to, to have all of it in view (and no box of it larger than the
   * pane), below `readableMin`: neighbours are only added at the size the focus needs (viewport.ts).
   */
  focusMin?: number;
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
  /** Source-linked text alternative for this diagram. */
  textView?: ReactNode;
  /** The name "Save image" gives the PNG of the whole diagram (the view's title). */
  imageName: string;
}

export function PanZoom({
  width,
  height,
  resetKey,
  onBackgroundClick,
  label,
  maxFitZoom = MAX_FIT_ZOOM,
  minFitZoom,
  panCue = true,
  fitPadding = FIT_PADDING,
  readableZoom,
  readableMin,
  focusMin,
  overlay,
  tools,
  focus,
  keepInView,
  revealMargin,
  children,
  textView,
  imageName,
}: PanZoomProps) {
  const wrap = useRef<HTMLDivElement>(null);
  /** The canvas: the pane's size is its size (on a phone the toolbar sits above it, not over it). */
  const canvas = useRef<SVGSVGElement>(null);
  const content = useRef<SVGGElement>(null);
  const [textMode, setTextMode] = useState(false);
  const textId = useId();
  const [size, setSize] = useState({ w: 0, h: 0 });
  /** The height of the pane on screen, when less than all of it is (a phone): what fitting uses. */
  const [shown, setShown] = useState<number | undefined>();
  /**
   * The band at the top of the pane that the floating toolbar covers, px (0 when the toolbar sits above the
   * canvas, as on a phone). Fitting and the first view place the diagram under it: the toolbar never covers
   * a box of a fitted diagram (D6).
   */
  const [band, setBand] = useState(0);
  /** The band is at the bottom of the pane (Present), not the top: the diagram is not moved down under it. */
  const [bandBelow, setBandBelow] = useState(false);
  /** How far down the band moves a fitted diagram. */
  const bandTop = bandBelow ? 0 : band;
  const presenting = useContext(Presenting);
  // In Present the toolbar stays out of sight until the mouse moves (a talk is driven by keys): a slide's
  // first view takes the whole pane; "Fit all", clicked with the toolbar in sight, keeps clear of it.
  const startBand = presenting ? 0 : band;
  const fitSize = useMemo(() => {
    const h = shown !== undefined && shown < size.h ? shown : size.h;
    return { w: size.w, h: Math.max(1, h - band) };
  }, [size, shown, band]);
  /** The pane on screen, the toolbar's band included: whether a diagram reads whole is decided on it. */
  const paneSize = useMemo(() => ({ w: fitSize.w, h: fitSize.h + band }), [fitSize, band]);
  const startSize = startBand === band ? fitSize : paneSize;
  const [t, setT] = useState<Transform>({ k: 1, x: 0, y: 0 });
  /** Focused elements the first view leaves out ("+N more"); 0 once the user moves the view. */
  const [more, setMore] = useState(0);
  const follow = useRef<Follow>("start");
  const start = useRef<Focus | undefined>(focus);
  const lastReset = useRef(resetKey);
  const drag = useRef<{ x: number; y: number; moved: boolean; id: number } | null>(null);
  const suppressClick = useRef(false);

  useLayoutEffect(() => {
    const el = canvas.current;
    if (!el) return;
    // (hidden in the text view: the size it had stays)
    const measure = () => {
      if (el.clientWidth > 0 || el.clientHeight > 0) {
        setSize({ w: el.clientWidth, h: el.clientHeight });
        // On a phone the pane can reach below the screen (the parts list follows it): fit to what shows (N11).
        const below = el.getBoundingClientRect().top;
        setShown(
          window.innerWidth <= PHONE_WIDTH && below >= 0
            ? Math.max(160, Math.min(el.clientHeight, window.innerHeight - below))
            : undefined,
        );
      }
      const toolbar = wrap.current?.querySelector<HTMLElement>(".pz-toolbar");
      if (toolbar && getComputedStyle(toolbar).position === "absolute") {
        const pane = el.getBoundingClientRect();
        const bar = toolbar.getBoundingClientRect();
        // (in Present the toolbar sits at the bottom of the pane, clear of a sequence's participant names)
        const below = bar.top > pane.top + pane.height / 2;
        const covered = below ? pane.bottom - bar.top : bar.bottom - pane.top;
        setBand(covered > 0 ? Math.round(covered + TOOLBAR_GAP) : 0);
        setBandBelow(below);
      } else setBand(0);
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    const toolbar = wrap.current?.querySelector(".pz-toolbar");
    if (toolbar) observer.observe(toolbar);
    return () => observer.disconnect();
  }, []);

  // In Present a frame of the focus keeps the floor too (D7: text never under 12px when a slide starts).
  const least = presenting ? (readableMin ?? readableZoom) : readableMin;
  const floor = readableZoom !== undefined ? (least ?? readableZoom) : READABLE_FLOOR;
  const options = useMemo(
    () => ({
      padding: fitPadding,
      maxZoom: maxFitZoom,
      minZoom: minFitZoom,
      ...(readableZoom !== undefined
        ? { whole: floor, readable: readableZoom, readableMin: least }
        : {}),
      ...(focusMin !== undefined ? { focusMin } : {}),
    }),
    [fitPadding, maxFitZoom, minFitZoom, readableZoom, least, focusMin, floor],
  );

  // Present: ask the slide for the width this diagram needs to read whole at the 12px floor.
  const askRoom = useContext(PresentRoom);
  useLayoutEffect(() => {
    if (!askRoom || width <= 0 || height <= 0 || paneSize.w <= 1 || paneSize.h <= 1) return;
    const k = PRESENT_READABLE_ZOOM;
    if (rawFitScale(paneSize, { width, height }, fitPadding) >= k) return;
    const tall = height * k + 2 * fitPadding > paneSize.h;
    askRoom(tall ? Infinity : Math.ceil(width * k + 2 * fitPadding - paneSize.w));
  }, [askRoom, width, height, paneSize, fitPadding]);

  /** All of the diagram in the pane, however small that makes it. */
  const fitAll = useCallback(() => {
    const next = fitTransform(fitSize, { width, height }, options);
    if (next) setT({ ...next, y: next.y + bandTop });
  }, [fitSize, width, height, options, bandTop]);

  /** The first view: the fit, or for a diagram too big to read whole, a readable frame of the focus. */
  const showStart = useCallback(() => {
    // A diagram that reads whole in the pane starts whole, under the toolbar's band (a little smaller):
    // the band does not turn it into one that starts on its focus.
    if (rawFitScale(paneSize, { width, height }, fitPadding) >= floor) {
      const fit = fitTransform(startSize, { width, height }, options);
      if (!fit) return;
      setT({ ...fit, y: fit.y + startBand });
      setMore(0);
      return;
    }
    const next = frameView(startSize, { width, height }, start.current, options);
    if (!next) return;
    setT({ ...next.transform, y: next.transform.y + startBand });
    setMore(next.hidden);
  }, [paneSize, startSize, width, height, options, startBand, fitPadding, floor]);

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
      if (event.target instanceof Element && event.target.closest(".diagram-text-view")) return;
      event.preventDefault();
      const rect = (canvas.current ?? el).getBoundingClientRect();
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
    const fitted = fitTransform(fitSize, all, { padding: fitPadding, maxZoom: maxFitZoom });
    if (!fitted) return;
    follow.current = "free";
    setMore(0);
    setT({ k: fitted.k, x: fitted.x - all.x * fitted.k, y: bandTop + fitted.y - all.y * fitted.k });
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

  const keyboardHelp = useId();
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (textMode) return;
    const host = event.currentTarget;
    const items = [
      ...host.querySelectorAll<SVGElement>(
        '.pz-svg [role="button"][data-element-id], .pz-svg [role="button"][data-key-for]',
      ),
    ];
    // Flow lines are painted behind stages; keyboard reading starts with the stages.
    items.sort(
      (a, b) =>
        Number(b.classList.contains("flow-stage")) - Number(a.classList.contains("flow-stage")),
    );
    const idOf = (el: SVGElement) => el.dataset.keyFor ?? el.dataset.elementId;
    const current = items.indexOf(event.target as SVGElement);
    const focusItem = (item: SVGElement | undefined) => {
      if (!item) return;
      item.focus({ preventScroll: true });
      const box = item.getBoundingClientRect();
      const room = host.getBoundingClientRect();
      const dx =
        box.left < room.left + 16
          ? room.left + 16 - box.left
          : box.right > room.right - 16
            ? room.right - 16 - box.right
            : 0;
      const dy =
        box.top < room.top + 16
          ? room.top + 16 - box.top
          : box.bottom > room.bottom - 16
            ? room.bottom - 16 - box.bottom
            : 0;
      if (dx || dy) {
        follow.current = "free";
        setT((cur) => ({ ...cur, x: cur.x + dx, y: cur.y + dy }));
      }
    };
    if (event.target === host && event.key === "Enter") {
      event.preventDefault();
      focusItem(items[0]);
      return;
    }
    if (
      current >= 0 &&
      ["Escape", "ArrowDown", "ArrowUp", "Home", "End", "ArrowLeft", "ArrowRight"].includes(
        event.key,
      )
    ) {
      const item = items[current]!;
      let target: SVGElement | undefined;
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        host.focus({ preventScroll: true });
        return;
      }
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        target =
          items[(current + (event.key === "ArrowDown" ? 1 : -1) + items.length) % items.length];
      } else if (event.key === "Home" || event.key === "End") {
        target = items[event.key === "Home" ? 0 : items.length - 1];
      } else if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
        const forward = event.key === "ArrowRight";
        const end = forward ? "navigationTo" : "navigationFrom";
        const start = forward ? "navigationFrom" : "navigationTo";
        const ownEnd = item.dataset[end];
        if (ownEnd) target = items.find((candidate) => idOf(candidate) === ownEnd);
        else {
          const link = [
            ...host.querySelectorAll<SVGElement>("[data-navigation-from][data-navigation-to]"),
          ].find((candidate) => candidate.dataset[start] === idOf(item));
          if (link)
            target =
              items.find((candidate) => idOf(candidate) === idOf(link)) ??
              items.find((candidate) => idOf(candidate) === link.dataset[end]);
        }
      }
      event.preventDefault();
      event.stopPropagation();
      focusItem(target);
      return;
    }

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
  const raw = rawFitScale(paneSize, { width, height }, fitPadding);
  const big = raw > 0 && raw < floor;
  const fitted = rawFitScale(fitSize, { width, height }, fitPadding);
  const allInSight = big && Math.abs(t.k - clamp(fitted, MIN_ZOOM, maxFitZoom)) < 0.005;
  // In a short pane (a laptop at 200%) "+N more" joins the zoom buttons: a pill in the bottom corner would sit
  // on the boxes, which then fill the pane.
  const short = size.h > 0 && size.h < SHORT_PANE;
  // A big diagram, part of it out of sight: how many of its boxes are (when the caller says where they are).
  const outOfSight =
    big && !allInSight
      ? (start.current?.others ?? []).filter(
          (box) =>
            t.x + box.x * t.k < -1 ||
            t.y + box.y * t.k < -1 ||
            t.x + (box.x + box.width) * t.k > size.w + 1 ||
            t.y + (box.y + box.height) * t.k > size.h + 1,
        ).length
      : 0;
  const readableAgain = allInSight && minFitZoom === undefined;
  // "Fit all" is a cue only while part of the diagram really is out of the pane (a big diagram fitted by
  // the reader, or one whose first view shows all of it, has nothing more to show).
  const cut =
    size.w > 0 &&
    (t.x < -1 || t.y < -1 || t.x + width * t.k > size.w + 1 || t.y + height * t.k > size.h + 1);
  const cue = big && !allInSight && cut;

  const cues = (
    <>
      {big && minFitZoom !== undefined && panCue && (
        <button
          type="button"
          className="pz-badge"
          data-testid="pz-badge"
          title="This diagram keeps its words readable. Drag to pan; click to return to where it started."
          onPointerDown={(event) => event.stopPropagation()}
          onClick={() => {
            follow.current = "start";
            showStart();
          }}
        >
          Pan to explore
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
    </>
  );

  return (
    <div
      ref={wrap}
      className="panzoom"
      tabIndex={0}
      role="group"
      aria-label={label}
      aria-describedby={keyboardHelp}
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
      <span id={keyboardHelp} className="pz-keyboard-hint">
        Enter to navigate. Up/Down: next element. Left/Right: follow links. Enter: select code.
        Escape: canvas.
      </span>
      {/* Before the canvas: Tab reaches the zoom buttons drawn above the diagram before its boxes (U51). */}
      <div className="pz-toolbar" onPointerDown={(event) => event.stopPropagation()}>
        {!textMode && (
          <>
            {short && cues}
            <button
              type="button"
              aria-label="Zoom in"
              title="Zoom in (+)"
              onClick={() => zoomBy(1.25)}
            >
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
              className={`pz-fit${cue ? " is-cue" : ""}`}
              data-testid="pz-fit"
              title={
                readableAgain
                  ? `All of it is in view at ${Math.round(t.k * 100)}%, too small to read comfortably. Zoom back to a readable size.`
                  : big
                    ? `Part of this diagram is out of sight${outOfSight > 0 ? ` (${outOfSight} boxes)` : ""}: it starts at a readable size. Fit all of it in the view (0).`
                    : "Fit all of it in the view (0)"
              }
              onClick={() => {
                if (readableAgain) {
                  follow.current = "start";
                  showStart();
                } else fitEverything();
              }}
            >
              {readableAgain ? "Readable size" : "Fit all"}
              {!readableAgain && outOfSight > 0 && (
                <span className="pz-fit-count"> ({outOfSight} out of sight)</span>
              )}
            </button>
            {tools}
            <button
              type="button"
              title="Save the whole diagram as a PNG image, as it looks here"
              onClick={() => void saveDiagramImage(content.current!, width, height, imageName)}
            >
              Save image
            </button>
          </>
        )}
        {textView && (
          <button
            type="button"
            aria-pressed={textMode}
            aria-controls={textId}
            onClick={() => setTextMode((shown) => !shown)}
          >
            Text view
          </button>
        )}
      </div>
      <svg
        ref={canvas}
        className="pz-svg"
        width="100%"
        height="100%"
        role="presentation"
        style={textMode ? { display: "none" } : undefined}
      >
        <g ref={content} transform={`translate(${t.x} ${t.y}) scale(${t.k})`}>
          {children}
        </g>
        {overlay?.(t, size)}
      </svg>
      {!textMode && !short && cues}
      {textView && (
        <div
          id={textId}
          hidden={!textMode}
          className="diagram-text-view"
          role="region"
          aria-label="Diagram as text"
          onPointerDown={(event) => event.stopPropagation()}
        >
          {textView}
        </div>
      )}
    </div>
  );
}
