import { createContext, useContext, useSyncExternalStore } from "react";
import { getDerived, type Derived } from "./derive.js";
import type { ViewerState, ViewerStore } from "./store.js";

export const StoreContext = createContext<ViewerStore | null>(null);

/** The store, for actions. */
export function useStore(): ViewerStore {
  const store = useContext(StoreContext);
  if (!store) throw new Error("useStore outside <StoreContext.Provider>");
  return store;
}

/** The current state; re-renders on every change. */
export function useViewerState(): ViewerState {
  const store = useStore();
  return useSyncExternalStore(store.subscribe, store.getState);
}

/** Everything derived from the current state (graph, focus, panes, matches; see derive.ts). */
export function useDerived(): Derived {
  return getDerived(useViewerState());
}
