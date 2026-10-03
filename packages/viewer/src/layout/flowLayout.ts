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
    /** The stages the transition joins (no `to`: a return to the caller, an arrow out of `from`). */
    from: string;
    to?: string;
    sections: { startPoint: Point; bendPoints: Point[]; endPoint: Point }[];
    labels: { text: string; x: number; y: number; width: number; height: number }[];
    /** A link that changes the level of a recursion (`FlowLink.kind`): drawn dashed, its label says which way. */
    kind?: "recurse" | "return";
  }[];
}

/** The words a recurse or return link adds to its label: which way the level changes. */
export const LEVEL_WORDS = { recurse: "one level down", return: "up one level" } as const;

/**
 * The tooltip of a recurse or return link: what it means, in words. A return without a target goes back to
 * whoever made the call, which differs by level: the step that recursed, or at the top the first caller.
 */
export function levelTitle(kind: "recurse" | "return", target: string | undefined): string {
  if (kind === "recurse")
    return `The function calls itself: the steps from "${target ?? ""}" run again, one level down.`;
  return target === undefined
    ? "The call returns, back up one level, to whoever made the call: the step that called it one level up, or, at the top, the code that first called the function."
    : `The call returns, back up one level, to "${target}".`;
}

/** The label drawn on a transition: its own words, and for a recurse or return link the way the level changes. */
export function transitionText(edge: {
  label?: string;
  kind?: "recurse" | "return";
}): string | undefined {
  if (!edge.kind) return edge.label || undefined;
  const words = LEVEL_WORDS[edge.kind];
  return edge.label ? `${edge.label} (${words})` : words;
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
      const text = transitionText(edge);
      if (!text) return [];
      const lines = wrapWords(text, EDGE_LABEL_CHARS);
      const size = {
        width: Math.max(...lines.map((line) => textWidth(line, FLOW_FONT))) + 16,
        height: 8 + EDGE_LABEL_LINE * lines.length,
      };
      return [[edge.id, { text, ...size }] as const];
    }),
  );
  const joins = flow.transitions.flatMap((edge) =>
    edge.to === undefined ? [] : [{ ...edge, to: edge.to }],
  );
  const result = layered(
    children,
    joins.map((edge) => ({
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
  const transitions = joins.filter(
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
  const loops = flow.transitions
    .filter((edge) => edge.from === edge.to && result.boxes.has(edge.from))
    .map((edge) => loopTransition(edge, result.boxes.get(edge.from)!, labels.get(edge.id)));
  const exits = flow.transitions
    .filter((edge) => edge.to === undefined && result.boxes.has(edge.from))
    .map((edge) => exitTransition(edge, result.boxes.get(edge.from)!, labels.get(edge.id)));
  const right = Math.max(
    result.width,
    ...[...loops, ...exits].flatMap((loop) => [
      ...loop.sections[0]!.bendPoints.map((point) => point.x + 24),
      ...loop.labels.map((label) => label.x + label.width + 12),
    ]),
  );
  return {
    width: right,
    height: result.height,
    children: children.map((child) => ({ ...child, ...result.boxes.get(child.id)! })),
    edges: [
      ...transitions.map((edge, n) => {
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
          ...(edge.kind ? { kind: edge.kind } : {}),
        };
      }),
      ...loops,
      ...exits,
    ],
  };
}

/** How far a loop reaches out of the right side of its box. */
const LOOP_REACH = 22;

/**
 * A transition of a stage to itself (the next item of a loop, a call of the same steps one level down): a loop out
 * of the right side of the box and back into it, a little higher, its label to the right of the loop. For a
 * decision, the loop leaves the right corner and comes back onto the upper right edge.
 */
function loopTransition(
  edge: ProcessFlow["transitions"][number],
  box: { x: number; y: number; width: number; height: number },
  label: { text: string; width: number; height: number } | undefined,
): FlowLayout["edges"][number] {
  const right = box.x + box.width;
  const diamond = box.height === DECISION_HEIGHT && box.width === DECISION_WIDTH;
  const start = { x: right, y: box.y + (diamond ? box.height / 2 : box.height * 0.68) };
  const end = diamond
    ? { x: box.x + box.width * 0.75 + 6, y: box.y + box.height / 4 + 3 }
    : { x: right, y: box.y + box.height * 0.32 };
  const top = Math.min(end.y - (diamond ? 18 : 0), start.y - 30);
  const bend = diamond
    ? [
        { x: right + LOOP_REACH, y: start.y },
        { x: right + LOOP_REACH, y: top },
        { x: end.x, y: top },
      ]
    : [
        { x: right + LOOP_REACH, y: start.y },
        { x: right + LOOP_REACH, y: end.y },
      ];
  return {
    id: edge.id,
    from: edge.from,
    to: edge.to,
    sections: [{ startPoint: start, bendPoints: bend, endPoint: end }],
    labels: label
      ? [
          {
            ...label,
            x: right + LOOP_REACH + 6,
            y: (start.y + top) / 2 - label.height / 2,
          },
        ]
      : [],
    ...(edge.kind ? { kind: edge.kind } : {}),
  };
}

/**
 * A return to the caller (a `return` link without a step): an arrow out of the right side of the box and up,
 * past its top edge, toward the level above; its label to the right.
 */
function exitTransition(
  edge: ProcessFlow["transitions"][number],
  box: { x: number; y: number; width: number; height: number },
  label: { text: string; width: number; height: number } | undefined,
): FlowLayout["edges"][number] {
  const right = box.x + box.width;
  const diamond = box.height === DECISION_HEIGHT && box.width === DECISION_WIDTH;
  const start = diamond
    ? { x: box.x + box.width * 0.75, y: box.y + box.height / 4 }
    : { x: right, y: box.y + box.height / 2 };
  const end = { x: right + LOOP_REACH, y: box.y - 24 };
  return {
    id: edge.id,
    from: edge.from,
    sections: [{ startPoint: start, bendPoints: [{ x: end.x, y: start.y }], endPoint: end }],
    labels: label ? [{ ...label, x: right + LOOP_REACH + 6, y: start.y - label.height - 4 }] : [],
    ...(edge.kind ? { kind: edge.kind } : {}),
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
 *
 * When the step's code (its first anchor) is inside `to` and not inside `from`, `to` is the one that does it: a
 * terminal "Throw a size error" drawn from the caller but anchored in the stream that throws names the stream.
 */
export function stageActor(
  step: { from: ElementId; to: ElementId; anchors?: readonly unknown[] },
  model: Pick<ExplainerModel, "label"> & Partial<Pick<ExplainerModel, "subtreeContains">>,
  max = 34,
  shape: "stage" | "decision" | "terminal" = "stage",
): string {
  const actor = anchorOwner(step, model) ?? step.from;
  const from = model.label(actor);
  const text = step.to === actor || shape !== "stage" ? from : `${from} → ${model.label(step.to)}`;
  if (text.length <= max) return text;
  return from.length <= max ? from : `${from.slice(0, max - 1)}…`;
}

/** `to`, when the step's first anchor is inside it and not inside `from`. */
function anchorOwner(
  step: { from: ElementId; to: ElementId; anchors?: readonly unknown[] },
  model: Partial<Pick<ExplainerModel, "subtreeContains">>,
): ElementId | undefined {
  const contains = model.subtreeContains?.bind(model);
  if (!contains || step.from === step.to) return undefined;
  const anchor = (step.anchors ?? []).find(
    (a): a is { file: string; symbol?: string } =>
      typeof a === "object" &&
      a !== null &&
      typeof (a as { file?: unknown }).file === "string" &&
      (a as { at?: unknown }).at !== "base",
  );
  if (!anchor) return undefined;
  const id = anchor.symbol ? `sym:${anchor.file}#${anchor.symbol}` : `file:${anchor.file}`;
  const inside = (participant: ElementId) => participant === id || contains(participant, id);
  return inside(step.to) && !inside(step.from) ? step.to : undefined;
}
