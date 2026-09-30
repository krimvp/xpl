import type { SequenceStep, SequenceView } from "./schema.js";
import { resolveFrames } from "./sequence.js";

export interface ProcessFlow {
  stages: { step: SequenceStep; frames: string[]; shape: "stage" | "decision" | "terminal" }[];
  transitions: { id: string; from: string; to: string; label?: string }[];
  projected: boolean;
}

export function processFlow(view: SequenceView): ProcessFlow {
  const steps = Array.isArray(view.steps)
    ? view.steps.filter((step) => step && typeof step.id === "string")
    : [];
  const known = new Set(steps.map((step) => step.id));
  const frames = resolveFrames(view);
  const stages = steps.map((step, index) => ({
    step,
    shape: step.shape ?? (step.next?.length && step.next.length > 1 ? "decision" : "stage"),
    frames: frames
      .filter((frame) => frame.from <= index && index <= frame.to)
      .map(({ frame }) => `${frame.kind}: ${frame.label}`),
  }));
  const transitions = steps.flatMap((step, index) => {
    const next =
      step.shape === "terminal"
        ? []
        : (step.next ?? (steps[index + 1] ? [{ step: steps[index + 1]!.id }] : []));
    return next
      .filter((target) => target && known.has(target.step))
      .map((target, i) => ({
        id: `${step.id}->${target.step}:${i}`,
        from: step.id,
        to: target.step,
        ...(target.label !== undefined ? { label: target.label } : {}),
      }));
  });
  return { stages, transitions, projected: view.type === "sequence" };
}
