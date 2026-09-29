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
const LABEL_FONT = 12;
const FRAME_TOP = 26;
const FRAME_BOTTOM = 12;
const FRAME_PAD_X = 16;
const FRAME_NEST_X = 12;

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
  const labelWidths = steps.map((step) =>
    Math.ceil(textWidth(String(step.label ?? ""), LABEL_FONT, 500)),
  );

  // ── x: heads, then gaps wide enough for the labels of the steps that pass through them ──────────
  const headWidths = participants.map((p) =>
    Math.max(MIN_HEAD_WIDTH, Math.ceil(textWidth(p.label, 13, 600)) + 36),
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
  const rows: Row[] = [];
  let y = HEAD_TOP + HEAD_HEIGHT + 22;
  steps.forEach((step, i) => {
    y += startsAt(i) * FRAME_TOP;
    const { from, to, detached } = ends[i]!;
    const self = from !== -1 && from === to;
    const labelW = labelWidths[i]!;
    const lineY = y + 30;
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
        bandLeft: x1 - 8,
        bandTop: y + 4,
        bandRight: x1 + SELF_WIDTH + 10 + labelW + 8,
        bandBottom: lineY + 32,
      };
      y += SELF_PITCH;
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
        labelY: lineY - 9,
        labelAnchor: "middle",
        labelWidth: labelW,
        bandLeft: left - 6,
        bandTop: y + 4,
        bandRight: rightX + 6,
        bandBottom: lineY + 9,
      };
      y += ROW_PITCH;
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
    const x = minX - FRAME_PAD_X;
    const top = minY - FRAME_TOP + 4;
    boxes.set(resolved.frame, {
      frame: resolved.frame,
      depth: resolved.depth,
      x,
      y: top,
      width: maxX + FRAME_PAD_X - x,
      height: maxY + FRAME_BOTTOM - top,
    });
  }

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
    width,
    height,
    lifelines,
    rows,
    // Outer frames first, so inner ones are drawn on top of them.
    frames: frames.map((f) => boxes.get(f.frame)!).filter(Boolean),
  };
}
