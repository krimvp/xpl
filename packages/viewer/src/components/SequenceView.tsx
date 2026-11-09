import { DiagramText } from "./DiagramText.js";
/**
 * Sequence view: lifelines for the participants (labels from the model), one arrow per step top to
 * bottom (`call` solid, `return` dashed, `async` open arrowhead), self-calls as loops, frames
 * (`loop` / `alt` / `opt` / `par`) as labelled rectangles around their steps; an `alt` with arms has a dashed
 * line between two arms and each arm's condition, a button that selects the arm's steps. A frame's name is a
 * button too: it selects the frame's steps, whose code is the frame's code (a frame has no code link of its own).
 * Frame names, conditions and steps are drawn (and reached with Tab) in reading order, top to bottom.
 *
 * Steps and lifelines are `<g data-element-id="...">` like graph elements; a step's group carries a
 * transparent hit area covering its label and arrow, so clicking anywhere on the row selects it.
 */
import type { ExplainerModel, SequenceView as SequenceViewData } from "@xpl/core";
import { useMemo, useSyncExternalStore, type KeyboardEvent, type MouseEvent } from "react";
import {
  ARM_TOP,
  frameLabelWidth,
  frameTabWidth,
  LABEL_LINE,
  layoutSequence,
  readingOrder,
  type ArmBox,
  type FrameBox,
  type Lifeline,
  type Row,
  type SequenceLayout,
} from "../layout/sequenceLayout.js";
import { useStore } from "../hooks.js";
import { arrowHeadPath, openArrowHeadPath, roundedPath } from "../svg.js";
import { READABLE_ZOOM } from "../viewport.js";
import { sequenceFocus } from "../sequenceFocus.js";
import { SequenceKey } from "./Legend.js";
import {
  PanZoom,
  PRESENT_FIT_PADDING,
  PRESENT_MAX_FIT_ZOOM,
  PRESENT_READABLE_ZOOM,
} from "./PanZoom.js";

/**
 * On a laptop, a sequence a little wider than its pane at `READABLE_ZOOM` starts at the zoom that shows all
 * its lifelines, down to this (13-unit words at about 9px): it is cut only at the bottom, where the reader
 * scrolls on. A phone (`PHONE_MAX` px or less) keeps its 10px floor and pans across.
 */
const SEQUENCE_WIDTH_ZOOM = 0.7;
const PHONE_MAX = 640;

