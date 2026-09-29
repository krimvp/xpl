/**
 * The stub mode of a graph view (`GraphView.stubs.mode`), in the diagram's caption next to the edge-kind
 * toggles: how many of the places where the view stops are drawn as ghost boxes. `top` keeps the few most
 * referenced (the default), `all` every one, `none` no stubs at all. Like the toggles, a change is a view
 * edit: stored on the view, and persisted under `xpl view`.
 */
import { DEFAULT_STUB_MAX, STUB_MODES, type StubMode } from "@xpl/core";
import { useStore } from "../hooks.js";

const HELP: Record<StubMode, (max: number) => string> = {
  top: (max) =>
    `The ${max} most referenced places where this view stops; the rest are folded into "N more" and "rest of <file>" ghosts`,
  all: () => "Every place where this view stops, one ghost box each (crowded in a big view)",
  none: () => "No dashed stubs and no ghost boxes: only the arrows between the boxes shown",
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
