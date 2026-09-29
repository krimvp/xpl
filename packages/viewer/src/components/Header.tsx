/**
 * The header: explainer title, view switcher, derived-edge-kind toggles (graph views), the
 * Explore / Present toggle (Present is a later phase) and the save / download controls.
 */
import { DEFAULT_EDGE_KINDS, DERIVED_EDGE_KINDS, type Edge } from "@xpl/core";
import { PRESENT_AVAILABLE } from "../modes.js";
import { explainerFileName } from "../edits.js";
import { useDerived, useStore, useViewerState } from "../hooks.js";

export function Header() {
  const store = useStore();
  const state = useViewerState();
  const derived = useDerived();
  const views = state.model.views;
  const view = derived.view.view;

  return (
    <header className="header">
      <div className="brand">
        <span className="logo" aria-hidden="true">
          xpl
        </span>
        <h1 className="title" title={state.explainer.title}>
          {state.explainer.title}
        </h1>
      </div>

      <div className="view-tabs" role="tablist" aria-label="Views">
        {views.map((v) => (
          <button
            key={v.id}
            type="button"
            role="tab"
            className={"tab" + (v.id === state.viewId ? " is-active" : "")}
            aria-selected={v.id === state.viewId}
            data-view-id={v.id}
            title={v.type === "sequence" && v.scope?.question ? v.scope.question : v.title}
            onClick={() => store.setView(v.id)}
          >
            <span className={`tab-icon is-${v.type}`} aria-hidden="true" />
            <span className="tab-title">{v.title}</span>
          </button>
        ))}
      </div>

      <div className="spacer" />

      {view?.type === "graph" && <EdgeKindToggles kinds={view.edgeKinds ?? DEFAULT_EDGE_KINDS} />}

      <div className="segmented" role="group" aria-label="Mode">
        <button
          type="button"
          className={state.mode === "explore" ? "is-active" : ""}
          aria-pressed={state.mode === "explore"}
          onClick={() => store.setMode("explore")}
        >
          Explore
        </button>
        <button
          type="button"
          className={state.mode === "present" ? "is-active" : ""}
          aria-pressed={state.mode === "present"}
          disabled={!PRESENT_AVAILABLE}
          title={PRESENT_AVAILABLE ? "Present a tour" : "Present mode (tours) is not available yet"}
          onClick={() => store.setMode("present")}
        >
          Present
        </button>
      </div>

      <SaveControls
        fileName={explainerFileName(state.explainer)}
        json={() => store.explainerJson()}
      />
    </header>
  );
}

function EdgeKindToggles({ kinds }: { kinds: readonly Edge["kind"][] }) {
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

function SaveControls({ fileName, json }: { fileName: string; json: () => string }) {
  const store = useStore();
  const state = useViewerState();
  const { save, dirty, serverMode } = state;

  let status: { text: string; tone: string; title: string } | undefined;
  if (serverMode) {
    if (save.status === "saving") {
      status = { text: "Saving…", tone: "busy", title: "Saving the view" };
    } else if (save.status === "error") {
      const text = `Not saved: ${save.message}`;
      status = { text, tone: "error", title: text };
    } else if (save.status === "saved") {
      status = { text: "Saved", tone: "ok", title: "View edits are saved" };
    }
  } else if (dirty) {
    status = {
      text: "Unsaved",
      tone: "warn",
      title:
        "Unsaved edits: they live only in this page. Download the explainer JSON to keep them.",
    };
  }

  const download = () => {
    const url = URL.createObjectURL(new Blob([json()], { type: "application/json" }));
    const link = document.createElement("a");
    link.href = url;
    link.download = fileName;
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };

  return (
    <div className="save">
      {status && (
        <span className={`save-status is-${status.tone}`} role="status" title={status.title}>
          {status.text}
        </span>
      )}
      {serverMode && save.status === "error" && (
        <button type="button" className="btn" onClick={() => void store.flush()}>
          Retry save
        </button>
      )}
      <button
        type="button"
        className={"btn" + (!serverMode && dirty ? " is-primary" : "")}
        title="Download the explainer JSON, including the view edits made here"
        onClick={download}
      >
        Download explainer JSON
      </button>
    </div>
  );
}
