/**
 * The stub mode of a graph view (`GraphView.stubs.mode`), in the Edit menu next to the arrow-kind
 * toggles: how many of the places where the view stops are drawn as ghost boxes. `top` keeps the few most
 * referenced (the default), `all` every one, `none` no stubs at all. Like the toggles, a change is a view
 * edit: stored on the view, and persisted under `xpl view`.
 */
import { DEFAULT_STUB_MAX, STUB_MODES, type StubMode } from "@xpl/core";
import { useStore } from "../hooks.js";

const HELP: Record<StubMode, (max: number) => string> = {
  top: (max) =>
    `The ${max} most used places outside this map; the rest fold into "N more" and "rest of <file>" boxes`,
  all: () => "Every place outside this map, one dashed box each (crowded in a big map)",
  none: () => "No arrows to places outside this map: only the arrows between the boxes shown",
};

export function StubsControl({ mode, max = DEFAULT_STUB_MAX }: { mode: StubMode; max?: number }) {
  const store = useStore();
  return (
    <div
      className="stubs-control"
      role="group"
      aria-label="Stubs shown"
      data-testid="stubs-control"
    >
      <span className="edge-kinds-label">Stubs</span>
      {STUB_MODES.map((m) => (
        <button
          key={m}
          type="button"
          aria-pressed={mode === m}
          className={"chip" + (mode === m ? " is-on" : "")}
          data-stub-mode={m}
          title={HELP[m](max)}
          onClick={() => store.setStubMode(m)}
        >
          {m}
        </button>
      ))}
    </div>
  );
}
