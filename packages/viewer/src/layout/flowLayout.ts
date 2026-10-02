import ELKModule, { type ElkNode } from "elkjs/lib/elk.bundled.js";
import type { ElementId, ExplainerModel, ProcessFlow } from "@xpl/core";
import { textWidth } from "../measure.js";

const ELK = ((ELKModule as unknown as { default?: unknown }).default ?? ELKModule) as new () => {
  layout(graph: ElkNode): Promise<ElkNode>;
};
const elk = new ELK();

/**
 * Box sizes, in the diagram's units. Kept compact: a flow is fitted to the width of its pane, so every unit
 * of width a box or a gap takes makes the text of the whole flow smaller. (A typical eight-stage flow with
 * one branch is about 700 units wide, so it shows at full size in a pane of that width.)
 */
export const STAGE_WIDTH = 250;
export const STAGE_HEIGHT = 100;
export const DECISION_WIDTH = 300;
export const DECISION_HEIGHT = 150;
/** Characters per line of a stage label (three lines at most). */
export const STAGE_LABEL_CHARS = 28;
/** Characters per line of a transition label ("yes: HTTP below ASGI 2.4" takes two lines). */
export const EDGE_LABEL_CHARS = 18;
/** Font size of the flow's text (styles: `.flow-stage text`, `.flow-transition text`). */
const FLOW_FONT = 13;
/** Line height of a transition label. */
export const EDGE_LABEL_LINE = 17;

/** Words into lines of about `width` characters; `max` lines at most (the last one ends with "…"). */
export function wrapWords(text: string, width: number, max = Infinity): string[] {
  const lines: string[] = [];
  for (const word of text.split(/\s+/).filter(Boolean)) {
    const last = lines[lines.length - 1];
    if (last !== undefined && last.length + word.length < width)
      lines[lines.length - 1] += ` ${word}`;
    else lines.push(word);
  }
  if (lines.length <= max) return lines;
  return lines.slice(0, max).map((line, index) => (index === max - 1 ? `${line}…` : line));
}

export function layoutFlow(flow: ProcessFlow): Promise<ElkNode> {
  return elk.layout({
    id: "process",
    layoutOptions: {
      "elk.algorithm": "layered",
      "elk.direction": "DOWN",
      "elk.edgeRouting": "ORTHOGONAL",
      "elk.spacing.nodeNode": "36",
      "elk.layered.spacing.nodeNodeBetweenLayers": "70",
      "elk.padding": "[top=30,left=24,bottom=30,right=24]",
    },
    children: flow.stages.map(({ step, shape }) => ({
      id: step.id,
      width: shape === "decision" ? DECISION_WIDTH : STAGE_WIDTH,
      height: shape === "decision" ? DECISION_HEIGHT : STAGE_HEIGHT,
    })),
    edges: flow.transitions.map((edge) => {
      if (!edge.label) return { id: edge.id, sources: [edge.from], targets: [edge.to] };
      const lines = wrapWords(edge.label, EDGE_LABEL_CHARS);
      return {
        id: edge.id,
        sources: [edge.from],
        targets: [edge.to],
        labels: [
          {
            text: edge.label,
            width: Math.max(...lines.map((line) => textWidth(line, FLOW_FONT))) + 16,
            height: 8 + EDGE_LABEL_LINE * lines.length,
          },
        ],
      };
    }),
  });
}

/**
 * The laid-out boxes of a flow, each with its stage. ELK answers after the render that asked for it: a
 * node the flow does not have (from the layout of another view, still on screen while the new one is
 * computed) is skipped, never drawn from a missing stage.
 */
export function placedStages(
  flow: ProcessFlow,
  layout: ElkNode,
): { node: ElkNode; stage: ProcessFlow["stages"][number] }[] {
  const stages = new Map(flow.stages.map((stage) => [stage.step.id, stage] as const));
  return (layout.children ?? []).flatMap((node) => {
    const stage = stages.get(node.id);
    return stage ? [{ node, stage }] : [];
  });
}

/**
 * The caption under a stage's label: who does the stage. That is the step's `from` (its actor), never its `to`:
 * a step is "A calls B", and the work the box names is done by A (the review found boxes captioned with `to`
 * naming the wrong owner, such as a constructor for the check that calls it).
 *
 * - stage: the actor; a stage that hands work to another part says so too ("A → B") when that fits the box,
 *   else the actor alone;
 * - decision and terminal: the actor alone. A decision is a question the actor asks (its branches say where
 *   the work goes next), and a terminal is where the actor's flow ends.
 */
export function stageActor(
  step: { from: ElementId; to: ElementId },
  model: Pick<ExplainerModel, "label">,
  max = 34,
  shape: "stage" | "decision" | "terminal" = "stage",
): string {
  const from = model.label(step.from);
  const text =
    step.to === step.from || shape !== "stage" ? from : `${from} → ${model.label(step.to)}`;
  if (text.length <= max) return text;
  return from.length <= max ? from : `${from.slice(0, max - 1)}…`;
}
