import { useStore, useViewerState } from "../hooks.js";
import type { Perspective } from "../store.js";
import { hasMapTab } from "../workspace.js";
import { readingStep } from "./Guide.js";

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
  // a guide without a map of its own, whose flow has one or two parts: no Map tab (V6-02)
  const map = hasMapTab(state);
  return (
    <nav className="workspace-tabs" aria-label="Read the guide">
      {PERSPECTIVES.filter(({ id }) => id !== "map" || map || state.perspective === "map").map(
        ({ id, label, hint }) => (
          <button
            key={id}
            type="button"
            className={state.perspective === id ? "is-active" : ""}
            aria-current={state.perspective === id ? "page" : undefined}
            data-testid={`perspective-${id}`}
            title={hint}
            onClick={() => {
              // Leaving the Tour while another step than the applied one is on screen: that step is the one
              // being read, so the tab opens on its diagram and title (R4-5).
              const on = readingStep.current;
              const applied = state.applied;
              if (
                state.perspective === "guide" &&
                id !== "guide" &&
                on &&
                on.stepId !== applied?.stepId
              ) {
                const index =
                  state.model.tour(on.tourId)?.steps.findIndex((step) => step.id === on.stepId) ??
                  -1;
                if (index >= 0) store.previewStep(on.tourId, index);
              }
              store.setPerspective(id);
            }}
          >
            {label}
          </button>
        ),
      )}
    </nav>
  );
}
