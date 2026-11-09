import type { ElementId, ExplainerModel, ProcessFlow, SequenceView } from "@xpl/core";
import { textWidth } from "../measure.js";
import type { Point } from "../svg.js";
import type { Box } from "../svg.js";
import {
  type Direction,
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
  /** Which way the steps run: `DOWN` (top to bottom, the default) or `RIGHT` (left to right). */
  direction: Direction;
  /** One column in step order, for a phone (`FlowLayoutOptions.column`). */
  column?: boolean;
  /**
   * Characters per line of a box's label (`wrapWords`), by shape: a left-to-right flow has narrower boxes,
   * and its diamonds are narrow and tall.
   */
  labelChars: { stage: number; decision: number };
  /**
   * In how many parts a long flow is set, like lines of text: columns side by side (top to bottom) or rows
   * one under the other (left to right). An arrow from the end of one part to the next runs between them.
   */
  parts: number;
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
/**
 * A left-to-right flow's stage box: narrower, with fewer characters per line. Its width runs along the
 * flow, so each unit saved is saved once per step.
 */
export const STAGE_WIDTH_ACROSS = 190;
/** Characters per line of a stage label (three lines at most). */
export const STAGE_LABEL_CHARS = 28;
/** Characters per line of a stage label in a left-to-right flow. */
export const STAGE_LABEL_CHARS_ACROSS = 20;
/** Characters per line of a decision's label in a left-to-right flow: a narrower, taller diamond. */
export const DECISION_LABEL_CHARS_ACROSS = 14;
/** A stage box is as tall as its words: one line of label is 66 units, each more adds a line. */
export function stageHeight(label: string, chars = STAGE_LABEL_CHARS): number {
  return 66 + 18 * (wrapWords(label, chars, 3).length - 1);
}
/** The largest a decision diamond gets; a short question gets a smaller one (`decisionSize`). */
export const DECISION_WIDTH = 300;
export const DECISION_HEIGHT = 150;
/** The smallest decision diamond. */
const DECISION_MIN = { width: 150, height: 84 };
/** Font size and line height of a stage's label (styles: `.flow-stage .flow-stage-label`), and of its actor line. */
const STAGE_FONT = 14;
const STAGE_LINE = 20;
const OWNER_FONT = 13;

/**
 * A decision diamond's size: just big enough to hold its words. The text block (the label's lines and the
 * actor line under them) fits inside a diamond twice its width and twice its height, plus a margin.
 */
export function decisionSize(
  label: string,
  actor = "",
  chars = STAGE_LABEL_CHARS,
): { width: number; height: number } {
  const lines = wrapWords(label, chars, 3);
  const textW = Math.max(
    ...lines.map((line) => textWidth(line, STAGE_FONT, 600)),
    actor ? textWidth(actor, OWNER_FONT) : 0,
  );
  const textH = STAGE_LINE * lines.length + (actor ? 18 : 0);
  return {
    width: Math.round(Math.min(DECISION_WIDTH, Math.max(DECISION_MIN.width, 2 * textW + 44))),
    height: Math.round(Math.min(DECISION_HEIGHT, Math.max(DECISION_MIN.height, 2 * textH + 20))),
  };
}
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

/** How a flow is laid out. */
export interface FlowLayoutOptions {
  /** `DOWN` (the default) or `RIGHT`. */
  direction?: Direction;
  /** In how many parts to set the flow (`FlowLayout.parts`, default 1); fewer when it has fewer places to cut. */
  parts?: number;
  /** The actor line drawn under each step's label, by step id: a decision diamond is sized to hold it. */
  actors?: ReadonlyMap<string, string>;
  /**
   * One column for a phone (`inColumn`): the steps one under the other in step order, with the narrow boxes
   * and diamonds of a left-to-right flow, and every arrow that skips a step run in a lane on the right.
   */
  column?: boolean;
}

/**
 * Lays out a flow: stages in layers, right-angled transitions with their labels between them. Top to
 * bottom by default; left to right (`direction: "RIGHT"`) is the same layout turned: it is computed top to
 * bottom with every box and label turned on its side, then turned back, so the rules below (lower step
 * numbers first where a path splits, a straight main path, routes clear of boxes) hold either way.
 */
export async function layoutFlow(
  source: ProcessFlow,
  options: FlowLayoutOptions = {},
): Promise<FlowLayout> {
  const direction = options.direction ?? "DOWN";
  const across = direction === "RIGHT";
  const column = !across && options.column === true;
  const narrow = across || column;
  const labelChars = narrow
    ? { stage: STAGE_LABEL_CHARS_ACROSS, decision: DECISION_LABEL_CHARS_ACROSS }
    : { stage: STAGE_LABEL_CHARS, decision: STAGE_LABEL_CHARS };
  // in a left-to-right flow every size goes in turned, and the result is turned back at the end
  const turn = <T extends { width: number; height: number }>(size: T): T =>
    across ? { ...size, width: size.height, height: size.width } : size;
  // (a column has no long routes to save: its ends are drawn once)
  const { boxes, transitions: links }: ReturnType<typeof repeatEnds> = column
    ? {
        boxes: source.stages.map(({ step, shape }) => ({ id: step.id, shape })),
        transitions: source.transitions,
      }
    : repeatEnds(source);
  const flow = { ...source, transitions: links };
  const labelOf = new Map(source.stages.map(({ step }) => [step.id, step.label] as const));
  const decisions = new Set(boxes.filter((b) => b.shape === "decision").map((b) => b.id));
  const children = boxes.map(({ id, shape, copyOf }) => {
    const label = labelOf.get(copyOf ?? id) ?? "";
    return {
      id,
      ...turn(
        shape === "decision"
          ? decisionSize(label, options.actors?.get(copyOf ?? id), labelChars.decision)
          : {
              width: narrow ? STAGE_WIDTH_ACROSS : STAGE_WIDTH,
              height: stageHeight(label, labelChars.stage),
            },
      ),
      ...(copyOf ? { copyOf } : {}),
    };
  });
  const labels = new Map(
    flow.transitions.flatMap((edge) => {
      const text = transitionText(edge);
      if (!text) return [];
      const lines = wrapWords(text, EDGE_LABEL_CHARS);
      const size = turn({
        width: Math.max(...lines.map((line) => textWidth(line, FLOW_FONT))) + 16,
        height: 8 + EDGE_LABEL_LINE * lines.length,
      });
      return [[edge.id, { text, ...size }] as const];
    }),
  );
  const joins = flow.transitions.flatMap((edge) =>
    edge.to === undefined ? [] : [{ ...edge, to: edge.to }],
  );
  if (column) {
    const steps = joins.filter((edge) => edge.from !== edge.to);
    const { result, routed } = inColumn(children, steps, labels, decisions);
    return {
      ...finishFlow(flow, result, steps, routed, labels, children, decisions),
      direction,
      labelChars,
      parts: 1,
      column: true,
    };
  }
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
      nodeGap: narrow ? 28 : 36,
      layerGap: across ? 56 : 70,
      edgeGap: 14,
      pad: { top: 30, right: 24, bottom: 30, left: 24 },
    },
  );
  const transitions = joins.filter(
    (edge) => result.boxes.has(edge.from) && result.boxes.has(edge.to) && edge.from !== edge.to,
  );
  // Where a path splits, the lower step numbers go on the left: the whole flow is mirrored when that
  // agrees with more of its rows than dagre's own order does, and the ends a choice leads to are put in order.
  const number = new Map(source.stages.map(({ step }, i) => [step.id, i] as const));
  const indexOf = (id: string) =>
    number.get(children.find((child) => child.id === id)?.copyOf ?? id) ?? 0;
  const facing = readsBackwards(result, indexOf) ? mirrored(result) : result;
  // The main path of a run of choices goes straight down: a box moves under the one before it, its
  // early exits step aside. Kept only when no route then runs through a box and no box lands on another
  // (an exit moved aside can reach the next choice's ends).
  const ordered = endsInOrder(facing, transitions, indexOf);
  const straight = straightened(ordered, transitions, 36, indexOf);
  let routed: Point[][] = routeFlow(
    straight ?? ordered,
    transitions,
    new Set([...ordered.moved, ...(straight?.moved ?? [])]),
  );
  let placed: LayeredResult = straight ?? ordered;
  if (
    straight &&
    (!clearOfBoxes(routed, transitions, straight.boxes) || !apart(straight.boxes, 0))
  ) {
    routed = routeFlow(ordered, transitions, ordered.moved);
    placed = ordered;
  }
  onDiamonds(routed, transitions, placed.boxes, decisions);
  const laid = finishFlow(flow, placed, transitions, routed, labels, children, decisions);
  const parts = Math.max(1, Math.floor(options.parts ?? 1));
  const split = parts > 1 ? inParts(laid, parts) : undefined;
  const out = {
    ...(split ?? laid),
    direction,
    labelChars,
    parts: split ? parts : 1,
  };
  return across ? turned(out) : out;
}

