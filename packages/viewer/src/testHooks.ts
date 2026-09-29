/**
 * `window.__xpl`: the stable contract for Playwright (ARCHITECTURE.md section 6). It drives the same
 * store actions the UI does, so anything a test does here is what a click would do.
 *
 *   select(ids)              replace the selection (like clicking; several ids like shift-click)
 *   selection()              the selected ids, in order
 *   focus()                  the code focus of the selection: core `FocusRange`s
 *                            ({ file, range: { startLine, endLine }, role, elementId, status }), in the
 *                            order the editor panes show them
 *   matches()                ids (diagram elements, concepts) whose code contains the caret; sorted
 *   setCursor(file, line)    move the caret (opens the file when no pane shows it); same code path as a
 *                            real caret move: the store's `setCursor`, which the editors also call
 *   setView(id)              switch views (clears the selection)
 *   present(tourId, step)    enter Present mode on a tour, at step `step` (1-based, default 1: the numbers of
 *                            the URL and of the "2 / 5" counter); false when there is no such tour
 *   next() / prev()          the next / previous step of the tour (like the arrow keys)
 *   exitPresent()            back to Explore, keeping the view and the selection (like Esc)
 *   state()                  a JSON snapshot for assertions
 */
import type { FocusRange } from "@xpl/core";
import { getDerived } from "./derive.js";
import { stepNumber } from "./modes.js";
import type { ViewerStore } from "./store.js";

export interface XplHooks {
  select(ids: string[]): void;
  selection(): string[];
  focus(): FocusRange[];
  matches(): string[];
  setCursor(file: string, line: number): void;
  setView(id: string): void;
  present(tourId: string, step?: number): boolean;
  next(): void;
  prev(): void;
  exitPresent(): void;
  state(): XplSnapshot;
}

export interface XplSnapshot {
  mode: "explore" | "present";
  /** Id of the tour that is on (being presented, or chosen in Explore); null when none. */
  tour: string | null;
  /** The step of that tour, counting from 1; null without a tour. */
  step: number | null;
  /** Number of steps of that tour; null without a tour. */
  stepCount: number | null;
  /** Id of the tour step on screen (the step's own id, `t1`); null after a detour or without a tour. */
  stepId: string | null;
  /** In Present: the selection was changed by a click since the step was applied (a detour). */
  detour: boolean;
  viewId: string | null;
  viewType: "graph" | "sequence" | null;
  selection: string[];
  cursor: { file: string; fromLine: number; toLine: number } | null;
  matches: string[];
  related: string[];
  /** Files with an editor pane, in stack order. */
  panes: { file: string; focused: boolean; opened: boolean; dim: boolean }[];
  /** Files in the current focus, in order. */
  focusFiles: string[];
  openedFile: string | null;
  /** Graph views: what is drawn. */
  graph: { nodes: string[]; edges: string[]; stubs: string[] } | null;
  serverMode: boolean;
  dirty: boolean;
  /** `include` of the current graph view (after edits). */
  include: string[] | null;
  edgeKinds: string[] | null;
}

declare global {
  interface Window {
    __xpl?: XplHooks;
  }
}

export function installTestHooks(store: ViewerStore, target: Window = window): XplHooks {
  const derived = () => getDerived(store.getState());
  const hooks: XplHooks = {
    select: (ids) => store.select(ids),
    selection: () => [...store.getState().selection],
    focus: () =>
      derived().selection.focus.map((range) => ({ ...range, range: { ...range.range } })),
    matches: () => [...derived().matches],
    setCursor(file, line) {
      const { panes } = derived();
      if (panes.some((pane) => pane.file === file)) store.setCursor(file, line);
      else store.openFile(file, line);
    },
    setView: (id) => void store.setView(id),
    present: (tourId, step = 1) => store.present(tourId, step - 1),
    next: () => store.nextStep(),
    prev: () => store.prevStep(),
    exitPresent: () => store.exitPresent(),
    state() {
      const state = store.getState();
      const d = derived();
      const view = d.view.view;
      const graph = d.view.graph;
      const tour = store.currentTour();
      return {
        mode: state.mode,
        tour: state.tour ? state.tour.tourId : null,
        step: state.tour ? stepNumber(state.tour.step) : null,
        stepCount: tour ? tour.steps.length : null,
        stepId: state.applied?.stepId ?? null,
        detour: state.mode === "present" && state.tour !== undefined && state.applied === undefined,
        viewId: state.viewId ?? null,
        viewType: view?.type ?? null,
        selection: [...state.selection],
        cursor: state.cursor ? { ...state.cursor } : null,
        matches: [...d.matches],
        related: [...d.selection.related].sort(),
        panes: d.panes.map((p) => ({
          file: p.file,
          focused: p.focused,
          opened: p.opened,
          dim: p.dim,
        })),
        focusFiles: d.selection.files.map((f) => f.file),
        openedFile: state.openedFile ?? null,
        graph: graph
          ? {
              nodes: graph.nodes.map((n) => n.id),
              edges: graph.edges.map((e) => e.id),
              stubs: graph.stubs.map((s) => s.id),
            }
          : null,
        serverMode: state.serverMode,
        dirty: state.dirty,
        include: view?.type === "graph" ? [...view.include] : null,
        edgeKinds: view?.type === "graph" && view.edgeKinds ? [...view.edgeKinds] : null,
      };
    },
  };
  target.__xpl = hooks;
  return hooks;
}
