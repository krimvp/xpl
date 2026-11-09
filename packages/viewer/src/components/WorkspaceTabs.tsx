import { useStore, useViewerState } from "../hooks.js";
import type { Perspective } from "../store.js";

/** The reading tabs: short plain names, so all four fit beside the title on a 1280px screen. */
export const PERSPECTIVES: { id: Perspective; label: string; hint: string }[] = [
  { id: "guide", label: "Tour", hint: "Step by step through the code" },
  { id: "map", label: "Map", hint: "The parts of the code and how they connect" },
  { id: "flow", label: "Flow", hint: "What happens, in order" },
  { id: "code", label: "Code", hint: "The code files" },
];

export function WorkspaceTabs() {
  const store = useStore();
  const state = useViewerState();
  return (
    <nav className="workspace-tabs" aria-label="Read the guide">
      {PERSPECTIVES.map(({ id, label, hint }) => (
        <button
          key={id}
          type="button"
          className={state.perspective === id ? "is-active" : ""}
          aria-current={state.perspective === id ? "page" : undefined}
          data-testid={`perspective-${id}`}
          title={hint}
          onClick={() => store.setPerspective(id)}
        >
          {label}
        </button>
      ))}
    </nav>
  );
}
