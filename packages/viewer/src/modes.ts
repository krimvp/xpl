/**
 * Explore and Present (ARCHITECTURE.md section 6).
 *
 * Explore is the full diagram with the concept list, the details panel and the file tree. Present plays a
 * tour: every step applies a view, a focus, a code override and a caption (see store.ts and present/).
 * `?mode=present&tour=<id>&step=<n>` (n counts from 1) and `ViewerBundle.mode` / `.tour` choose where the
 * page starts; url.ts keeps the address bar in sync afterwards.
 */
export type Mode = "explore" | "present";

/**
 * Where a tour is: `step` is an index into `Tour.steps` (0-based). Everything a person sees or types
 * (the URL, `window.__xpl`, the "2 / 5" counter) counts from 1: use `stepNumber` / `stepIndex`.
 */
export interface TourPosition {
  tourId: string;
  step: number;
}

/** 0-based index -> the number shown to people. */
export const stepNumber = (index: number): number => index + 1;

/** An index into a tour of `count` steps, clamped to it (0 for an empty tour). */
export function clampStep(index: number, count: number): number {
  if (!Number.isFinite(index)) return 0;
  return Math.min(Math.max(0, Math.floor(index)), Math.max(0, count - 1));
}

/** The 1-based number of the URL and the hooks -> an index into `Tour.steps`, clamped to the tour. */
export function stepIndex(number: number | undefined, count: number): number {
  return number === undefined ? 0 : clampStep(number - 1, count);
}