/** The space between two steps of a column, and between two lanes of arrows beside it. */
const COLUMN_GAP = 40;
const LANE_GAP = 16;

/**
 * One column for a phone, read top to bottom: the boxes one under the other in step order, centred on one
 * line. An arrow to the next step runs straight down. Every other arrow leaves its box on the right, runs
 * in a lane beside the column and comes into its target's right side; the arrows into one step share a
 * lane, and lanes whose runs do not overlap share a place. A box's ends on the right are spread along it.
 */
function inColumn(
  children: readonly { id: string; width: number; height: number }[],
  transitions: readonly { id: string; from: string; to: string }[],
  labels: ReadonlyMap<string, { width: number; height: number }>,
  decisions: ReadonlySet<string>,
): { result: LayeredResult; routed: Point[][] } {
  const pad = { top: 30, side: 24 };
  const widest = Math.max(...children.map((c) => c.width));
  const centre = pad.side + widest / 2;
  const row = new Map(children.map((c, i) => [c.id, i] as const));
  const next = (edge: { from: string; to: string }) => row.get(edge.to) === row.get(edge.from)! + 1;
  const boxes = new Map<string, Box>();
  let y = pad.top;
  children.forEach((c, i) => {
    boxes.set(c.id, { x: centre - c.width / 2, y, width: c.width, height: c.height });
    const down = transitions.find((edge) => edge.from === c.id && row.get(edge.to) === i + 1);
    const words = down && labels.get(down.id);
    y += c.height + Math.max(COLUMN_GAP, words ? words.height + 30 : 0);
  });
  // where each arrow in a lane meets its boxes: the target's end first, then the ways out, along the right side
  const aside = transitions.filter((edge) => !next(edge));
  const ends = new Map<string, number>();
  for (const c of children) {
    const keys = [
      ...(aside.some((edge) => edge.to === c.id) ? [`in:${c.id}`] : []),
      ...aside.filter((edge) => edge.from === c.id).map((edge) => `out:${edge.id}`),
    ];
    const b = boxes.get(c.id)!;
    const step = Math.min(26, b.height / (keys.length + 1));
    keys.forEach((key, k) =>
      ends.set(key, b.y + b.height / 2 + (k - (keys.length - 1) / 2) * step),
    );
  }
  // a box's right side at a height: a diamond's outline narrows toward its top and bottom
  const rightAt = (id: string, at: number) => {
    const b = boxes.get(id)!;
    if (!decisions.has(id)) return b.x + b.width;
    const off = Math.abs(at - (b.y + b.height / 2)) / (b.height / 2);
    return b.x + b.width / 2 + (b.width / 2) * (1 - Math.min(1, off));
  };
  // the lanes: one per target, placed left to right so that runs which overlap get places of their own
  const targets = [...new Set(aside.map((edge) => edge.to))];
  const span = (to: string) => {
    const ys = [
      ends.get(`in:${to}`)!,
      ...aside.filter((edge) => edge.to === to).map((edge) => ends.get(`out:${edge.id}`)!),
    ];
    return { top: Math.min(...ys), bottom: Math.max(...ys) };
  };
  const placeOf = new Map<string, number>();
  const taken: number[] = [];
  for (const to of [...targets].sort((a, b) => span(a).top - span(b).top)) {
    const { top, bottom } = span(to);
    let place = taken.findIndex((last) => last + 12 < top);
    if (place < 0) place = taken.length;
    taken[place] = bottom;
    placeOf.set(to, place);
  }
  // the words on an arrow's way out sit on it, just right of the box; words that would sit on the words of
  // another way out of the same box move right of them
  const wordsAt = new Map<string, number>();
  const placed: { from: string; y: number; height: number; right: number }[] = [];
  for (const edge of aside) {
    const words = labels.get(edge.id);
    if (!words) continue;
    const y = ends.get(`out:${edge.id}`)!;
    const over = placed.filter(
      (p) => p.from === edge.from && Math.abs(p.y - y) < (p.height + words.height) / 2 + 2,
    );
    const x = Math.max(rightAt(edge.from, y) + 8, ...over.map((p) => p.right + 6));
    wordsAt.set(edge.id, x);
    placed.push({ from: edge.from, y, height: words.height, right: x + words.width });
  }
  // the first lane clears the boxes and those words
  const first = Math.max(
    ...children.map((c) => boxes.get(c.id)!.x + c.width + 16),
    ...placed.map((p) => p.right + 12),
  );
  const routes = new Map<string, { via: Point[]; label?: Point }>();
  const routed = transitions.map((edge) => {
    const from = boxes.get(edge.from)!,
      to = boxes.get(edge.to)!;
    const words = labels.get(edge.id);
    if (next(edge)) {
      const start = { x: centre, y: from.y + from.height };
      const end = { x: centre, y: to.y };
      routes.set(edge.id, {
        via: [],
        ...(words ? { label: { x: centre, y: (start.y + end.y) / 2 } } : {}),
      });
      return [start, end];
    }
    const out = ends.get(`out:${edge.id}`)!;
    const into = ends.get(`in:${edge.to}`)!;
    const lane = first + LANE_GAP * placeOf.get(edge.to)!;
    const start = { x: rightAt(edge.from, out), y: out };
    routes.set(edge.id, {
      via: [],
      ...(words ? { label: { x: wordsAt.get(edge.id)! + words.width / 2, y: out } } : {}),
    });
    return [
      start,
      { x: lane, y: out },
      { x: lane, y: into },
      { x: rightAt(edge.to, into), y: into },
    ];
  });
  const width = first + LANE_GAP * Math.max(0, taken.length - 1) + pad.side;
  return { result: { width, height: y - COLUMN_GAP + pad.top, boxes, routes }, routed };
}

