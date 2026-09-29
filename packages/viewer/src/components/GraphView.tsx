/**
 * Graph view: `DerivedGraph` -> ELK layout (async) -> our own SVG inside a pan/zoom canvas.
 *
 * Every clickable piece is a `<g data-element-id="...">`: nodes and containers (containers nest their
 * children so a click on a child never also selects the container), derived and stored edges, stubs
 * (`data-stub-id` too) and ghost boxes (`ghost:<id>`). State classes: is-selected, is-match, is-related.
 * Click selects (shift adds), double-click drills into a node, a click on a ghost adds it to the view.
 * A ghost that stands for several elements ("rest of <file>", "N more") opens a menu of them instead
 * (GhostMenu), and adding one of them expands the view.
 */
import type { DerivedGraph } from "@xpl/core";
import {
  createContext,
  memo,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type MouseEvent,
  type PointerEvent,
  type WheelEvent,
} from "react";
import {
  badgeWidth,
  EDGE_BOUNDS_PAD,
  labelWidth,
  layoutGraphFitting,
  startAnchor,
  type GraphLayout,
  type LayoutEdge,
  type LayoutNode,
} from "../layout/graphLayout.js";
import { arrowHeadPath, distanceToSegment, roundedPath, routeBox } from "../svg.js";
import { useStore } from "../hooks.js";
import { GhostTargetList } from "./GhostTargets.js";
import { PanZoom, PRESENT_FIT_PADDING, PRESENT_MAX_FIT_ZOOM } from "./PanZoom.js";

/** True while presenting: a talk looks at the diagram, it does not edit it (no drill-in, collapse or expand). */
const ReadOnly = createContext(false);

/** Where a ghost box is on screen, relative to the diagram pane (the menu of a folded ghost opens beside it). */
interface Anchor {
  left: number;
  right: number;
  top: number;
  bottom: number;
}

interface GhostMenuState {
  /** Render id of the ghost (`ghost:rest:file:src/a.ts`). */
  id: string;
  anchor: Anchor;
}

/** Opens and closes the menu of a folded ghost; `openId` is the ghost whose menu is open. */
interface GhostMenuApi {
  openId: string | undefined;
  toggle(id: string, box: DOMRect): void;
}
const GhostMenuContext = createContext<GhostMenuApi>({
  openId: undefined,
  toggle: () => undefined,
});

interface Marks {
  selected: ReadonlySet<string>;
  matches: ReadonlySet<string>;
  related: ReadonlySet<string>;
}

/**
 * Padding of the invisible `bounds` rects (more than any stroke or miter can stick out). An SVG group's
 * bounding box is the union of what is in it, and automated clicks (like a user's "click it in the
 * middle") aim at its centre; a `bounds` rect makes that centre a point we chose.
 */
const BOUNDS_PAD = EDGE_BOUNDS_PAD;
/** The same for a container, which holds edges whose padded boxes may stick out of its body. */
const CONTAINER_BOUNDS_PAD = 40;

const additive = (event: MouseEvent | KeyboardEvent) =>
  event.shiftKey || event.metaKey || event.ctrlKey;

function stateClasses(id: string, marks: Marks): string {
  return (
    (marks.selected.has(id) ? " is-selected" : "") +
    (marks.matches.has(id) ? " is-match" : "") +
    (marks.related.has(id) ? " is-related" : "")
  );
}

function activate(event: KeyboardEvent, run: () => void) {
  if (event.key === "Enter" || event.key === " ") {
    event.preventDefault();
    event.stopPropagation();
    run();
  }
}

export interface GraphViewProps {
  viewId: string;
  /** A new key starts the diagram over (its first view); default: the view id. */
  resetKey?: string;
  graph: DerivedGraph;
  selection: readonly string[];
  matches: readonly string[];
  related: ReadonlySet<string>;
  /**
   * The view's include list, in the author's order. A diagram too big to be shown whole starts on the
   * selection, else on the first of these that is drawn.
   */
  order?: readonly string[];
  /** Present mode: larger fitting, and the diagram cannot be edited. */
  present?: boolean;
}

const NO_ORDER: readonly string[] = [];

