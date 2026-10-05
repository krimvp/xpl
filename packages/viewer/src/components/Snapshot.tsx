/**
 * The Guide's inline diagram: a still picture of a step's view, framed on the step's focus, with a button
 * that opens the live diagram (Map or Flow). It is drawn with the same shapes as the live diagram (graph
 * boxes, flow stages, sequence arrows) but takes no clicks and holds no element ids: the reader looks at
 * it while reading, and opens the real diagram to explore.
 *
 * Laying out a graph or a flow is asynchronous and not free, so a picture is only laid out once its
 * section is near the screen (an IntersectionObserver), and a layout is kept per view for the page's life.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import {
  deriveGraph,
  repr,
  type ElementId,
  type GraphView,
  type SequenceView,
  type View,
} from "@xpl/core";
import { useViewerState } from "../hooks.js";
import {
  cutAt,
  graphBounds,
  frameFocus,
  layoutGraphFitting,
  type ChangeMarks,
  type GraphLayout,
} from "../layout/graphLayout.js";
import { layoutSequence } from "../layout/sequenceLayout.js";
import { SNAPSHOT_WHOLE, type Box } from "../viewport.js";
import { FlowDiagram } from "./FlowDiagram.js";
import { GraphPicture, useGraphChanges } from "./GraphView.js";
import { SequencePicture } from "./SequenceView.js";
import { SNAPSHOT_HEIGHT, SNAPSHOT_TALL_HEIGHT, SnapshotFrame } from "./SnapshotFrame.js";

/** Graph layouts by view, for the page's life: a guide shows the same view in many sections. */
const graphLayouts = new WeakMap<View, Promise<GraphLayout>>();

/**
 * The layout of a picture `width` px wide: laid out to the right or downwards, whichever shows larger in a
 * picture of that width and the tallest height a picture may take (a tall map in a wide column reads better
 * turned). Kept for the view, laid out for the first width asked.
 */
function graphLayoutOf(
  view: GraphView,
  graph: ReturnType<typeof deriveGraph>,
  changes: ChangeMarks | undefined,
  width: number,
) {
  let known = graphLayouts.get(view);
  if (!known) {
    known = layoutGraphFitting(
      graph,
      width > 0 ? { width, height: SNAPSHOT_TALL_HEIGHT } : undefined,
      // the picture is whole at this zoom or more: a direction that reaches it is as good as any
      SNAPSHOT_WHOLE,
      10,
      changes,
      view.layout,
    );
    graphLayouts.set(view, known);
  }
  return known;
}

export function Snapshot({
  view,
  focus,
  onOpen,
  context,
}: {
  view: View;
  focus: readonly ElementId[];
  onOpen: () => void;
  /** a11y: what the picture belongs to ("step 3: …"): the open button's name says it, as every step has one. */
  context?: string;
}) {
  const host = useRef<HTMLDivElement>(null);
  const [near, setNear] = useState(false);
  const [width, setWidth] = useState(0);

  // Laid out only once the section comes near the screen.
  useEffect(() => {
    const el = host.current;
    if (!el || near) return;
    if (typeof IntersectionObserver === "undefined") {
      setNear(true);
      return;
    }
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          setWidth(el.clientWidth);
          setNear(true);
        }
      },
      { rootMargin: "400px 0px" },
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, [near]);

  const graph = view.type === "graph";
  const open = graph ? "Open in Map" : "Open in Flow";
  return (
    <figure
      ref={host}
      className="guide-snapshot"
      data-testid="guide-snapshot"
      data-view-id={view.id}
      aria-label={`Diagram: ${view.title}`}
      // A still picture: a double-click opens the live diagram, where boxes open and code shows.
      onDoubleClick={onOpen}
      title={`Double-click to open in the ${graph ? "Map" : "Flow"}`}
    >
      <figcaption>
        <span className="guide-snapshot-title">{view.title}</span>
        <button
          type="button"
          className="btn"
          data-testid="snapshot-open"
          aria-label={context ? `${open}, ${context}` : undefined}
          onClick={onOpen}
        >
          {open}
        </button>
      </figcaption>
      {near ? (
        view.type === "graph" ? (
          <GraphSnapshot view={view} focus={focus} width={width} />
        ) : view.type === "flow" ? (
          <FlowDiagram view={view} snapshot={{ selection: focus }} />
        ) : view.type === "sequence" ? (
          <SequenceSnapshot view={view} focus={focus} />
        ) : null
      ) : (
        <div className="snapshot-placeholder" style={{ height: SNAPSHOT_HEIGHT }} />
      )}
    </figure>
  );
}