/**
 * A decision's arrows start and end on the diamond's outline, not on its bounding box: an arrow that
 * leaves the bottom beside the tip starts where the diamond's lower edge is above it.
 */
function onDiamonds(
  routed: Point[][],
  transitions: readonly { from: string; to: string }[],
  boxes: ReadonlyMap<string, Box>,
  decisions: ReadonlySet<string>,
): void {
  const snap = (point: Point, next: Point, id: string) => {
    const b = boxes.get(id);
    if (!b || !decisions.has(id) || Math.abs(point.x - next.x) > 0.5) return;
    const cx = b.x + b.width / 2,
      cy = b.y + b.height / 2;
    const off = Math.min(1, Math.abs(point.x - cx) / (b.width / 2));
    point.y = cy + Math.sign(point.y - cy) * (b.height / 2) * (1 - off);
  };
  routed.forEach((points, n) => {
    const edge = transitions[n]!;
    if (points.length < 2) return;
    snap(points[0]!, points[1]!, edge.from);
    snap(points[points.length - 1]!, points[points.length - 2]!, edge.to);
  });
}

/** A layout computed top to bottom with turned sizes, turned back: x and y swap, and so do width and height. */
function turned(layout: FlowLayout): FlowLayout {
  const p = (point: Point): Point => ({ x: point.y, y: point.x });
  return {
    ...layout,
    width: layout.height,
    height: layout.width,
    children: layout.children.map((c) => ({
      ...c,
      x: c.y,
      y: c.x,
      width: c.height,
      height: c.width,
    })),
    edges: layout.edges.map((edge) => ({
      ...edge,
      sections: edge.sections.map((s) => ({
        startPoint: p(s.startPoint),
        bendPoints: s.bendPoints.map(p),
        endPoint: p(s.endPoint),
      })),
      labels: edge.labels.map((l) => ({ ...l, x: l.y, y: l.x, width: l.height, height: l.width })),
    })),
  };
}

