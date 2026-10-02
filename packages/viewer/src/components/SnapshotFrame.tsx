/** The frame of the Guide's still pictures (Snapshot.tsx), shared by every kind of diagram. */
import { useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { snapshotView, type Box } from "../viewport.js";

/** The picture's height at most, px. */
export const SNAPSHOT_HEIGHT = 260;

/**
 * The frame of a still picture: as wide as its column, at most `SNAPSHOT_HEIGHT` tall, the content placed by
 * `snapshotView` (all of it when that reads well, else a readable zoom centred on `focus`).
 */
export function SnapshotFrame({
  width,
  height,
  focus,
  children,
}: {
  width: number;
  height: number;
  focus: Box | undefined;
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
  const placed = snapshotView(paneWidth, SNAPSHOT_HEIGHT, { width, height }, focus);
  return (
    <div
      ref={box}
      className="snapshot-frame"
      style={{ height: placed?.height ?? SNAPSHOT_HEIGHT }}
      data-zoom={placed?.transform.k.toFixed(3)}
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
    </div>
  );
}
