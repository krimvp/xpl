/**
 * The derived-edge-kind toggles of a graph view (`calls`, `imports`, ...): which kinds of arrows found in the
 * code are drawn. They sit in the Edit menu (Header), with the stub mode.
 */
import { DERIVED_EDGE_KINDS, type Edge } from "@xpl/core";
import { useStore } from "../hooks.js";

export function EdgeKindToggles({ kinds }: { kinds: readonly Edge["kind"][] }) {
  const store = useStore();
  const on = new Set<Edge["kind"]>(kinds);
  return (
    <div className="edge-kinds" role="group" aria-label="Kinds of arrows shown">
      <span className="edge-kinds-label">Arrows</span>
      {DERIVED_EDGE_KINDS.map((kind) => (
        <button
          key={kind}
          type="button"
          role="switch"
          aria-checked={on.has(kind)}
          className={"chip" + (on.has(kind) ? " is-on" : "")}
          data-edge-kind={kind}
          title={`${on.has(kind) ? "Hide" : "Show"} the ${kind} arrows found in the code`}
          onClick={() => store.toggleEdgeKind(kind)}
        >
          {kind === "references" ? "refs" : kind}
        </button>
      ))}
    </div>
  );
}