function GraphSnapshot({
  view,
  focus,
  width,
}: {
  view: GraphView;
  focus: readonly ElementId[];
  width: number;
}) {
  const state = useViewerState();
  const graph = useMemo(() => deriveGraph(view, state.model), [view, state.model]);
  const changes = useGraphChanges(graph);
  const [layout, setLayout] = useState<GraphLayout>();
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let cancelled = false;
    graphLayoutOf(view, graph, changes, width).then(
      (result) => !cancelled && setLayout(result),
      () => !cancelled && setFailed(true),
    );
    return () => {
      cancelled = true;
    };
  }, [view, graph, changes, width]);
  // What the step is about, as this view draws it: the focused boxes, or the boxes that stand for them.
  const marked = useMemo(() => {
    const include = new Set(
      (Array.isArray(view.include) ? view.include : []).filter((id) => typeof id === "string"),
    );
    const related = new Set<ElementId>();
    for (const id of focus) {
      const ends = state.model.element(id);
      const ids =
        ends?.type === "edge"
          ? [ends.edge.from, ends.edge.to]
          : ends?.type === "derived-edge"
            ? [ends.from, ends.to]
            : ends?.type === "concept"
              ? (ends.concept.related ?? [])
              : [id];
      for (const one of ids) {
        const shown = repr(one, include, state.model);
        if (shown && shown !== id) related.add(shown);
      }
    }
    return related;
  }, [view, focus, state.model]);
  if (failed) return <p className="snapshot-message">This diagram could not be drawn.</p>;
  if (!layout) return <div className="snapshot-placeholder" style={{ height: SNAPSHOT_HEIGHT }} />;
  const bounds = graphBounds(layout);
  const focused = frameFocus(layout, [...focus, ...marked]);
  const shift = (b: Box) => ({ ...b, x: b.x - bounds.x, y: b.y - bounds.y });
  return (
    <SnapshotFrame
      width={bounds.width}
      height={bounds.height}
      focus={
        focused && {
          ...focused,
          boxes: focused.boxes.map(shift),
          neighbours: focused.neighbours?.map(shift),
          others: focused.others?.map(shift),
        }
      }
      where="Map"
    >
      {(window) => (
        <g transform={`translate(${-bounds.x} ${-bounds.y})`}>
          <GraphPicture
            layout={layout}
            selection={focus}
            related={marked}
            cut={cutAt(layout, { ...window, x: window.x + bounds.x, y: window.y + bounds.y })}
          />
        </g>
      )}
    </SnapshotFrame>
  );
}

function SequenceSnapshot({ view, focus }: { view: SequenceView; focus: readonly ElementId[] }) {
  const state = useViewerState();
  const layout = useMemo(() => layoutSequence(view, state.model), [view, state.model]);
  const selected = new Set(focus);
  const boxes: Box[] = [];
  const heads: Box[] = [];
  // The names at the top of the lifelines a step joins come with it when there is room: an arrow means
  // little without its ends.
  const ends = new Set<string>();
  for (const row of layout.rows) {
    if (selected.has(row.step.id)) {
      boxes.push({
        x: row.bandLeft,
        y: row.bandTop,
        width: row.bandRight - row.bandLeft,
        height: row.bandBottom - row.bandTop,
      });
      ends.add(row.step.from);
      ends.add(row.step.to);
    }
  }
  for (const lifeline of layout.lifelines) {
    const head = {
      x: lifeline.x - lifeline.headWidth / 2,
      y: lifeline.headTop,
      width: lifeline.headWidth,
      height: lifeline.headHeight,
    };
    if (selected.has(lifeline.id)) boxes.push(head);
    else if (ends.has(lifeline.id)) heads.push(head);
  }
  return (
    <SnapshotFrame
      width={layout.width}
      height={layout.height}
      focus={boxes.length > 0 ? { boxes, neighbours: heads } : undefined}
      where="Flow"
    >
      <SequencePicture layout={layout} selection={focus} />
    </SnapshotFrame>
  );
}
