/**
 * The header. It is one row, in three versions:
 *
 * - Read (the default screen, for readers): the explainer title, the reading tabs (Guide, Map, Flow, Code),
 *   Present, and one "Edit" menu that holds the author tools: Explore, the tour editor, the download and the
 *   save status. A reader sees reader controls only (progressive disclosure).
 * - Explore (the author's workbench): the view tabs (ViewTabs; they scroll so the controls never leave the
 *   screen), the Tours panel, the Read / Explore / Present switch and the save / download controls.
 * - Present: the tour picker instead of the tabs (the tour decides which view is on screen).
 *
 * (The edge-kind and stub toggles sit with the diagram they filter, in Explore only: DiagramPane.)
 */
import { useEffect, useId, useRef, useState, type KeyboardEvent } from "react";
import { explainerFileName } from "../edits.js";
import { useStore, useViewerState } from "../hooks.js";
import { TourPanel } from "./TourPanel.js";
import { ViewTabs } from "./ViewTabs.js";
import { WorkspaceTabs } from "./WorkspaceTabs.js";

/** The tooltip of the disabled Present toggle. */
export const NO_TOURS_HINT =
  "This explainer has no tour yet. Run /code-explainer make tour in Claude Code, or add steps from the Tours panel.";

export function Header() {
  const store = useStore();
  const state = useViewerState();
  const [toursOpen, setToursOpen] = useState(false);
  const tours = state.model.tours;
  const present = state.mode === "present";
  const reading = !present && state.perspective !== "explore";
  // The tour panel belongs to Explore and Read: Present starts with it closed.
  useEffect(() => {
    if (present) setToursOpen(false);
  }, [present]);
  const save = { fileName: explainerFileName(state.explainer), json: () => store.explainerJson() };

  return (
    <header className={"header" + (present ? " is-present" : reading ? " is-reading" : "")}>
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
      ) : // One popup at a time: the views menu takes the place of the tour panel.
      reading ? (
        <WorkspaceTabs />
      ) : (
        <ViewTabs onMenuOpen={() => setToursOpen(false)} />
      )}

      <div className="spacer" />

      {reading ? (
        <>
          <PresentButton />
          <EditMenu {...save} toursOpen={toursOpen} onTours={() => setToursOpen((open) => !open)} />
        </>
      ) : (
        <>
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
              className=""
              aria-pressed={false}
              data-testid="mode-read"
              title="Back to the guide"
              onClick={() => store.setPerspective("guide")}
            >
              Read
            </button>
            <button
              type="button"
              className={!present ? "is-active" : ""}
              aria-pressed={!present}
              data-testid="mode-explore"
              onClick={() => store.setMode("explore")}
            >
              Explore
            </button>
            <button
              type="button"
              className={present ? "is-active" : ""}
              aria-pressed={present}
              data-testid="mode-present"
              disabled={tours.length === 0}
              title={tours.length === 0 ? NO_TOURS_HINT : "Present a tour: ← → step, Esc to leave"}
              onClick={() => store.setMode("present")}
            >
              Present
            </button>
          </div>

          {!present && <SaveControls {...save} />}
        </>
      )}

      {!present && toursOpen && <TourPanel onClose={() => setToursOpen(false)} />}
    </header>
  );
}

/** Read: the one button that starts the talk. */
function PresentButton() {
  const store = useStore();
  const state = useViewerState();
  const none = state.model.tours.length === 0;
  return (
    <button
      type="button"
      className="btn present-btn"
      data-testid="mode-present"
      aria-pressed={false}
      disabled={none}
      title={none ? NO_TOURS_HINT : "Show the guide as slides: ← → step, Esc to leave"}
      onClick={() => store.setMode("present")}
    >
      Present
    </button>
  );
}

/** What the save state is, in words (none when there is nothing to say). */
function saveStatus(state: ReturnType<typeof useViewerState>) {
  const { save, dirty, serverMode } = state;
  if (serverMode) {
    if (save.status === "saving")
      return { text: "Saving…", tone: "busy", title: "Saving your edits" };
    if (save.status === "error") {
      const text = `Not saved: ${save.message}`;
      return { text, tone: "error", title: text };
    }
    if (save.status === "saved")
      return { text: "Saved", tone: "ok", title: "Your edits are saved" };
    return undefined;
  }
  return dirty
    ? {
        text: "Unsaved",
        tone: "warn",
        title:
          "Unsaved edits: they live only in this page. Download the explainer JSON to keep them.",
      }
    : undefined;
}

