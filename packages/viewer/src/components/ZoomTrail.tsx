/**
 * The way back up from a view that a box opened (`Node.opens`): "System map › API service › Orders". Each
 * level above the current one is a link; nothing is shown for a view no box opens.
 */
import { zoomTrail } from "@xpl/core";
import { useStore, useViewerState } from "../hooks.js";

export function ZoomTrail({ viewId }: { viewId: string }) {
  const store = useStore();
  const state = useViewerState();
  const trail = zoomTrail(state.model, viewId);
  if (trail.length === 0) return null;
  // The top view by its title, then each box that leads one level down, the last one being this view.
  const steps = [
    { label: trail[0]!.view.title, viewId: trail[0]!.view.id },
    ...trail.map((level, i) => ({
      label: state.model.node(level.box)?.label ?? level.box,
      viewId: trail[i + 1]?.view.id ?? viewId,
    })),
  ];
  const present = state.mode === "present";
  return (
    <nav className="zoom-trail" aria-label="Levels" data-testid="zoom-trail">
      {steps.map((step, i) => {
        const current = i === steps.length - 1;
        return (
          <span key={`${i}:${step.viewId}`}>
            {current || present ? (
              <span aria-current={current ? "page" : undefined}>{step.label}</span>
            ) : (
              <button type="button" onClick={() => store.goToLevel(step.viewId)}>
                {step.label}
              </button>
            )}
            {!current && <span aria-hidden="true"> › </span>}
          </span>
        );
      })}
    </nav>
  );
}
