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
import { codeFocus, type DerivedGraph, type GraphView as StoredGraphView } from "@xpl/core";
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
  type ReactNode,
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
  nodeBox,
  graphBounds,
  PILL_GAP,
  startAnchor,
  startFocus,
  type ChangeMarks,
  type GraphLayout,
  type LayoutEdge,
  type LayoutNode,
} from "../layout/graphLayout.js";
import {
  arrowHeadPath,
  distanceToSegment,
  roundedPath,
  routeBox,
  type Box,
  type Point,
} from "../svg.js";
import { changeMarks, changeOf } from "../diff.js";
import { useStore, useViewerState } from "../hooks.js";
import { mapKeyShows } from "../keyMarks.js";
import { boxName, readingOrder } from "../mapOrder.js";
import { readerBadge } from "../readerWords.js";
import { GhostTargetList } from "./GhostTargets.js";
import { Legend } from "./Legend.js";
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
/** The edge under the pointer (its label is drawn apart from it, and shows while it is hovered). */
const Hovered = createContext<string | undefined>(undefined);
const SetHovered = createContext<(id: string | undefined) => void>(() => undefined);
/** The names of the boxes drawn, by render id: an edge's accessible name says which two it joins. */
const BoxNames = createContext<ReadonlyMap<string, string>>(new Map());

function boxNames(
  nodes: readonly LayoutNode[],
  into = new Map<string, string>(),
): Map<string, string> {
  for (const node of nodes) {
    into.set(node.id, node.label);
    boxNames(node.children, into);
  }
  return into;
}

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
  /** In a still picture: what the frame cuts (graphLayout `cutAt`), drawn faded. */
  cut?: ReadonlySet<string>;
}

/**
 * Padding of the invisible `bounds` rects (more than any stroke or miter can stick out). An SVG group's
 * bounding box is the union of what is in it, and automated clicks (like a user's "click it in the
 * middle") aim at its centre; a `bounds` rect makes that centre a point we chose.
 */
const BOUNDS_PAD = EDGE_BOUNDS_PAD;
/** The same for a container, which holds edges whose padded boxes may stick out of its body. */
const CONTAINER_BOUNDS_PAD = 40;

/** How far the invisible bounds rect of an edge reaches from its anchor, each way (see EdgeShape). */
function edgeReach(edge: LayoutEdge): { x: number; y: number } {
  const box = routeBox(edge.points, edge.label);
  return {
    x: Math.max(edge.anchor.x - box.x, box.x + box.width - edge.anchor.x) + BOUNDS_PAD,
    y: Math.max(edge.anchor.y - box.y, box.y + box.height - edge.anchor.y) + BOUNDS_PAD,
  };
}

const containerPads = new WeakMap<LayoutNode, number>();
/**
 * The padding of a container's bounds rect: at least CONTAINER_BOUNDS_PAD, and enough to hold the bounds of
 * everything drawn in it (its edges, and its children's own bounds), the same on every side, so that the
 * centre of the container's group stays the centre of its box.
 */
function containerPad(node: LayoutNode): number {
  const known = containerPads.get(node);
  if (known !== undefined) return known;
  let pad = CONTAINER_BOUNDS_PAD;
  const fit = (left: number, top: number, right: number, bottom: number) => {
    pad = Math.max(
      pad,
      (node.frame?.x ?? 0) - left,
      (node.frame?.y ?? 0) - top,
      right - (node.frame?.x ?? 0) - node.width,
      bottom - (node.frame?.y ?? 0) - node.height,
    );
  };
  for (const edge of node.edges) {
    const reach = edgeReach(edge);
    fit(
      edge.anchor.x - reach.x,
      edge.anchor.y - reach.y,
      edge.anchor.x + reach.x,
      edge.anchor.y + reach.y,
    );
  }
  for (const child of node.children) {
    if (child.children.length === 0) continue;
    const inner = containerPad(child);
    fit(
      nodeBox(child).x - inner,
      nodeBox(child).y - inner,
      nodeBox(child).x + child.width + inner,
      nodeBox(child).y + child.height + inner,
    );
  }
  pad = Math.ceil(pad) + 1;
  containerPads.set(node, pad);
  return pad;
}

const additive = (event: MouseEvent | KeyboardEvent) =>
  event.shiftKey || event.metaKey || event.ctrlKey;

