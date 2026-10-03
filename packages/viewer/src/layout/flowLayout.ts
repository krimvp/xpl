import type { ElementId, ExplainerModel, ProcessFlow } from "@xpl/core";
import { textWidth } from "../measure.js";
import type { Point } from "../svg.js";
import {
  layered,
  orthogonalRoute,
  separateTracks,
  sideToward,
  spreadPorts,
  type Port,
} from "./layered.js";

/** A laid-out flow: its size, its boxes (top-left corners), and each transition's route and label box. */
export interface FlowLayout {
  width: number;
  height: number;
  children: { id: string; x: number; y: number; width: number; height: number }[];
  edges: {
    id: string;
    /** The stages the transition joins. */
    from: string;
    to: string;
    sections: { startPoint: Point; bendPoints: Point[]; endPoint: Point }[];
    labels: { text: string; x: number; y: number; width: number; height: number }[];
  }[];
}

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

/** Lays out a flow top-down: stages in layers, right-angled transitions with their labels between them. */
export async function layoutFlow(flow: ProcessFlow): Promise<FlowLayout> {
  const children = flow.stages.map(({ step, shape }) => ({
    id: step.id,
    width: shape === "decision" ? DECISION_WIDTH : STAGE_WIDTH,
    height: shape === "decision" ? DECISION_HEIGHT : STAGE_HEIGHT,
  }));
  const labels = new Map(
    flow.transitions.flatMap((edge) => {
      if (!edge.label) return [];
      const lines = wrapWords(edge.label, EDGE_LABEL_CHARS);
      const size = {
        width: Math.max(...lines.map((line) => textWidth(line, FLOW_FONT))) + 16,
        height: 8 + EDGE_LABEL_LINE * lines.length,
      };
      return [[edge.id, { text: edge.label, ...size }] as const];
    }),
  );
  const result = layered(
    children,
    flow.transitions.map((edge) => ({
      id: edge.id,
      from: edge.from,
      to: edge.to,
      ...(labels.has(edge.id) ? { label: labels.get(edge.id)! } : {}),
    })),
    {
      direction: "DOWN",
      nodeGap: 36,
      layerGap: 70,
      edgeGap: 14,
      pad: { top: 30, right: 24, bottom: 30, left: 24 },
    },
  );
  const ports = new Map<string, Port>();
  const transitions = flow.transitions.filter(
    (edge) => result.boxes.has(edge.from) && result.boxes.has(edge.to) && edge.from !== edge.to,
  );
  for (const edge of transitions) {
    const from = result.boxes.get(edge.from)!;
    const to = result.boxes.get(edge.to)!;
    const via = result.routes.get(edge.id)?.via ?? [];
    const next = via[0] ?? { x: to.x + to.width / 2, y: to.y + to.height / 2 };
    const previous = via[via.length - 1] ?? {
      x: from.x + from.width / 2,
      y: from.y + from.height / 2,
    };
    ports.set(`${edge.id}\0from`, {
      box: edge.from,
      side: sideToward(from, next, "DOWN"),
      toward: next.x,
    });
    ports.set(`${edge.id}\0to`, {
      box: edge.to,
      side: sideToward(to, previous, "DOWN"),
      toward: previous.x,
    });
  }
  const spread = spreadPorts(ports, result.boxes, "DOWN");
  const routed = transitions.map((edge) =>
    orthogonalRoute(
      result.boxes.get(edge.from)!,
      result.boxes.get(edge.to)!,
      result.routes.get(edge.id)?.via ?? [],
      { from: spread.get(`${edge.id}\0from`)!, to: spread.get(`${edge.id}\0to`)! },
      "DOWN",
    ),
  );
  separateTracks(routed, "DOWN");
  return {
    width: result.width,
    height: result.height,
    children: children.map((child) => ({ ...child, ...result.boxes.get(child.id)! })),
    edges: transitions.map((edge, n) => {
      const route = result.routes.get(edge.id);
      const points = routed[n]!;
      const label = labels.get(edge.id);
      return {
        id: edge.id,
        from: edge.from,
        to: edge.to,
        sections: [
          {
            startPoint: points[0]!,
            bendPoints: points.slice(1, -1),
            endPoint: points[points.length - 1]!,
          },
        ],
        labels:
          label && route?.label
            ? [
                {
                  ...label,
                  x: route.label.x - label.width / 2,
                  y: route.label.y - label.height / 2,
                },
              ]
            : [],
      };
    }),
  };
}

/**
 * The laid-out boxes of a flow, each with its stage. The layout answers after the render that asked for it: a
 * node the flow does not have (from the layout of another view, still on screen while the new one is
 * computed) is skipped, never drawn from a missing stage.
 */
export function placedStages(
  flow: ProcessFlow,
  layout: Pick<FlowLayout, "children">,
): { node: FlowLayout["children"][number]; stage: ProcessFlow["stages"][number] }[] {
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