/** The scale a flow is shown at when fitted into a pane (PanZoom's "Fit"). */
function flowFit(
  layout: { width: number; height: number },
  pane: { width: number; height: number },
) {
  return Math.min(
    FIT_MAX_ZOOM,
    (pane.width - 48) / layout.width,
    (pane.height - 48) / layout.height,
  );
}
/** The largest zoom a fitted flow is drawn at (PanZoom's default `maxFitZoom`). */
const FIT_MAX_ZOOM = 1.25;
/** Left to right has to fit this much larger to win: a flow reads top to bottom otherwise. */
const ACROSS_MARGIN = 1.08;

/** An upright pane narrower than this, px (a phone), shows a flow as one column, top to bottom. */
export const NARROW_PANE = 600;

/**
 * Lays the flow out for a pane of the given size: top to bottom while that shows the flow at its natural
 * size. Else by the pane's shape: an upright phone pane keeps one column (the reader scrolls one way); a
 * landscape pane sets the flow left to right, in the rows that show it largest; an upright wider pane sets it
 * top to bottom in columns. Columns in a landscape pane cut between choices, and send each choice's exits
 * down, across and back up past each other.
 */
export async function layoutFlowFitting(
  flow: ProcessFlow,
  pane: { width: number; height: number } | undefined,
  options: Omit<FlowLayoutOptions, "direction" | "parts"> = {},
): Promise<FlowLayout> {
  const down = await layoutFlow(flow, options);
  if (!pane || pane.width <= 0 || pane.height <= 0 || flowFit(down, pane) >= 1) return down;
  const upright = pane.height > pane.width;
  if (upright && pane.width < NARROW_PANE) return layoutFlow(flow, { ...options, column: true });
  const direction = upright ? "DOWN" : "RIGHT";
  let best = down;
  for (let parts = upright ? 2 : 1; parts <= MAX_PARTS; parts++) {
    const layout = await layoutFlow(flow, { ...options, direction, parts });
    if (layout.parts !== parts) break;
    if (flowFit(layout, pane) > flowFit(best, pane) * (best === down ? ACROSS_MARGIN : 1))
      best = layout;
  }
  return best;
}