/** a11y: how far the keyboard focus ring sits outside a box (the gap shows the canvas). */
const FOCUS_RING_GAP = 5;

function stateClasses(id: string, marks: Marks): string {
  return (
    (marks.selected.has(id) ? " is-selected" : "") +
    (marks.matches.has(id) ? " is-match" : "") +
    (marks.related.has(id) ? " is-related" : "") +
    (marks.cut?.has(id) ? " is-cut" : "")
  );
}

function activate(event: KeyboardEvent, run: () => void) {
  if (event.key === "Enter" || event.key === " ") {
    event.preventDefault();
    event.stopPropagation();
    run();
  }
}

interface MoveApi {
  disabled: boolean;
  cancel: () => void;
  start: () => void;
  preview: (node: LayoutNode, position: Point) => void;
  finish: (node: LayoutNode, position?: Point) => void;
}
const Move = createContext<MoveApi | undefined>(undefined);

/** Frame decorations move around negative children; the children keep their saved coordinates. */
function Frame({ node, children }: { node: LayoutNode; children: ReactNode }) {
  return node.frame?.x || node.frame?.y ? (
    <g className="node-frame" transform={`translate(${node.frame.x} ${node.frame.y})`}>
      {children}
    </g>
  ) : (
    <>{children}</>
  );
}