/** True while the window is a phone's width: read again when the window is resized. */
function usePhoneWidth(): boolean {
  return useSyncExternalStore(
    (changed) => {
      window.addEventListener("resize", changed);
      return () => window.removeEventListener("resize", changed);
    },
    () => window.innerWidth <= PHONE_MAX,
  );
}

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
  const phone = usePhoneWidth();
  const layout = useMemo(() => layoutSequence(view, model), [view, model]);
  const selected = useMemo(() => new Set(selection), [selection]);
  const matched = useMemo(() => new Set(matches), [matches]);
  // What a diagram too big to show whole starts on: the selected arrows and participants (a tour step's
  // focus), so the step being talked about is on screen, not the top-left corner. An arrow counts by its
  // label (what is read): a long arrow in a narrow pane is then framed on its words, not on its tail.
  // Each selected arrow is one focus box: its label with both ends (the heads of the two participants it
  // joins), so a frame shows who talks to whom; several are framed together when they fit, else the first
  // whole and "+N more". When even one is too wide, its label (`core`) is what stays in view.
  const startFocus = useMemo(() => sequenceFocus(layout, selected), [layout, selected]);
  const { boxes: startBoxes, core: startCore } = startFocus;

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
      imageName={view.title}
      maxFitZoom={present ? PRESENT_MAX_FIT_ZOOM : undefined}
      fitPadding={present ? PRESENT_FIT_PADDING : undefined}
      // Whole only when its words read at 10px or more (13.5 units at 0.75); else framed on the step.
      readableZoom={present ? PRESENT_READABLE_ZOOM : READABLE_ZOOM}
      readableMin={present || phone ? undefined : SEQUENCE_WIDTH_ZOOM}
      focus={startBoxes.length > 0 ? startFocus : undefined}
      keepInView={startCore}
      overlay={(t, size) => <StickyHeads lifelines={layout.lifelines} t={t} paneWidth={size.w} />}
      onBackgroundClick={() => store.clearSelection()}
      tools={
        <SequenceKey
          shows={{
            returns: layout.rows.some((row) => row.step.kind === "return"),
            async: layout.rows.some((row) => row.step.kind === "async"),
            frames: layout.frames.length > 0,
            arms: layout.frames.some((box) => box.arms.length > 0),
          }}
        />
      }
    >
      <g className="sequence">
        <g className="lifelines">
          {layout.lifelines.map((lifeline) => (
            <LifelineShape key={lifeline.id} lifeline={lifeline} classes={states(lifeline.id)} />
          ))}
        </g>
        {/* Frames over the lifelines (their box is see-through): no dashed line runs through a frame's name. */}
        <g className="frames">
          {layout.frames.map((box) => (
            <FrameBoxShape key={box.frame.id} box={box} />
          ))}
        </g>
        <g className="steps">
          <ReadingOrder layout={layout} states={states} selected={selected} matched={matched} />
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
      <g className="frames">
        {layout.frames.map((box) => (
          <FrameBoxShape key={box.frame.id} box={box} />
        ))}
      </g>
      <g className="steps">
        <ReadingOrder layout={layout} states={states} selected={selected} still />
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
export function StickyHeads({
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

/** The plate under a step's words: all of its lines. */
function plateOf(row: Row) {
  return {
    x: (row.labelAnchor === "middle" ? row.labelX - row.labelWidth / 2 : row.labelX) - 4,
    y: row.labelY - 14,
    width: row.labelWidth + 8,
    height: 19 + (row.lines.length - 1) * LABEL_LINE,
  };
}

/** The frames' names, their arms' conditions and the steps, top to bottom (`readingOrder`): the Tab order. */
function ReadingOrder({
  layout,
  states,
  selected,
  matched,
  still = false,
}: {
  layout: SequenceLayout;
  states: (id: string) => string;
  selected: ReadonlySet<string>;
  matched?: ReadonlySet<string>;
  still?: boolean;
}) {
  return (
    <>
      {readingOrder(layout).map((item) =>
        item.kind === "step" ? (
          <StepShape
            key={item.row.step.id}
            row={item.row}
            classes={states(item.row.step.id)}
            still={still}
          />
        ) : item.kind === "frame" ? (
          <FrameHead
            key={item.box.frame.id}
            box={item.box}
            rows={layout.rows}
            selected={selected}
            still={still}
          />
        ) : (
          <ArmShape
            key={`${item.box.frame.id}:${item.n}`}
            box={item.box}
            rows={layout.rows}
            arm={item.arm}
            n={item.n}
            selected={selected}
            matched={matched}
            still={still}
          />
        ),
      )}
    </>
  );
}

/** A frame's box, under the steps. */
function FrameBoxShape({ box }: { box: FrameBox }) {
  return (
    <g
      className={`frame kind-${box.frame.kind}${box.depth > 0 ? " is-nested" : ""}`}
      data-frame-id={box.frame.id}
    >
      <rect
        className="frame-box"
        x={box.x}
        y={box.y}
        width={box.width}
        height={box.height}
        rx={6}
      />
    </g>
  );
}

/** Selects `steps`: the reader's pick, or added to it with Shift. */
function useSelectSteps(selected: ReadonlySet<string>) {
  const store = useStore();
  return (steps: readonly string[], event: MouseEvent | KeyboardEvent) => {
    event.stopPropagation();
    if (additive(event)) store.select([...new Set([...selected, ...steps])]);
    else store.select([...steps]);
  };
}

const onEnter =
  (act: (event: KeyboardEvent) => void) =>
  (event: KeyboardEvent): void => {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      act(event);
    }
  };

/** "steps 3 to 5", "step 8": a frame's or an arm's steps by their numbers. */
function stepNumbers(steps: readonly string[], rows: readonly Row[]): string {
  const numbers = steps.map((id) => rows.findIndex((row) => row.step.id === id) + 1);
  if (numbers.length === 0) return "no steps";
  return numbers.length === 1
    ? `step ${numbers[0]}`
    : `steps ${numbers[0]} to ${numbers[numbers.length - 1]}`;
}

/**
 * What a frame's name or an arm's condition shows when clicked, and what it cannot show: a frame and an
 * arm have no code link of their own (the schema gives them none), so the line that tests the condition is not
 * highlighted. The tooltip says where to look: the code above the frame's first step.
 */
function frameLimit(box: FrameBox, rows: readonly Row[]): string {
  const first = box.steps.length > 0 ? stepNumbers(box.steps.slice(0, 1), rows) : undefined;
  return (
    "Click to see its steps and their code. The condition has no code link of its own" +
    (first ? `: it is in the code above ${first}.` : ".")
  );
}

/**
 * A frame's tab and name: a button that selects the frame's steps. With arms, the name says what the
 * frame decides and is set apart from the conditions: no brackets, italic.
 */
function FrameHead({
  box,
  rows,
  selected,
  still,
}: {
  box: FrameBox;
  rows: readonly Row[];
  selected: ReadonlySet<string>;
  still: boolean;
}) {
  const select = useSelectSteps(selected);
  const tab = frameTabWidth(box.frame.kind);
  const arms = box.arms.length > 0;
  const text = arms ? box.frame.label : `[${box.frame.label}]`;
  const width = Math.min(box.width - 2, frameLabelWidth(box.frame.kind, box.frame.label));
  const on = box.steps.length > 0 && box.steps.every((id) => selected.has(id));
  const act = (event: MouseEvent | KeyboardEvent) => select(box.steps, event);
  return (
    <g
      className={`frame frame-head kind-${box.frame.kind}${on ? " is-selected" : ""}`}
      data-frame-head={box.frame.id}
      role={still ? undefined : "button"}
      tabIndex={still ? undefined : 0}
      aria-pressed={still ? undefined : on}
      aria-label={still ? undefined : `${box.frame.kind} ${text}: ${stepNumbers(box.steps, rows)}`}
      onClick={still ? undefined : act}
      onKeyDown={still ? undefined : onEnter(act)}
    >
      {!still && <title>{frameLimit(box, rows)}</title>}
      <rect className="hit" x={box.x + 1} y={box.y + 1} width={width} height={20} rx={4} />
      <path className="frame-tab" d={`M${box.x} ${box.y}h${tab}v12l-8 8h-${tab - 8}z`} />
      <text className="frame-kind" x={box.x + 8} y={box.y + 14}>
        {box.frame.kind}
      </text>
      <text
        className={`frame-label${arms ? " frame-title" : ""}`}
        x={box.x + tab + 8}
        y={box.y + 14}
      >
        {text}
      </text>
    </g>
  );
}

/** An arm of an `alt`: the dashed line above it (not the first) and its condition, which selects its steps. */
function ArmShape({
  box,
  rows,
  arm,
  n,
  selected,
  matched,
  still,
}: {
  box: FrameBox;
  rows: readonly Row[];
  arm: ArmBox;
  n: number;
  selected: ReadonlySet<string>;
  matched?: ReadonlySet<string> | undefined;
  still: boolean;
}) {
  const select = useSelectSteps(selected);
  const on = arm.steps.every((id) => selected.has(id));
  const state =
    (on ? " is-selected" : "") + (arm.steps.some((id) => matched?.has(id)) ? " is-match" : "");
  const act = (event: MouseEvent | KeyboardEvent) => select(arm.steps, event);
  return (
    <g
      className={`frame frame-arm${state}`}
      data-arm-of={box.frame.id}
      data-arm={still ? undefined : n}
      role={still ? undefined : "button"}
      tabIndex={still ? undefined : 0}
      aria-pressed={still ? undefined : on}
      aria-label={
        still
          ? undefined
          : `${box.frame.label}, arm [${arm.label}]: ${stepNumbers(arm.steps, rows)}`
      }
      onClick={still ? undefined : act}
      onKeyDown={still ? undefined : onEnter(act)}
    >
      {!still && <title>{frameLimit(box, rows)}</title>}
      {n > 0 && (
        <line
          className="frame-divider"
          x1={box.x}
          y1={arm.top}
          x2={box.x + box.width}
          y2={arm.top}
        />
      )}
      <rect
        className="hit"
        x={box.x + 2}
        y={arm.top + 1}
        width={box.width - 4}
        height={ARM_TOP - 2}
        rx={4}
      />
      <text className="frame-label arm-label" x={box.x + 8} y={arm.top + 14}>
        {`[${arm.label}]`}
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
      data-navigation-from={still ? undefined : step.from}
      data-navigation-to={still ? undefined : step.to}
      role={still ? undefined : "button"}
      tabIndex={still ? undefined : 0}
      aria-label={`${row.index + 1}. ${kind} ${step.label ?? ""}`}
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
      {/* On a plate of the canvas' colour, tinted like each frame it sits in: no lifeline runs through
          the words, and inside a loop the plate is not a white box on the grey frame. */}
      {[0, ...Array.from({ length: row.depth }, (_, n) => n + 1)].map((n) => (
        <rect
          key={n}
          className={n === 0 ? "label-plate" : "label-plate-tint"}
          {...plateOf(row)}
          rx={4}
        />
      ))}
      <text className="label" x={row.labelX} y={row.labelY} textAnchor={row.labelAnchor}>
        {row.lines.map((line, n) => (
          <tspan key={n} x={row.labelX} dy={n === 0 ? 0 : LABEL_LINE}>
            {/* the space keeps the words apart when the text is read or copied as one */}
            {n < row.lines.length - 1 ? `${line} ` : line}
          </tspan>
        ))}
      </text>
      {/* Its number, where it starts: the number the text view, the parts list and the prose use. */}
      <g className="step-number" aria-hidden="true">
        <circle cx={row.x1} cy={row.y} r={10} />
        <text x={row.x1} y={row.y + 4}>
          {row.index + 1}
        </text>
      </g>
    </g>
  );
}
