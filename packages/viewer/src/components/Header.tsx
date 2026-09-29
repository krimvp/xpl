/**
 * The header: explainer title and view switcher, the Tours panel, the Explore / Present toggle and the
 * save / download controls. While presenting it holds the tour picker instead of the view tabs: the tour
 * decides which view is on screen. (The edge-kind toggles sit with the diagram they filter: EdgeKinds.)
 */
import { useEffect, useState } from "react";
import { explainerFileName } from "../edits.js";
import { useStore, useViewerState } from "../hooks.js";
import { TourPanel } from "./TourPanel.js";

/** The tooltip of the disabled Present toggle. */
export const NO_TOURS_HINT =
  "This explainer has no tour yet. Run /code-explainer make tour in Claude Code, or add steps from the Tours panel.";

export function Header() {
  const store = useStore();
  const state = useViewerState();
  const [toursOpen, setToursOpen] = useState(false);
  const views = state.model.views;
  const tours = state.model.tours;
  const present = state.mode === "present";
  // The tour panel belongs to Explore: Present starts with it closed.
  useEffect(() => {
    if (present) setToursOpen(false);
  }, [present]);

  return (
    <header className={"header" + (present ? " is-present" : "")}>
      <div className="brand">
        <span className="logo" aria-hidden="true">
          xpl
        </span>
        <h1 className="title" title={state.explainer.title}>
          {state.explainer.title}
        </h1>
      </div>

      {present ? (
        <TourPicker />
      ) : (
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
      )}

      <div className="spacer" />

      {!present && (
        <button
          type="button"
          className={"btn tours-btn" + (toursOpen ? " is-active" : "")}
          data-testid="tours-button"
          aria-expanded={toursOpen}
          aria-controls="tour-panel"
          title="Add the current view and selection to a tour, and edit the steps of your tours"
          onClick={() => setToursOpen((open) => !open)}
        >
          Tours
          {tours.length > 0 && <span className="count">{tours.length}</span>}
        </button>
      )}

      <div className="segmented" role="group" aria-label="Mode">
        <button
          type="button"
          className={state.mode === "explore" ? "is-active" : ""}
          aria-pressed={state.mode === "explore"}
          data-testid="mode-explore"
          onClick={() => store.setMode("explore")}
        >
          Explore
        </button>
        <button
          type="button"
          className={state.mode === "present" ? "is-active" : ""}
          aria-pressed={state.mode === "present"}
          data-testid="mode-present"
          disabled={tours.length === 0}
          title={tours.length === 0 ? NO_TOURS_HINT : "Present a tour: ← → step, Esc to leave"}
          onClick={() => store.setMode("present")}
        >
          Present
        </button>
      </div>

      {!present && (
        <SaveControls
          fileName={explainerFileName(state.explainer)}
          json={() => store.explainerJson()}
        />
      )}

      {!present && toursOpen && <TourPanel onClose={() => setToursOpen(false)} />}
    </header>
  );
}

/** Present mode: which tour is played. Choosing one starts it at its first step. */
function TourPicker() {
  const store = useStore();
  const state = useViewerState();
  const tours = state.model.tours;
  return (
    <label className="tour-picker">
      <span className="tour-picker-label">Tour</span>
      <select
        data-testid="tour-picker"
        value={state.tour?.tourId ?? ""}
        onChange={(event) => {
          store.chooseTour(event.target.value);
          // Hand the keys back to the talk: a focused menu would keep the arrows for itself.
          event.currentTarget.blur();
        }}
      >
        {tours.map((tour) => (
          <option key={tour.id} value={tour.id}>
            {tour.title}
          </option>
        ))}
      </select>
    </label>
  );
}

function SaveControls({ fileName, json }: { fileName: string; json: () => string }) {
  const store = useStore();
  const state = useViewerState();
  const { save, dirty, serverMode } = state;

  let status: { text: string; tone: string; title: string } | undefined;
  if (serverMode) {
    if (save.status === "saving") {
      status = { text: "Saving…", tone: "busy", title: "Saving your edits" };
    } else if (save.status === "error") {
      const text = `Not saved: ${save.message}`;
      status = { text, tone: "error", title: text };
    } else if (save.status === "saved") {
      status = { text: "Saved", tone: "ok", title: "Your edits are saved" };
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
        title="Download the explainer JSON, including the view and tour edits made here"
        onClick={download}
      >
        Download explainer JSON
      </button>
    </div>
  );
}
