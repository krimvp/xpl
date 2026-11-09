/**
 * What the first view of a sequence frames (viewport.ts `frameView`), shared by the live diagram
 * (SequenceView, Present) and the Guide's still picture (Snapshot): the selected arrows and lifelines, and
 * the rest of the diagram as boxes not to cut.
 *
 * - Each selected arrow is one focus box: its label with both its lifelines (who talks to whom), and the
 *   condition of the choice it is in when that is near (an `alt` from its top, so the first arm's condition
 *   shows too). Its label (`core`) is what stays in view when even one is too wide. The lifelines the arrows
 *   after it join are its neighbours: they come in, nearest first, while the frame can zoom out for them.
 * - Above each, the room the sticky lifeline names take once the view starts lower down: a label is shown
 *   under them, never behind them.
 * - A selected lifeline is its head, with its own arrows as neighbours: they come in while there is room.
 * - `others`: every arrow's words, every arrow end to end with them (with the same room above), and every
 *   lifeline. The frame slides to cut as few as it can: it does not start mid-label or cut a lifeline's name
 *   in half, and keeps the lifelines the arrows in sight join, not empty ones (`fill`).
 */
import type { SequenceLayout, Row } from "./layout/sequenceLayout.js";
import { frameLabelWidth } from "./layout/sequenceLayout.js";
import { unionBox, type Box, type Focus } from "./viewport.js";

/** How far above a step (layout units) the condition of the choice it is in is still drawn with it. */
const CONDITION_REACH = 360;
/** Room kept between the sticky names and what is under them, layout units. */
const UNDER_HEADS = 12;

/** The words of an arrow, as drawn (layout units). */
export function labelBox(row: Row): Box {
  const left = row.labelAnchor === "middle" ? row.labelX - row.labelWidth / 2 : row.labelX;
  return {
    x: Math.max(row.bandLeft, left - 12),
    y: row.bandTop,
    width: row.labelWidth + 24,
    height: row.bandBottom - row.bandTop,
  };
}

export function sequenceFocus(
  layout: SequenceLayout,
  selected: ReadonlySet<string>,
): Focus & { core?: Box } {
  const heads = (layout.lifelines[0]?.headHeight ?? 0) + UNDER_HEADS;
  /** `box` with the sticky names' room above it (never above the top of the diagram). */
  const roomAbove = (box: Box): Box => {
    const y = Math.max(0, box.y - heads);
    return { ...box, y, height: box.height + box.y - y };
  };
  const lanes = new Map(layout.lifelines.map((lifeline) => [lifeline.id, lifeline]));
  const column = (id: string | undefined, top: number, height: number): Box[] => {
    const lifeline = id === undefined ? undefined : lanes.get(id);
    return lifeline
      ? [{ x: lifeline.x - lifeline.headWidth / 2, y: top, width: lifeline.headWidth, height }]
      : [];
  };
  const boxes: Box[] = [];
  const neighbours: Box[] = [];
  let core: Box | undefined;
  for (const row of layout.rows) {
    if (!selected.has(row.step.id)) continue;
    const label = labelBox(row);
    const own: Box[] = [
      label,
      ...column(row.step.from, label.y, label.height),
      ...column(row.step.to, label.y, label.height),
    ];
    for (const box of layout.frames) {
      if (!box.steps.includes(row.step.id)) continue;
      const width = Math.min(box.width, frameLabelWidth(box.frame.kind, box.frame.label));
      const arm = box.arms.find((one) => one.steps.includes(row.step.id));
      // a choice from its top (every arm's condition) when near, else from the arm's own line
      const top =
        label.y - box.y <= CONDITION_REACH ? box.y : arm && arm !== box.arms[0] ? arm.top : box.y;
      const condition = { x: box.x, y: top, width, height: label.y - top };
      if (box.frame.kind !== "loop" && label.y - top <= CONDITION_REACH) own.push(condition);
      else neighbours.push({ x: box.x, y: label.y, width, height: label.height });
    }
    core ??= label;
    boxes.push(roomAbove(unionBox(own)!));
    // (the lifelines the arrows after it end on, at its height: the frame zooms out, down to its floor, to
    // keep their names whole, so the reader sees where the run goes next)
    const after = layout.rows.slice(layout.rows.indexOf(row) + 1);
    for (const id of new Set(after.flatMap((next) => [next.step.from, next.step.to])))
      if (id !== row.step.from && id !== row.step.to)
        neighbours.push(...column(id, label.y, label.height));
  }
  for (const lifeline of layout.lifelines) {
    if (!selected.has(lifeline.id)) continue;
    const head = {
      x: lifeline.x - lifeline.headWidth / 2,
      y: lifeline.headTop,
      width: lifeline.headWidth,
      height: lifeline.headHeight,
    };
    core ??= head;
    boxes.push(head);
    // (its own arrows, nearest first: a picture about a participant shows its calls)
    for (const row of layout.rows)
      if (row.step.from === lifeline.id || row.step.to === lifeline.id)
        neighbours.push(
          roomAbove(
            unionBox([
              labelBox(row),
              ...column(row.step.from, row.bandTop, 1),
              ...column(row.step.to, row.bandTop, 1),
            ])!,
          ),
        );
  }
  // (each arrow whole, from end to end with its words: a lifeline with no arrow in the window is not kept)
  // (each arrow twice: its words, which a side must never cut, and the arrow end to end with them)
  const others = layout.rows.flatMap((row) => {
    const words = labelBox(row);
    const band = {
      x: row.bandLeft,
      y: row.bandTop,
      width: row.bandRight - row.bandLeft,
      height: row.bandBottom - row.bandTop,
    };
    return [roomAbove(words), roomAbove(unionBox([words, band])!)];
  });
  // (and each lifeline, top to bottom: a side does not cut its name in half)
  for (const lifeline of layout.lifelines)
    others.push({
      x: lifeline.x - lifeline.headWidth / 2,
      y: lifeline.headTop,
      width: lifeline.headWidth,
      height: layout.height - lifeline.headTop,
    });
  return { boxes, neighbours, others, core, fill: true };
}
