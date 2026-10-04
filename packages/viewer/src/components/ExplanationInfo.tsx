import { useViewerState } from "../hooks.js";

/** Reader guidance belongs beside the story, rather than behind the author tools. */
export function ExplanationInfo() {
  const state = useViewerState();
  return (
    <details className="guide-about" data-testid="explanation-info">
      <summary>About this explanation</summary>
      <p>
        This explanation was written by an author. Source anchors check code locations and changes;
        they do not verify the claims or prove that every execution path is covered. Use the linked
        code and tests to check important conclusions.
      </p>
      <p>
        Guide tells the story. Map shows relationships. Flow follows steps. Code opens the source.
        Present walks through a tour. Reference hints can include unresolved or indirect behavior.
      </p>
      <p>
        {state.serverMode
          ? "Explain this queues a request. The author runs /code-explainer feedback in Claude Code; applied changes appear here automatically."
          : "Explain this gives you a command to run in Claude Code. A saved HTML page stays at the version it was exported from."}
      </p>
    </details>
  );
}
