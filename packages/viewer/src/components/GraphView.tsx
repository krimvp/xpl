/**
 * Graph view: `DerivedGraph` -> layered layout (graphLayout.ts, async) -> our own SVG inside a pan/zoom canvas.
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
  changeText,
  CYLINDER_LID,
  CYLINDER_ROLES,
  ICON_ROOM,
  ZOOM_SIZE,
  EDGE_BOUNDS_PAD,
  labelWidth,
  layoutGraphFitting,
  PILL_GAP,
  startAnchor,
  type ChangeMarks,
  type GraphLayout,
  type LayoutEdge,
  type LayoutNode,
} from "../layout/graphLayout.js";
import { arrowHeadPath, distanceToSegment, roundedPath, routeBox, type Box } from "../svg.js";
import { unionBox } from "../viewport.js";
import { changeMarks, changeOf } from "../diff.js";
import { useStore, useViewerState } from "../hooks.js";
import { readerBadge } from "../readerWords.js";
import { GhostTargetList } from "./GhostTargets.js";
import { BoxIcon, iconName } from "./icons.js";
import {
  PanZoom,
  PRESENT_FIT_PADDING,
  PRESENT_MAX_FIT_ZOOM,
  PRESENT_READABLE_ZOOM,
} from "./PanZoom.js";

/** True while presenting: a talk looks at the diagram, it does not edit it (no drill-in, collapse or expand). */
const ReadOnly = createContext(false);
/**
 * True in reader views (Read mode, Present): boxes show the kind of code they are (file, class, function),
 * not the explainer's structure (group, dir), and the made-up `calls ×N` labels only show on hover or when
 * the edge or one of its ends is selected.
 */
const Reader = createContext(false);
/**
 * True in a still picture (the Guide's inline diagram, `GraphPicture`): the same shapes, but no element
 * ids (the live diagram keeps those to itself) and nothing to click or focus.
 */
const Still = createContext(false);

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

function canvasBounds(layout: GraphLayout): Box {
  const boxes: Box[] = [{ x: 0, y: 0, width: layout.width, height: layout.height }];
  const edges = (list: LayoutEdge[], x: number, y: number) => {
    for (const edge of list) {
      const box = routeBox(edge.points, edge.label);
      const width = Math.max(edge.anchor.x - box.x, box.x + box.width - edge.anchor.x) + BOUNDS_PAD;
      const height =
        Math.max(edge.anchor.y - box.y, box.y + box.height - edge.anchor.y) + BOUNDS_PAD;
      boxes.push({
        x: x + edge.anchor.x - width,
        y: y + edge.anchor.y - height,
        width: 2 * width,
        height: 2 * height,
      });
    }
  };
  const visit = (list: LayoutNode[], x: number, y: number) => {
    for (const node of list) {
      const at = { x: x + node.x, y: y + node.y };
      const pad = node.children.length > 0 ? CONTAINER_BOUNDS_PAD : 0;
      boxes.push({
        x: at.x - pad,
        y: at.y - pad,
        width: node.width + 2 * pad,
        height: node.height + 2 * pad,
      });
      edges(node.edges, at.x, at.y);
      visit(node.children, at.x, at.y);
    }
  };
  edges(layout.edges, 0, 0);
  visit(layout.nodes, 0, 0);
  return unionBox(boxes)!;
}

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
  /** A reader view (Read mode; Present always is one): plain badges, quiet count labels. */
  reader?: boolean;
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
  reader = false,
}: GraphViewProps) {
  const store = useStore();
  const host = useRef<HTMLDivElement>(null);
  const changes = useGraphChanges(graph);
  const [layout, setLayout] = useState<GraphLayout | undefined>();
  const [error, setError] = useState<string | undefined>();
  const [menu, setMenu] = useState<GhostMenuState | undefined>();
  // Stable while nothing selected, matched or related changes, so unchanged shapes are not re-rendered.
  const marks = useMemo<Marks>(
    () => ({ selected: new Set(selection), matches: new Set(matches), related }),
    [selection, matches, related],
  );

  const canvas = useMemo(() => (layout ? canvasBounds(layout) : undefined), [layout]);
  const startBox = useMemo(() => {
    const box = layout ? startAnchor(layout, selection, order) : undefined;
    return box && canvas ? { ...box, x: box.x - canvas.x, y: box.y - canvas.y } : box;
  }, [layout, canvas, selection, order]);

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
      changes,
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
  }, [graph, present, changes]);

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
        width={canvas!.width}
        height={canvas!.height}
        resetKey={resetKey}
        label="Diagram. Drag to pan, scroll to zoom."
        maxFitZoom={present ? PRESENT_MAX_FIT_ZOOM : undefined}
        fitPadding={present ? PRESENT_FIT_PADDING : undefined}
        readableZoom={present ? PRESENT_READABLE_ZOOM : undefined}
        startBox={startBox}
        onBackgroundClick={() => store.clearSelection()}
      >
        <g
          className="graph"
          transform={`translate(${-canvas!.x} ${-canvas!.y})`}
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
      <Reader.Provider value={present || reader}>
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
      </Reader.Provider>
    </ReadOnly.Provider>
  );
}

