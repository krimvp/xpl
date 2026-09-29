/**
 * The arithmetic of the header's view tabs (components/ViewTabs.tsx), kept apart from the DOM so that it can
 * be tested: which ends of the strip have more tabs beyond them, where to scroll to bring a tab into sight,
 * how far a wheel turn moves the strip and which entry an arrow key moves to.
 */

/** Which ends of a scrolled strip have content beyond them (those get an arrow and a fade). */
export interface StripEdges {
  start: boolean;
  end: boolean;
}

/** `slack` forgives the fractions of a pixel that a zoomed or scaled page scrolls to. */
export function stripEdges(
  scrollLeft: number,
  scrollWidth: number,
  clientWidth: number,
  slack = 1,
): StripEdges {
  const max = Math.max(0, scrollWidth - clientWidth);
  return { start: scrollLeft > slack, end: scrollLeft < max - slack };
}

/**
 * The scroll position that brings a tab (the run `[left, right]` of the strip's scrollable width) into
 * sight. It is the current position when the tab is in sight already, clear of the arrows and fades that
 * overlay the ends of the strip (`room` wide). A tab too wide for that but not for the strip is centred;
 * one wider than the strip is shown from its start. Always within what the strip can scroll to.
 */
export function revealOffset(
  strip: { scrollLeft: number; width: number; scrollWidth: number },
  tab: { left: number; right: number },
  room: number,
): number {
  const max = Math.max(0, strip.scrollWidth - strip.width);
  const width = tab.right - tab.left;
  let next = strip.scrollLeft;
  if (width > strip.width) {
    next = tab.left - room;
  } else if (width + 2 * room > strip.width) {
    next = tab.left - (strip.width - width) / 2;
  } else if (tab.left - room < next) {
    next = tab.left - room;
  } else if (tab.right + room > next + strip.width) {
    next = tab.right + room - strip.width;
  }
  return Math.min(max, Math.max(0, next));
}

/** How many pixels a line of a wheel that counts in lines is worth. */
const WHEEL_LINE = 16;

/**
 * How far a wheel turn moves a strip that scrolls sideways: a mouse wheel turns up and down, so its vertical
 * travel becomes the strip's horizontal one. Undefined for a gesture that is sideways already (a trackpad,
 * shift and the wheel): the browser scrolls the strip for those.
 */
export function wheelTravel(
  event: { deltaX: number; deltaY: number; deltaMode: number },
  pageWidth: number,
): number | undefined {
  if (Math.abs(event.deltaX) >= Math.abs(event.deltaY)) return undefined;
  const unit = event.deltaMode === 1 ? WHEEL_LINE : event.deltaMode === 2 ? pageWidth : 1;
  return event.deltaY * unit;
}

/**
 * The entry a key moves to in a row (or a column) of `count` entries, `at` being the one that has the focus
 * (-1 when none has): the arrows step and wrap round, Home and End jump. Undefined for any other key.
 */
export function stepIndex(
  key: string,
  at: number,
  count: number,
  keys: { prev: string; next: string },
): number | undefined {
  if (count === 0) return undefined;
  if (key === "Home") return 0;
  if (key === "End") return count - 1;
  if (key === keys.next) return at < 0 ? 0 : (at + 1) % count;
  if (key === keys.prev) return at < 0 ? count - 1 : (at - 1 + count) % count;
  return undefined;
}
