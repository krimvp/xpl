import { DiagramText } from "./DiagramText.js";
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
  type SequenceLayout,
} from "../layout/sequenceLayout.js";
import { useStore } from "../hooks.js";
import { arrowHeadPath, openArrowHeadPath, roundedPath, type Box } from "../svg.js";
import { unionBox } from "../viewport.js";
import { SequenceKey } from "./Legend.js";
import {
  PanZoom,
  PRESENT_FIT_PADDING,
  PRESENT_MAX_FIT_ZOOM,
  PRESENT_READABLE_ZOOM,
} from "./PanZoom.js";

export interface SequenceViewProps {
  view: SequenceViewData;
  /** A new key starts the diagram over (its first view); default: the view id. */
  resetKey?: string;
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
  resetKey = view.id,
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
  // What a diagram too big to show whole starts on: the selected arrows and participants (a tour step's
  // focus), so the step being talked about is on screen, not the top-left corner. An arrow counts by its
  // label (what is read): a long arrow in a narrow pane is then framed on its words, not on its tail.
  // Each selected arrow is one focus box: its label with both ends (the heads of the two participants it
  // joins), so a frame shows who talks to whom; several are framed together when they fit, else the first
  // whole and "+N more". When even one is too wide, its label (`core`) is what stays in view.
  const { boxes: startBoxes, core: startCore } = useMemo(() => {
    const boxes: Box[] = [];
    let core: Box | undefined;
    for (const row of layout.rows) {
      if (!selected.has(row.step.id)) continue;
      const left = row.labelAnchor === "middle" ? row.labelX - row.labelWidth / 2 : row.labelX;
      const label = {
        x: Math.max(row.bandLeft, left - 12),
        y: row.bandTop,
        width: row.labelWidth + 24,
        height: row.bandBottom - row.bandTop,
      };
      const ends = layout.lifelines
        .filter((lifeline) => lifeline.id === row.step.from || lifeline.id === row.step.to)
        .map((lifeline) => ({
          x: lifeline.x - lifeline.headWidth / 2,
          y: row.bandTop,
          width: lifeline.headWidth,
          height: row.bandBottom - row.bandTop,
        }));
      core ??= label;
      boxes.push(unionBox([label, ...ends])!);
    }
    for (const lifeline of layout.lifelines) {
      if (!selected.has(lifeline.id)) continue;
      const head = {
        x: lifeline.x - lifeline.headWidth / 2,
        y: lifeline.headTop,
        width: lifeline.headWidth,
        height: lifeline.headHeight,
      };
      core ??= head;
      boxes.push(head);
    }
    return { boxes, core };
  }, [layout, selected]);

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
      textView={<DiagramText sequence={layout} />}
      width={layout.width}
      height={layout.height}
      resetKey={resetKey}
      label="Sequence diagram. Drag to pan, scroll to zoom."
      maxFitZoom={present ? PRESENT_MAX_FIT_ZOOM : undefined}
      fitPadding={present ? PRESENT_FIT_PADDING : undefined}
      readableZoom={present ? PRESENT_READABLE_ZOOM : undefined}
      focus={startBoxes.length > 0 ? { boxes: startBoxes, core: startCore } : undefined}
      keepInView={startCore}
      overlay={(t, size) => <StickyHeads lifelines={layout.lifelines} t={t} paneWidth={size.w} />}
      onBackgroundClick={() => store.clearSelection()}
      tools={
        <SequenceKey
          shows={{
            returns: layout.rows.some((row) => row.step.kind === "return"),
            async: layout.rows.some((row) => row.step.kind === "async"),
            frames: layout.frames.length > 0,
          }}
        />
      }
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

/**
 * A still picture of a laid-out sequence (the Guide's inline diagram, Snapshot.tsx): the frames, lifelines
 * and arrows with the selection marked, no element ids and nothing to click.
 */
export function SequencePicture({
  layout,
  selection,
}: {
  layout: SequenceLayout;
  selection: readonly string[];
}) {
  const selected = new Set(selection);
  const states = (id: string) => (selected.has(id) ? " is-selected" : "");
  return (
    <g className="sequence is-still">
      <g className="frames">
        {layout.frames.map((box) => (
          <FrameShape key={box.frame.id} box={box} />
        ))}
      </g>
      <g className="lifelines">
        {layout.lifelines.map((lifeline) => (
          <LifelineShape
            key={lifeline.id}
            lifeline={lifeline}
            classes={states(lifeline.id)}
            still
          />
        ))}
      </g>
      <g className="steps">
        {layout.rows.map((row) => (
          <StepShape key={row.step.id} row={row} classes={states(row.step.id)} still />
        ))}
      </g>
    </g>
  );
}

function LifelineShape({
  lifeline,
  classes,
  still = false,
}: {
  lifeline: Lifeline;
  classes: string;
  still?: boolean;
}) {
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
        data-element-id={still ? undefined : lifeline.id}
        role={still ? undefined : "button"}
        tabIndex={still ? undefined : 0}
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

/**
 * The participant names, kept in sight: when the view has moved down a long sequence (a tour step framed
 * on a late call), a copy of the heads stays at the top of the pane, at the diagram's zoom and in line with
 * the lifelines, so you still see who calls whom. Only a picture: the heads in the diagram take the clicks.
 */
function StickyHeads({
  lifelines,
  t,
  paneWidth,
}: {
  lifelines: readonly Lifeline[];
  t: { k: number; x: number; y: number };
  paneWidth: number;
}) {
  const first = lifelines[0];
  if (!first || t.y + first.headTop * t.k >= 0) return null;
  const top = 6;
  const height = first.headHeight * t.k;
  return (
    <g className="sticky-heads" data-testid="sticky-heads" aria-hidden="true">
      <rect className="sticky-band" x={0} y={0} width={paneWidth} height={top + height + 6} />
      <g transform={`translate(${t.x} ${top}) scale(${t.k})`}>
        {lifelines.map((lifeline) => (
          <g key={lifeline.id} className="lifeline-head">
            <rect
              className="head"
              x={lifeline.x - lifeline.headWidth / 2}
              y={0}
              width={lifeline.headWidth}
              height={lifeline.headHeight}
              rx={8}
            />
            <text className="label" x={lifeline.x} y={lifeline.headHeight / 2 + 5}>
              {lifeline.label}
            </text>
          </g>
        ))}
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

function StepShape({
  row,
  classes,
  still = false,
}: {
  row: Row;
  classes: string;
  still?: boolean;
}) {
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
      data-element-id={still ? undefined : step.id}
      role={still ? undefined : "button"}
      tabIndex={still ? undefined : 0}
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
