/**
 * A warning under the header when the page was made from an explainer whose anchors no longer match the code
 * (`xpl bundle --allow-drift`, or `xpl view` while drift is being fixed): how many places changed or are gone, and
 * what that means for the highlighted lines. Hidden for good once the reader closes it.
 */
import { useMemo, useState } from "react";
import { collectAnchors, type Explainer } from "@xpl/core";

/** Anchors whose code changed (`drifted`) or is gone (`missing`), as `xpl bundle` counted them. */
export function driftCounts(explainer: Explainer): { drifted: number; missing: number } {
  let drifted = 0;
  let missing = 0;
  for (const { anchor } of collectAnchors(explainer)) {
    if (anchor.resolved?.status === "drifted") drifted++;
    else if (anchor.resolved?.status === "missing") missing++;
  }
  return { drifted, missing };
}

/** `3 places it points to have changed, and 1 is gone`. */
export function driftText({ drifted, missing }: { drifted: number; missing: number }): string {
  const changed =
    drifted === 1
      ? "1 place it points to has changed"
      : `${drifted} places it points to have changed`;
  const gone =
    missing === 1 ? "1 place it points to is gone" : `${missing} places it points to are gone`;
  if (drifted > 0 && missing > 0)
    return `${changed}, and ${missing} ${missing === 1 ? "is" : "are"} gone`;
  return drifted > 0 ? changed : gone;
}

export function DriftBanner({ explainer }: { explainer: Explainer }) {
  const counts = useMemo(() => driftCounts(explainer), [explainer]);
  const [hidden, setHidden] = useState(false);
  if (hidden || counts.drifted + counts.missing === 0) return null;
  return (
    <div className="drift-banner" role="status" data-testid="drift-banner">
      <p>
        <strong>Parts of this page may be out of date.</strong> The code changed after it was
        written: {driftText(counts)}.
        {counts.drifted > 0 && " Lines with a striped bar may not match the text."}
      </p>
      <button type="button" onClick={() => setHidden(true)} aria-label="Hide this warning">
        Hide
      </button>
    </div>
  );
}
