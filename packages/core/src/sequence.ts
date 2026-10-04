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
}

/**
 * Frames resolved to inclusive step index ranges. Frames whose steps are unknown, or whose
 * `fromStep` comes after `toStep`, are dropped. Sorted by start (then longer first, then stored
 * order). Of two frames with the same range, the one stored first is the outer.
 */
export function resolveFrames(view: SequenceView): ResolvedFrame[] {
  const resolved: { frame: SequenceFrame; from: number; to: number; order: number }[] = [];
  (Array.isArray(view.frames) ? view.frames : []).forEach((frame, order) => {
    const from = stepIndex(view, frame.fromStep);
    const to = stepIndex(view, frame.toStep);
    if (from !== -1 && to !== -1 && from <= to) resolved.push({ frame, from, to, order });
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
    }))
    .sort((a, b) => a.from - b.from || b.to - a.to || a.order - b.order)
    .map(({ frame, from, to, depth }) => ({ frame, from, to, depth }));
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
