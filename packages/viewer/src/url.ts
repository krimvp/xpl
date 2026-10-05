/**
 * Keeps the address bar in step with the tour: `?mode=present&tour=<id>&step=<n>` while presenting
 * (n counts from 1, like the "2 / 5" counter), so a reload, a bookmark or a shared link lands on the
 * same slide. Stepping through a talk uses `history.replaceState` (it must not fill the back button).
 *
 * The browser's Back button and a talk:
 * - A talk started on the page pushes an entry, so that Back leaves the talk instead of the page. Esc
 *   leaves it the same way (it goes back over that entry), so that afterwards Back does not land on a
 *   stale address that says something other than the screen.
 * - A page that opens in a talk (its URL or the bundle's `mode`) pushes an entry when the talk is left:
 *   Back from there returns to the talk, at the step it was left on.
 * - Whatever Back or Forward land on, the address ends up saying what is on screen.
 *
 * Navigation parameters are written only when the mode, tour or step changes. A managed service also
 * records its repository/guide attachment once on load, so bookmarks stay scoped to that guide. Leaving Present drops `tour` and `step`; when the bundle itself opens in Present (its `mode`
 * field), `mode=explore` is written instead, with the tour and step, so that a reload does not throw the
 * user back into the talk and Present resumes where it was. Other parameters are left alone.
 */
import { readLaunchParams } from "./data.js";
import { stepNumber } from "./modes.js";
import type { ViewerState, ViewerStore } from "./store.js";

/** The query string (with the leading `?`, or empty) for a state, on top of the current `search`. */
export function searchFor(
  state: Pick<ViewerState, "mode" | "tour"> &
    Partial<Pick<ViewerState, "perspective" | "viewId" | "selection" | "cursor" | "applied">>,
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
    if (bundleMode === "present") {
      params.set("mode", "explore");
      if (state.tour) {
        params.set("tour", state.tour.tourId);
        params.set("step", String(stepNumber(state.tour.step)));
      }
    } else params.delete("mode");
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
  if (state.cursor && !state.cursor.side) {
    params.set("file", state.cursor.file);
    const c = state.cursor;
    params.set(
      "range",
      `${c.fromLine}${c.fromCol === undefined ? "" : `:${c.fromCol}`}-${c.toLine}${c.toCol === undefined ? "" : `:${c.toCol}`}`,
    );
  } else if ("cursor" in state) {
    params.delete("file");
    params.delete("range");
  }
  if (
    state.applied &&
    params.has("tour") &&
    (params.has("step-id") || (state.mode !== "present" && state.perspective !== "explore"))
  )
    params.set("step-id", state.applied.stepId);
  else if ("applied" in state) params.delete("step-id");
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
  // Bind bookmarks and reloads to the guide as loaded, even if another service later owns the port.
  const attachment = store.getState().connection.attachment;
  if (attachment) {
    try {
      const url = new URL(win.location.href);
      url.searchParams.set(
        "attachment",
        JSON.stringify({ root: attachment.root, guide: attachment.guide }),
      );
      win.history.replaceState(win.history.state, "", url);
    } catch {
      /* sandboxed frames may refuse */
    }
  }
  const write = (state: ViewerState, push = false) => {
    try {
      const { pathname, search, hash } = win.location;
      const next = searchFor(state, search, bundleMode);
      if (push) win.history.pushState({ xplPresent: true }, "", pathname + next + hash);
      else if (next !== search)
        win.history.replaceState(win.history.state, "", pathname + next + hash);
    } catch {
      /* file:// pages and sandboxed frames may refuse; the address bar just stays as it is */
    }
  };
  const key = (state: ViewerState) =>
    JSON.stringify(state.cursor) +
    "|" +
    (state.mode === "present"
      ? `present|${state.tour?.tourId}|${state.tour?.step}`
      : state.perspective === "explore"
        ? "explore"
        : `${state.perspective}|${state.viewId}|${state.tour?.tourId}|${state.tour?.step}|${JSON.stringify(state.selection)}`);
  let last = key(store.getState());
  let mode = store.getState().mode;
  /** The talk on screen was started on this page, with an entry of its own. */
  let pushed = false;
  /** A talk with its own entry was left with Esc: going back over that entry. */
  let leaving = false;
  /** Following Back or Forward: the store changes, and the address is written once afterwards. */
  let popping = false;
  if (mode === "present") write(store.getState());
  const onPop = () => {
    const state = store.getState();
    if (leaving) leaving = false;
    else {
      const asked = readLaunchParams(win.location.search);
      popping = true;
      try {
        // Back out of a talk: leave Present, where the reader was. Back (or Forward) into one: resume it.
        if (state.mode === "present" && asked.mode !== "present") store.exitPresent();
        else if (state.mode !== "present" && asked.mode === "present")
          store.present(
            asked.tour,
            asked.stepId
              ? state.model.tour(asked.tour ?? "")?.steps.findIndex((s) => s.id === asked.stepId)
              : asked.step !== undefined
                ? asked.step - 1
                : undefined,
          );
        if (asked.file && asked.range) store.openRange(asked.file, asked.range);
      } finally {
        popping = false;
      }
      pushed = false;
    }
    const now = store.getState();
    last = key(now);
    mode = now.mode;
    write(now);
  };
  win.addEventListener("popstate", onPop);
  const unsubscribe = store.subscribe(() => {
    if (popping) return;
    const state = store.getState();
    const now = key(state);
    const started = state.mode === "present" && mode !== "present";
    const ended = state.mode !== "present" && mode === "present";
    mode = state.mode;
    if (now === last) return;
    last = now;
    if (started) {
      write(state, true);
      pushed = true;
    } else if (ended && pushed) {
      pushed = false;
      write(state);
      leaving = true;
      try {
        win.history.back();
      } catch {
        leaving = false;
      }
    } else write(state, ended);
  });
  return () => {
    unsubscribe();
    win.removeEventListener("popstate", onPop);
  };
}