export function GraphView({
  viewId,
  resetKey = viewId,
  graph,
  selection,
  matches,
  related,
  order = NO_ORDER,
  present = false,
}: GraphViewProps) {
  const store = useStore();
  const host = useRef<HTMLDivElement>(null);
  const [layout, setLayout] = useState<GraphLayout | undefined>();
  const [error, setError] = useState<string | undefined>();
  const [menu, setMenu] = useState<GhostMenuState | undefined>();
  // Stable while nothing selected, matched or related changes, so unchanged shapes are not re-rendered.
  const marks = useMemo<Marks>(
    () => ({ selected: new Set(selection), matches: new Set(matches), related }),
    [selection, matches, related],
  );

  const startBox = useMemo(
    () => (layout ? startAnchor(layout, selection, order) : undefined),
    [layout, selection, order],
  );

  // The layout direction (right or down) is chosen for the pane the diagram is drawn in.
  useEffect(() => {
    let cancelled = false;
    const el = host.current;
    const viewport = el ? { width: el.clientWidth, height: el.clientHeight } : undefined;
    layoutGraphFitting(
      graph,
      viewport,
      present ? PRESENT_MAX_FIT_ZOOM : undefined,
      present ? PRESENT_FIT_PADDING : undefined,
    ).then(
      (result) => {
        if (cancelled) return;
        setLayout(result);
        setError(undefined);
      },
      (failure: unknown) => {
        if (!cancelled) setError(failure instanceof Error ? failure.message : String(failure));
      },
    );
    return () => {
      cancelled = true;
    };
  }, [graph, present]);

  // The menu belongs to the layout it was opened on.
  useEffect(() => setMenu(undefined), [graph, present, viewId]);

  const menuApi = useMemo<GhostMenuApi>(
    () => ({
      openId: menu?.id,
      toggle(id, box) {
        const hostBox = host.current?.getBoundingClientRect();
        if (!hostBox) return;
        setMenu((open) =>
          open?.id === id
            ? undefined
            : {
                id,
                anchor: {
                  left: box.left - hostBox.left,
                  right: box.right - hostBox.left,
                  top: box.top - hostBox.top,
                  bottom: box.bottom - hostBox.top,
                },
              },
        );
      },
    }),
    [menu?.id],
  );
  const closeMenu = useCallback(() => setMenu(undefined), []);
  // A press anywhere else (a ghost handles its own click) or a wheel turn over the diagram puts the menu
  // away: what it was anchored to is about to move.
  const dismiss = (event: PointerEvent<HTMLDivElement>) => {
    if (!menu) return;
    const target = event.target as Element;
    if (target.closest(".ghost-menu") || target.closest('[data-element-id^="ghost:"]')) return;
    setMenu(undefined);
  };
  // (a long menu scrolls with the wheel: only a turn over the diagram puts it away)
  const dismissOnWheel = (event: WheelEvent<HTMLDivElement>) => {
    if (!(event.target as Element).closest(".ghost-menu")) setMenu(undefined);
  };
  const menuGhost = menu ? layout?.nodes.find((n) => n.id === menu.id) : undefined;

  let body;
  if (error) body = <div className="diagram-message is-error">Layout failed: {error}</div>;
  else if (!layout) body = <div className="diagram-message">Laying out the graph…</div>;
  else if (layout.nodes.length === 0) {
    body = (
      <div className="diagram-message">
        This view shows nothing yet. Add nodes to its <code>include</code> list.
      </div>
    );
  } else {
    body = (
      <PanZoom
        width={layout.width}
        height={layout.height}
        resetKey={resetKey}
        label="Diagram. Drag to pan, scroll to zoom."
        maxFitZoom={present ? PRESENT_MAX_FIT_ZOOM : undefined}
        fitPadding={present ? PRESENT_FIT_PADDING : undefined}
        startBox={startBox}
        onBackgroundClick={() => store.clearSelection()}
      >
        <g
          className="graph"
          data-fallback={layout.fallback ? "true" : undefined}
          data-direction={layout.direction}
        >
          {/* Nodes are drawn above the edges of their level: a click on a box is never taken by an edge. */}
          <g className="edges">
            {layout.edges.map((edge) => (
              <EdgeShape key={edge.id} edge={edge} marks={marks} />
            ))}
          </g>
          <g className="nodes">
            {layout.nodes.map((node) => (
              <NodeShape key={node.id} node={node} marks={marks} />
            ))}
          </g>
        </g>
      </PanZoom>
    );
  }
  return (
    <ReadOnly.Provider value={present}>
      <GhostMenuContext.Provider value={menuApi}>
        <div
          className="graph-host"
          ref={host}
          onPointerDownCapture={dismiss}
          onWheelCapture={menu ? dismissOnWheel : undefined}
        >
          {body}
          {menu && menuGhost?.ghostFold && (
            <GhostMenu node={menuGhost} anchor={menu.anchor} onClose={closeMenu} />
          )}
        </div>
      </GhostMenuContext.Provider>
    </ReadOnly.Provider>
  );
}

