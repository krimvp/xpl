import type { FlowLink, SequenceStep, SequenceView } from "./schema.js";
import { resolveFrames } from "./sequence.js";

export interface ProcessFlow {
  stages: { step: SequenceStep; frames: string[]; shape: "stage" | "decision" | "terminal" }[];
  transitions: {
    id: string;
    from: string;
    /** Absent for a `return` link without a step: back up one level, to whoever made the call. */
    to?: string;
    label?: string;
    /** A transition that changes the level of a recursive function (`FlowLink.kind`). */
    kind?: "recurse" | "return";
  }[];
  projected: boolean;
}

/** A link that changes the level of a recursion (`recurse`, `return`): see `FlowLink.kind`. */
export const levelLink = (link: FlowLink | undefined): boolean =>
  link?.kind === "recurse" || link?.kind === "return";

export function processFlow(view: SequenceView): ProcessFlow {
  const steps = Array.isArray(view.steps)
    ? view.steps.filter((step) => step && typeof step.id === "string")
    : [];
  const known = new Set(steps.map((step) => step.id));
  const frames = resolveFrames(view);
  const stages = steps.map((step, index) => ({
    step,
    // a step is a choice when it has more than one way on at its own level
    shape:
      step.shape ??
      ((Array.isArray(step.next) ? step.next.filter((link) => !levelLink(link)).length : 0) > 1
        ? "decision"
        : "stage"),
    frames: frames
      .filter((frame) => frame.from <= index && index <= frame.to)
      .map(({ frame }) => `${frame.kind}: ${frame.label}`),
  }));
  const transitions = steps.flatMap((step, index) => {
    const following = steps[index + 1] ? [{ step: steps[index + 1]!.id } as FlowLink] : [];
    const given = Array.isArray(step.next) ? step.next : undefined;
    const next: FlowLink[] =
      step.shape === "terminal"
        ? // a terminal ends its path at this level; the call may still return to its caller
          (given ?? []).filter((link) => link?.kind === "return")
        : given === undefined
          ? following
          : // a recursive call does not end the step: with nothing else, it goes on to the next one
            given.length > 0 && given.every((link) => link?.kind === "recurse")
            ? [...given, ...following]
            : given;
    return next
      .filter(
        (target) =>
          target && (target.step === undefined ? target.kind === "return" : known.has(target.step)),
      )
      .map((target, i) => ({
        id: `${step.id}->${target.step ?? "caller"}:${i}`,
        from: step.id,
        ...(target.step !== undefined ? { to: target.step } : {}),
        ...(target.label !== undefined ? { label: target.label } : {}),
        ...(levelLink(target) ? { kind: target.kind } : {}),
      }));
  });
  return { stages, transitions, projected: view.type === "sequence" };
}