export interface GraphViewProps {
  viewId: string;
  /** A new key starts the diagram over (its first view); default: the view id. */
  resetKey?: string;
  graph: DerivedGraph;
  pins?: StoredGraphView["layout"];
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
// 14px graph labels stay above 12px; larger pinned maps pan at this size.
const GRAPH_READABLE_ZOOM = 0.9;

export function GraphView({
  viewId,
  resetKey = viewId,
  graph,
  pins,
  selection,
  matches,
  related,
  order = NO_ORDER,
  present = false,
  reader = false,
}: GraphViewProps) {
  const store = useStore();
  const state = useViewerState();
  const host = useRef<HTMLDivElement>(null);
  const [preview, setPreview] = useState<StoredGraphView["layout"]>();
  const frozenCanvas = useRef<Box | undefined>(undefined);
  const activePins = preview ?? pins;
  const pinned = Object.keys(pins ?? {}).length > 0;
  const canMove =
    !present &&
    !reader &&
    state.mode === "explore" &&
    state.perspective === "explore" &&
    !state.editDraft &&
    state.model.view(viewId)?.type === "graph";

  const changes = useGraphChanges(graph);
  const [layout, setLayout] = useState<GraphLayout | undefined>();
  const [error, setError] = useState<string | undefined>();
  const [moveError, setMoveError] = useState<string>();
  const [menu, setMenu] = useState<GhostMenuState | undefined>();
  const [hovered, setHovered] = useState<string | undefined>();
  // Stable while nothing selected, matched or related changes, so unchanged shapes are not re-rendered.
  const marks = useMemo<Marks>(
    () => ({ selected: new Set(selection), matches: new Set(matches), related }),
    [selection, matches, related],
  );

  const drawnCanvas = useMemo(() => (layout ? graphBounds(layout) : undefined), [layout]);
  const canvas = preview ? (frozenCanvas.current ?? drawnCanvas) : drawnCanvas;
  const move: MoveApi | undefined = canMove
    ? {
        disabled: state.editBusy,
        cancel() {
          setPreview(undefined);
        },
        start() {
          frozenCanvas.current = canvas;
          setMoveError(undefined);
        },
        preview(node, position) {
          setPreview({ ...pins, [node.id]: position });
        },
        finish(node, position) {
          setPreview(undefined);
          if (position)
            void store
              .editGraph(viewId, { type: "pin", id: node.id, position })
              .catch((failure: unknown) =>
                setMoveError(failure instanceof Error ? failure.message : String(failure)),
              );
        },
      }
    : undefined;
  useEffect(() => setPreview(undefined), [viewId, graph, selection, canMove]);
  // The first view frames the selection and its neighbours (or the first box of the view); the selection
  // is kept in sight when it changes or the pane is resized. Both in the canvas' coordinates.
  const shift = useCallback(
    (box: Box): Box => (canvas ? { ...box, x: box.x - canvas.x, y: box.y - canvas.y } : box),
    [canvas],
  );
  const focus = useMemo(() => {
    const found = layout ? startFocus(layout, selection, order) : undefined;
    if (!found || !layout) return undefined;
    // the boxes without boxes inside them: a frame cuts as few of them as it can
    const leaves: Box[] = [];
    const walk = (list: readonly LayoutNode[], x: number, y: number) => {
      for (const node of list) {
        if (node.children.length === 0)
          leaves.push(
            shift({ x: x + node.x, y: y + node.y, width: node.width, height: node.height }),
          );
        walk(node.children, x + node.x, y + node.y);
      }
    };
    walk(layout.nodes, 0, 0);
    return {
      boxes: found.boxes.map(shift),
      neighbours: (found.neighbours ?? []).map(shift),
      others: leaves,
    };
  }, [layout, shift, selection, order]);
  const selectionBox = useMemo(() => {
    const box = layout && selection.length > 0 ? startAnchor(layout, selection, []) : undefined;
    return box && shift(box);
  }, [layout, shift, selection]);

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
      activePins,
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
  }, [graph, present, changes, activePins]);

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
  const names = useMemo(() => boxNames(layout?.nodes ?? []), [layout]);

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
        minFitZoom={pinned ? GRAPH_READABLE_ZOOM : undefined}
        readableZoom={present ? PRESENT_READABLE_ZOOM : pinned ? GRAPH_READABLE_ZOOM : undefined}
        readableMin={pinned ? GRAPH_READABLE_ZOOM : undefined}
        focus={focus}
        keepInView={preview ? undefined : selectionBox}
        onBackgroundClick={() => store.clearSelection()}
        tools={
          <Legend
            shows={mapKeyShows(layout.nodes, layout.edges, {
              canZoomInto: (id) => store.canZoomInto(id),
              canExpandInPlace: (id) => store.canExpandInPlace(id),
              changed: (changes?.size ?? 0) > 0,
            })}
          />
        }
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
              <EdgeShape key={edge.id} edge={edge} marks={marks} focusable={false} />
            ))}
          </g>
          <EdgeLabels edges={layout.edges} marks={marks} />
          <g className="nodes">
            {readingOrder(layout.nodes).map((node) => (
              <NodeShape key={node.id} node={node} marks={marks} />
            ))}
          </g>
          {/* The edges again, for the keyboard only: after the boxes, so Tab reaches the boxes first. */}
          <g className="edge-keys">
            {layout.edges.map((edge) => (
              <EdgeKey key={edge.id} edge={edge} />
            ))}
          </g>
        </g>
      </PanZoom>
    );
  }
  return (
    <Move.Provider value={move}>
      <ReadOnly.Provider value={present}>
        <Reader.Provider value={present || reader}>
          <BoxNames.Provider value={names}>
            <SetHovered.Provider value={setHovered}>
              <Hovered.Provider value={hovered}>
                <GhostMenuContext.Provider value={menuApi}>
                  <div
                    className="graph-host"
                    ref={host}
                    onPointerDownCapture={dismiss}
                    onWheelCapture={menu ? dismissOnWheel : undefined}
                  >
                    {body}
                    {moveError && (
                      <p className="placement-error" role="alert">
                        {moveError}
                      </p>
                    )}
                    {menu && menuGhost?.ghostFold && (
                      <GhostMenu node={menuGhost} anchor={menu.anchor} onClose={closeMenu} />
                    )}
                  </div>
                </GhostMenuContext.Provider>
              </Hovered.Provider>
            </SetHovered.Provider>
          </BoxNames.Provider>
        </Reader.Provider>
      </ReadOnly.Provider>
    </Move.Provider>
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
            (id) => codeFocus([id], state.model).map((range) => range.file),
          )
        : undefined,
    [graph, change, index, state.model],
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
  cut,
}: {
  layout: GraphLayout;
  selection: readonly string[];
  related: ReadonlySet<string>;
  /** What the picture's frame cuts (graphLayout `cutAt`): drawn faded. */
  cut?: ReadonlySet<string>;
}) {
  const marks = useMemo<Marks>(
    () => ({ selected: new Set(selection), matches: new Set(), related, ...(cut ? { cut } : {}) }),
    [selection, related, cut],
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
            <EdgeLabels edges={layout.edges} marks={marks} />
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
  // opened in place: the boxes of the map it opens are drawn inside it, until the reader folds it back
  const expandedHere = !still && store.isExpanded(node.id);
  const expandable =
    node.expandable === true && !container && !still && store.canExpandInPlace(node.id);
  const showCollapse = container && !still && (!readOnly || expandedHere);
  const zoom = () => store.zoomInto(node.id);
  const role = node.role ? ` role-${node.role}` : "";
  const textX = 14 + ICON_ROOM;
  const icon = iconName(node);
  const lid = node.role && CYLINDER_ROLES.has(node.role) && !container ? CYLINDER_LID : 0;
  const selected = marks.selected.has(node.id);
  const name = boxName(
    node.label,
    badgeText ?? (node.badge || undefined),
    node.change && changeText(node.change),
  );
  // left to right, the order Tab takes them in
  const cornerButtons = (
    <>
      {expandable && (
        <CornerButton
          className="expand-here"
          x={node.width - ZOOM_SIZE - 6 - (zoomable ? ZOOM_SIZE + 4 : 0)}
          y={node.height - ZOOM_SIZE - 6}
          label={`Show the parts of ${node.label} in its box`}
          title="Show its parts in this box, on this map"
          onPress={() => store.toggleExpanded(node.id)}
        >
          {/* a box with boxes in it: open it on this map */}
          <rect x={3.5} y={3.5} width={15} height={15} rx={2.5} />
          <rect x={6.5} y={9} width={4} height={4} rx={1} />
          <rect x={11.5} y={9} width={4} height={4} rx={1} />
          <path d="M6.5 6.5h9" />
        </CornerButton>
      )}
      {zoomable && (
        <CornerButton
          className="zoom"
          x={node.width - ZOOM_SIZE - 6 - (showCollapse ? 30 : 0)}
          y={container ? 8 : node.height - ZOOM_SIZE - 6}
          label={`Open the map of what is inside ${node.label}`}
          title="Open its own map: what is inside it"
          onPress={zoom}
        >
          {/* a magnifier with a plus: zoom in */}
          <circle cx={9.5} cy={9.5} r={5} />
          <path d="M13.2 13.2 L17.5 17.5 M7 9.5 H12 M9.5 7 V12" />
        </CornerButton>
      )}
    </>
  );
  const shape = (
    <g
      className={`node kind-${node.kindClass}${role}${container ? " is-container" : ""}${zoomable ? " is-zoomable" : ""}${stateClasses(node.id, marks)}`}
      data-element-id={still ? undefined : node.id}
      transform={`translate(${node.x} ${node.y})`}
      // a container holds boxes (buttons): it is a group, and says when it is the one picked
      role={still ? undefined : container ? "group" : "button"}
      tabIndex={still ? undefined : 0}
      aria-label={still ? undefined : container && selected ? `${name}, picked` : name}
      aria-pressed={still || container ? undefined : selected}
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
      <Frame node={node}>
        {container && (
          <rect
            className="bounds"
            x={-containerPad(node)}
            y={-containerPad(node)}
            width={node.width + 2 * containerPad(node)}
            height={node.height + 2 * containerPad(node)}
          />
        )}
        {node.role && !container ? (
          <RoleBox role={node.role} width={node.width} height={node.height} />
        ) : (
          <rect className="box" width={node.width} height={node.height} rx={container ? 10 : 8} />
        )}
        {!still && <FocusRing width={node.width} height={node.height} rx={container ? 10 : 8} />}
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
          </>
        ) : (
          <>
            <LeafText node={node} x={textX} badgeText={badgeText} badge={badge} lid={lid} />
            <BoxIcon name={icon} x={13} y={lid + (node.height - lid) / 2 - 8} />
          </>
        )}
      </Frame>
      {container && (
        <>
          {/* What the container holds: its own edges under its children. */}
          <g className="edges">
            {node.edges.map((edge) => (
              <EdgeShape key={edge.id} edge={edge} marks={marks} />
            ))}
          </g>
          <EdgeLabels edges={node.edges} marks={marks} />
          {readingOrder(node.children).map((child) => (
            <NodeShape key={child.id} node={child} marks={marks} />
          ))}
          <Frame node={node}>
            {showCollapse && (
              <g
                className="collapse"
                role="button"
                tabIndex={0}
                aria-label={expandedHere ? `Fold ${node.label} back` : `Collapse ${node.label}`}
                data-collapse-id={node.id}
                transform={`translate(${node.width - 30} 8)`}
                onClick={(event) => {
                  event.stopPropagation();
                  if (expandedHere) store.toggleExpanded(node.id);
                  else store.collapse(node.id);
                }}
                onDoubleClick={(event) => event.stopPropagation()}
                onKeyDown={(event) =>
                  activate(event, () =>
                    expandedHere ? store.toggleExpanded(node.id) : store.collapse(node.id),
                  )
                }
              >
                <title>
                  {expandedHere
                    ? "Fold back: show it as one box again"
                    : "Collapse: remove what is inside"}
                </title>
                <rect width={20} height={18} rx={4} />
                <path d="M5 9h10" />
              </g>
            )}
            {centerIsCovered(node) && (
              <circle className="hit" cx={node.width / 2} cy={node.height / 2} r={10} />
            )}
            {/* inside a container (a group), its buttons stay with it */}
            {cornerButtons}
          </Frame>
        </>
      )}
      {container && !still && selected && (
        <Frame node={node}>
          <MoveHandle node={node} />
        </Frame>
      )}
    </g>
  );
  if (container) return shape;
  // a11y: a box is a button, so its corner buttons are drawn beside it, over it, not inside it
  return (
    <>
      {shape}
      <g
        className="node-buttons"
        data-buttons-of={node.id}
        transform={`translate(${node.x} ${node.y})`}
      >
        {cornerButtons}
        {!still && selected && <MoveHandle node={node} />}
      </g>
    </>
  );
}