// ─── Nodes ──────────────────────────────────────────────────────────────────────────────────────

const NodeShape = memo(function NodeShape({ node, marks }: { node: LayoutNode; marks: Marks }) {
  return node.ghost ? (
    <GhostShape node={node} marks={marks} />
  ) : (
    <BoxShape node={node} marks={marks} />
  );
});

function BoxShape({ node, marks }: { node: LayoutNode; marks: Marks }) {
  const store = useStore();
  const readOnly = useContext(ReadOnly);
  const container = node.children.length > 0;
  const select = (event: MouseEvent | KeyboardEvent) => store.click(node.id, additive(event));
  const badge = badgeWidth(node.badge);
  return (
    <g
      className={`node kind-${node.kindClass}${container ? " is-container" : ""}${stateClasses(node.id, marks)}`}
      data-element-id={node.id}
      transform={`translate(${node.x} ${node.y})`}
      role="button"
      tabIndex={0}
      aria-label={`${node.badge} ${node.label}`}
      aria-pressed={marks.selected.has(node.id)}
      onClick={(event) => {
        event.stopPropagation();
        select(event);
      }}
      onDoubleClick={(event) => {
        event.stopPropagation();
        if (!readOnly) store.drillIn(node.id);
      }}
      onKeyDown={(event) => activate(event, () => select(event))}
    >
      <title>
        {!readOnly && store.canDrillIn(node.id)
          ? `${node.label} (${node.badge}): double-click to open what it contains`
          : `${node.label} (${node.badge})`}
      </title>
      {container && (
        <rect
          className="bounds"
          x={-CONTAINER_BOUNDS_PAD}
          y={-CONTAINER_BOUNDS_PAD}
          width={node.width + 2 * CONTAINER_BOUNDS_PAD}
          height={node.height + 2 * CONTAINER_BOUNDS_PAD}
        />
      )}
      <rect className="box" width={node.width} height={node.height} rx={container ? 10 : 8} />
      {container ? (
        <>
          <text className="label" x={14} y={22}>
            {node.label}
          </text>
          <Badge x={14 + labelWidth(node.label) + 8} y={9} text={node.badge} width={badge} />
          {/* What the container holds: its own edges under its children. */}
          <g className="edges">
            {node.edges.map((edge) => (
              <EdgeShape key={edge.id} edge={edge} marks={marks} />
            ))}
          </g>
          {node.children.map((child) => (
            <NodeShape key={child.id} node={child} marks={marks} />
          ))}
          {!readOnly && (
            <g
              className="collapse"
              role="button"
              tabIndex={0}
              aria-label={`Collapse ${node.label}`}
              data-collapse-id={node.id}
              transform={`translate(${node.width - 30} 8)`}
              onClick={(event) => {
                event.stopPropagation();
                store.collapse(node.id);
              }}
              onDoubleClick={(event) => event.stopPropagation()}
              onKeyDown={(event) => activate(event, () => store.collapse(node.id))}
            >
              <title>Collapse: remove what is inside</title>
              <rect width={20} height={18} rx={4} />
              <path d="M5 9h10" />
            </g>
          )}
          {centerIsCovered(node) && (
            <circle className="hit" cx={node.width / 2} cy={node.height / 2} r={10} />
          )}
        </>
      ) : (
        <>
          <text className="label" x={14} y={19}>
            {node.label}
          </text>
          <Badge x={14} y={27} text={node.badge} width={badge} />
        </>
      )}
    </g>
  );
}

/**
 * The centre of a container is where a click on "the container" lands (see BOUNDS_PAD). When a child
 * box or one of the container's own edges is drawn over it, a small hit target above them keeps that
 * click on the container.
 */