/**
 * What the explainer's change did to the boxes of a graph ("New", "Changed"), stable while the change record,
 * the index and the graph stay the same (a tour edit makes a new model, not a new layout).
 */
export function useGraphChanges(graph: DerivedGraph): ChangeMarks | undefined {
  const state = useViewerState();
  const change = changeOf(state.explainer);
  const index = state.model.index;
  return useMemo(
    () =>
      change
        ? changeMarks(
            graph.nodes.map((node) => node.id),
            index,
            change,
          )
        : undefined,
    [graph, change, index],
  );
}

/**
 * A still picture of a laid-out graph (the Guide's inline diagram): the shapes of the live diagram in their
 * reader form, with the selection and the related boxes marked. The caller draws it in its own frame
 * (Snapshot.tsx) and keeps it from taking clicks.
 */
export function GraphPicture({
  layout,
  selection,
  related,
}: {
  layout: GraphLayout;
  selection: readonly string[];
  related: ReadonlySet<string>;
}) {
  const marks = useMemo<Marks>(
    () => ({ selected: new Set(selection), matches: new Set(), related }),
    [selection, related],
  );
  return (
    <ReadOnly.Provider value={true}>
      <Reader.Provider value={true}>
        <Still.Provider value={true}>
          <g className="graph" data-direction={layout.direction}>
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
        </Still.Provider>
      </Reader.Provider>
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
  const reader = useContext(Reader);
  const container = node.children.length > 0;
  const still = useContext(Still);
  const select = (event: MouseEvent | KeyboardEvent) => store.click(node.id, additive(event));
  const badgeText = reader || node.role ? readerBadge(node.badge) : node.badge;
  const badge = badgeWidth(badgeText ?? "");
  // A box that opens a more detailed view zooms into it; while presenting, the tour decides what is shown.
  const zoomable = node.opens !== undefined && !still && store.canZoomInto(node.id);
  const zoom = () => store.zoomInto(node.id);
  const role = node.role ? ` role-${node.role}` : "";
  const textX = 14 + ICON_ROOM;
  const icon = iconName(node);
  const lid = node.role && CYLINDER_ROLES.has(node.role) && !container ? CYLINDER_LID : 0;
  return (
    <g
      className={`node kind-${node.kindClass}${role}${container ? " is-container" : ""}${zoomable ? " is-zoomable" : ""}${stateClasses(node.id, marks)}`}
      data-element-id={still ? undefined : node.id}
      transform={`translate(${node.x} ${node.y})`}
      role={still ? undefined : "button"}
      tabIndex={still ? undefined : 0}
      aria-label={still ? undefined : `${node.badge} ${node.label}`}
      aria-pressed={still ? undefined : marks.selected.has(node.id)}
      onClick={(event) => {
        event.stopPropagation();
        select(event);
      }}
      onDoubleClick={(event) => {
        event.stopPropagation();
        if (zoomable) zoom();
        else if (!readOnly) store.drillIn(node.id);
      }}
      onKeyDown={(event) => activate(event, () => select(event))}
    >
      <title>
        {zoomable
          ? `${node.label} (${node.badge}): double-click to see what is inside`
          : !readOnly && store.canDrillIn(node.id)
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
      {node.role && !container ? (
        <RoleBox role={node.role} width={node.width} height={node.height} />
      ) : (
        <rect className="box" width={node.width} height={node.height} rx={container ? 10 : 8} />
      )}
      {container ? (
        <>
          <BoxIcon name={icon} x={13} y={9} />
          <text className="label" x={textX} y={22}>
            {node.label}
          </text>
          {badgeText && (
            <Badge x={textX + labelWidth(node.label) + 8} y={9} text={badgeText} width={badge} />
          )}
          {node.change && (
            <ChangePill
              x={textX + labelWidth(node.label) + 8 + (badgeText ? badge + PILL_GAP : 0)}
              y={9}
              change={node.change}
            />
          )}
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
          <LeafText node={node} x={textX} badgeText={badgeText} badge={badge} lid={lid} />
          {/* centred on the text block beside it */}
          <BoxIcon name={icon} x={13} y={lid + (node.height - lid) / 2 - 8} />
        </>
      )}
      {zoomable && (
        <ZoomButton
          x={node.width - ZOOM_SIZE - 6}
          y={container ? 8 : node.height - ZOOM_SIZE - 6}
          label={node.label}
          onZoom={zoom}
          offset={container && !readOnly ? 30 : 0}
        />
      )}
    </g>
  );
}

/** The label, badge and change pill of a box that is not a container, centred under a cylinder's lid. */
function LeafText({
  node,
  x,
  badgeText,
  badge,
  lid,
}: {
  node: LayoutNode;
  x: number;
  badgeText: string | undefined;
  badge: number;
  lid: number;
}) {
  const two = Boolean(badgeText || node.change);
  // A box of code keeps its fixed rows. An architecture box is taller (and a cylinder has a lid): the text
  // block (label, gap, badge: 35 px; a label alone: 14 px) is centred in what is left.
  const top = node.role
    ? lid + (node.height - lid - (two ? 35 : 14)) / 2
    : two
      ? 6
      : node.height / 2 - 8;
  const labelY = top + 13;
  const badgeY = node.role ? top + 19 : 27;
  return (
    <>
      <text className="label" x={x} y={labelY}>
        {node.label}
      </text>
      {badgeText && <Badge x={x} y={badgeY} text={badgeText} width={badge} />}
      {node.change && (
        <ChangePill x={x + (badgeText ? badge + PILL_GAP : 0)} y={badgeY} change={node.change} />
      )}
    </>
  );
}

/**
 * The outline of an architecture box (`Node.role`): a cylinder for what keeps data (a database, a cache, a
 * file store), a pipe for a queue, a dashed box for a system outside the repo, a heavier box for a service.
 * The main shape keeps the `box` class, so selection and hover style it like any box.
 */
function RoleBox({ role, width, height }: { role: string; width: number; height: number }) {
  if (CYLINDER_ROLES.has(role as never)) {
    const ry = CYLINDER_LID / 2 + 1;
    const top = ry;
    const bottom = height - ry;
    const rx = width / 2;
    return (
      <>
        <path
          className="box"
          d={`M0 ${top} A${rx} ${ry} 0 0 1 ${width} ${top} V${bottom} A${rx} ${ry} 0 0 1 0 ${bottom} Z`}
        />
        <path className="lid" d={`M0 ${top} A${rx} ${ry} 0 0 0 ${width} ${top}`} />
      </>
    );
  }
  if (role === "queue") {
    const r = height / 2;
    const ex = 7;
    return (
      <>
        <path
          className="box"
          d={`M${ex} 0 H${width - ex} A${ex} ${r} 0 0 1 ${width - ex} ${height} H${ex} A${ex} ${r} 0 0 1 ${ex} 0 Z`}
        />
        <path className="lid" d={`M${width - ex} 0 A${ex} ${r} 0 0 0 ${width - ex} ${height}`} />
      </>
    );
  }
  return <rect className="box" width={width} height={height} rx={role === "person" ? 20 : 8} />;
}

/** The button of a box that opens a more detailed view: "see what is inside". */
function ZoomButton({
  x,
  y,
  label,
  onZoom,
  offset,
}: {
  x: number;
  y: number;
  label: string;
  onZoom: () => void;
  offset: number;
}) {
  return (
    <g
      className="zoom"
      role="button"
      tabIndex={0}
      aria-label={`See what is inside ${label}`}
      transform={`translate(${x - offset} ${y})`}
      onClick={(event) => {
        event.stopPropagation();
        onZoom();
      }}
      onDoubleClick={(event) => event.stopPropagation()}
      onKeyDown={(event) => activate(event, onZoom)}
    >
      <title>See what is inside</title>
      <rect width={ZOOM_SIZE} height={ZOOM_SIZE} rx={5} />
      {/* a magnifier with a plus: zoom in */}
      <circle cx={9.5} cy={9.5} r={5} />
      <path d="M13.2 13.2 L17.5 17.5 M7 9.5 H12 M9.5 7 V12" />
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

/** "New" or "Changed": what the explainer's change did to this box, in plain words. */
function ChangePill({ x, y, change }: { x: number; y: number; change: "new" | "changed" }) {
  const text = changeText(change);
  const width = badgeWidth(text);
  return (
    <g
      className={`change-pill is-${change}`}
      transform={`translate(${x} ${y})`}
      data-change={change}
    >
      <title>{change === "new" ? "Added by this change" : "This change edits its code"}</title>
      <rect width={width} height={16} rx={8} />
      <text x={width / 2} y={12}>
        {text}
      </text>
    </g>
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
  const still = useContext(Still);
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
      data-element-id={still ? undefined : node.id}
      transform={`translate(${node.x} ${node.y})`}
      role={still ? undefined : "button"}
      tabIndex={still ? undefined : 0}
      aria-label={still ? undefined : label}
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
  const reader = useContext(Reader);
  const still = useContext(Still);
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
  // A count label in a reader view: shown on hover (CSS) and when the edge or an end of it is selected.
  if (
    reader &&
    edge.counted &&
    !marks.selected.has(edge.id) &&
    !marks.selected.has(edge.from) &&
    !marks.selected.has(edge.to)
  )
    classes.push("is-quiet");
  return (
    <g
      className={classes.join(" ") + stateClasses(edge.id, marks)}
      data-element-id={still ? undefined : edge.id}
      data-stub-id={edge.stub && !still ? edge.id : undefined}
      role={still ? undefined : "button"}
      tabIndex={still ? undefined : 0}
      aria-label={still ? undefined : `${edge.stub ? "stub" : "edge"} ${edge.title}`}
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