/** The most parts a flow is set in (`FlowLayout.parts`). */
const MAX_PARTS = 4;
/** The space between two parts of a flow: the arrows from one part to the next run in it. */
const PART_GAP = 56;
/** The space between two lanes of arrows from one part to the next. */
const WRAP_LANE = 16;

/**
 * A top-to-bottom layout set in `parts` columns side by side, like a newspaper: cut between two layers
 * (where every arrow across the cut goes down, and its label is above the cut), each lower piece moved up
 * beside the one before. An arrow across a cut goes down past the bottom of its column, through the gap to
 * the right, up over the next column and down into its box. Undefined when there are not enough such cuts.
 * (A left-to-right flow is set in rows the same way: it is laid out turned.)
 */
function inParts(
  layout: Omit<FlowLayout, "direction" | "labelChars" | "parts">,
  parts: number,
): Omit<FlowLayout, "direction" | "labelChars" | "parts"> | undefined {
  const boxes = new Map(layout.children.map((c) => [c.id, c] as const));
  const top = Math.min(...layout.children.map((c) => c.y));
  const bottom = Math.max(...layout.children.map((c) => c.y + c.height));
  // the tops of the bands of boxes after the first: where the flow can be cut
  const spans = [...layout.children].sort((a, b) => a.y - b.y);
  const cuts: number[] = [];
  let reach = -Infinity;
  for (const c of spans) {
    if (c.y > reach + 0.5 && reach > -Infinity) cuts.push(c.y);
    reach = Math.max(reach, c.y + c.height);
  }
  const pointsOf = (edge: FlowLayout["edges"][number]) =>
    edge.sections.flatMap((s) => [s.startPoint, ...s.bendPoints, s.endPoint]);
  const fits = (cut: number) =>
    layout.edges.every((edge) => {
      if (edge.to === undefined || edge.to === edge.from) return true;
      const above = (id: string) => boxes.get(id)!.y < cut;
      if (above(edge.from) === above(edge.to)) return true;
      // only arrows that go down across the cut, their words above it
      return above(edge.from) && edge.labels.every((l) => l.y + l.height < cut);
    });
  // the cuts that make the longest part shortest, each arrow across a cut beyond the first counted as an
  // eighth of the flow's length: a part that ends on a choice leaves its exits hanging in the next one
  const valid = cuts.filter(fits);
  const across = (cut: number) =>
    layout.edges.filter(
      (edge) =>
        edge.to !== undefined &&
        edge.to !== edge.from &&
        boxes.get(edge.from)!.y < cut !== boxes.get(edge.to)!.y < cut,
    ).length;
  const crossings = new Map(valid.map((cut) => [cut, across(cut)] as const));
  let chosen: number[] | undefined;
  let cost = Infinity;
  const pick = (from: number, list: number[]) => {
    if (list.length === parts - 1) {
      const ends = [top, ...list, bottom];
      const longest = Math.max(...ends.slice(1).map((end, i) => end - ends[i]!));
      const extra = list.reduce((sum, cut) => sum + crossings.get(cut)! - 1, 0);
      const value = longest + ((bottom - top) / 8) * extra;
      if (value < cost) {
        cost = value;
        chosen = list;
      }
      return;
    }
    for (let i = from; i < valid.length; i++) pick(i + 1, [...list, valid[i]!]);
  };
  if (valid.length <= 24) pick(0, []);
  if (!chosen) return undefined;
  const cutsAt: number[] = chosen;
  cutsAt.sort((a, b) => a - b);
  const partOf = (id: string) => {
    const y = boxes.get(id)!.y;
    return cutsAt.filter((cut) => y >= cut).length;
  };
  if (new Set(layout.children.map((c) => partOf(c.id))).size !== parts) return undefined;
  const crossing = layout.edges.filter(
    (edge) =>
      edge.to !== undefined && edge.to !== edge.from && partOf(edge.from) !== partOf(edge.to),
  );
  // each part's extent across, from its boxes, its own arrows and words, and the upper ends of the arrows that leave it
  const kept = new Map(
    crossing.map((edge) => {
      const points = pointsOf(edge);
      const cut = cutsAt[partOf(edge.from)]!;
      const at = points.findIndex((p) => p.y >= cut);
      const head = points.slice(0, Math.max(1, at));
      // a sideways jog toward where the box used to be is dropped when the arrow can go straight down
      // from before it, past no box of its part
      const part = partOf(edge.from);
      const clear = (p: Point) =>
        layout.children.every(
          (c) =>
            c.id === edge.from ||
            partOf(c.id) !== part ||
            c.y + c.height <= p.y ||
            p.x <= c.x ||
            p.x >= c.x + c.width,
        );
      while (
        head.length >= 2 &&
        Math.abs(head[head.length - 1]!.y - head[head.length - 2]!.y) < 0.5 &&
        clear(head[head.length - 2]!)
      )
        head.pop();
      return [edge.id, head] as const;
    }),
  );
  const lo = Array<number>(parts).fill(Infinity),
    hi = Array<number>(parts).fill(-Infinity),
    low = Array<number>(parts).fill(-Infinity);
  const extend = (part: number, x0: number, x1: number, y1: number) => {
    lo[part] = Math.min(lo[part]!, x0);
    hi[part] = Math.max(hi[part]!, x1);
    low[part] = Math.max(low[part]!, y1);
  };
  for (const c of layout.children) extend(partOf(c.id), c.x, c.x + c.width, c.y + c.height);
  for (const edge of layout.edges) {
    const part = partOf(edge.from);
    const points = kept.get(edge.id) ?? pointsOf(edge);
    for (const p of points) extend(part, p.x, p.x, crossing.includes(edge) ? -Infinity : p.y);
    for (const l of edge.labels) extend(part, l.x, l.x + l.width, l.y + l.height);
  }
  // The arrows that leave one box share a lane (one trunk, split only near their ends), and the lanes keep
  // `WRAP_LANE` apart: the arrow that leaves furthest along runs innermost, so no two of them cross.
  const headEnd = (edge: FlowLayout["edges"][number]) => {
    const head = kept.get(edge.id)!;
    return head[head.length - 1]!.x;
  };
  const sources = [...new Set(crossing.map((edge) => edge.from))];
  const farthest = (from: string) =>
    Math.max(...crossing.filter((edge) => edge.from === from).map(headEnd));
  sources.sort((a, b) => farthest(b) - farthest(a));
  const lanes = sources.length;
  const dx: number[] = [],
    dy: number[] = [];
  let cursor = Math.min(...lo);
  for (let part = 0; part < parts; part++) {
    dx.push(cursor - lo[part]!);
    dy.push(part === 0 ? 0 : top - cutsAt[part - 1]!);
    cursor += hi[part]! - lo[part]! + PART_GAP + WRAP_LANE * Math.max(0, lanes - 1);
  }
  const move =
    (part: number) =>
    (p: Point): Point => ({ x: p.x + dx[part]!, y: p.y + dy[part]! });
  const children = layout.children.map((c) => {
    const m = move(partOf(c.id))(c);
    return { ...c, x: m.x, y: m.y };
  });
  const edges = layout.edges.map((edge) => {
    const from = partOf(edge.from);
    if (!crossing.includes(edge)) {
      const m = move(from);
      return {
        ...edge,
        sections: edge.sections.map((s) => ({
          startPoint: m(s.startPoint),
          bendPoints: s.bendPoints.map(m),
          endPoint: m(s.endPoint),
        })),
        labels: edge.labels.map((l) => ({ ...l, ...m(l) })),
      };
    }
    const lane = sources.indexOf(edge.from);
    const to = partOf(edge.to!);
    const head = kept.get(edge.id)!.map(move(from));
    const last = head[head.length - 1]!;
    const points = pointsOf(edge);
    const end = move(to)(points[points.length - 1]!);
    const run = low[from]! + dy[from]! + 18 + WRAP_LANE * lane;
    const gutter = hi[from]! + dx[from]! + PART_GAP / 2 + WRAP_LANE * lane;
    const over = top - 16 - WRAP_LANE * lane;
    const route = [
      ...head,
      { x: last.x, y: run },
      { x: gutter, y: run },
      { x: gutter, y: over },
      { x: end.x, y: over },
      end,
    ];
    return {
      ...edge,
      sections: [
        {
          startPoint: route[0]!,
          bendPoints: route.slice(1, -1),
          endPoint: route[route.length - 1]!,
        },
      ],
      labels: edge.labels.map((l) => ({ ...l, ...move(from)(l) })),
    };
  });
  // everything back inside the picture, with the padding the layout had
  const all = edges.flatMap((edge) => [
    ...pointsOf(edge),
    ...edge.labels.flatMap((l) => [
      { x: l.x, y: l.y },
      { x: l.x + l.width, y: l.y + l.height },
    ]),
  ]);
  const minX = Math.min(...children.map((c) => c.x), ...all.map((p) => p.x));
  const minY = Math.min(...children.map((c) => c.y), ...all.map((p) => p.y));
  const shiftX = Math.max(0, 24 - minX),
    shiftY = Math.max(0, 30 - minY);
  const shifted = (p: Point): Point => ({ x: p.x + shiftX, y: p.y + shiftY });
  const outChildren = children.map((c) => ({ ...c, ...shifted(c) }));
  const outEdges = edges.map((edge) => ({
    ...edge,
    sections: edge.sections.map((s) => ({
      startPoint: shifted(s.startPoint),
      bendPoints: s.bendPoints.map(shifted),
      endPoint: shifted(s.endPoint),
    })),
    labels: edge.labels.map((l) => ({ ...l, ...shifted(l) })),
  }));
  const maxX = Math.max(
    ...outChildren.map((c) => c.x + c.width),
    ...outEdges.flatMap((edge) => [
      ...pointsOf(edge).map((p) => p.x),
      ...edge.labels.map((l) => l.x + l.width),
    ]),
  );
  const maxY = Math.max(
    ...outChildren.map((c) => c.y + c.height),
    ...outEdges.flatMap((edge) => [
      ...pointsOf(edge).map((p) => p.y),
      ...edge.labels.map((l) => l.y + l.height),
    ]),
  );
  return { width: maxX + 24, height: maxY + 30, children: outChildren, edges: outEdges };
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
 * The flow with the boxes one choice leads to (each with no other way in, side by side in one layer) in step
 * order, the lowest number first: read left to right, or top to bottom once a left-to-right flow is turned.
 * Boxes of other sizes keep the room they had between them. `moved` names the boxes that moved.
 */
function endsInOrder(
  result: LayeredResult,
  transitions: readonly { from: string; to: string }[],
  indexOf: (id: string) => number,
): LayeredResult & { moved: Set<string> } {
  const boxes = new Map([...result.boxes].map(([id, b]) => [id, { ...b }]));
  const out = new Map<string, string[]>();
  const into = new Map<string, number>();
  for (const edge of transitions) {
    out.set(edge.from, [...(out.get(edge.from) ?? []), edge.to]);
    into.set(edge.to, (into.get(edge.to) ?? 0) + 1);
  }
  const centreY = (b: Box) => Math.round(b.y + b.height / 2);
  const moved = new Set<string>();
  for (const nexts of out.values()) {
    const ends = [...new Set(nexts)].filter((id) => into.get(id) === 1);
    const row = ends.map((id) => boxes.get(id)!).sort((a, b) => a.x - b.x);
    if (ends.length < 2 || row.some((b) => centreY(b) !== centreY(row[0]!))) continue;
    // (no other box between them: they swap only among themselves)
    const left = row[0]!.x,
      right = row[row.length - 1]!.x + row[row.length - 1]!.width;
    const between = [...boxes].some(
      ([id, b]) =>
        !ends.includes(id) && centreY(b) === centreY(row[0]!) && b.x > left && b.x < right,
    );
    if (between) continue;
    const gap = row.length > 1 ? row[1]!.x - (row[0]!.x + row[0]!.width) : 0;
    let x = left;
    for (const id of [...ends].sort((a, b) => indexOf(a) - indexOf(b))) {
      const b = boxes.get(id)!;
      if (Math.abs(b.x - x) >= 0.5) moved.add(id);
      b.x = x;
      x += b.width + gap;
    }
  }
  return { ...result, boxes, moved };
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
    // an exit pushed aside onto a box of another branch: this box stays where dagre put it
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
  decisions: ReadonlySet<string>,
): Omit<FlowLayout, "direction" | "labelChars" | "parts"> {
  const loops = flow.transitions
    .filter((edge) => edge.from === edge.to && result.boxes.has(edge.from))
    .map((edge) =>
      loopTransition(
        edge,
        result.boxes.get(edge.from)!,
        labels.get(edge.id),
        decisions.has(edge.from),
      ),
    );
  const exits = flow.transitions
    .filter((edge) => edge.to === undefined && result.boxes.has(edge.from))
    .map((edge) =>
      exitTransition(
        edge,
        result.boxes.get(edge.from)!,
        labels.get(edge.id),
        decisions.has(edge.from),
      ),
    );
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
  diamond: boolean,
): FlowLayout["edges"][number] {
  const right = box.x + box.width;
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
  diamond: boolean,
): FlowLayout["edges"][number] {
  const right = box.x + box.width;
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

/**
 * A flow of states (`stateRoles`) as a state diagram: the states are its boxes, and each move is a labelled
 * arrow from the state before it to the state after it. `moveOf` names the move step of each arrow (a move
 * reached from two states is two arrows), so a click on an arrow still picks the move and its code.
 * Undefined when a move has no state before it: it would have no arrow to be drawn on.
 */
export function stateMachine(
  flow: ProcessFlow,
  roles: ReadonlyMap<string, "state" | "move">,
): { flow: ProcessFlow; moveOf: Map<string, string> } | undefined {
  const after = new Map<string, string>();
  for (const edge of flow.transitions)
    if (roles.get(edge.from) === "move" && edge.to !== undefined) after.set(edge.from, edge.to);
  const labels = new Map(flow.stages.map(({ step }) => [step.id, step.label] as const));
  const moveOf = new Map<string, string>();
  const reached = new Set<string>();
  const transitions = flow.transitions.flatMap((edge) => {
    const move = edge.to;
    if (roles.get(edge.from) !== "state" || move === undefined || roles.get(move) !== "move")
      return [];
    const to = after.get(move);
    if (to === undefined) return [];
    const id = reached.has(move) ? `${move}#from:${edge.from}` : move;
    reached.add(move);
    moveOf.set(id, move);
    return [{ id, from: edge.from, to, label: labels.get(move) ?? "" }];
  });
  const moves = [...roles].filter(([, role]) => role === "move").map(([id]) => id);
  if (moves.some((move) => !reached.has(move))) return undefined;
  return {
    flow: {
      ...flow,
      stages: flow.stages.filter(({ step }) => roles.get(step.id) === "state"),
      transitions,
    },
    moveOf,
  };
}

/**
 * The states and the moves of a flow that `xpl draft states` drew, by step id, or undefined for any
 * other flow. Such a flow starts at the status type (its entry point and first participant); a state step
 * runs from that type to itself and leads only to moves, and a move step runs inside the function that
 * makes it and leads to one state. The viewer draws states as pills and moves as labelled arrows between
 * them (`stateMachine`), with no step numbers: a state machine has no order to number.
 */
export function stateRoles(
  view: Pick<SequenceView, "type" | "scope" | "participants" | "steps">,
): Map<string, "state" | "move"> | undefined {
  const entry = view.scope?.entryPoints?.[0];
  const owner = Array.isArray(view.participants) ? view.participants[0] : undefined;
  const steps = Array.isArray(view.steps) ? view.steps : [];
  if (view.type !== "flow" || !entry || !owner || steps.length < 2) return undefined;
  if (owner !== `sym:${entry}` && owner !== `file:${entry}`) return undefined;
  const roles = new Map<string, "state" | "move">();
  for (const step of steps) {
    if (step.from !== step.to) return undefined;
    roles.set(step.id, step.from === owner ? "state" : "move");
  }
  const ok = steps.every((step) => {
    const next = (step.next ?? []).map((link) => roles.get(link.step ?? ""));
    return roles.get(step.id) === "state"
      ? next.every((role) => role === "move")
      : next.length === 1 && next[0] === "state";
  });
  const kinds = new Set(roles.values());
  return ok && kinds.size === 2 ? roles : undefined;
}
