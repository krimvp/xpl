import { DiagramText } from "./DiagramText.js";
import { useEffect, useId, useMemo, useState } from "react";
import { processFlow, type ElementId, type ProcessFlow, type SequenceView } from "@xpl/core";
import { viewReverseIndex } from "../derive.js";
import { useStore, useViewerState } from "../hooks.js";
import {
  EDGE_LABEL_LINE,
  EDGE_LABEL_CHARS,
  layoutFlow,
  levelTitle,
  type FlowLayout,
  placedStages,
  sharedActor,
  LEVEL_WORDS,
  STAGE_LABEL_CHARS,
  stageActor,
  wrapWords,
} from "../layout/flowLayout.js";
import { flowRelated, stepLinks, topicElements, topicMatches } from "../workspace.js";
import { FlowKey } from "./Legend.js";
import type { Focus } from "../viewport.js";
import { SnapshotFrame } from "./SnapshotFrame.js";
import {
  FLOW_READABLE_ZOOM,
  PanZoom,
  PRESENT_FIT_PADDING,
  PRESENT_FLOW_FOCUS_ZOOM,
  PRESENT_FLOW_MAX_ZOOM,
  PRESENT_MAX_FIT_ZOOM,
} from "./PanZoom.js";

/** How far the outline keeps the step it follows from the pane's edge, px: near the middle, with its neighbours. */
const OUTLINE_MARGIN = 140;

export interface FlowDiagramProps {
  view: SequenceView;
  /**
   * A still picture (the Guide's inline diagram): no pan, zoom or clicks, the selection drawn as given, and
   * the picture framed on it. Default: the live diagram of the current mode.
   */
  snapshot?: { selection: readonly ElementId[] };
  /**
   * The narrow outline beside the code of a code-first view (`codeFirstView`): it follows the caret, panning to
   * the step whose code it is in (else to the selection).
   */
  outline?: boolean;
}

