import { useRef, type KeyboardEvent, type PointerEvent } from "react";

/**
 * A draggable divider (and a keyboard one: focus it and use the arrow keys). Reports movement in px;
 * the parent clamps and stores the size.
 */
export function Splitter({
  orientation,
  label,
  onResize,
}: {
  /** `col`: a vertical bar between two columns; `row`: a horizontal bar between two rows. */
  orientation: "col" | "row";
  label: string;
  onResize: (deltaPx: number) => void;
}) {
  const last = useRef<number | null>(null);
  const position = (event: PointerEvent) => (orientation === "col" ? event.clientX : event.clientY);
  return (
    <div
      className={`splitter is-${orientation}`}
      role="separator"
      aria-orientation={orientation === "col" ? "vertical" : "horizontal"}
      aria-label={label}
      tabIndex={0}
      onPointerDown={(event) => {
        last.current = position(event);
        event.currentTarget.setPointerCapture(event.pointerId);
        event.currentTarget.classList.add("is-dragging");
      }}
      onPointerMove={(event) => {
        if (last.current === null) return;
        const now = position(event);
        onResize(now - last.current);
        last.current = now;
      }}
      onPointerUp={(event) => {
        last.current = null;
        event.currentTarget.classList.remove("is-dragging");
      }}
      onPointerCancel={() => {
        last.current = null;
      }}
      onKeyDown={(event: KeyboardEvent) => {
        const step = event.shiftKey ? 64 : 24;
        const grow = orientation === "col" ? "ArrowRight" : "ArrowDown";
        const shrink = orientation === "col" ? "ArrowLeft" : "ArrowUp";
        if (event.key === grow) onResize(step);
        else if (event.key === shrink) onResize(-step);
        else return;
        event.preventDefault();
      }}
    />
  );
}
