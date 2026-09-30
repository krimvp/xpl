import { useStore, useViewerState } from "../hooks.js";
import type { Perspective } from "../store.js";

export const PERSPECTIVES: { id: Perspective; label: string }[] = [
  { id: "guide", label: "Guide" },
  { id: "map", label: "System map" },
  { id: "flow", label: "Process flow" },
  { id: "code", label: "Code & files" },
];

export function WorkspaceTabs() {
  const store = useStore();
  const state = useViewerState();
  return (
    <nav className="workspace-tabs" aria-label="Explore the explanation">
      {PERSPECTIVES.map(({ id, label }) => (
        <button
          key={id}
          type="button"
          className={state.perspective === id ? "is-active" : ""}
          aria-current={state.perspective === id ? "page" : undefined}
          data-testid={`perspective-${id}`}
          onClick={() => store.setPerspective(id)}
        >
          {label}
        </button>
      ))}
    </nav>
  );
}
