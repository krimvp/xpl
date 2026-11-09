/**
 * Small helpers for sequence views (used by the viewer): step and participant lookups, frames
 * resolved to step index ranges with their nesting depth, and participant labels.
 */
import { baseName } from "./index-model.js";
import { parseId } from "./ids.js";
import type { ExplainerModel } from "./model.js";
import type { ElementId, SequenceFrame, SequenceStep, SequenceView } from "./schema.js";

const steps = (view: SequenceView): readonly SequenceStep[] =>
  Array.isArray(view.steps) ? view.steps : [];
const participants = (view: SequenceView): readonly ElementId[] =>
  Array.isArray(view.participants) ? view.participants : [];

/** Position of a step in `view.steps`, or -1. */
export function stepIndex(view: SequenceView, stepId: string): number {
  return steps(view).findIndex((step) => step?.id === stepId);
}

/** A frame with the step positions it spans and how deeply it is nested. */
export interface ResolvedFrame {
  frame: SequenceFrame;
  /** Index (into `view.steps`) of the first step inside the frame. */
  from: number;
  /** Index of the last step inside the frame (inclusive). */
  to: number;
  /** 0 = outermost. A frame is nested in every frame whose step range contains its own. */
  depth: number;
  /** The arms of an `alt` frame, top to bottom; [] when it has none, or when they do not split its steps. */
  arms: ResolvedArm[];
}

/** An arm of an `alt` frame with the step positions it spans (inclusive). */
export interface ResolvedArm {
  label: string;
  from: number;
  to: number;
}

/**
 * The arms of a frame that spans the steps `from`..`to`, as step positions: [] when it has none, else the arms,
 * or what is wrong with them (validation reports it; the diagram then draws the frame without lines). Arms
 * belong to an `alt` frame, two or more, and split its steps top to bottom with no gap and no overlap.
 */
export function frameArms(
  view: SequenceView,
  frame: SequenceFrame,
  from: number,
  to: number,
): ResolvedArm[] | string {
  if (frame.arms === undefined) return [];
  if (frame.kind !== "alt") return `only an alt frame has arms (${frame.id} is a ${frame.kind})`;
  if (!Array.isArray(frame.arms)) return "arms must be an array";
  if (frame.arms.length < 2)
    return "an alt frame has two or more arms (with one, it is an opt frame)";
  const out: ResolvedArm[] = [];
  for (const [n, arm] of frame.arms.entries()) {
    const which = `arm ${n + 1} of ${frame.id}`;
    if (typeof arm !== "object" || arm === null || typeof arm.label !== "string")
      return `${which} must be an object {label, fromStep, toStep}`;
    const start = stepIndex(view, arm.fromStep);
    const end = stepIndex(view, arm.toStep);
    if (start === -1 || end === -1)
      return `${which}: ${start === -1 ? `fromStep "${String(arm.fromStep)}"` : `toStep "${String(arm.toStep)}"`} is not a step of ${view.id}`;
    const expected = n === 0 ? from : out[n - 1]!.to + 1;
    if (start !== expected || end < start || (n === frame.arms.length - 1 && end !== to)) {
      return (
        `${which} runs ${arm.fromStep}..${arm.toStep}: the arms split the frame's steps (${frame.fromStep}..` +
        `${frame.toStep}) top to bottom, with no gap and no overlap, so it must start at ` +
        `${steps(view)[expected]?.id ?? "a step inside the frame"}` +
        (n === frame.arms.length - 1 ? ` and end at ${frame.toStep}` : "")
      );
    }
    out.push({ label: arm.label, from: start, to: end });
  }
  return out;
}

/**
 * Frames resolved to inclusive step index ranges. Frames whose steps are unknown, or whose
 * `fromStep` comes after `toStep`, are dropped. Sorted by start (then longer first, then stored
 * order). Of two frames with the same range, the one stored first is the outer.
 */
export function resolveFrames(view: SequenceView): ResolvedFrame[] {
  const resolved: {
    frame: SequenceFrame;
    from: number;
    to: number;
    order: number;
    arms: ResolvedArm[];
  }[] = [];
  (Array.isArray(view.frames) ? view.frames : []).forEach((frame, order) => {
    const from = stepIndex(view, frame.fromStep);
    const to = stepIndex(view, frame.toStep);
    if (from === -1 || to === -1 || from > to) return;
    const arms = frameArms(view, frame, from, to);
    resolved.push({ frame, from, to, order, arms: Array.isArray(arms) ? arms : [] });
  });
  const contains = (outer: (typeof resolved)[number], inner: (typeof resolved)[number]) =>
    outer !== inner &&
    outer.from <= inner.from &&
    inner.to <= outer.to &&
    (outer.from < inner.from || outer.to > inner.to || outer.order < inner.order);
  return resolved
    .map((entry) => ({
      frame: entry.frame,
      from: entry.from,
      to: entry.to,
      order: entry.order,
      depth: resolved.filter((other) => contains(other, entry)).length,
      arms: entry.arms,
    }))
    .sort((a, b) => a.from - b.from || b.to - a.to || a.order - b.order)
    .map(({ frame, from, to, depth, arms }) => ({ frame, from, to, depth, arms }));
}

/**
 * Display labels of the lifelines, left to right. Two participants with the same label get a
 * qualifier (a file: its last two path segments; a symbol: its file's name) so they can be told apart.
 */
export function participantLabels(
  view: SequenceView,
  model: ExplainerModel,
): { id: ElementId; label: string }[] {
  const ids = participants(view);
  const labels = ids.map((id) => model.label(id));
  const duplicated = (label: string) => labels.filter((l) => l === label).length > 1;
  return ids.map((id, i) => {
    const label = labels[i]!;
    if (!duplicated(label)) return { id, label };
    const parsed = parseId(id);
    switch (parsed.type) {
      case "file":
      case "dir":
        return { id, label: parsed.path.split("/").slice(-2).join("/") };
      case "symbol":
        return { id, label: `${label} (${baseName(parsed.file)})` };
      default:
        return { id, label: id };
    }
  });
}
