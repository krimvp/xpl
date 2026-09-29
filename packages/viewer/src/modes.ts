/**
 * The seam between Explore mode (this phase) and Present mode (tours; a later phase).
 *
 * The store keeps `mode` and `tour` (see store.ts); App picks the layout from `mode`; the header shows
 * the toggle. Turning Present on means: flip PRESENT_AVAILABLE, implement `present/PresentMode.tsx`, and
 * let the store's `setTour` drive it (`?mode=present&tour=<id>&step=<n>` is already parsed into the
 * launch parameters, and `ViewerBundle.mode` / `.tour` are passed through).
 */
export type Mode = "explore" | "present";

/** Present mode is not built yet: the header shows its toggle disabled and the store stays in explore. */
export const PRESENT_AVAILABLE = false;

/** Where a tour is: `step` is an index into `Tour.steps`. */
export interface TourPosition {
  tourId: string;
  step: number;
}