export function FlowDiagram({ view, snapshot, outline = false }: FlowDiagramProps) {
  const store = useStore();
  const state = useViewerState();
  const flow = useMemo(() => processFlow(view), [view]);
  // The layout remembers the flow it belongs to: after a switch to another view, the old layout is not
  // drawn with the new flow (that used to crash) while the new one is computed.
  const [laidOut, setLaidOut] = useState<{ flow: ProcessFlow; layout: FlowLayout }>();
  const layout = laidOut?.flow === flow ? laidOut.layout : undefined;
  const [error, setError] = useState<string>();
  const arrow = useId().replace(/:/g, "");
  const present = state.mode === "present" && !snapshot;
  const topics = topicElements(snapshot?.selection ?? state.selection, state.model);
  // The index once per flow; a caret move only looks a line up in it.
  const reverse = useMemo(
    () => (snapshot ? undefined : viewReverseIndex(view, state.model)),
    [view, state.model, snapshot],
  );
  const matches = useMemo(
    () =>
      new Set<string>(
        state.cursor && reverse ? reverse.lookup(state.cursor.file, state.cursor.fromLine) : [],
      ),
    [reverse, state.cursor],
  );
  // An outline follows what moved last: the caret in the code, or the selection (a click on a step).
  const [followCaret, setFollowCaret] = useState(false);
  useEffect(() => {
    if (state.cursor) setFollowCaret(true);
  }, [state.cursor]);
  useEffect(() => {
    setFollowCaret(false);
  }, [state.selection]);
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
  // The steps of one function: its name is said once over the flow (the caption), not under every box.
  // A still picture and Present have no caption with it, so their boxes keep it.
  const owner = snapshot || present ? undefined : sharedActor(flow);
  const relatedStages = flowRelated(
    flow,
    snapshot?.selection ?? state.selection,
    topics,
    state.model,
  );
  // What the step is about: the selected stages, else the stages that involve the selection (a concept,
  // a part of the code), framed with the stages next to them (viewport.ts frameView).
  const boxOf = (node: FlowLayout["children"][number]) => ({
    x: node.x ?? 0,
    y: node.y ?? 0,
    width: node.width ?? 250,
    height: node.height ?? 100,
  });
  // (a repeated end is framed by its first box: its copies are only drawn)
  const originals = placed.filter(({ node }) => !node.copyOf);
  const selectedStages = originals.filter(({ node }) => topics.has(node.id));
  const focused = (
    selectedStages.length > 0
      ? selectedStages
      : originals.filter(
          ({ stage: { step } }) =>
            topicMatches(step.from, topics, state.model) ||
            topicMatches(step.to, topics, state.model),
        )
  ).map(({ node }) => node.id);
  const focusIds = new Set(focused);
  const nextTo = new Set<string>();
  for (const edge of layout.edges ?? []) {
    if (edge.to === undefined) continue;
    if (focusIds.has(edge.from) && !focusIds.has(edge.to)) nextTo.add(edge.to);
    if (focusIds.has(edge.to) && !focusIds.has(edge.from)) nextTo.add(edge.from);
  }
  const nodes = new Map(placed.map(({ node }) => [node.id, node] as const));
  const stageLabels = new Map(flow.stages.map(({ step }) => [step.id, step.label] as const));
  const focus: Focus | undefined =
    focused.length > 0
      ? {
          boxes: focused.map((id) => boxOf(nodes.get(id)!)),
          neighbours: [...nextTo].flatMap((id) => {
            const node = nodes.get(id);
            return node ? [boxOf(node)] : [];
          }),
        }
      : undefined;
  // An outline follows the caret: the step whose code the caret is in, kept in view as the caret moves.
  const caretStage =
    outline && followCaret ? originals.find(({ node }) => matches.has(node.id)) : undefined;
  const followed = caretStage ? boxOf(caretStage.node) : undefined;
  const transitionClass = (edge: FlowLayout["edges"][number]) =>
    `flow-transition${state.selection.includes(edge.id) ? " is-selected" : ""}${flow.projected ? " is-projected" : ""}${edge.kind ? ` is-${edge.kind}` : ""}`;
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
        <marker
          id={`${arrow}-level`}
          viewBox="0 0 10 10"
          refX="9"
          refY="5"
          markerWidth="7"
          markerHeight="7"
          orient="auto-start-reverse"
        >
          <path d="M 0 0 L 10 5 L 0 10 z" fill="var(--purple)" />
        </marker>
      </defs>
      {(layout.edges ?? []).map((edge) => (
        <g
          key={edge.id}
          className={transitionClass(edge)}
          data-transition-kind={edge.kind}
          data-element-id={snapshot ? undefined : edge.id}
          role={snapshot ? undefined : "button"}
          tabIndex={snapshot ? undefined : 0}
          aria-label={`${stageLabels.get(edge.from)} to ${edge.to ? stageLabels.get(edge.to) : "caller"}${edge.labels.length ? `: ${edge.labels.map((label) => label.text).join(" ")}` : ""}`}
          onClick={(event) => {
            event.stopPropagation();
            select(edge.id, event.shiftKey);
          }}
          onKeyDown={(event) => {
            if (event.key === "Enter" || event.key === " ") {
              event.preventDefault();
              select(edge.id, event.shiftKey);
            }
          }}
        >
          {edge.kind && (
            <title>
              {levelTitle(
                edge.kind,
                edge.to === undefined
                  ? undefined
                  : (stageLabels.get(nodes.get(edge.to)?.copyOf ?? edge.to) ?? ""),
              )}
            </title>
          )}
          {(edge.sections ?? []).map((section, i) => (
            <polyline
              key={i}
              points={[section.startPoint, ...(section.bendPoints ?? []), section.endPoint]
                .map((point) => `${point.x},${point.y}`)
                .join(" ")}
              fill="none"
              stroke={edge.kind ? "var(--purple)" : "var(--edge)"}
              strokeWidth="2"
              markerEnd={`url(#${edge.kind ? `${arrow}-level` : arrow})`}
            />
          ))}
        </g>
      ))}
      {/* The labels after all the lines: no line runs over a label. */}
      {(layout.edges ?? []).map((edge) =>
        (edge.labels ?? []).length === 0 ? null : (
          <g key={`${edge.id}:label`} className={transitionClass(edge)} aria-hidden="true">
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
        ),
      )}
      {placed.map(({ node, stage }, index) => {
        const { step, shape, frames } = stage;
        // A loop or a branch is named once, over the first box it covers, not again over every box in it.
        const frameText = frames.join(" · ");
        const newFrame =
          frames.length > 0 && placed[index - 1]?.stage.frames.join(" · ") !== frameText;
        const width = node.width ?? 250,
          height = node.height ?? 100;
        const active = topics.has(step.id),
          related = relatedStages.has(step.id);
        const label = wrapWords(step.label, STAGE_LABEL_CHARS, 3);
        const actor = stageActor(step, state.model, shape === "decision" ? 26 : 34, shape, owner);
        return (
          <g
            key={node.id}
            transform={`translate(${node.x ?? 0},${node.y ?? 0})`}
            className={`flow-stage${active ? " is-selected" : related ? " is-related" : ""}${matches.has(step.id) ? " is-matched" : ""}`}
            data-element-id={snapshot || node.copyOf ? undefined : step.id}
            data-copy-of={node.copyOf}
            data-stage-id={step.id}
            role={snapshot ? undefined : "button"}
            tabIndex={snapshot ? undefined : node.copyOf ? -1 : 0}
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
              // without an actor line under it, the label sits in the middle of the box
              y={
                height / 2 - (label.length - 1) * 10 - (!actor ? -5 : shape === "decision" ? 8 : 4)
              }
              textAnchor="middle"
            >
              {label.map((line, i) => (
                <tspan x={width / 2} dy={i === 0 ? 0 : 20} key={i}>
                  {line}
                </tspan>
              ))}
            </text>
            {/* In a diamond the actor sits just under the label, where the shape is still wide. */}
            {actor && (
              <text
                className="flow-owner"
                x={width / 2}
                y={shape === "decision" ? height / 2 + 12 + label.length * 10 : height - 13}
                textAnchor="middle"
              >
                {actor}
              </text>
            )}
            {newFrame && (
              // Above the arrowhead (it ends at the box), on a halo: the dashed line runs behind it.
              <text className="flow-frame" x={width / 2} y="-18" textAnchor="middle">
                {frameText.slice(0, 60)}
              </text>
            )}
          </g>
        );
      })}
    </>
  );
  if (snapshot)
    return (
      <SnapshotFrame
        width={layout.width ?? 400}
        height={layout.height ?? 300}
        focus={focus}
        where="Flow"
      >
        {content}
      </SnapshotFrame>
    );
  return (
    <div className={`flow-diagram${outline ? " is-outline" : ""}`} data-testid="process-flow">
      {flow.projected && (
        <p className="flow-projection" role="note">
          Read from top to bottom. Each box is one call. The arrows show the order, not every
          possible path. A purple label above a box says when it, and the boxes after it, run.
        </p>
      )}
      <PanZoom
        textView={<DiagramText flow={flow} />}
        width={layout.width ?? 400}
        height={layout.height ?? 300}
        resetKey={`${view.id}:${state.stepSeq}`}
        focus={focus}
        keepInView={followed ?? focus?.boxes[0]}
        revealMargin={outline ? OUTLINE_MARGIN : undefined}
        label="Process flow"
        maxFitZoom={present ? PRESENT_MAX_FIT_ZOOM : undefined}
        fitPadding={present ? PRESENT_FIT_PADDING : undefined}
        // Present: a flow is read from the back of the room: it starts fitted only when its text comes out
        // at 16px or more, else at that size on its focus and the stages next to it ("Fit all" shows the
        // rest). All of the focus is in view: smaller (down to 10px) when it does not fit at 16px.
        readableZoom={present ? PRESENT_FLOW_MAX_ZOOM : FLOW_READABLE_ZOOM}
        readableMin={present ? PRESENT_FLOW_MAX_ZOOM : undefined}
        focusMin={present ? PRESENT_FLOW_FOCUS_ZOOM : undefined}
        onBackgroundClick={() => store.clearSelection()}
        tools={
          <FlowKey
            shows={{
              decision: placed.some(({ stage }) => stage.shape === "decision"),
              terminal: placed.some(({ stage }) => stage.shape === "terminal"),
              frames: placed.some(({ stage }) => stage.frames.length > 0),
              projected: Boolean(flow.projected),
              recurse: flow.transitions.some((edge) => edge.kind === "recurse"),
              returns: flow.transitions.some((edge) => edge.kind === "return"),
            }}
          />
        }
      >
        {content}
      </PanZoom>
      {outline && (
        <StepNeighbours
          flow={flow}
          stepId={caretStage?.node.id ?? selectedStages[0]?.node.id}
          onPick={(id) => select(id, false)}
        />
      )}
    </div>
  );
}