function centerIsCovered(node: LayoutNode): boolean {
  const c = { x: node.width / 2, y: node.height / 2 };
  const near = 8;
  if (
    node.children.some(
      (child) =>
        c.x >= child.x - near &&
        c.x <= child.x + child.width + near &&
        c.y >= child.y - near &&
        c.y <= child.y + child.height + near,
    )
  ) {
    return true;
  }
  return node.edges.some(
    (edge) =>
      edge.points.some(
        (p, i) => i > 0 && distanceToSegment(c, edge.points[i - 1]!, p) <= near + 6,
      ) ||
      (edge.label !== undefined &&
        c.x >= edge.label.x &&
        c.x <= edge.label.x + edge.label.width &&
        c.y >= edge.label.y &&
        c.y <= edge.label.y + edge.label.height),
  );
}

function Badge({ x, y, text, width }: { x: number; y: number; text: string; width: number }) {
  return (
    <g className="badge" transform={`translate(${x} ${y})`} aria-hidden="true">
      <rect width={width} height={16} rx={8} />
      <text x={width / 2} y={12}>
        {text}
      </text>
    </g>
  );
}

function GhostShape({ node, marks }: { node: LayoutNode; marks: Marks }) {
  const store = useStore();
  const readOnly = useContext(ReadOnly);
  const menu = useContext(GhostMenuContext);
  const fold = node.ghostFold;
  const open = fold !== undefined && menu.openId === node.id;
  // One element: add it. Several: choose (the menu). While presenting, nothing happens.
  const expand = (box: DOMRect) => {
    if (readOnly) return;
    if (fold) menu.toggle(node.id, box);
    else if (node.ghostTarget !== undefined) store.expandStub({ ghost: node.ghostTarget });
  };
  const label = readOnly
    ? `${node.label} (not in this view)`
    : fold
      ? `${node.label}: choose what to add to the view`
      : `Add ${node.label} to the view`;
  return (
    <g
      className={`node ghost${fold ? " is-fold" : ""}${open ? " is-open" : ""}${stateClasses(node.id, marks)}`}
      data-element-id={node.id}
      transform={`translate(${node.x} ${node.y})`}
      role="button"
      tabIndex={0}
      aria-label={label}
      aria-haspopup={fold && !readOnly ? "menu" : undefined}
      aria-expanded={fold && !readOnly ? open : undefined}
      onClick={(event) => {
        event.stopPropagation();
        expand(event.currentTarget.getBoundingClientRect());
      }}
      onKeyDown={(event) =>
        activate(event, () => expand(event.currentTarget.getBoundingClientRect()))
      }
    >
      <title>
        {readOnly
          ? `${node.label} is not in this view`
          : fold
            ? `${node.label}: ${node.hint ?? ""} reach ${fold.kind === "more" ? "places" : "symbols"} that are not in this view. Click to choose what to add.`
            : node.hint
              ? `Add ${node.label} to the view (${node.hint} reach it across the edge of this view)`
              : `Add ${node.label} to the view`}
      </title>
      <rect className="box" width={node.width} height={node.height} rx={8} />
      {fold ? (
        <path className="plus is-list" d="M12 11h10M12 15h10M12 19h10" />
      ) : (
        <path className="plus" d="M13 15h8M17 11v8" />
      )}
      <text className="label" x={28} y={19}>
        {node.label}
      </text>
      {node.detail && (
        <text className="detail" x={14} y={33}>
          {node.detail}
        </text>
      )}
    </g>
  );
}

/**
 * The menu of a ghost that stands for several elements: what it folds, most referenced first, each with
 * its reference count. Picking one adds that element to the view (`expandStub`); a "rest of <file>" ghost
 * also offers the whole file as one box, which wraps what is shown and stands for everything else in it.
 */
