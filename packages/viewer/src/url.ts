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
 * Navigation parameters follow the mode, view, focus, source range and stable tour step. A managed
 * service also records its repository/guide attachment once on load. Leaving Present preserves the
 * reading perspective and tour position; a Present bundle also writes `mode=explore`, so reloading
 * keeps the reader out of the talk. Other parameters are left alone.
 */
import { hashText } from "@xpl/core";
import { readLaunchParams } from "./data.js";
import { stepNumber } from "./modes.js";
import type { ViewerState, ViewerStore } from "./store.js";

/** Sibling links work on file:// and static hosts; standalone HTML copies have no staged tree. */
export function versionUrl(href: string, version: string): URL | undefined {
  if (!/^version-[A-Za-z0-9_-]+$/.test(version)) return undefined;
  const url = new URL(href);
  if (!/\/(?:current|version-[A-Za-z0-9_-]+)\/index\.html$/.test(url.pathname)) return undefined;
  url.pathname = url.pathname.replace(/\/[^/]+\/index\.html$/, `/${version}/index.html`);
  url.searchParams.set("version", version);
  url.searchParams.delete("attachment");
  return url;
}

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
  if (state.perspective !== undefined) {
    if (state.mode !== "present" && bundleMode !== "present") params.delete("mode");
    if (state.mode !== "present" || state.perspective !== "explore")
      params.set("perspective", state.perspective);
    else params.delete("perspective");
  }
  if ("viewId" in state) {
    if (state.viewId) params.set("view", state.viewId);
    else params.delete("view");
  }
  if ("selection" in state) {
    params.delete("focus");
    for (const id of state.selection ?? []) params.append("focus", id);
    if (state.selection?.length === 0) params.set("focus", "");
  }
  if (state.tour && state.perspective !== undefined) {
    params.set("tour", state.tour.tourId);
    params.set("step", String(stepNumber(state.tour.step)));
  }
  if (state.cursor) {
    params.set("file", state.cursor.file);
    params.set("side", state.cursor.side ?? "head");
    const c = state.cursor;
    params.set(
      "range",
      `${c.fromLine}${c.fromCol === undefined ? "" : `:${c.fromCol}`}-${c.toLine}${c.toCol === undefined ? "" : `:${c.toCol}`}`,
    );
  } else if ("cursor" in state) {
    params.delete("file");
    params.delete("range");
    params.delete("side");
  }
  if ("applied" in state) {
    if (params.has("tour")) params.set("step-id", state.applied?.stepId ?? "");
    else params.delete("step-id");
  }
  // Ids are `tour:intro`: a colon is fine in a query string, and much easier to read than `%3A`.
  const text = params.toString().replace(/%3A/gi, ":");
  return text === "" ? "" : `?${text}`;
}

/**
 * Starts writing the URL whenever navigation changes (and once now when the page
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
      let next = searchFor(state, search, bundleMode);
      const params = new URLSearchParams(next);
      if (params.has("snapshot")) {
        const file = params.get("file");
        const previous = new URLSearchParams(search);
        if (
          file !== previous.get("file") ||
          params.get("side") !== previous.get("side") ||
          !params.has("source-hash")
        ) {
          const files = params.get("side") === "base" ? state.baseFiles : state.files;
          const text = file ? files?.[file] : undefined;
          if (text === undefined) params.delete("source-hash");
          else params.set("source-hash", hashText(text));
          next = `?${params.toString().replace(/%3A/gi, ":")}`;
        }
      }
      if (push) win.history.pushState({ xplPresent: true }, "", pathname + next + hash);
      else if (next !== search)
        win.history.replaceState(win.history.state, "", pathname + next + hash);
    } catch {
      /* file:// pages and sandboxed frames may refuse; the address bar just stays as it is */
    }
  };
  const key = (state: ViewerState) =>
    JSON.stringify([
      state.mode,
      state.perspective,
      state.viewId,
      state.selection,
      state.cursor,
      state.applied?.stepId,
      state.tour?.tourId,
      state.tour?.step,
    ]);
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
    if (leaving) {
      leaving = false;
      // Esc keeps the last reading state while removing the talk's history entry.
      write(store.getState());
    }
    popping = true;
    try {
      store.restoreNavigation(readLaunchParams(win.location.search));
    } finally {
      popping = false;
    }
    pushed = false;
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
