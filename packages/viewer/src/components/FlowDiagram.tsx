import { useEffect, useId, useMemo, useState } from "react";
import type { ElkNode } from "elkjs/lib/elk.bundled.js";
import {
  buildReverseIndex,
  processFlow,
  viewCandidates,
  type ProcessFlow,
  type SequenceView,
} from "@xpl/core";
import { useStore, useViewerState } from "../hooks.js";
import { layoutFlow, placedStages } from "../layout/flowLayout.js";
import { topicElements, topicMatches } from "../workspace.js";
import {
  FLOW_READABLE_ZOOM,
  PanZoom,
  PRESENT_FIT_PADDING,
  PRESENT_MAX_FIT_ZOOM,
  PRESENT_READABLE_ZOOM,
} from "./PanZoom.js";

function wrap(text: string, width = 32): string[] {
  const lines: string[] = [];
  for (const word of text.split(/\s+/)) {
    const last = lines[lines.length - 1];
    if (last && last.length + word.length < width) lines[lines.length - 1] += ` ${word}`;
    else lines.push(word);
  }
  return lines
    .slice(0, 3)
    .map((line, index) => (index === 2 && lines.length > 3 ? `${line}…` : line));
}

export function FlowDiagram({ view }: { view: SequenceView }) {
  const store = useStore();
  const state = useViewerState();
  const flow = useMemo(() => processFlow(view), [view]);
  // The layout remembers the flow it belongs to: after a switch to another view, the old layout is not
  // drawn with the new flow (that used to crash) while the new one is computed.
  const [laidOut, setLaidOut] = useState<{ flow: ProcessFlow; layout: ElkNode }>();
  const layout = laidOut?.flow === flow ? laidOut.layout : undefined;
  const [error, setError] = useState<string>();
  const arrow = useId().replace(/:/g, "");
  const present = state.mode === "present";
  const topics = topicElements(state.selection, state.model);
  const matches = useMemo(
    () =>
      state.cursor
        ? new Set(
            buildReverseIndex(viewCandidates(view, state.model), state.model).lookup(
              state.cursor.file,
              state.cursor.fromLine,
            ),
          )
        : new Set<string>(),
    [view, state.model, state.cursor],
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
        startBox={
          focal
            ? {
                x: focal.x ?? 0,
                y: focal.y ?? 0,
                width: focal.width ?? 290,
                height: focal.height ?? 108,
              }
            : undefined
        }
        label="Process flow"
        maxFitZoom={present ? PRESENT_MAX_FIT_ZOOM : undefined}
        fitPadding={present ? PRESENT_FIT_PADDING : undefined}
        readableZoom={present ? PRESENT_READABLE_ZOOM : FLOW_READABLE_ZOOM}
        fitFloor={FLOW_READABLE_ZOOM}
        onBackgroundClick={() => store.clearSelection()}
      >
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
            {(edge.labels ?? []).map((label, i) => (
              <g key={i}>
                <rect
                  x={label.x ?? 0}
                  y={label.y ?? 0}
                  width={label.width ?? 0}
                  height={label.height ?? 24}
                  rx="5"
                  fill="var(--panel)"
                />
                <text
                  x={(label.x ?? 0) + (label.width ?? 0) / 2}
                  y={(label.y ?? 0) + 17}
                  textAnchor="middle"
                >
                  {label.text}
                </text>
              </g>
            ))}
          </g>
        ))}
        {placed.map(({ node, stage }) => {
          const { step, shape, frames } = stage;
          const width = node.width ?? 290,
            height = node.height ?? 108;
          const active = topics.has(step.id),
            related =
              topicMatches(step.from, topics, state.model) ||
              topicMatches(step.to, topics, state.model);
          const label = wrap(step.label);
          return (
            <g
              key={node.id}
              transform={`translate(${node.x ?? 0},${node.y ?? 0})`}
              className={`flow-stage${active ? " is-selected" : related ? " is-related" : ""}${matches.has(step.id) ? " is-matched" : ""}`}
              data-element-id={step.id}
              role="button"
              tabIndex={0}
              aria-label={step.label}
              onClick={(event) => {
                event.stopPropagation();
                store.click(step.id, event.shiftKey);
              }}
              onKeyDown={(event) => {
                if (event.key === "Enter" || event.key === " ") {
                  event.preventDefault();
                  store.click(step.id, event.shiftKey);
                }
              }}
            >
              <title>{[step.label, step.summary, ...frames].filter(Boolean).join("\n")}</title>
              {shape === "decision" ? (
                <polygon
                  points={`${width / 2},0 ${width},${height / 2} ${width / 2},${height} 0,${height / 2}`}
                />
              ) : (
                <rect width={width} height={height} rx={shape === "terminal" ? 48 : 12} />
              )}
              <text
                className="flow-stage-label"
                x={width / 2}
                y={height / 2 - (label.length - 1) * 10}
                textAnchor="middle"
              >
                {label.map((line, i) => (
                  <tspan x={width / 2} dy={i === 0 ? 0 : 20} key={i}>
                    {line}
                  </tspan>
                ))}
              </text>
              <text
                className="flow-owner"
                x={width / 2}
                y={height - (shape === "decision" ? 28 : 14)}
                textAnchor="middle"
              >
                {state.model.label(step.to).slice(0, 38)}
              </text>
              {frames.length > 0 && (
                <text className="flow-frame" x={width / 2} y="-10" textAnchor="middle">
                  {frames.join(" · ").slice(0, 70)}
                </text>
              )}
            </g>
          );
        })}
      </PanZoom>
    </div>
  );
}