/**
 * Under a narrow outline: the step being read (picked, or holding the caret) and the steps one arrow away, in
 * words that stay readable at any zoom, recurse and return links included (on the canvas they often run off
 * the side). Each one picks that step.
 */
function StepNeighbours({
  flow,
  stepId,
  onPick,
}: {
  flow: ProcessFlow;
  stepId: string | undefined;
  onPick: (id: string) => void;
}) {
  const stage = stepId ? flow.stages.find(({ step }) => step.id === stepId) : undefined;
  if (!stage) return null;
  const links = stepLinks(flow, stage.step.id);
  const row = (link: (typeof links)[number]) => (
    <li key={`${link.side}:${link.id}:${link.kind ?? ""}:${link.words ?? ""}`}>
      <button
        type="button"
        className={`flow-around-link${link.kind ? ` is-${link.kind}` : ""}`}
        onClick={() => onPick(link.id)}
      >
        <span className="flow-around-arrow" aria-hidden="true">
          {link.kind === "recurse"
            ? "↻"
            : link.kind === "return"
              ? "↩"
              : link.side === "before"
                ? "↑"
                : "↓"}
        </span>
        <span className="flow-around-label">{link.label}</span>
        {(link.words || link.kind) && (
          <span className="flow-around-words">
            {[link.words, link.kind && LEVEL_WORDS[link.kind]].filter(Boolean).join(", ")}
          </span>
        )}
      </button>
    </li>
  );
  const before = links.filter((link) => link.side === "before");
  const after = links.filter((link) => link.side === "after");
  return (
    <section className="flow-around" data-testid="step-neighbours" aria-label="Around this step">
      <p className="flow-around-step">
        <span className="eyebrow">This step</span> {stage.step.label}
      </p>
      {before.length > 0 && (
        <>
          <h4>Comes from</h4>
          <ul>{before.map(row)}</ul>
        </>
      )}
      {after.length > 0 && (
        <>
          <h4>Goes on to</h4>
          <ul>{after.map(row)}</ul>
        </>
      )}
    </section>
  );
}
