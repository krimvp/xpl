/**
 * The way back up from a view that a box opened (`Node.opens`): "System map › API service › Orders". Each
 * level above the current one is a link; nothing is shown for a view no box opens.
 */
import { liveTrail, zoomTrail } from "@xpl/core";
import { shortText } from "../shortLabels.js";
import { useStore, useViewerState } from "../hooks.js";
import { liveViewTitle } from "../live.js";

export function ZoomTrail({ viewId }: { viewId: string }) {
  const store = useStore();
  const state = useViewerState();
  // (a live page puts its design level on the trail of the level it is a lens of)
  const trail = (state.live ? liveTrail : zoomTrail)(state.model, viewId);
  if (trail.length === 0) return null;
  // The top view by its title, then each box that leads one level down, the last one being this view.
  const steps = [
    {
      // (a live page names a level without a title by what it is: "The system")
      label: shortText(trail[0]!.view.title) || liveViewTitle(state.model, trail[0]!.view.id),
      viewId: trail[0]!.view.id,
    },
    ...trail.map((level, i) => ({
      label: shortText(state.model.node(level.box)?.label ?? level.box) || level.box,
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
              <button type="button" title={step.label} onClick={() => store.goToLevel(step.viewId)}>
                {step.label}
              </button>
            )}
            {!current && (
              <span className="zoom-trail-sep" aria-hidden="true">
                ›
              </span>
            )}
          </span>
        );
      })}
    </nav>
  );
}
