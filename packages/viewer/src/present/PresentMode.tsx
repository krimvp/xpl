/**
 * Present mode (tours): a later phase. The store already carries `mode` and `tour` (see ../modes.ts and
 * ../store.ts); the header keeps its toggle disabled until PRESENT_AVAILABLE is true. This component is
 * what App renders for `mode === "present"`, so the phase that builds tours only has to fill it in.
 */
import { useStore } from "../hooks.js";

export function PresentMode() {
  const store = useStore();
  return (
    <main className="present-stub">
      <h2>Present mode is not available yet</h2>
      <p>Tours arrive in a later phase. Explore mode has everything else.</p>
      <button type="button" className="btn is-primary" onClick={() => store.setMode("explore")}>
        Back to Explore
      </button>
    </main>
  );
}
