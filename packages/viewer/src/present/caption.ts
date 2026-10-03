/**
 * The caption of a talk (PresentMode): how much of the left column it may take, and at which type size.
 * One size and one height for the whole tour, so that nothing jumps from step to step.
 */

/**
 * The diagram's room in a talk, px of its drawing area: never less than this, or than 45% of the left
 * column on a very short screen. The caption gets what is left.
 */
const DIAGRAM_MIN = 200;
const DIAGRAM_MIN_SHARE = 0.45;
/** The gap between the diagram and the caption (`.present-left` gap). */
const GAP = 8;
/** The caption's type sizes, largest first (`.tour-caption[data-size]` in styles.css). */
const CAPTION_SIZES = 4;

/** The most the caption may take of a left column `height` px tall, `chrome` px of it the diagram's title bar. */
export function captionCap(height: number, chrome: number): number {
  const diagram = Math.min(DIAGRAM_MIN, Math.round(height * DIAGRAM_MIN_SHARE));
  return Math.max(80, height - GAP - chrome - diagram);
}

/**
 * The caption's type size and height for a tour: the largest size at which its tallest caption fits `cap`
 * (a tour with a long note starts one size down); at the smallest size, the tallest or `cap`, whichever is
 * less (a note longer than that scrolls inside the caption). `tallestAt` measures the copies at a size.
 */
export function captionFit(
  tallestAt: (size: number) => number,
  cap: number,
  long: boolean,
): { size: number; height: number } {
  let size = long ? 1 : 0;
  for (; ; size++) {
    const tallest = tallestAt(size);
    if (tallest <= cap || size === CAPTION_SIZES - 1)
      return { size, height: Math.ceil(Math.min(tallest, cap)) };
  }
}
