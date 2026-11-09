import type { ElementId, ExplainerModel, ProcessFlow } from "@xpl/core";
import { textWidth } from "../measure.js";
import type { Point } from "../svg.js";
import type { Box } from "../svg.js";
import {
  layered,
  orthogonalRoute,
  type LayeredResult,
  separateTracks,
  sideToward,
  spreadPorts,
  type Port,
} from "./layered.js";

/** A laid-out flow: its size, its boxes (top-left corners), and each transition's route and label box. */
export interface FlowLayout {
  width: number;
  height: number;
  /**
   * The boxes, by layout id: a stage's id, or for a repeated end (`copyOf`) an id of its own. A stage drawn
   * more than once is one element: a click on any of its boxes picks it.
   */
  children: {
    id: string;
    x: number;
    y: number;
    width: number;
    height: number;
    copyOf?: string;
  }[];
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
/** A stage box is as tall as its words: one line of label is 66 units, each more adds a line (V2-07). */
export function stageHeight(label: string): number {
  return 66 + 18 * (wrapWords(label, STAGE_LABEL_CHARS, 3).length - 1);
}
export const DECISION_WIDTH = 300;
export const DECISION_HEIGHT = 150;
/** Characters per line of a stage label (three lines at most). */
export const STAGE_LABEL_CHARS = 28;
/** Characters per line of a transition label ("yes: HTTP below ASGI 2.4" takes two lines). */
export const EDGE_LABEL_CHARS = 18;
/** Font size of a transition's words (styles: `.flow-transition text`). */
const FLOW_FONT = 13;
/** Line height of a transition label. */
export const EDGE_LABEL_LINE = 17;

/**
 * A word longer than a line (code: `ky.#runAfterResponseHooks(response)`) in pieces of at most `width`
 * characters, cut after a `.`, `,` or `/` or before a `(` where it can be, else at `width`.
 */
function splitWord(word: string, width: number): string[] {
  const pieces: string[] = [];
  let rest = word;
  while (rest.length > width) {
    let cut = 0;
    for (let i = 1; i < width; i++) {
      if (/[.,/]/.test(rest[i - 1]!) || rest[i] === "(") cut = i;
    }
    // a cut that leaves only a mark or two on the line is no better than a hard one
    if (cut < width / 3) cut = width;
    pieces.push(rest.slice(0, cut));
    rest = rest.slice(cut);
  }
  if (rest) pieces.push(rest);
  return pieces;
}

/**
 * Words into lines of about `width` characters; `max` lines at most (the last one ends with "…"). A word that
 * does not fit on a line of its own is cut in pieces (`splitWord`), so no line runs past the box.
 */
export function wrapWords(text: string, width: number, max = Infinity): string[] {
  const lines: string[] = [];
  for (const word of text.split(/\s+/).filter(Boolean)) {
    const last = lines[lines.length - 1];
    if (last !== undefined && last.length + word.length < width)
      lines[lines.length - 1] += ` ${word}`;
    else lines.push(...splitWord(word, width));
  }
  if (lines.length <= max) return lines;
  return lines.slice(0, max).map((line, index) => (index === max - 1 ? `${line}…` : line));
}

/** An end that this many transitions or more lead into is drawn again under each of them (`repeatEnds`). */
export const REPEAT_END_FROM = 4;

/**
 * The flow with each busy end drawn once per way into it: an end (a terminal stage that leads nowhere) that
 * `REPEAT_END_FROM` or more transitions lead into gets a copy under each of them but the first, so a flow
 * with many ways to "give up" does not draw a dozen lines converging on one box from all over the picture.
 * Returns the boxes to lay out (a copy has its own id, `copyOf` its stage) and the transitions, retargeted.
 */
export function repeatEnds(flow: ProcessFlow): {
  boxes: { id: string; shape: ProcessFlow["stages"][number]["shape"]; copyOf?: string }[];
  transitions: ProcessFlow["transitions"];
} {
  const leaves = new Set(
    flow.transitions.filter((edge) => edge.from !== edge.to).map((edge) => edge.from),
  );
  const busy = new Set(
    flow.stages
      .filter(({ step, shape }) => shape === "terminal" && !leaves.has(step.id))
      .map(({ step }) => step.id)
      .filter(
        (id) =>
          flow.transitions.filter((edge) => edge.to === id && edge.from !== id).length >=
          REPEAT_END_FROM,
      ),
  );
  const boxes: ReturnType<typeof repeatEnds>["boxes"] = flow.stages.map(({ step, shape }) => ({
    id: step.id,
    shape,
  }));
  const seen = new Map<string, number>();
  const transitions = flow.transitions.map((edge) => {
    // a return to the caller has no box to copy
    if (edge.to === undefined || !busy.has(edge.to) || edge.from === edge.to) return edge;
    const n = seen.get(edge.to) ?? 0;
    seen.set(edge.to, n + 1);
    if (n === 0) return edge;
    const id = `${edge.to}#${n + 1}`;
    const shape = flow.stages.find(({ step }) => step.id === edge.to)!.shape;
    boxes.push({ id, shape, copyOf: edge.to });
    return { ...edge, to: id };
  });
  return { boxes, transitions };
}

/** Lays out a flow top-down: stages in layers, right-angled transitions with their labels between them. */
export async function layoutFlow(source: ProcessFlow): Promise<FlowLayout> {
  const { boxes, transitions: links } = repeatEnds(source);
  const flow = { ...source, transitions: links };
  const labelOf = new Map(source.stages.map(({ step }) => [step.id, step.label] as const));
  const children = boxes.map(({ id, shape, copyOf }) => ({
    id,
    width: shape === "decision" ? DECISION_WIDTH : STAGE_WIDTH,
    height: shape === "decision" ? DECISION_HEIGHT : stageHeight(labelOf.get(copyOf ?? id) ?? ""),
    ...(copyOf ? { copyOf } : {}),
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
  const transitions = joins.filter(
    (edge) => result.boxes.has(edge.from) && result.boxes.has(edge.to) && edge.from !== edge.to,
  );
  // Where a path splits, the lower step numbers go on the left (V2-06): the whole flow is mirrored when that
  // agrees with more of its rows than dagre's own order does, and the ends a choice leads to are put in order.
  const number = new Map(source.stages.map(({ step }, i) => [step.id, i] as const));
  const indexOf = (id: string) =>
    number.get(children.find((child) => child.id === id)?.copyOf ?? id) ?? 0;
  const facing = readsBackwards(result, indexOf) ? mirrored(result) : result;
  // The main path of a run of choices goes straight down (V1-08): a box moves under the one before it, its
  // early exits step aside. Kept only when no route then runs through a box and no box lands on another
  // (an exit moved aside can reach the next choice's ends, V3-03).
  const straight = straightened(facing, transitions, 36, indexOf);
  let routed: Point[][] = routeFlow(
    straight ?? facing,
    transitions,
    straight ? straight.moved : new Set(),
  );
  let placed: LayeredResult = straight ?? facing;
  if (
    straight &&
    (!clearOfBoxes(routed, transitions, straight.boxes) || !apart(straight.boxes, 0))
  ) {
    routed = routeFlow(facing, transitions, new Set());
    placed = facing;
  }
  return finishFlow(flow, placed, transitions, routed, labels, children);
}

/** True when more pairs of boxes side by side read against the step numbers (higher on the left) than with them. */
function readsBackwards(result: LayeredResult, indexOf: (id: string) => number): boolean {
  const rows = new Map<number, { id: string; x: number }[]>();
  for (const [id, b] of result.boxes) {
    const key = Math.round(b.y + b.height / 2);
    rows.set(key, [...(rows.get(key) ?? []), { id, x: b.x }]);
  }
  let with_ = 0,
    against = 0;
  for (const row of rows.values())
    for (const a of row)
      for (const b of row)
        if (a.x < b.x) {
          if (indexOf(a.id) < indexOf(b.id)) with_++;
          else if (indexOf(a.id) > indexOf(b.id)) against++;
        }
  return against > with_;
}

/** The layout seen in a mirror: left and right swapped. */
function mirrored(result: LayeredResult): LayeredResult {
  const flip = (p: Point): Point => ({ x: result.width - p.x, y: p.y });
  return {
    width: result.width,
    height: result.height,
    boxes: new Map(
      [...result.boxes].map(([id, b]) => [id, { ...b, x: result.width - b.x - b.width }]),
    ),
    routes: new Map(
      [...result.routes].map(([id, route]) => [
        id,
        { via: route.via.map(flip), ...(route.label ? { label: flip(route.label) } : {}) },
      ]),
    ),
  };
}

/** The routes of a flow's transitions; those that touch a box in `moved` are routed afresh (dagre's track is stale). */
function routeFlow(
  result: LayeredResult,
  transitions: readonly { id: string; from: string; to: string }[],
  moved: ReadonlySet<string>,
): Point[][] {
  const via = (edge: { id: string; from: string; to: string }) =>
    moved.has(edge.from) || moved.has(edge.to) ? [] : (result.routes.get(edge.id)?.via ?? []);
  const ports = new Map<string, Port>();
  for (const edge of transitions) {
    const from = result.boxes.get(edge.from)!;
    const to = result.boxes.get(edge.to)!;
    const track = via(edge);
    const next = track[0] ?? { x: to.x + to.width / 2, y: to.y + to.height / 2 };
    const previous = track[track.length - 1] ?? {
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
      via(edge),
      { from: spread.get(`${edge.id}\0from`)!, to: spread.get(`${edge.id}\0to`)! },
      "DOWN",
    ),
  );
  separateTracks(routed, "DOWN");
  return routed;
}

/** True when no two boxes overlap or come closer than `gap` side by side. */
function apart(boxes: ReadonlyMap<string, Box>, gap: number): boolean {
  const list = [...boxes.values()];
  return list.every((a, i) =>
    list
      .slice(i + 1)
      .every(
        (b) =>
          a.y >= b.y + b.height ||
          b.y >= a.y + a.height ||
          a.x >= b.x + b.width + gap - 0.5 ||
          b.x >= a.x + a.width + gap - 0.5,
      ),
  );
}

/** True when no route runs through a box other than its own two. */
function clearOfBoxes(
  routed: readonly Point[][],
  transitions: readonly { from: string; to: string }[],
  boxes: ReadonlyMap<string, Box>,
): boolean {
  return routed.every((points, n) => {
    const edge = transitions[n]!;
    return [...boxes].every(
      ([id, b]) =>
        id === edge.from ||
        id === edge.to ||
        points.slice(1).every((p, i) => {
          const a = points[i]!;
          const left = Math.min(a.x, p.x),
            right = Math.max(a.x, p.x),
            top = Math.min(a.y, p.y),
            bottom = Math.max(a.y, p.y);
          return (
            right <= b.x + 1 ||
            left >= b.x + b.width - 1 ||
            bottom <= b.y + 1 ||
            top >= b.y + b.height - 1
          );
        }),
    );
  });
}

/**
 * The flow with its main path straight: going down rank by rank, the main next box of each box (the one more
 * of the flow follows; the first written on a tie) moves under it when that box has no other way in, and the
 * boxes beside it that lead nowhere (early exits) step aside to make room. Undefined when nothing moves.
 */
function straightened(
  result: LayeredResult,
  transitions: readonly { from: string; to: string }[],
  gap: number,
  indexOf: (id: string) => number,
): (LayeredResult & { moved: Set<string> }) | undefined {
  const boxes = new Map([...result.boxes].map(([id, b]) => [id, { ...b }]));
  const out = new Map<string, string[]>();
  const into = new Map<string, number>();
  for (const edge of transitions) {
    out.set(edge.from, [...(out.get(edge.from) ?? []), edge.to]);
    into.set(edge.to, (into.get(edge.to) ?? 0) + 1);
  }
  const after = new Map<string, number>();
  const reach = (id: string, seen = new Set<string>()): number => {
    if (after.has(id)) return after.get(id)!;
    if (seen.has(id)) return 0;
    seen.add(id);
    const n = (out.get(id) ?? []).reduce((sum, next) => sum + 1 + reach(next, seen), 0);
    after.set(id, n);
    return n;
  };
  const centreY = (b: Box) => Math.round(b.y + b.height / 2);
  const moved = new Set<string>();
  // the boxes one choice leads to (each with no other way in), side by side in one row, in step order
  for (const nexts of out.values()) {
    const ends = nexts.filter((id) => into.get(id) === 1);
    const row = ends.map((id) => boxes.get(id)!);
    if (ends.length < 2 || row.some((b) => b.y !== row[0]!.y || b.width !== row[0]!.width))
      continue;
    const slots = row.map((b) => b.x).sort((a, b) => a - b);
    [...ends]
      .sort((a, b) => indexOf(a) - indexOf(b))
      .forEach((id, n) => {
        const b = boxes.get(id)!;
        if (Math.abs(b.x - slots[n]!) < 0.5) return;
        b.x = slots[n]!;
        moved.add(id);
      });
  }
  const ids = [...boxes.keys()].sort((a, b) => boxes.get(a)!.y - boxes.get(b)!.y);
  for (const id of ids) {
    const nexts = out.get(id) ?? [];
    if (nexts.length === 0) continue;
    if (nexts.length === 1) continue;
    const main = [...nexts].sort((a, b) => reach(b) - reach(a))[0]!;
    // a main path and early exits only: a box whose other ways on lead on too is two paths, not one
    if (
      reach(main) === 0 ||
      nexts.some((next) => next !== main && (out.get(next) ?? []).length > 0)
    )
      continue;
    const parent = boxes.get(id)!;
    const child = boxes.get(main)!;
    if ((into.get(main) ?? 0) !== 1 || child.y <= parent.y) continue;
    const target = parent.x + parent.width / 2 - child.width / 2;
    if (Math.abs(target - child.x) < 0.5) continue;
    // the others of its rank, which must step aside: only boxes that lead nowhere may
    const rank = [...boxes].filter(([other, b]) => other !== main && centreY(b) === centreY(child));
    const clash = rank.filter(
      ([, b]) => b.x < target + child.width + gap && b.x + b.width + gap > target,
    );
    if (clash.some(([other]) => (out.get(other) ?? []).length > 0)) continue;
    const before = new Map(
      [main, ...clash.map(([other]) => other)].map((k) => [k, boxes.get(k)!.x]),
    );
    child.x = target;
    // the exits it clashes with go to the side they were on, packed away from it
    for (const side of [-1, 1]) {
      let edge = side < 0 ? target - gap : target + child.width + gap;
      const list = clash
        .filter(
          ([, b]) =>
            Math.sign(b.x + b.width / 2 - (target + child.width / 2)) === side ||
            (side > 0 && b.x + b.width / 2 === target + child.width / 2),
        )
        .sort(([, a], [, b]) => side * (a.x - b.x));
      for (const [, b] of list) {
        b.x = side < 0 ? edge - b.width : edge;
        edge = side < 0 ? b.x - gap : b.x + b.width + gap;
      }
    }
    // an exit pushed aside onto a box of another branch (V3-03): this box stays where dagre put it
    const landed = [...before.keys()].some((k) => {
      const a = boxes.get(k)!;
      return [...boxes].some(
        ([other, b]) =>
          !before.has(other) &&
          a.y < b.y + b.height &&
          b.y < a.y + a.height &&
          a.x < b.x + b.width + gap - 0.5 &&
          b.x < a.x + a.width + gap - 0.5,
      );
    });
    if (landed) {
      for (const [k, x] of before) boxes.get(k)!.x = x;
      continue;
    }
    for (const [k, x] of before) if (Math.abs(boxes.get(k)!.x - x) >= 0.5) moved.add(k);
  }
  if (moved.size === 0) return undefined;
  // back inside the padding, and as wide as it now is
  const left = Math.min(...[...boxes.values()].map((b) => b.x));
  const shift = 24 - left;
  for (const b of boxes.values()) b.x += shift;
  const routes = new Map(
    [...result.routes].map(([id, route]) => [
      id,
      {
        via: route.via.map((p) => ({ x: p.x + shift, y: p.y })),
        ...(route.label ? { label: { x: route.label.x + shift, y: route.label.y } } : {}),
      },
    ]),
  );
  const width = Math.max(...[...boxes.values()].map((b) => b.x + b.width)) + 24;
  return { width, height: result.height, boxes, routes, moved };
}

function finishFlow(
  flow: ProcessFlow,
  result: LayeredResult,
  transitions: readonly (ProcessFlow["transitions"][number] & { to: string })[],
  routed: Point[][],
  labels: ReadonlyMap<string, { text: string; width: number; height: number }>,
  children: readonly { id: string; width: number; height: number; copyOf?: string }[],
): FlowLayout {
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
          labels: (() => {
            if (!label) return [];
            const centre =
              route?.label && onRoute(points, route.label) ? route.label : midRun(points);
            return [{ ...label, x: centre.x - label.width / 2, y: centre.y - label.height / 2 }];
          })(),
          ...(edge.kind ? { kind: edge.kind } : {}),
        };
      }),
      ...loops,
      ...exits,
    ],
  };
}

