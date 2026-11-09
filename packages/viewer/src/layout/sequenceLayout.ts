/**
 * Sequence views: lifelines left to right, one row per step top to bottom, frames as rectangles around
 * their rows. A small custom layout (lifelines are trivial); nesting of frames comes from core's
 * `resolveFrames`, the lifeline labels from `participantLabels`.
 *
 * Geometry is in canvas px. Every row carries the box (`band*`) that a click on the step should hit, so
 * SequenceView can give each step a hit area that covers its label and arrow.
 */
import {
  participantLabels,
  resolveFrames,
  type ElementId,
  type ExplainerModel,
  type SequenceFrame,
  type SequenceStep,
  type SequenceView,
} from "@xpl/core";
import { textWidth } from "../measure.js";
import { wrapWords } from "./flowLayout.js";

export interface Lifeline {
  id: ElementId;
  label: string;
  /** Centre x. */
  x: number;
  headWidth: number;
  headTop: number;
  headHeight: number;
  /** Where the dashed line ends. */
  bottom: number;
}

export interface Row {
  step: SequenceStep;
  index: number;
  /** y of the arrow line. */
  y: number;
  /** Arrow start and end x (equal for a self-call). */
  x1: number;
  x2: number;
  self: boolean;
  /** An end of the step is not a lifeline: the arrow is drawn as a note-like row instead. */
  detached: boolean;
  labelX: number;
  labelY: number;
  labelAnchor: "middle" | "start";
  labelWidth: number;
  /** The label on lines of about `LABEL_CHARS` characters (a long call signature wraps). */
  lines: string[];
  /** How many frames the row sits in: its label's plate takes their tint, not the canvas'. */
  depth: number;
  /** The hit area of the step. */
  bandLeft: number;
  bandTop: number;
  bandRight: number;
  bandBottom: number;
}

export interface FrameBox {
  frame: SequenceFrame;
  depth: number;
  x: number;
  y: number;
  width: number;
  height: number;
  /** An `alt` frame's arms, top to bottom ([] without them): SequenceView draws a line above all but the first. */
  arms: ArmBox[];
  /** The ids of the steps it holds, top to bottom: a click on its name selects them (their code is its code). */
  steps: string[];
}

/** One arm of an `alt` frame: its condition sits at the top left, under the line that starts it. */
export interface ArmBox {
  label: string;
  /** The ids of its steps, top to bottom: a click on the condition selects them. */
  steps: string[];
  /** y of the line above the arm, and of the top of its condition's row (`ARM_TOP` high). */
  top: number;
}

export interface SequenceLayout {
  width: number;
  height: number;
  lifelines: Lifeline[];
  rows: Row[];
  frames: FrameBox[];
}

const MARGIN_X = 36;
const HEAD_TOP = 20;
const HEAD_HEIGHT = 46;
const MIN_HEAD_WIDTH = 124;
const MIN_GAP = 36;
const ROW_PITCH = 58;
const SELF_PITCH = 78;
const SELF_WIDTH = 46;
// Font sizes in the diagram's own units; styles.css draws the text with the same numbers. Kept generous:
// a diagram is fitted into its pane, and the lifeline heads (not the labels) decide how wide it is.
const LABEL_FONT = 13.5;
/** Characters per line of a message label. */
const LABEL_CHARS = 40;
/** Line height of a wrapped message label. */
export const LABEL_LINE = 17;
/** The font of a frame's kind and condition (styles: `.frame-kind`, `.frame-label`). */
const FRAME_FONT = 12;
/** Font size of an arm's condition (styles: `.frame-label.arm-label`): a call's words' size. */
const ARM_FONT = 13;

/** The tab of a frame ("loop", "alt"): as SequenceView draws it. */
export function frameTabWidth(kind: string): number {
  return kind.length * 7.5 + 16;
}

/** How wide a frame must be to hold an arm's condition in brackets, on one line. */
function armLabelWidth(label: string): number {
  return 8 + Math.ceil(textWidth(`[${label}]`, ARM_FONT, 500)) + 12;
}

/** How wide a frame must be to hold its tab and its condition in brackets, on one line. */
export function frameLabelWidth(kind: string, label: string): number {
  return frameTabWidth(kind) + 8 + Math.ceil(textWidth(`[${label}]`, FRAME_FONT, 500)) + 12;
}
const HEAD_FONT = 14;
const FRAME_TOP = 26;
const FRAME_BOTTOM = 12;
const FRAME_PAD_X = 16;
const FRAME_NEST_X = 12;
/** The row above each arm of an `alt`: the line between two arms, and the arm's condition under it. */
export const ARM_TOP = 20;

