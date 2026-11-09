import type { KeyboardEvent } from "react";

const FOCUSABLE =
  "input:not(:disabled), select:not(:disabled), textarea:not(:disabled), button:not(:disabled), a[href], summary";

/**
 * Tab and Shift+Tab stay inside `root` (an open dialog): past its last control focus goes to the first, and
 * back. Other keys pass.
 */
export function keepTabInside(event: KeyboardEvent<HTMLElement>, root: HTMLElement | null): void {
  if (event.key !== "Tab" || !root) return;
  const focusable = [...root.querySelectorAll<HTMLElement>(FOCUSABLE)].filter(
    (el) => el.getClientRects().length > 0,
  );
  const first = focusable[0];
  const last = focusable.at(-1);
  if (!first || !last) return;
  const at = document.activeElement;
  if (event.shiftKey && (at === first || at === root)) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && at === last) {
    event.preventDefault();
    first.focus();
  }
}