/** True when `p` lies on the route (within a few units). */
function onRoute(points: readonly Point[], p: Point): boolean {
  return points.slice(1).some((b, i) => {
    const a = points[i]!;
    return (
      p.x >= Math.min(a.x, b.x) - 3 &&
      p.x <= Math.max(a.x, b.x) + 3 &&
      p.y >= Math.min(a.y, b.y) - 3 &&
      p.y <= Math.max(a.y, b.y) + 3
    );
  });
}

/** The middle of the longest upright run of a route (else of its longest run): where its label goes. */
function midRun(points: readonly Point[]): Point {
  let best = points[0] ?? { x: 0, y: 0 };
  let longest = -1;
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1]!,
      b = points[i]!;
    const length = Math.hypot(b.x - a.x, b.y - a.y) * (Math.abs(a.x - b.x) < 0.5 ? 2 : 1);
    if (length > longest) {
      longest = length;
      best = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
    }
  }
  return best;
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
 * The laid-out boxes of a flow, each with its stage (a repeated end's copies too). The layout answers after the render that asked for it: a
 * node the flow does not have (from the layout of another view, still on screen while the new one is
 * computed) is skipped, never drawn from a missing stage.
 */
export function placedStages(
  flow: ProcessFlow,
  layout: Pick<FlowLayout, "children">,
): { node: FlowLayout["children"][number]; stage: ProcessFlow["stages"][number] }[] {
  const stages = new Map(flow.stages.map((stage) => [stage.step.id, stage] as const));
  return (layout.children ?? []).flatMap((node) => {
    const stage = stages.get(node.copyOf ?? node.id);
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
  shared?: ElementId,
): string {
  const actor = anchorOwner(step, model) ?? step.from;
  // The owner every box shares is said once, over the flow: a box names only where its work goes.
  if (actor === shared) {
    if (step.to === actor || shape !== "stage") return "";
    const to = `→ ${model.label(step.to)}`;
    return to.length <= max ? to : `${to.slice(0, max - 1)}…`;
  }
  const from = model.label(actor);
  const text = step.to === actor || shape !== "stage" ? from : `${from} → ${model.label(step.to)}`;
  if (text.length <= max) return text;
  return from.length <= max ? from : `${from.slice(0, max - 1)}…`;
}

/**
 * The one part every step of the flow starts from (the steps of one function), when there are two steps or
 * more: named once with the flow (its caption), not under every box. A box whose code is in another part
 * (`anchorOwner`) still names that part.
 */
export function sharedActor(flow: Pick<ProcessFlow, "stages">): ElementId | undefined {
  if (flow.stages.length < 2) return undefined;
  const actors = new Set(flow.stages.map(({ step }) => step.from));
  return actors.size === 1 ? [...actors][0] : undefined;
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
