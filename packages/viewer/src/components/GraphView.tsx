/**
 * Graph view: `DerivedGraph` -> ELK layout (async) -> our own SVG inside a pan/zoom canvas.
 *
 * Every clickable piece is a `<g data-element-id="...">`: nodes and containers (containers nest their
 * children so a click on a child never also selects the container), derived and stored edges, stubs
 * (`data-stub-id` too) and ghost boxes (`ghost:<id>`). State classes: is-selected, is-match, is-related.
 * Click selects (shift adds), double-click drills into a node, a click on a ghost adds it to the view.
 */
import type { DerivedGraph } from "@xpl/core";
import { memo, useEffect, useMemo, useState, type KeyboardEvent, type MouseEvent } from "react";
import {
  badgeWidth,
  EDGE_BOUNDS_PAD,
  labelWidth,
  layoutGraph,
  type GraphLayout,
  type LayoutEdge,
  type LayoutNode,
} from "../layout/graphLayout.js";
import { arrowHeadPath, distanceToSegment, roundedPath, routeBox } from "../svg.js";
import { useStore } from "../hooks.js";
import { PanZoom } from "./PanZoom.js";

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
  graph: DerivedGraph;
  selection: readonly string[];
  matches: readonly string[];
  related: ReadonlySet<string>;
}

export function GraphView({ viewId, graph, selection, matches, related }: GraphViewProps) {
  const store = useStore();
  const [layout, setLayout] = useState<GraphLayout | undefined>();
  const [error, setError] = useState<string | undefined>();
  // Stable while nothing selected, matched or related changes, so unchanged shapes are not re-rendered.
  const marks = useMemo<Marks>(
    () => ({ selected: new Set(selection), matches: new Set(matches), related }),
    [selection, matches, related],
  );

  useEffect(() => {
    let cancelled = false;
    layoutGraph(graph).then(
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
  }, [graph]);

  if (error) return <div className="diagram-message is-error">Layout failed: {error}</div>;
  if (!layout) return <div className="diagram-message">Laying out the graph…</div>;
  if (layout.nodes.length === 0) {
    return (
      <div className="diagram-message">
        This view shows nothing yet. Add nodes to its <code>include</code> list.
      </div>
    );
  }

  return (
    <PanZoom
      width={layout.width}
      height={layout.height}
      resetKey={viewId}
      label="Diagram. Drag to pan, scroll to zoom."
      onBackgroundClick={() => store.clearSelection()}
    >
      <g className="graph" data-fallback={layout.fallback ? "true" : undefined}>
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
        store.drillIn(node.id);
      }}
      onKeyDown={(event) => activate(event, () => select(event))}
    >
      <title>
        {store.canDrillIn(node.id)
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
  const expand = () => {
    if (node.ghostTarget !== undefined) store.expandStub({ ghost: node.ghostTarget });
  };
  return (
    <g
      className={`node ghost${stateClasses(node.id, marks)}`}
      data-element-id={node.id}
      transform={`translate(${node.x} ${node.y})`}
      role="button"
      tabIndex={0}
      aria-label={`Add ${node.label} to the view`}
      onClick={(event) => {
        event.stopPropagation();
        expand();
      }}
      onKeyDown={(event) => activate(event, expand)}
    >
      <title>
        {node.hint
          ? `Add ${node.label} to the view (${node.hint} reach it across the edge of this view)`
          : `Add ${node.label} to the view`}
      </title>
      <rect className="box" width={node.width} height={node.height} rx={8} />
      <path className="plus" d="M13 15h8M17 11v8" />
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
