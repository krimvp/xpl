/**
 * Keeps the address bar in step with the tour: `?mode=present&tour=<id>&step=<n>` while presenting
 * (n counts from 1, like the "2 / 5" counter), so a reload, a bookmark or a shared link lands on the
 * same slide. `history.replaceState` only: stepping through a talk must not fill the back button.
 *
 * Nothing is written until the mode, tour or step changes, so a page opened with parameters keeps its
 * URL as it is. Leaving Present drops `tour` and `step`; `mode=explore` is written only when the bundle
 * itself opens in Present (its `mode` field), so that a reload does not throw the user back into the talk.
 * Other parameters are left alone.
 */
import { stepNumber } from "./modes.js";
import type { ViewerState, ViewerStore } from "./store.js";

/** The query string (with the leading `?`, or empty) for a state, on top of the current `search`. */
export function searchFor(
  state: Pick<ViewerState, "mode" | "tour"> &
    Partial<Pick<ViewerState, "perspective" | "viewId" | "selection">>,
  search: string,
  bundleMode: "explore" | "present" | undefined,
): string {
  const params = new URLSearchParams(search);
  if (state.mode === "present" && state.tour) {
    params.set("mode", "present");
    params.set("tour", state.tour.tourId);
    params.set("step", String(stepNumber(state.tour.step)));
  } else {
    params.delete("tour");
    params.delete("step");
    if (bundleMode === "present") params.set("mode", "explore");
    else params.delete("mode");
  }
  if (state.mode !== "present" && state.perspective && state.perspective !== "explore") {
    params.delete("mode");
    params.set("perspective", state.perspective);
    if (state.viewId) params.set("view", state.viewId);
    if (state.tour) {
      params.set("tour", state.tour.tourId);
      params.set("step", String(stepNumber(state.tour.step)));
    }
    params.delete("focus");
    for (const id of state.selection ?? []) params.append("focus", id);
  } else {
    params.delete("perspective");
    params.delete("focus");
  }
  // Ids are `tour:intro`: a colon is fine in a query string, and much easier to read than `%3A`.
  const text = params.toString().replace(/%3A/gi, ":");
  return text === "" ? "" : `?${text}`;
}

/**
 * Starts writing the URL whenever the mode, the tour or the step changes (and once now when the page
 * opens in Present, so the address always names the slide). Returns the unsubscribe.
 */
export function watchUrl(
  store: ViewerStore,
  bundleMode: "explore" | "present" | undefined,
  win: Window = window,
): () => void {
  const write = (state: ViewerState) => {
    try {
      const { pathname, search, hash } = win.location;
      const next = searchFor(state, search, bundleMode);
      if (next !== search) win.history.replaceState(win.history.state, "", pathname + next + hash);
    } catch {
      /* file:// pages and sandboxed frames may refuse; the address bar just stays as it is */
    }
  };
  const key = (state: ViewerState) =>
    state.mode === "present"
      ? `present|${state.tour?.tourId}|${state.tour?.step}`
      : state.perspective === "explore"
        ? "explore"
        : `${state.perspective}|${state.viewId}|${state.tour?.tourId}|${state.tour?.step}|${JSON.stringify(state.selection)}`;
  let last = key(store.getState());
  if (store.getState().mode === "present") write(store.getState());
  return store.subscribe(() => {
    const state = store.getState();
    const now = key(state);
    if (now === last) return;
    last = now;
    write(state);
  });
}
