/**
 * Sequence view: lifelines for the participants (labels from the model), one arrow per step top to
 * bottom (`call` solid, `return` dashed, `async` open arrowhead), self-calls as loops, frames
 * (`loop` / `alt` / `opt` / `par`) as labelled rectangles around their steps.
 *
 * Steps and lifelines are `<g data-element-id="...">` like graph elements; a step's group carries a
 * transparent hit area covering its label and arrow, so clicking anywhere on the row selects it.
 */
import type { ExplainerModel, SequenceView as SequenceViewData } from "@xpl/core";
import { useMemo, type KeyboardEvent, type MouseEvent } from "react";
import {
  layoutSequence,
  type FrameBox,
  type Lifeline,
  type Row,
} from "../layout/sequenceLayout.js";
import { useStore } from "../hooks.js";
import { arrowHeadPath, openArrowHeadPath, roundedPath } from "../svg.js";
import { PanZoom, PRESENT_FIT_PADDING, PRESENT_MAX_FIT_ZOOM } from "./PanZoom.js";

export interface SequenceViewProps {
  view: SequenceViewData;
  model: ExplainerModel;
  selection: readonly string[];
  matches: readonly string[];
  related: ReadonlySet<string>;
  /** Present mode: a small diagram is enlarged more. */
  present?: boolean;
}

const additive = (event: MouseEvent | KeyboardEvent) =>
  event.shiftKey || event.metaKey || event.ctrlKey;

export function SequenceView({
  view,
  model,
  selection,
  matches,
  related,
  present = false,
}: SequenceViewProps) {
  const store = useStore();
  const layout = useMemo(() => layoutSequence(view, model), [view, model]);
  const selected = useMemo(() => new Set(selection), [selection]);
  const matched = useMemo(() => new Set(matches), [matches]);

  if (layout.lifelines.length === 0) {
    return (
      <div className="diagram-message">
        This sequence has no participants yet. Add elements to its <code>participants</code> list.
      </div>
    );
  }
  const states = (id: string) =>
    (selected.has(id) ? " is-selected" : "") +
    (matched.has(id) ? " is-match" : "") +
    (related.has(id) ? " is-related" : "");

  return (
    <PanZoom
      width={layout.width}
      height={layout.height}
      resetKey={view.id}
      label="Sequence diagram. Drag to pan, scroll to zoom."
      maxFitZoom={present ? PRESENT_MAX_FIT_ZOOM : undefined}
      fitPadding={present ? PRESENT_FIT_PADDING : undefined}
      onBackgroundClick={() => store.clearSelection()}
    >
      <g className="sequence">
        <g className="frames">
          {layout.frames.map((box) => (
            <FrameShape key={box.frame.id} box={box} />
          ))}
        </g>
        <g className="lifelines">
          {layout.lifelines.map((lifeline) => (
            <LifelineShape key={lifeline.id} lifeline={lifeline} classes={states(lifeline.id)} />
          ))}
        </g>
        <g className="steps">
          {layout.rows.map((row) => (
            <StepShape key={row.step.id} row={row} classes={states(row.step.id)} />
          ))}
        </g>
      </g>
    </PanZoom>
  );
}

function LifelineShape({ lifeline, classes }: { lifeline: Lifeline; classes: string }) {
  const store = useStore();
  const select = (event: MouseEvent | KeyboardEvent) => store.click(lifeline.id, additive(event));
  const left = lifeline.x - lifeline.headWidth / 2;
  const lineTop = lifeline.headTop + lifeline.headHeight;
  return (
    <g className={`lifeline${classes}`}>
      {/* The dashed line is part of the participant (a click on it selects it) but not of the element's
          group: steps are drawn over the line, and the group's centre, where a click lands, must be the
          head, which nothing covers. */}
      <g
        className="lifeline-line"
        onClick={(event) => {
          event.stopPropagation();
          select(event);
        }}
      >
        <line className="line" x1={lifeline.x} y1={lineTop} x2={lifeline.x} y2={lifeline.bottom} />
        <line className="hit" x1={lifeline.x} y1={lineTop} x2={lifeline.x} y2={lifeline.bottom} />
      </g>
      <g
        className={`lifeline-head${classes}`}
        data-element-id={lifeline.id}
        role="button"
        tabIndex={0}
        aria-label={`Participant ${lifeline.label}`}
        onClick={(event) => {
          event.stopPropagation();
          select(event);
        }}
        onKeyDown={(event) => {
          if (event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            select(event);
          }
        }}
      >
        <title>{lifeline.id}</title>
        <rect
          className="head"
          x={left}
          y={lifeline.headTop}
          width={lifeline.headWidth}
          height={lifeline.headHeight}
          rx={8}
        />
        <text className="label" x={lifeline.x} y={lifeline.headTop + lifeline.headHeight / 2 + 5}>
          {lifeline.label}
        </text>
      </g>
    </g>
  );
}

function FrameShape({ box }: { box: FrameBox }) {
  const tab = box.frame.kind.length * 7.5 + 16;
  return (
    <g className={`frame kind-${box.frame.kind}`} data-frame-id={box.frame.id}>
      <rect
        className="frame-box"
        x={box.x}
        y={box.y}
        width={box.width}
        height={box.height}
        rx={6}
      />
      <path className="frame-tab" d={`M${box.x} ${box.y}h${tab}v12l-8 8h-${tab - 8}z`} />
      <text className="frame-kind" x={box.x + 8} y={box.y + 14}>
        {box.frame.kind}
      </text>
      <text className="frame-label" x={box.x + tab + 8} y={box.y + 14}>
        {`[${box.frame.label}]`}
      </text>
    </g>
  );
}

function StepShape({ row, classes }: { row: Row; classes: string }) {
  const store = useStore();
  const { step } = row;
  const select = (event: MouseEvent | KeyboardEvent) => store.click(step.id, additive(event));
  const kind = step.kind;
  const tail = { x: row.x1, y: row.y };
  const tip = { x: row.x2, y: row.y };
  let path: string;
  let head: string;
  if (row.self) {
    const loop = [
      { x: row.x1, y: row.y },
      { x: row.x1 + 46, y: row.y },
      { x: row.x1 + 46, y: row.y + 26 },
      { x: row.x1, y: row.y + 26 },
    ];
    path = roundedPath(loop, 6);
    head =
      kind === "call" ? arrowHeadPath(loop[2]!, loop[3]!) : openArrowHeadPath(loop[2]!, loop[3]!);
  } else {
    path = roundedPath([tail, tip]);
    head = kind === "call" ? arrowHeadPath(tail, tip) : openArrowHeadPath(tail, tip);
  }
  return (
    <g
      className={`step kind-${kind}${row.detached ? " is-detached" : ""}${classes}`}
      data-element-id={step.id}
      role="button"
      tabIndex={0}
      aria-label={`${kind} ${step.label ?? ""}`}
      onClick={(event) => {
        event.stopPropagation();
        select(event);
      }}
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          select(event);
        }
      }}
    >
      <rect
        className="hit"
        x={row.bandLeft}
        y={row.bandTop}
        width={row.bandRight - row.bandLeft}
        height={row.bandBottom - row.bandTop}
        rx={5}
      />
      <path className="line" d={path} />
      <path className="head" d={head} />
      <text className="label" x={row.labelX} y={row.labelY} textAnchor={row.labelAnchor}>
        {step.label ?? ""}
      </text>
    </g>
  );
}
