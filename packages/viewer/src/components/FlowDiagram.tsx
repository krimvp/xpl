import { DiagramText } from "./DiagramText.js";
import { useEffect, useId, useMemo, useRef, useState } from "react";
import {
  codeFocus,
  processFlow,
  type ElementId,
  type ProcessFlow,
  type SequenceView,
} from "@xpl/core";
import { shortFlow } from "../shortLabels.js";
import { changeOf, rangesChange } from "../diff.js";
import { ChangePill, changePillWidth } from "./GraphView.js";
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
  stateMachine,
  stateRoles,
  LEVEL_WORDS,
  stageActor,
  wrapWords,
} from "../layout/flowLayout.js";
import {
  flowRelated,
  layoutFlowView,
  stepLinks,
  topicElements,
  topicMatches,
} from "../workspace.js";
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
/**
 * A flow (Read tab, Explore) starts whole when that shows its 13-unit words at 10px or more: the reader sees
 * all of it, and the layout "Fit all" shows. Smaller, it starts on its focus at `FLOW_READABLE_ZOOM`.
 */
const FLOW_WHOLE_ZOOM = 10 / 13;
/** The smallest zoom of that outline: its 13-14 unit words come out at 9-10 px. */
const OUTLINE_MIN_ZOOM = 0.7;

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
  // (a draft's TODO labels show short, as on a map: the selected step's details keep them whole)
  const flow = useMemo(() => processFlow(shortFlow(view)), [view]);
  // a flow of states and the moves between them: states are pills, each move a labelled arrow between two
  // of them (no numbers: a state machine has no order), the arrow still the move's link to its code
  const roles = useMemo(() => stateRoles(view), [view]);
  const machine = useMemo(() => (roles ? stateMachine(flow, roles) : undefined), [flow, roles]);
  const drawn = machine?.flow ?? flow;
  // The layout remembers the flow it belongs to: after a switch to another view, the old layout is not
  // drawn with the new flow (that used to crash) while the new one is computed.
  const [laidOut, setLaidOut] = useState<{ flow: ProcessFlow; layout: FlowLayout }>();
  const layout = laidOut && laidOut.flow === drawn ? laidOut.layout : undefined;
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
  // In a change guide, a step whose code the change added or edits carries the same pill as a map box.
  const change = changeOf(state.explainer);
  const changes = useMemo(() => {
    const marks = new Map<string, "new" | "changed">();
    for (const { step } of change ? flow.stages : []) {
      const status = rangesChange(codeFocus([step.id], state.model), change!);
      if (status) marks.set(step.id, status);
    }
    return marks;
  }, [flow, change, state.model]);
  // An outline follows what moved last: the caret in the code, or the selection (a click on a step).
  const [followCaret, setFollowCaret] = useState(false);
  useEffect(() => {
    if (state.cursor) setFollowCaret(true);
  }, [state.cursor]);
  useEffect(() => {
    setFollowCaret(false);
  }, [state.selection]);
  // An outline beside the code opens on its first step, with that step's code: the code pane is not empty.
  const opened = useRef<string | undefined>(undefined);
  const firstStep = flow.stages[0]?.step.id;
  useEffect(() => {
    if (!outline || snapshot || !layout || opened.current === view.id) return;
    opened.current = view.id;
    if (firstStep && state.selection.length === 0 && !state.cursor) store.select([firstStep]);
  }, [outline, snapshot, layout, view.id, firstStep, state.selection.length, state.cursor, store]);
  // The steps of one function: its name is said once with the flow (the caption of the Flow tab, the tour's
  // picture and the slide), not under every box. Every pane draws the same boxes, so the flow keeps one
  // shape: a slide whose boxes named the function had larger diamonds, and broke its rows at another step.
  const owner = sharedActor(flow);
  // (a state names its type nowhere but the caption: under every pill it says nothing the title does not)
  // The line under each step's label: the layout sizes a decision's diamond to hold it.
  const actors = useMemo(
    () =>
      new Map(
        flow.stages.map(({ step, shape }) => [
          step.id,
          roles?.get(step.id) === "state"
            ? ""
            : stageActor(step, state.model, shape === "decision" ? 26 : 34, shape, owner),
        ]),
      ),
    [flow, roles, state.model, owner],
  );
  // A flow keeps the shape it got for the window (`layoutFlowView`), whatever pane draws it: the Tour's
  // picture, the Flow tab, Explore and Present. (Present chose its own for the slide's pane, and a reader
  // who had learned the picture lost it when the talk started.)
  useEffect(() => {
    let cancelled = false;
    setError(undefined);
    // (an outline beside the code is one narrow column, top to bottom, whatever the window's shape)
    (outline ? layoutFlow(drawn, { actors }) : layoutFlowView(view.id, drawn, { actors })).then(
      (result) => {
        if (!cancelled) setLaidOut({ flow: drawn, layout: result });
      },
      (reason: unknown) => {
        if (!cancelled) setError(reason instanceof Error ? reason.message : String(reason));
      },
    );
    return () => {
      cancelled = true;
    };
  }, [drawn, actors, outline, view.id]);
  if (error)
    return (
      <div className="diagram-message" role="alert">
        Could not lay out the process: {error}
      </div>
    );
  if (!layout)
    return (
      <div className={`diagram-message flow-diagram${outline ? " is-outline" : ""}`}>
        Drawing the flow…
      </div>
    );
  if (flow.stages.length === 0)
    return <div className="diagram-message">This process has no stages yet.</div>;
  const placed = placedStages(drawn, layout);
  // the element an arrow stands for: itself, or the move it draws
  const elementOf = (edge: { id: string }) => machine?.moveOf.get(edge.id) ?? edge.id;
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
  // (a selected move: the two states its arrow joins)
  const movedBetween = new Set(
    (layout.edges ?? []).flatMap((edge) =>
      machine && topics.has(elementOf(edge)) ? [edge.from, ...(edge.to ? [edge.to] : [])] : [],
    ),
  );
  const focused = (
    selectedStages.length > 0
      ? selectedStages
      : movedBetween.size > 0
        ? originals.filter(({ node }) => movedBetween.has(node.id))
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
  // Each step's number: the one the text view, the parts list and the prose use.
  const numbers = new Map(flow.stages.map(({ step }, i) => [step.id, i + 1] as const));
  // Nothing picked: the flow is read from its first step, so a flow too big to show whole starts there (its
  // top-left corner can be empty: a wide flow centres its first step).
  const first = originals[0]?.node;
  const focus: Focus | undefined =
    focused.length > 0
      ? {
          boxes: focused.map((id) => boxOf(nodes.get(id)!)),
          neighbours: [...nextTo].flatMap((id) => {
            const node = nodes.get(id);
            return node ? [boxOf(node)] : [];
          }),
        }
      : first
        ? {
            boxes: [boxOf(first)],
            neighbours: (layout.edges ?? []).flatMap((edge) => {
              const next = edge.from === first.id && edge.to ? nodes.get(edge.to) : undefined;
              return next ? [boxOf(next)] : [];
            }),
          }
        : undefined;
  // An outline follows the caret: the step whose code the caret is in, kept in view as the caret moves.
  const caretStage =
    outline && followCaret ? originals.find(({ node }) => matches.has(node.id)) : undefined;
  const followed = caretStage ? boxOf(caretStage.node) : undefined;
  const transitionClass = (edge: FlowLayout["edges"][number]) =>
    `flow-transition${state.selection.includes(elementOf(edge)) ? " is-selected" : ""}${machine?.moveOf.has(edge.id) ? ` is-move${matches.has(elementOf(edge)) ? " is-matched" : ""}` : ""}${flow.projected ? " is-projected" : ""}${edge.kind ? ` is-${edge.kind}` : ""}`;
  const transitionWords = (edge: FlowLayout["edges"][number]) => {
    const to = edge.to ? stageLabels.get(nodes.get(edge.to)?.copyOf ?? edge.to) : "caller";
    return machine?.moveOf.has(edge.id)
      ? `Move: ${stageLabels.get(elementOf(edge))}, from ${stageLabels.get(edge.from)} to ${to}`
      : `${stageLabels.get(edge.from)} to ${to}${edge.labels.length ? `: ${edge.labels.map((label) => label.text).join(" ")}` : ""}`;
  };
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
      {/* The steps first, then the arrows: the reader (and Tab) meets the steps in reading order, and an
          arrow's end shows over the box it meets. */}
      {placed.map(({ node, stage }) => {
        const { step, shape, frames } = stage;
        const width = node.width ?? 250,
          height = node.height ?? 100;
        const active = topics.has(step.id),
          related = relatedStages.has(step.id);
        const label = wrapWords(
          step.label,
          layout.labelChars[shape === "decision" ? "decision" : "stage"],
          3,
        );
        const actor = actors.get(step.id) ?? "";
        const role = roles?.get(step.id);
        // a repeated end's copies carry no number: one step 6, drawn again near each way into it
        const numbered = !snapshot && !role && !node.copyOf;
        return (
          <g
            key={node.id}
            transform={`translate(${node.x ?? 0},${node.y ?? 0})`}
            className={`flow-stage${active ? " is-selected" : related ? " is-related" : ""}${matches.has(step.id) ? " is-matched" : ""}${role ? ` is-${role}` : ""}${node.copyOf ? " is-copy" : ""}`}
            data-element-id={snapshot || node.copyOf ? undefined : step.id}
            data-copy-of={node.copyOf}
            data-stage-id={step.id}
            role={snapshot ? undefined : "button"}
            tabIndex={snapshot ? undefined : node.copyOf ? -1 : 0}
            aria-label={
              snapshot
                ? undefined
                : role
                  ? `${role === "state" ? "State" : "Move"}: ${step.label}`
                  : `${numbers.get(step.id)}. ${step.label}`
            }
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
              <rect
                width={width}
                height={height}
                rx={
                  role === "state"
                    ? height / 2
                    : role === "move"
                      ? 4
                      : shape === "terminal"
                        ? 44
                        : 12
                }
              />
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
            {numbered && (
              <g
                className="flow-step-number"
                aria-hidden="true"
                transform={
                  shape === "decision"
                    ? `translate(${width / 4 - 2} ${height / 4 - 2})`
                    : `translate(${shape === "terminal" ? 22 : 12} 0)`
                }
              >
                <circle r={11} />
                <text y={4.5}>{numbers.get(step.id)}</text>
              </g>
            )}
            {changes.get(step.id) &&
              (() => {
                const status = changes.get(step.id)!;
                const pill = changePillWidth(status);
                // Top right, opposite the step number; in a diamond on its upper right edge.
                return shape === "decision" ? (
                  <ChangePill x={(width * 3) / 4 - pill / 2} y={height / 4 - 8} change={status} />
                ) : (
                  <ChangePill x={width - pill - 12} y={-8} change={status} />
                );
              })()}
          </g>
        );
      })}
      {(layout.edges ?? []).map((edge) => (
        <g
          key={edge.id}
          className={transitionClass(edge)}
          data-transition-kind={edge.kind}
          data-element-id={snapshot ? undefined : elementOf(edge)}
          role={snapshot ? undefined : "button"}
          tabIndex={snapshot ? undefined : 0}
          aria-label={snapshot ? undefined : transitionWords(edge)}
          onClick={(event) => {
            event.stopPropagation();
            select(elementOf(edge), event.shiftKey);
          }}
          onKeyDown={(event) => {
            if (event.key === "Enter" || event.key === " ") {
              event.preventDefault();
              select(elementOf(edge), event.shiftKey);
            }
          }}
          data-navigation-from={snapshot ? undefined : edge.from}
          data-navigation-to={
            snapshot || edge.to === undefined ? undefined : (nodes.get(edge.to)?.copyOf ?? edge.to)
          }
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
          <g
            key={`${edge.id}:label`}
            className={transitionClass(edge)}
            aria-hidden="true"
            onClick={(event) => {
              event.stopPropagation();
              select(elementOf(edge), event.shiftKey);
            }}
          >
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
      {/* A loop or a branch is named once, over the first box it covers, after the arrows: on a halo, the
          dashed line into the box runs behind it. */}
      {placed.map(({ node, stage }, index) => {
        const frameText = stage.frames.join(" · ");
        if (stage.frames.length === 0 || placed[index - 1]?.stage.frames.join(" · ") === frameText)
          return null;
        return (
          <text
            key={`${node.id}:frame`}
            className="flow-frame"
            x={(node.x ?? 0) + (node.width ?? 250) / 2}
            y={(node.y ?? 0) - 18}
            textAnchor="middle"
          >
            {frameText.slice(0, 60)}
          </text>
        );
      })}
    </>
  );
  if (snapshot)
    return (
      <SnapshotFrame
        width={layout.width ?? 400}
        height={layout.height ?? 300}
        // (the picture slides to cut as few boxes as it can at its edges: a step cut in half reads as a mistake)
        focus={focus && { ...focus, others: originals.map(({ node }) => boxOf(node)) }}
        where="Flow"
      >
        {content}
      </SnapshotFrame>
    );
  return (
    <div
      className={`flow-diagram${outline ? " is-outline" : ""}`}
      data-testid="process-flow"
      data-direction={layout.direction}
      data-parts={layout.parts}
    >
      {flow.projected && (
        <p className="flow-projection" role="note">
          {readingOrder(layout)} Each step is one call in the code. The arrows show the order, not
          every possible path. A purple label above a step says when it and the steps after it run.
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
        imageName={view.title}
        maxFitZoom={present ? PRESENT_MAX_FIT_ZOOM : undefined}
        fitPadding={present ? PRESENT_FIT_PADDING : undefined}
        // Present: a flow is read from the back of the room: it starts fitted only when its text comes out
        // at 16px or more, else at that size on its focus and the stages next to it ("Fit all" shows the
        // rest). All of the focus is in view: smaller (down to 10px) when it does not fit at 16px.
        readableZoom={present ? PRESENT_FLOW_MAX_ZOOM : FLOW_READABLE_ZOOM}
        // The outline beside the code (a 360 px column) starts at the zoom that shows the flow's whole width,
        // but never below `OUTLINE_MIN_ZOOM`, and its Fit all stops there too: it pans rather than shrinking
        // the words to 4 px.
        readableMin={present ? PRESENT_FLOW_MAX_ZOOM : outline ? OUTLINE_MIN_ZOOM : FLOW_WHOLE_ZOOM}
        minFitZoom={outline ? OUTLINE_MIN_ZOOM : undefined}
        panCue={false}
        focusMin={present ? PRESENT_FLOW_FOCUS_ZOOM : undefined}
        onBackgroundClick={() => store.clearSelection()}
        tools={
          <FlowKey
            shows={{
              decision: placed.some(({ stage }) => stage.shape === "decision"),
              terminal: placed.some(({ stage }) => stage.shape === "terminal"),
              frames: placed.some(({ stage }) => stage.frames.length > 0),
              copies: placed.some(({ node }) => node.copyOf !== undefined),
              states: machine !== undefined,
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

/** How to read a laid-out flow, in words: its direction, and where it goes on when it is set in parts. */
export function readingOrder(layout: Pick<FlowLayout, "direction" | "parts">): string {
  if (layout.direction === "RIGHT")
    return layout.parts > 1
      ? "Read from left to right; the flow goes on in the row below."
      : "Read from left to right.";
  return layout.parts > 1
    ? "Read from top to bottom; the flow goes on in the next column."
    : "Read from top to bottom.";
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
