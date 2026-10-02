import { useEffect, useId, useMemo, useState } from "react";
import type { ElkNode } from "elkjs/lib/elk.bundled.js";
import {
  buildReverseIndex,
  processFlow,
  viewCandidates,
  type ElementId,
  type ProcessFlow,
  type SequenceView,
} from "@xpl/core";
import { useStore, useViewerState } from "../hooks.js";
import {
  EDGE_LABEL_LINE,
  EDGE_LABEL_CHARS,
  layoutFlow,
  placedStages,
  STAGE_LABEL_CHARS,
  stageActor,
  wrapWords,
} from "../layout/flowLayout.js";
import { topicElements, topicMatches } from "../workspace.js";
import { SnapshotFrame } from "./SnapshotFrame.js";
import {
  FLOW_READABLE_ZOOM,
  PanZoom,
  PRESENT_FIT_PADDING,
  PRESENT_FLOW_MAX_ZOOM,
  PRESENT_MAX_FIT_ZOOM,
} from "./PanZoom.js";

export interface FlowDiagramProps {
  view: SequenceView;
  /**
   * A still picture (the Guide's inline diagram): no pan, zoom or clicks, the selection drawn as given, and
   * the picture framed on it. Default: the live diagram of the current mode.
   */
  snapshot?: { selection: readonly ElementId[] };
}

