import { useStore, useViewerState } from "../hooks.js";

/** A fold action stays in the caption when an expanded box's own corner is off screen. */
export function FoldBackAction({ visibleIds }: { visibleIds: readonly string[] }) {
  const store = useStore();
  const state = useViewerState();
  if (state.mode === "present") return null;
  const visible = new Set(visibleIds);
  const id = [...state.expanded].reverse().find((expanded) => visible.has(expanded));
  if (!id) return null;
  const label = `Fold ${state.model.label(id)} back`;
  return (
    <button
      type="button"
      className="btn fold-back-action"
      title={label}
      onClick={() => store.toggleExpanded(id)}
    >
      {label}
    </button>
  );
}
