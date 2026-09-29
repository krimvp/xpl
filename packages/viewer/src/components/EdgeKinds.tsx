/**
 * The derived-edge-kind toggles of a graph view (`calls`, `imports`, ...): which kinds of edges found by
 * static analysis are drawn. They sit in the diagram's caption, next to what they filter.
 */
import { DERIVED_EDGE_KINDS, type Edge } from "@xpl/core";
import { useStore } from "../hooks.js";

export function EdgeKindToggles({ kinds }: { kinds: readonly Edge["kind"][] }) {
  const store = useStore();
  const on = new Set<Edge["kind"]>(kinds);
  return (
    <div className="edge-kinds" role="group" aria-label="Edge kinds shown">
      <span className="edge-kinds-label">Edges</span>
      {DERIVED_EDGE_KINDS.map((kind) => (
        <button
          key={kind}
          type="button"
          role="switch"
          aria-checked={on.has(kind)}
          className={"chip" + (on.has(kind) ? " is-on" : "")}
          data-edge-kind={kind}
          title={`${on.has(kind) ? "Hide" : "Show"} ${kind} edges found by static analysis`}
          onClick={() => store.toggleEdgeKind(kind)}
        >
          {kind === "references" ? "refs" : kind}
        </button>
      ))}
    </div>
  );
}
