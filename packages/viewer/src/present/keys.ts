/**
 * The keyboard of Present mode. Pure functions (the listener lives in App.tsx), so the key table is
 * unit-tested without a browser.
 *
 *   ArrowRight, PageDown, Space   next step          ArrowLeft, PageUp, Shift+Space   previous step
 *   Home / End                    first / last step  Escape                            leave Present
 */
export type TourKeyAction = "next" | "prev" | "first" | "last" | "exit";

export interface KeyLike {
  key: string;
  shiftKey?: boolean;
  ctrlKey?: boolean;
  metaKey?: boolean;
  altKey?: boolean;
}

/** What a key press does in Present; undefined for every other key (and for browser shortcuts). */
export function tourKeyAction(event: KeyLike): TourKeyAction | undefined {
  if (event.ctrlKey || event.metaKey || event.altKey) return undefined;
  switch (event.key) {
    case "ArrowRight":
    case "PageDown":
      return "next";
    case " ":
    case "Spacebar":
      return event.shiftKey ? "prev" : "next";
    case "ArrowLeft":
    case "PageUp":
      return "prev";
    case "Home":
      return "first";
    case "End":
      return "last";
    case "Escape":
      return "exit";
    default:
      return undefined;
  }
}

/**
 * True for elements that use the keys themselves: text fields and menus. Not the code editors: their
 * caret keys give way to the talk (a click into the code must not stop the arrows from stepping).
 */
export function isFormField(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (/^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName)) return true;
  return target.isContentEditable && target.closest(".cm-editor") === null;
}