export function layoutSequence(view: SequenceView, model: ExplainerModel): SequenceLayout {
  const participants = participantLabels(view, model);
  const steps = (Array.isArray(view.steps) ? view.steps : []).filter(
    (step) => step && typeof step.id === "string",
  );
  const count = participants.length;

  /** Lifeline index of an element: the participant itself, else the participant that contains it. */
  const lifelineOf = (id: ElementId): number => {
    const exact = participants.findIndex((p) => p.id === id);
    if (exact !== -1) return exact;
    return participants.findIndex((p) => model.subtreeContains(p.id, id));
  };

  const ends = steps.map((step) => {
    let from = lifelineOf(step.from);
    let to = lifelineOf(step.to);
    const detached = from === -1 || to === -1;
    if (from === -1) from = to;
    if (to === -1) to = from;
    return { from, to, detached };
  });
  const labelLines = steps.map((step) => {
    const lines = wrapWords(String(step.label ?? ""), LABEL_CHARS);
    return lines.length > 0 ? lines : [""];
  });
  const labelWidths = labelLines.map((lines) =>
    Math.max(...lines.map((line) => Math.ceil(textWidth(line, LABEL_FONT, 500)))),
  );

  // ── x: heads, then gaps wide enough for the labels of the steps that pass through them ──────────
  const headWidths = participants.map((p) =>
    Math.max(MIN_HEAD_WIDTH, Math.ceil(textWidth(p.label, HEAD_FONT, 600)) + 36),
  );
  const gaps: number[] = [];
  for (let i = 0; i + 1 < count; i++)
    gaps.push(headWidths[i]! / 2 + headWidths[i + 1]! / 2 + MIN_GAP);
  const spanNeeds = (from: number, to: number, need: number) => {
    const lo = Math.min(from, to);
    const hi = Math.max(from, to);
    if (lo === hi || lo < 0) return;
    let have = 0;
    for (let g = lo; g < hi; g++) have += gaps[g]!;
    if (have < need) for (let g = lo; g < hi; g++) gaps[g]! += (need - have) / (hi - lo);
  };
  steps.forEach((_, i) => {
    const { from, to, detached } = ends[i]!;
    if (detached || from === -1) return;
    if (from !== to) spanNeeds(from, to, labelWidths[i]! + 56);
    else if (from + 1 < count) {
      // A self-call writes its label to the right of the loop: it must clear the next head.
      spanNeeds(from, from + 1, SELF_WIDTH + 22 + labelWidths[i]! + 20 + headWidths[from + 1]! / 2);
    }
  });
  const centers: number[] = [];
  let cursor = MARGIN_X + (headWidths[0] ?? 0) / 2;
  for (let i = 0; i < count; i++) {
    centers.push(cursor);
    cursor += gaps[i] ?? 0;
  }
  // Right edge: the last head, or a self-call label hanging off the last lifeline.
  let right = (centers[count - 1] ?? 0) + (headWidths[count - 1] ?? 0) / 2;
  steps.forEach((_, i) => {
    const { from, to } = ends[i]!;
    if (from !== -1 && from === to && from === count - 1) {
      right = Math.max(right, centers[from]! + SELF_WIDTH + 22 + labelWidths[i]! + 12);
    }
  });
  const width = right + MARGIN_X;

  // ── y: rows, with room above a row for each frame that starts there and below for each that ends ──
  const frames = resolveFrames(view);
  const startsAt = (i: number) => frames.filter((f) => f.from === i).length;
  const endsAt = (i: number) => frames.filter((f) => f.to === i).length;
  const armsAt = (i: number) =>
    frames.reduce((n, f) => n + f.arms.filter((arm) => arm.from === i).length, 0);
  const rows: Row[] = [];
  let y = HEAD_TOP + HEAD_HEIGHT + 22;
  steps.forEach((step, i) => {
    y += startsAt(i) * FRAME_TOP + armsAt(i) * ARM_TOP;
    const { from, to, detached } = ends[i]!;
    const self = from !== -1 && from === to;
    const labelW = labelWidths[i]!;
    const lines = labelLines[i]!;
    const extra = (lines.length - 1) * LABEL_LINE;
    const depth = frames.filter((f) => f.from <= i && i <= f.to).length;
    // (a wrapped label above the arrow pushes the arrow down; one beside a loop makes the row taller)
    const lineY = y + 30 + (self ? 0 : extra);
    const x1 = from === -1 ? width / 2 : centers[from]!;
    const x2 = to === -1 ? width / 2 : centers[to]!;
    let row: Row;
    if (self) {
      row = {
        step,
        index: i,
        y: lineY,
        x1,
        x2,
        self: true,
        detached,
        labelX: x1 + SELF_WIDTH + 10,
        labelY: lineY + 16,
        labelAnchor: "start",
        labelWidth: labelW,
        lines,
        depth,
        bandLeft: x1 - 8,
        bandTop: y + 4,
        bandRight: x1 + SELF_WIDTH + 10 + labelW + 8,
        bandBottom: lineY + 32 + extra,
      };
      y += SELF_PITCH + extra;
    } else {
      const left = Math.min(x1, x2);
      const rightX = Math.max(x1, x2);
      row = {
        step,
        index: i,
        y: lineY,
        x1,
        x2,
        self: false,
        detached,
        labelX: (x1 + x2) / 2,
        // (the first line of a wrapped label: the others follow below it, down to the arrow)
        labelY: lineY - 9 - extra,
        labelAnchor: "middle",
        labelWidth: labelW,
        lines,
        depth,
        bandLeft: left - 6,
        bandTop: y + 4,
        bandRight: rightX + 6,
        bandBottom: lineY + 9,
      };
      y += ROW_PITCH + extra;
    }
    rows.push(row);
    y += endsAt(i) * FRAME_BOTTOM;
  });
  const height = y + 36;

  // ── frames: the rows they span, unioned with the frames nested inside them ─────────────────────────
  const boxes = new Map<SequenceFrame, FrameBox>();
  const innerFirst = [...frames].sort(
    (a, b) => a.to - a.from - (b.to - b.from) || b.depth - a.depth,
  );
  for (const resolved of innerFirst) {
    let minX = Infinity;
    let maxX = -Infinity;
    let minY = Infinity;
    let maxY = -Infinity;
    for (let i = resolved.from; i <= resolved.to; i++) {
      const row = rows[i]!;
      minX = Math.min(minX, row.bandLeft);
      maxX = Math.max(maxX, row.bandRight);
      minY = Math.min(minY, row.bandTop);
      maxY = Math.max(maxY, row.bandBottom);
    }
    for (const inner of innerFirst) {
      const box = boxes.get(inner.frame);
      if (box && inner !== resolved && inner.from >= resolved.from && inner.to <= resolved.to) {
        minX = Math.min(minX, box.x - FRAME_NEST_X);
        maxX = Math.max(maxX, box.x + box.width + FRAME_NEST_X);
        minY = Math.min(minY, box.y - FRAME_TOP + 4);
        maxY = Math.max(maxY, box.y + box.height + FRAME_BOTTOM - 4);
      }
    }
    // each arm's condition sits above what the arm holds: its first row, or a frame that starts with it
    const arms = resolved.arms.map((arm): ArmBox => {
      let top = rows[arm.from]!.bandTop;
      for (const inner of innerFirst) {
        const box = boxes.get(inner.frame);
        if (box && inner !== resolved && inner.from === arm.from && inner.to <= arm.to)
          top = Math.min(top, box.y);
      }
      return {
        label: arm.label,
        steps: rows.slice(arm.from, arm.to + 1).map((row) => row.step.id),
        top: top - ARM_TOP,
      };
    });
    if (arms.length > 0) minY = Math.min(minY, arms[0]!.top);
    const x = minX - FRAME_PAD_X;
    const top = minY - FRAME_TOP + 4;
    boxes.set(resolved.frame, {
      frame: resolved.frame,
      depth: resolved.depth,
      x,
      y: top,
      // wide enough for its tab and its condition: a long "[until …]" does not spill past the frame
      width: Math.max(
        maxX + FRAME_PAD_X - x,
        frameLabelWidth(resolved.frame.kind, resolved.frame.label),
        ...arms.map((arm) => armLabelWidth(arm.label)),
      ),
      height: maxY + FRAME_BOTTOM - top,
      arms,
      steps: rows.slice(resolved.from, resolved.to + 1).map((row) => row.step.id),
    });
  }
  const frameRight = Math.max(0, ...[...boxes.values()].map((box) => box.x + box.width));

  const lifelines: Lifeline[] = participants.map((p, i) => ({
    id: p.id,
    label: p.label,
    x: centers[i]!,
    headWidth: headWidths[i]!,
    headTop: HEAD_TOP,
    headHeight: HEAD_HEIGHT,
    bottom: height - 16,
  }));

  return {
    width: Math.max(width, frameRight + MARGIN_X / 2),
    height,
    lifelines,
    rows,
    // Outer frames first, so inner ones are drawn on top of them.
    frames: frames.map((f) => boxes.get(f.frame)!).filter(Boolean),
  };
}

/** One thing a reader meets going down a sequence: a frame's name, an arm's condition, or a step. */
export type SequenceItem =
  | { kind: "frame"; box: FrameBox }
  | { kind: "arm"; box: FrameBox; arm: ArmBox; n: number }
  | { kind: "step"; row: Row };

/**
 * The sequence top to bottom, as it is read: a frame's name before its first arm's condition, before the steps
 * under them. The order of the Tab key in the diagram and of its text view.
 */
export function readingOrder(layout: Pick<SequenceLayout, "frames" | "rows">): SequenceItem[] {
  const items: { item: SequenceItem; y: number; rank: number }[] = [];
  for (const box of layout.frames) {
    items.push({ item: { kind: "frame", box }, y: box.y, rank: box.depth });
    box.arms.forEach((arm, n) =>
      items.push({ item: { kind: "arm", box, arm, n }, y: arm.top, rank: 100 + box.depth }),
    );
  }
  for (const row of layout.rows)
    items.push({ item: { kind: "step", row }, y: row.bandTop, rank: 200 });
  return items.sort((a, b) => a.y - b.y || a.rank - b.rank).map(({ item }) => item);
}
