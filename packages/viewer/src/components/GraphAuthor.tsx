import { useState } from "react";
import type { GraphEdit, GraphView } from "@xpl/core";
import { useDerived, useStore, useViewerState } from "../hooks.js";

/** Explicit graph edits stay separate from opening boxes and navigating levels. */
export function GraphAuthor({ view }: { view: GraphView }) {
  const store = useStore();
  const state = useViewerState();
  const derived = useDerived();
  const [label, setLabel] = useState("");
  const [error, setError] = useState<string>();
  if (
    state.mode !== "explore" ||
    state.perspective !== "explore" ||
    state.model.view(view.id)?.type !== "graph"
  )
    return null;
  const graph = derived.view.graph;
  const shown = new Set(
    [
      ...(graph?.nodes ?? []),
      ...(graph?.edges ?? []),
      ...(graph?.stubs ?? []),
      ...(graph?.ghosts ?? []),
    ].map((item) => item.id),
  );
  const selected = state.selection.filter((id) => shown.has(id));
  const boxes = selected.map((id) => graph?.nodes.find((node) => node.id === id));
  const canGroup =
    selected.length >= 2 &&
    boxes.every(
      (node) => node && view.include.includes(node.id) && node.parent === boxes[0]?.parent,
    );
  const group = selected.length === 1 ? state.model.node(selected[0]!) : undefined;
  const blocked = state.editBusy || state.editDraft;
  const apply = async (action: GraphEdit) => {
    setError(undefined);
    try {
      await store.editGraph(view.id, action);
      if (action.type === "group") setLabel("");
    } catch (error) {
      setError(error instanceof Error ? error.message : String(error));
    }
  };
  const hidden = view.hidden ?? [];
  return (
    <details
      className="graph-author"
      data-testid="graph-author"
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.currentTarget.open = false;
          event.currentTarget.querySelector("summary")?.focus();
        }
      }}
    >
      <summary>Edit map</summary>
      <div className="graph-author-controls">
        <p>
          Shift-click boxes to select them together. Group selected boxes, or change visibility in
          this map.
        </p>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            const slug =
              label
                .trim()
                .toLowerCase()
                .replace(/[^A-Za-z0-9_-]+/g, "-")
                .replace(/^-+|-+$/g, "")
                .slice(0, 100) || "group";
            let id = `grp:${slug}`;
            for (let n = 2; state.model.hasElement(id); n++) id = `grp:${slug}-${n}`;
            void apply({ type: "group", id, label, members: selected });
          }}
        >
          <label>
            Group name
            <input
              value={label}
              maxLength={200}
              onChange={(event) => setLabel(event.target.value)}
            />
          </label>
          <button className="btn" type="submit" disabled={blocked || !canGroup || !label.trim()}>
            Group selected boxes
          </button>
        </form>
        <p>
          {canGroup
            ? `${selected.length} sibling boxes selected.`
            : "Select at least two sibling boxes included in this map to group them."}
        </p>
        <div className="actions">
          <button
            type="button"
            className="btn"
            disabled={blocked || group?.kind !== "group" || !view.include.includes(group.id)}
            onClick={() => {
              if (group) void apply({ type: "ungroup", id: group.id });
            }}
          >
            Ungroup in this map
          </button>
          <button
            type="button"
            className="btn"
            disabled={blocked || selected.length === 0}
            onClick={() => void apply({ type: "hide", ids: selected })}
          >
            Hide selected items
          </button>
        </div>
        <p>Ungroup keeps the group available to other maps, arrows and tour steps.</p>
        <h3>Placement</h3>
        <p>{Object.keys(view.layout ?? {}).length} pinned boxes in this map.</p>
        <p>
          Select a box, then drag its move handle to pin it. Arrow keys on the handle move it by 20
          pixels; Enter pins it here.
        </p>
        <div className="actions">
          <button
            type="button"
            className="btn"
            disabled={blocked || !selected.some((id) => view.layout?.[id])}
            onClick={() => void apply({ type: "reset", ids: selected })}
          >
            Reset selected placement
          </button>
          <button
            type="button"
            className="btn"
            disabled={blocked || !Object.keys(view.layout ?? {}).length}
            onClick={() => void apply({ type: "reset" })}
          >
            Reset all placement
          </button>
        </div>
        <p>Reset returns boxes to automatic layout. Pan and zoom only change your view.</p>
        {hidden.length > 0 && (
          <>
            <h3>Hidden in this map</h3>
            <ul>
              {hidden.map((id) => (
                <li key={id}>
                  <span title={id}>{state.model.label(id)}</span>
                  <button
                    type="button"
                    className="btn"
                    disabled={blocked}
                    aria-label={`Restore ${state.model.label(id)}`}
                    onClick={() => void apply({ type: "restore", ids: [id] })}
                  >
                    Restore
                  </button>
                </li>
              ))}
            </ul>
            <button
              type="button"
              className="btn"
              disabled={blocked}
              onClick={() => void apply({ type: "restore", ids: hidden })}
            >
              Restore all hidden items
            </button>
          </>
        )}
        {blocked && (
          <p role="status">
            {state.editBusy ? "Saving…" : "Save or cancel the author draft first."}
          </p>
        )}
        {error && <p role="alert">{error}</p>}
      </div>
    </details>
  );
}
