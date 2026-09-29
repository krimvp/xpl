/**
 * Text widths for the diagram layouts. The SVG text and this measurement use the same font stack, so
 * boxes fit their labels; without a canvas (tests, odd environments) a per-character estimate is used.
 */
export const UI_FONT = 'system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", sans-serif';

let context: CanvasRenderingContext2D | null | undefined;
const cache = new Map<string, number>();

function canvas(): CanvasRenderingContext2D | null {
  if (context !== undefined) return context;
  try {
    context = document.createElement("canvas").getContext("2d");
  } catch {
    context = null;
  }
  return context;
}

/** Width in px of `text` set in `font` (a CSS font shorthand such as `600 13px system-ui`). */
export function textWidth(text: string, size: number, weight: number | string = 400): number {
  const key = `${weight}|${size}|${text}`;
  const known = cache.get(key);
  if (known !== undefined) return known;
  const ctx = canvas();
  let width: number;
  if (ctx) {
    ctx.font = `${weight} ${size}px ${UI_FONT}`;
    width = ctx.measureText(text).width;
  } else {
    width = text.length * size * 0.58;
  }
  cache.set(key, width);
  return width;
}
