import type { GraphNode } from "@xpl/core";
import { useStore, useViewerState } from "../hooks.js";

/** A phone-width action when an expandable box's SVG corner falls outside the pane. */
export function ExpandInPlaceAction({ nodes }: { nodes: readonly GraphNode[] }) {
  const store = useStore();
  const state = useViewerState();
  if (state.mode === "present") return null;
  const available = nodes.filter(
    (node) => node.expandable && !state.expanded.has(node.id) && store.canExpandInPlace(node.id),
  );
  const chosen =
    available.find((node) => node.id === state.selection.at(-1)) ??
    (available.length === 1 ? available[0] : undefined);
  if (!chosen) return null;
  const label = `Show parts of ${chosen.label} here`;
  return (
    <button
      type="button"
      className="btn mobile-expand-action"
      title={label}
      onClick={() => store.toggleExpanded(chosen.id)}
    >
      {label}
    </button>
  );
}