export function FlowDiagram({ view, snapshot }: FlowDiagramProps) {
  const store = useStore();
  const state = useViewerState();
  const flow = useMemo(() => processFlow(view), [view]);
  // The layout remembers the flow it belongs to: after a switch to another view, the old layout is not
  // drawn with the new flow (that used to crash) while the new one is computed.
  const [laidOut, setLaidOut] = useState<{ flow: ProcessFlow; layout: ElkNode }>();
  const layout = laidOut?.flow === flow ? laidOut.layout : undefined;
  const [error, setError] = useState<string>();
  const arrow = useId().replace(/:/g, "");
  const present = state.mode === "present" && !snapshot;
  const topics = topicElements(snapshot?.selection ?? state.selection, state.model);
  const matches = useMemo(
    () =>
      state.cursor && !snapshot
        ? new Set(
            buildReverseIndex(viewCandidates(view, state.model), state.model).lookup(
              state.cursor.file,
              state.cursor.fromLine,
            ),
          )
        : new Set<string>(),
    [view, state.model, state.cursor, snapshot],
  );
  useEffect(() => {
    let cancelled = false;
    setError(undefined);
    layoutFlow(flow).then(
      (result) => {
        if (!cancelled) setLaidOut({ flow, layout: result });
      },
      (reason: unknown) => {
        if (!cancelled) setError(reason instanceof Error ? reason.message : String(reason));
      },
    );
    return () => {
      cancelled = true;
    };
  }, [flow]);
  if (error)
    return (
      <div className="diagram-message" role="alert">
        Could not lay out the process: {error}
      </div>
    );
  if (!layout) return <div className="diagram-message">Laying out the process…</div>;
  if (flow.stages.length === 0)
    return <div className="diagram-message">This process has no stages yet.</div>;
  const placed = placedStages(flow, layout);
  const focal = (
    placed.find(({ node }) => topics.has(node.id)) ??
    placed.find(
      ({ stage: { step } }) =>
        topicMatches(step.from, topics, state.model) || topicMatches(step.to, topics, state.model),
    )
  )?.node;
  const startBox = focal
    ? { x: focal.x ?? 0, y: focal.y ?? 0, width: focal.width ?? 250, height: focal.height ?? 100 }
    : undefined;
  const select = (id: string, additive: boolean) => {
    if (!snapshot) store.click(id, additive);
  };
  const content = (
    <>
      <defs>
        <marker
          id={arrow}
          viewBox="0 0 10 10"
          refX="9"
          refY="5"
          markerWidth="7"
          markerHeight="7"
          orient="auto-start-reverse"
        >
          <path d="M 0 0 L 10 5 L 0 10 z" fill="var(--edge)" />
        </marker>
      </defs>
      {(layout.edges ?? []).map((edge) => (
        <g key={edge.id} className={`flow-transition${flow.projected ? " is-projected" : ""}`}>
          {(edge.sections ?? []).map((section, i) => (
            <polyline
              key={i}
              points={[section.startPoint, ...(section.bendPoints ?? []), section.endPoint]
                .map((point) => `${point.x},${point.y}`)
                .join(" ")}
              fill="none"
              stroke="var(--edge)"
              strokeWidth="2"
              markerEnd={`url(#${arrow})`}
            />
          ))}
          {(edge.labels ?? []).map((label, i) => {
            const lines = wrapWords(label.text ?? "", EDGE_LABEL_CHARS);
            const x = (label.x ?? 0) + (label.width ?? 0) / 2;
            return (
              <g key={i}>
                <rect
                  x={label.x ?? 0}
                  y={label.y ?? 0}
                  width={label.width ?? 0}
                  height={label.height ?? 24}
                  rx="5"
                  fill="var(--panel)"
                />
                <text x={x} y={(label.y ?? 0) + 17} textAnchor="middle">
                  {lines.map((line, n) => (
                    <tspan key={n} x={x} dy={n === 0 ? 0 : EDGE_LABEL_LINE}>
                      {line}
                    </tspan>
                  ))}
                </text>
              </g>
            );
          })}
        </g>
      ))}
      {placed.map(({ node, stage }) => {
        const { step, shape, frames } = stage;
        const width = node.width ?? 250,
          height = node.height ?? 100;
        const active = topics.has(step.id),
          related =
            topicMatches(step.from, topics, state.model) ||
            topicMatches(step.to, topics, state.model);
        const label = wrapWords(step.label, STAGE_LABEL_CHARS, 3);
        return (
          <g
            key={node.id}
            transform={`translate(${node.x ?? 0},${node.y ?? 0})`}
            className={`flow-stage${active ? " is-selected" : related ? " is-related" : ""}${matches.has(step.id) ? " is-matched" : ""}`}
            data-element-id={snapshot ? undefined : step.id}
            data-stage-id={step.id}
            role={snapshot ? undefined : "button"}
            tabIndex={snapshot ? undefined : 0}
            aria-label={snapshot ? undefined : step.label}
            onClick={(event) => {
              event.stopPropagation();
              select(step.id, event.shiftKey);
            }}
            onKeyDown={(event) => {
              if (event.key === "Enter" || event.key === " ") {
                event.preventDefault();
                select(step.id, event.shiftKey);
              }
            }}
          >
            <title>{[step.label, step.summary, ...frames].filter(Boolean).join("\n")}</title>
            {shape === "decision" ? (
              <polygon
                points={`${width / 2},0 ${width},${height / 2} ${width / 2},${height} 0,${height / 2}`}
              />
            ) : (
              <rect width={width} height={height} rx={shape === "terminal" ? 44 : 12} />
            )}
            <text
              className="flow-stage-label"
              x={width / 2}
              y={height / 2 - (label.length - 1) * 10 - (shape === "decision" ? 8 : 4)}
              textAnchor="middle"
            >
              {label.map((line, i) => (
                <tspan x={width / 2} dy={i === 0 ? 0 : 20} key={i}>
                  {line}
                </tspan>
              ))}
            </text>
            {/* In a diamond the actor sits just under the label, where the shape is still wide. */}
            <text
              className="flow-owner"
              x={width / 2}
              y={shape === "decision" ? height / 2 + 12 + label.length * 10 : height - 13}
              textAnchor="middle"
            >
              {stageActor(step, state.model, shape === "decision" ? 26 : 34, shape)}
            </text>
            {frames.length > 0 && (
              <text className="flow-frame" x={width / 2} y="-10" textAnchor="middle">
                {frames.join(" · ").slice(0, 60)}
              </text>
            )}
          </g>
        );
      })}
    </>
  );
  if (snapshot)
    return (
      <SnapshotFrame width={layout.width ?? 400} height={layout.height ?? 300} focus={startBox}>
        {content}
      </SnapshotFrame>
    );
  return (
    <div className="flow-diagram" data-testid="process-flow">
      {flow.projected && (
        <p className="flow-projection" role="note">
          Read from top to bottom. Each box is one call. The arrows show the order, not every
          possible path. A label above a box says when it runs.
        </p>
      )}
      <PanZoom
        width={layout.width ?? 400}
        height={layout.height ?? 300}
        resetKey={`${view.id}:${state.stepSeq}`}
        startBox={startBox}
        label="Process flow"
        maxFitZoom={present ? PRESENT_MAX_FIT_ZOOM : undefined}
        fitPadding={present ? PRESENT_FIT_PADDING : undefined}
        // Present: the flow starts at the zoom that shows its whole width (text 11 to 16px), on its focus.
        readableZoom={present ? PRESENT_FLOW_MAX_ZOOM : FLOW_READABLE_ZOOM}
        readableMin={present ? FLOW_READABLE_ZOOM : undefined}
        fitFloor={FLOW_READABLE_ZOOM}
        onBackgroundClick={() => store.clearSelection()}
      >
        {content}
      </PanZoom>
    </div>
  );
}