/** A separate handle leaves box clicks and canvas panning available to readers. */
function MoveHandle({ node }: { node: LayoutNode }) {
  const move = useContext(Move);
  const gesture = useRef<
    | {
        inverse: DOMMatrix;
        start: DOMPoint;
        position: Point;
        moved: boolean;
      }
    | undefined
  >(undefined);
  const cancel = useRef(move?.cancel);
  if (move) cancel.current = move.cancel;
  useEffect(
    () => () => {
      if (gesture.current) {
        gesture.current = undefined;
        cancel.current?.();
      }
    },
    [],
  );
  const blocked = !move || move.disabled;
  useEffect(() => {
    if (blocked && gesture.current) {
      gesture.current = undefined;
      cancel.current?.();
    }
  }, [blocked]);
  if (!move) return null;
  return (
    <g
      className="move-handle"
      role="button"
      tabIndex={0}
      aria-disabled={move.disabled}
      aria-label={`Move ${node.label}`}
      transform={`translate(6 ${node.height - 26})`}
      onClick={(event) => event.stopPropagation()}
      onDoubleClick={(event) => event.stopPropagation()}
      onPointerDown={(event) => {
        if (event.button !== 0 || move.disabled) return;
        event.preventDefault();
        event.stopPropagation();
        event.currentTarget.focus();
        const parent = event.currentTarget.closest(".node, .node-buttons")
          ?.parentElement as SVGGraphicsElement | null;
        const matrix = parent?.getScreenCTM();
        if (!matrix) return;
        const inverse = matrix.inverse();
        gesture.current = {
          inverse,
          start: new DOMPoint(event.clientX, event.clientY).matrixTransform(inverse),
          position: { x: node.x, y: node.y },
          moved: false,
        };
        event.currentTarget.setPointerCapture(event.pointerId);
        move.start();
      }}
      onPointerMove={(event) => {
        const drag = gesture.current;
        if (!drag) return;
        event.stopPropagation();
        const at = new DOMPoint(event.clientX, event.clientY).matrixTransform(drag.inverse);
        const dx = at.x - drag.start.x,
          dy = at.y - drag.start.y;
        if (!drag.moved && Math.hypot(dx, dy) < 3) return;
        drag.moved = true;
        move.preview(node, { x: drag.position.x + dx, y: drag.position.y + dy });
      }}
      onPointerUp={(event) => {
        const drag = gesture.current;
        if (!drag) return;
        event.stopPropagation();
        const at = new DOMPoint(event.clientX, event.clientY).matrixTransform(drag.inverse);
        gesture.current = undefined;
        move.finish(node, {
          x: drag.position.x + (drag.moved ? at.x - drag.start.x : 0),
          y: drag.position.y + (drag.moved ? at.y - drag.start.y : 0),
        });
      }}
      onPointerCancel={() => {
        gesture.current = undefined;
        move.finish(node);
      }}
      onLostPointerCapture={() => {
        if (gesture.current) {
          gesture.current = undefined;
          move.finish(node);
        }
      }}
      onKeyDown={(event) => {
        event.stopPropagation();
        if (move.disabled) return;
        const delta = {
          ArrowLeft: [-20, 0],
          ArrowRight: [20, 0],
          ArrowUp: [0, -20],
          ArrowDown: [0, 20],
        }[event.key];
        if (event.key === "Escape" && gesture.current) {
          gesture.current = undefined;
          move.finish(node);
        } else if (delta || event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          move.finish(node, { x: node.x + (delta?.[0] ?? 0), y: node.y + (delta?.[1] ?? 0) });
        }
      }}
    >
      <title>Drag to pin; arrow keys move by 20 pixels</title>
      <rect width={22} height={22} rx={5} />
      <path d="M11 3v16M3 11h16M8 6l3-3 3 3M8 16l3 3 3-3M6 8l-3 3 3 3M16 8l3 3-3 3" />
    </g>
  );
}