function download(fileName: string, json: string): void {
  const url = URL.createObjectURL(new Blob([json], { type: "application/json" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = fileName;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/**
 * Read: the author tools, behind one button. Explore (the workbench), the tour editor, the download and the
 * save status. ↑ ↓ move along the items, Escape closes the menu.
 */
function EditMenu({
  fileName,
  json,
  toursOpen,
  onTours,
}: {
  fileName: string;
  json: () => string;
  toursOpen: boolean;
  onTours: () => void;
}) {
  const store = useStore();
  const state = useViewerState();
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const menuId = useId();
  const status = saveStatus(state);

  // A press outside the button and the menu closes it.
  useEffect(() => {
    if (!open) return;
    const onPress = (event: PointerEvent) => {
      if (!root.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", onPress, true);
    return () => document.removeEventListener("pointerdown", onPress, true);
  }, [open]);

  // The first item gets the focus, for the keys.
  useEffect(() => {
    if (open) root.current?.querySelector<HTMLElement>('[role="menuitem"]')?.focus();
  }, [open]);

  const close = (refocus: boolean) => {
    setOpen(false);
    if (refocus) button.current?.focus();
  };
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      close(true);
    } else if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      const items = [...event.currentTarget.querySelectorAll<HTMLElement>('[role="menuitem"]')];
      const at = items.indexOf(document.activeElement as HTMLElement);
      const step = event.key === "ArrowDown" ? 1 : -1;
      items[(at + step + items.length) % items.length]?.focus();
    } else if (event.key === "Tab") close(false);
  };
  const run = (action: () => void) => () => {
    close(false);
    action();
  };

  return (
    <div ref={root} className="edit-menu">
      <button
        ref={button}
        type="button"
        className={"btn edit-btn" + (open || toursOpen ? " is-active" : "")}
        data-testid="edit-button"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        title="Tools to change this explainer: explore the diagrams, edit the tours, download the file"
        onClick={() => (open ? close(false) : setOpen(true))}
      >
        Edit
        {status && status.tone !== "ok" && (
          <span
            className={`edit-dot is-${status.tone}`}
            role="status"
            aria-label={status.text}
            title={status.title}
          />
        )}
        <span className="views-caret" aria-hidden="true" />
      </button>
      {open && (
        <div
          id={menuId}
          className="edit-list"
          role="menu"
          aria-label="Edit"
          data-testid="edit-menu"
          onKeyDown={onKeyDown}
        >
          <button
            type="button"
            role="menuitem"
            className="edit-item"
            data-testid="edit-explore"
            onClick={run(() => store.setMode("explore"))}
          >
            <span className="edit-item-title">Explore the diagrams</span>
            <span className="edit-item-hint">
              Every view, with filters and the details of each box
            </span>
          </button>
          <button
            type="button"
            role="menuitem"
            className="edit-item"
            data-testid="edit-tours"
            aria-expanded={toursOpen}
            aria-controls="tour-panel"
            onClick={run(onTours)}
          >
            <span className="edit-item-title">Edit the guide's steps</span>
            <span className="edit-item-hint">Add, order and write the steps of a tour</span>
          </button>
          <button
            type="button"
            role="menuitem"
            className="edit-item"
            data-testid="edit-download"
            onClick={run(() => download(fileName, json()))}
          >
            <span className="edit-item-title">Download explainer JSON</span>
            <span className="edit-item-hint">The file with the edits made here</span>
          </button>
          {status && (
            <p className={`save-status is-${status.tone}`} role="status" title={status.title}>
              {status.text}
            </p>
          )}
          {state.serverMode && state.save.status === "error" && (
            <button
              type="button"
              role="menuitem"
              className="edit-item"
              onClick={run(() => void store.flush())}
            >
              <span className="edit-item-title">Retry save</span>
            </button>
          )}
        </div>
      )}
    </div>
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
  const status = saveStatus(state);
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
        onClick={() => download(fileName, json())}
      >
        Download explainer JSON
      </button>
    </div>
  );
}
