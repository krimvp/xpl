/** The frame of the Guide's still pictures (Snapshot.tsx), shared by every kind of diagram. */
import { useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { snapshotView, type Focus } from "../viewport.js";

/** The picture's height at most, px. */
export const SNAPSHOT_HEIGHT = 260;
/** A picture cut at `SNAPSHOT_HEIGHT` that would show whole at this height is drawn this tall, px. */
export const SNAPSHOT_TALL_HEIGHT = 420;
/** A picture that would cut a box its step names may be this tall, px (never taller than its diagram). */
export const SNAPSHOT_NAMED_HEIGHT = 620;

/**
 * The frame of a still picture: as wide as its column, at most `SNAPSHOT_HEIGHT` tall (or
 * `SNAPSHOT_TALL_HEIGHT` when that shows all of it, or `SNAPSHOT_NAMED_HEIGHT` when that is what it takes to
 * show every box the step names), the content placed by `snapshotView` (all of it when
 * that reads well, else the focus and its neighbours at a readable zoom). The step's elements left out are
 * counted in a "+N more" note: the live diagram shows them.
 */
export function SnapshotFrame({
  width,
  height,
  focus,
  where,
  children,
}: {
  width: number;
  height: number;
  focus: Focus | undefined;
  /** Where the rest is: "Map" or "Flow". */
  where: string;
  children: ReactNode;
}) {
  const box = useRef<HTMLDivElement>(null);
  const [paneWidth, setPaneWidth] = useState(0);
  useLayoutEffect(() => {
    const el = box.current;
    if (!el) return;
    const measure = () => setPaneWidth(el.clientWidth);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);
  const placed = snapshotView(
    paneWidth,
    SNAPSHOT_HEIGHT,
    { width, height },
    focus,
    SNAPSHOT_TALL_HEIGHT,
    SNAPSHOT_NAMED_HEIGHT,
  );
  return (
    <div
      ref={box}
      className="snapshot-frame"
      style={{ height: placed?.height ?? SNAPSHOT_HEIGHT }}
      data-zoom={placed?.transform.k.toFixed(3)}
      data-partial={placed?.partial ? "true" : undefined}
    >
      {placed && (
        <svg className="pz-svg snapshot-svg" width="100%" height="100%" aria-hidden="true">
          <g
            transform={`translate(${placed.transform.x} ${placed.transform.y}) scale(${placed.transform.k})`}
          >
            {children}
          </g>
        </svg>
      )}
      {placed && placed.hidden > 0 && (
        <span className="snapshot-more" data-testid="snapshot-more">
          +{placed.hidden} more in the {where}
        </span>
      )}
    </div>
  );
}