/** a11y: the keyboard focus ring of a box: outside it, with a gap, never like the selection outline. */
function FocusRing({ width, height, rx }: { width: number; height: number; rx: number }) {
  return (
    <rect
      className="focus-ring"
      x={-FOCUS_RING_GAP}
      y={-FOCUS_RING_GAP}
      width={width + 2 * FOCUS_RING_GAP}
      height={height + 2 * FOCUS_RING_GAP}
      rx={rx + FOCUS_RING_GAP}
    />
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

/** A small button in the corner of a box: zoom into what it opens, or show that inside it, here. */
function CornerButton({
  className,
  x,
  y,
  label,
  title,
  onPress,
  children,
}: {
  className: string;
  x: number;
  y: number;
  label: string;
  title: string;
  onPress: () => void;
  children: ReactNode;
}) {
  return (
    <g
      className={`corner-button ${className}`}
      role="button"
      tabIndex={0}
      aria-label={label}
      transform={`translate(${x} ${y})`}
      onClick={(event) => {
        event.stopPropagation();
        onPress();
      }}
      onDoubleClick={(event) => event.stopPropagation()}
      onKeyDown={(event) => activate(event, onPress)}
    >
      <title>{title}</title>
      <rect className="corner-button-face" width={ZOOM_SIZE} height={ZOOM_SIZE} rx={5} />
      {children}
    </g>
  );
}

/**
 * The centre of a container is where a click on "the container" lands (see BOUNDS_PAD). When a child
 * box or one of the container's own edges is drawn over it, a small hit target above them keeps that
 * click on the container.
 */
function centerIsCovered(node: LayoutNode): boolean {
  const c = { x: (node.frame?.x ?? 0) + node.width / 2, y: (node.frame?.y ?? 0) + node.height / 2 };
  const near = 8;
  if (
    node.children.some(
      (child) =>
        c.x >= nodeBox(child).x - near &&
        c.x <= nodeBox(child).x + child.width + near &&
        c.y >= nodeBox(child).y - near &&
        c.y <= nodeBox(child).y + child.height + near,
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
      {!still && <FocusRing width={node.width} height={node.height} rx={8} />}
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

/**
 * The keyboard's way to an edge of the top level (drawn by EdgeShape under the boxes): an invisible copy of its
 * route that takes the focus after the boxes, shows a ring when focused, and lets clicks through.
 */
function EdgeKey({ edge }: { edge: LayoutEdge }) {
  const store = useStore();
  const names = useContext(BoxNames);
  if (edge.points.length < 2) return null;
  const select = (event: KeyboardEvent) => store.click(edge.id, additive(event));
  return (
    <g
      className="edge-key"
      data-key-for={edge.id}
      role="button"
      tabIndex={0}
      aria-label={
        `${names.get(edge.from) ?? "?"} to ${names.get(edge.to) ?? "?"}: ${edge.title}` +
        (edge.stub ? " (outside this map)" : "")
      }
      onKeyDown={(event) => activate(event, () => select(event))}
    >
      <path d={roundedPath(edge.points)} />
    </g>
  );
}

/** The classes of an edge (and of its label): kind, trust, state, and quiet in a reader view. */
function edgeClasses(edge: LayoutEdge, marks: Marks, reader: boolean): string {
  const classes = ["edge", edge.stub ? "is-stub" : `res-${edge.resolution}`, `kind-${edge.kind}`];
  // A count label in a reader view: shown on hover and when the edge or an end of it is selected.
  if (
    reader &&
    edge.counted &&
    !marks.selected.has(edge.id) &&
    !marks.selected.has(edge.from) &&
    !marks.selected.has(edge.to)
  )
    classes.push("is-quiet");
  return classes.join(" ") + stateClasses(edge.id, marks);
}

const EdgeShape = memo(function EdgeShape({
  edge,
  marks,
  focusable = true,
}: {
  edge: LayoutEdge;
  marks: Marks;
  /** False when EdgeKey gives the keyboard its way to the edge (the top level). */
  focusable?: boolean;
}) {
  const store = useStore();
  const reader = useContext(Reader);
  const still = useContext(Still);
  const names = useContext(BoxNames);
  const points = edge.points;
  if (points.length < 2) return null;
  const path = roundedPath(points);
  const tip = points[points.length - 1]!;
  const before = points[points.length - 2]!;
  const hover = useContext(SetHovered);
  // A click on the edge lands on its anchor, a point of the route (see BOUNDS_PAD): the invisible
  // `bounds` rect is centred on it and reaches around the whole route.
  const { x: reachX, y: reachY } = edgeReach(edge);
  const select = (event: MouseEvent | KeyboardEvent) => store.click(edge.id, additive(event));
  return (
    <g
      className={edgeClasses(edge, marks, reader)}
      onPointerEnter={edge.label ? () => hover(edge.id) : undefined}
      onPointerLeave={edge.label ? () => hover(undefined) : undefined}
      data-element-id={still ? undefined : edge.id}
      data-stub-id={edge.stub && !still ? edge.id : undefined}
      role={still || !focusable ? undefined : "button"}
      tabIndex={still || !focusable ? undefined : 0}
      aria-hidden={!still && !focusable ? true : undefined}
      aria-label={
        still || !focusable
          ? undefined
          : `${names.get(edge.from) ?? "?"} to ${names.get(edge.to) ?? "?"}: ${edge.title}` +
            (edge.stub ? " (outside this map)" : "")
      }
      onClick={(event) => {
        event.stopPropagation();
        select(event);
      }}
      onKeyDown={(event) => activate(event, () => select(event))}
    >
      <title>
        {edge.stub
          ? `${edge.title} (leaves or enters the view here)`
          : edge.via
            ? `${edge.title}\nThrough ${edge.via.join(", then ")}, which this map does not draw as a box`
            : edge.title}
      </title>
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
    </g>
  );
});

/**
 * The labels of a level's edges, drawn after all of its lines: a line never runs over a label (not even the
 * selected edge's line). A label takes its edge's classes (colour, quiet, selected) and its click; a quiet
 * label shows while its edge is hovered (`Hovered`) or the label itself is.
 */
function EdgeLabels({ edges, marks }: { edges: readonly LayoutEdge[]; marks: Marks }) {
  if (!edges.some((edge) => edge.label)) return null;
  return (
    <g className="edge-labels">
      {edges.map((edge) =>
        edge.label ? <EdgeLabel key={edge.id} edge={edge} marks={marks} /> : null,
      )}
    </g>
  );
}

function EdgeLabel({ edge, marks }: { edge: LayoutEdge; marks: Marks }) {
  const store = useStore();
  const still = useContext(Still);
  const hovered = useContext(Hovered) === edge.id;
  const label = edge.label!;
  return (
    <g
      className={edgeClasses(edge, marks, useContext(Reader)) + (hovered ? " is-hover" : "")}
      aria-hidden="true"
      onClick={(event) => {
        event.stopPropagation();
        if (!still) store.click(edge.id, additive(event));
      }}
    >
      <g className="edge-label">
        <rect x={label.x} y={label.y} width={label.width} height={label.height} rx={4} />
        <text x={label.x + label.width / 2} y={label.y + label.height / 2 + 4}>
          {label.text}
        </text>
      </g>
    </g>
  );
}