function GhostMenu({
  node,
  anchor,
  onClose,
}: {
  node: LayoutNode;
  anchor: Anchor;
  onClose: () => void;
}) {
  const store = useStore();
  const ref = useRef<HTMLDivElement>(null);
  const [at, setAt] = useState<{ left: number; top: number }>({
    left: anchor.right + 8,
    top: anchor.top,
  });
  const fold = node.ghostFold!;

  // Beside the ghost, on the side that has room, and inside the pane.
  useLayoutEffect(() => {
    const el = ref.current;
    const hostEl = el?.parentElement;
    if (!el || !hostEl) return;
    const room = 8;
    const right = anchor.right + room;
    const left =
      right + el.offsetWidth <= hostEl.clientWidth - room
        ? right
        : Math.max(room, anchor.left - room - el.offsetWidth);
    const top = Math.max(room, Math.min(anchor.top, hostEl.clientHeight - el.offsetHeight - room));
    setAt({ left, top });
  }, [anchor]);

  useEffect(() => {
    ref.current?.querySelector<HTMLElement>("button")?.focus({ preventScroll: true });
  }, []);

  const add = (target: string) => {
    store.expandStub({ ghost: target });
    onClose();
  };
  const whole =
    fold.kind === "rest" &&
    fold.file !== undefined &&
    !fold.targets.some((t) => t.target === fold.file)
      ? fold.file
      : undefined;

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const items = [...event.currentTarget.querySelectorAll<HTMLElement>("button")];
    const current = items.indexOf(document.activeElement as HTMLElement);
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      onClose();
      // Back to the ghost, so the keyboard picks up where it was.
      requestAnimationFrame(() =>
        document.querySelector<SVGElement>(`[data-element-id="${node.id}"]`)?.focus(),
      );
    } else if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      const step = event.key === "ArrowDown" ? 1 : -1;
      items[(current + step + items.length) % items.length]?.focus();
    } else if (event.key === "Home" || event.key === "End") {
      event.preventDefault();
      items[event.key === "Home" ? 0 : items.length - 1]?.focus();
    }
  };

  return (
    <div
      ref={ref}
      className="ghost-menu"
      role="menu"
      aria-label={`${node.label}: choose what to add to the view`}
      data-testid="ghost-menu"
      data-ghost-id={node.id}
      style={{ left: at.left, top: at.top }}
      onKeyDown={onKeyDown}
    >
      <p className="ghost-menu-head">
        <strong>{node.label}</strong>
        <span>
          {fold.kind === "rest"
            ? "Not in this view. Add one to expand it."
            : "Left out to keep the view readable. Add one to expand it."}
        </span>
      </p>
      {whole && (
        <button
          type="button"
          role="menuitem"
          className="ghost-target is-whole"
          data-ghost-target={whole}
          title="Add the file as one box: it wraps what is shown and stands for the rest of it"
          onClick={() => add(whole)}
        >
          <span className="ghost-target-label">The whole file</span>
          <span className="ghost-target-count">as one box</span>
        </button>
      )}
      <GhostTargetList targets={fold.targets} onPick={add} menu />
    </div>
  );
}

// ─── Edges ──────────────────────────────────────────────────────────────────────────────────────

const EdgeShape = memo(function EdgeShape({ edge, marks }: { edge: LayoutEdge; marks: Marks }) {
  const store = useStore();
  const points = edge.points;
  if (points.length < 2) return null;
  const path = roundedPath(points);
  const tip = points[points.length - 1]!;
  const before = points[points.length - 2]!;
  const label = edge.label;
  // A click on the edge lands on its anchor, a point of the route (see BOUNDS_PAD): the invisible
  // `bounds` rect is centred on it and reaches around the whole route.
  const box = routeBox(points, label);
  const reachX = Math.max(edge.anchor.x - box.x, box.x + box.width - edge.anchor.x) + BOUNDS_PAD;
  const reachY = Math.max(edge.anchor.y - box.y, box.y + box.height - edge.anchor.y) + BOUNDS_PAD;
  const select = (event: MouseEvent | KeyboardEvent) => store.click(edge.id, additive(event));
  const classes = ["edge", edge.stub ? "is-stub" : `res-${edge.resolution}`, `kind-${edge.kind}`];
  return (
    <g
      className={classes.join(" ") + stateClasses(edge.id, marks)}
      data-element-id={edge.id}
      data-stub-id={edge.stub ? edge.id : undefined}
      role="button"
      tabIndex={0}
      aria-label={`${edge.stub ? "stub" : "edge"} ${edge.title}`}
      onClick={(event) => {
        event.stopPropagation();
        select(event);
      }}
      onKeyDown={(event) => activate(event, () => select(event))}
    >
      <title>{edge.stub ? `${edge.title} (leaves or enters the view here)` : edge.title}</title>
      <rect
        className="bounds"
        x={edge.anchor.x - reachX}
        y={edge.anchor.y - reachY}
        width={2 * reachX}
        height={2 * reachY}
      />
      <path className="halo" d={path} />
      <path className="line" d={path} />
      <path className="head" d={arrowHeadPath(before, tip)} />
      <path className="hit" d={path} />
      {label && (
        <g className="edge-label">
          <rect x={label.x} y={label.y} width={label.width} height={label.height} rx={4} />
          <text x={label.x + label.width / 2} y={label.y + label.height / 2 + 4}>
            {label.text}
          </text>
        </g>
      )}
    </g>
  );
});
