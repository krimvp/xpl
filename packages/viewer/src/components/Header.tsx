/**
 * The header: one row, built the same way in every mode.
 *
 *   [xpl] Title | what this mode moves between | spacer | save state | the mode's one action | Edit ▾
 *
 * - Read (the default screen, for readers): the reading tabs (Guide, Map, Flow, Code); the action is
 *   Present.
 * - Explore (the author's workbench): the view tabs and the Views menu (ViewTabs: they scroll, so the
 *   controls never leave the screen); the action is Present.
 * - Present: the tour picker and the step progress (‹ 3 / 10 ›, and a bar along the header's lower edge);
 *   the action is Exit.
 *
 * Every author tool sits in the one "Edit" menu: the way between Read and Explore, the tour editor, the
 * stub and edge-kind toggles of a graph view (Explore), "Save as HTML" and the JSON download. The save
 * state shows beside Edit only when there is something to say ("Unsaved", "Saving…", "Not saved").
 */
import { useEffect, useId, useRef, useState, type KeyboardEvent } from "react";
import { DEFAULT_EDGE_KINDS, resolveStubPolicy } from "@xpl/core";
import { explainerFileName } from "../edits.js";
import { useStore, useViewerState } from "../hooks.js";
import { stepNumber } from "../modes.js";
import { canSaveHtml } from "../saveHtml.js";
import { SaveHtml } from "./SaveHtml.js";
import { FeedbackPanel } from "./FeedbackPanel.js";
import { EdgeKindToggles } from "./EdgeKinds.js";
import { StubsControl } from "./StubsControl.js";
import { TourPanel } from "./TourPanel.js";
import { ViewTabs } from "./ViewTabs.js";
import { WorkspaceTabs } from "./WorkspaceTabs.js";

/** The tooltip of the disabled Present button. */
export const NO_TOURS_HINT =
  "This explainer has no tour yet. Run /code-explainer make tour in Claude Code, or add steps with Edit > Edit the guide's steps.";

export function Header() {
  const state = useViewerState();
  const [feedbackOpen, setFeedbackOpen] = useState(false);
  const [toursOpen, setToursOpen] = useState(false);
  const present = state.mode === "present";
  const reading = !present && state.perspective !== "explore";
  const mode = present ? "present" : reading ? "read" : "explore";

  return (
    <header className={`header is-${mode}` + (reading ? " is-reading" : "")} data-mode={mode}>
      <div className="brand">
        <span className="logo" aria-hidden="true">
          xpl
        </span>
        <h1
          className="title"
          title={[state.explainer.title, state.explainer.scope?.audience?.trim()]
            .filter(Boolean)
            .join("\n")}
        >
          {state.explainer.title}
        </h1>
      </div>

      {present ? (
        <>
          <TourPicker />
          <StepProgress />
        </>
      ) : reading ? (
        <WorkspaceTabs />
      ) : (
        // One popup at a time: the views menu takes the place of the tour editor.
        <ViewTabs onMenuOpen={() => setToursOpen(false)} />
      )}

      <div className="spacer" />
      <SaveStatus />
      <button
        className="btn"
        type="button"
        aria-expanded={feedbackOpen}
        onClick={() => {
          setFeedbackOpen(!feedbackOpen);
          setToursOpen(false);
        }}
      >
        Feedback{state.feedback.length > 0 ? ` (${state.feedback.length})` : ""}
      </button>
      {present ? <ExitButton /> : <PresentButton />}
      <EditMenu toursOpen={toursOpen} onTours={() => setToursOpen((open) => !open)} />

      {feedbackOpen && <FeedbackPanel onClose={() => setFeedbackOpen(false)} />}
      {toursOpen && <TourPanel onClose={() => setToursOpen(false)} />}
    </header>
  );
}

/** Read and Explore: the one button that starts the talk. */
function PresentButton() {
  const store = useStore();
  const state = useViewerState();
  const none = state.model.tours.length === 0;
  return (
    <button
      type="button"
      className="btn present-btn"
      data-testid="mode-present"
      disabled={none}
      title={none ? NO_TOURS_HINT : "Show the guide as slides: ← → step, Esc to leave"}
      onClick={() => store.setMode("present")}
    >
      Present
    </button>
  );
}

/** Present: back to where the talk was started from (Read or Explore), like Esc. */
function ExitButton() {
  const store = useStore();
  return (
    <button
      type="button"
      className="btn present-btn"
      data-testid="present-exit"
      title="Leave the talk (Esc)"
      onClick={() => store.exitPresent()}
    >
      Exit
    </button>
  );
}

/** Present: the step counter between the previous and next buttons, and a bar along the header's edge. */
function StepProgress() {
  const store = useStore();
  const state = useViewerState();
  const tour = store.currentTour();
  const count = tour?.steps.length ?? 0;
  if (!tour || count === 0) return null;
  const index = state.tour?.step ?? 0;
  const detour = state.applied === undefined;
  return (
    <div className="step-progress" title="← → step · Home, End: first, last · Esc: leave">
      <button
        type="button"
        className="tour-btn"
        data-testid="tour-prev"
        aria-label="Previous step"
        title="Previous step (←, Page Up)"
        disabled={index === 0}
        onClick={() => store.prevStep()}
      >
        ‹
      </button>
      <span className="tour-counter" data-testid="tour-counter" aria-live="polite">
        {stepNumber(index)} / {count}
      </span>
      <button
        type="button"
        className="tour-btn"
        data-testid="tour-next"
        aria-label="Next step"
        title="Next step (→, Page Down, Space)"
        disabled={index >= count - 1}
        onClick={() => store.nextStep()}
      >
        ›
      </button>
      {detour && (
        <p
          className="tour-detour"
          role="status"
          data-testid="tour-detour"
          title="A click took the screen off the tour: an arrow key applies the next step again"
        >
          Exploring ·{" "}
          <button type="button" className="link" onClick={() => store.goToStep(index)}>
            Back to step {stepNumber(index)}
          </button>
        </p>
      )}
      <span className="tour-progress" aria-hidden="true">
        <span style={{ width: `${(stepNumber(index) / count) * 100}%` }} />
      </span>
    </div>
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
          "Unsaved edits: they live only in this page. Use Edit > Save as HTML (or download the explainer JSON) to keep them.",
      }
    : undefined;
}

/** Beside Edit: the save state, when there is one. */
function SaveStatus() {
  const status = saveStatus(useViewerState());
  if (!status) return null;
  return (
    <span className={`save-status is-${status.tone}`} role="status" title={status.title}>
      {status.text}
    </span>
  );
}

function download(fileName: string, text: string, type: string): void {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const link = document.createElement("a");
  link.href = url;
  link.download = fileName;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/**
 * Every author tool, behind one button. ↑ ↓ move along the items, Escape closes the menu (and gives the
 * focus back to the button), Tab leaves it. The toggles of a graph view keep the menu open: a toggle is
 * often flipped twice.
 */
function EditMenu({ toursOpen, onTours }: { toursOpen: boolean; onTours: () => void }) {
  const store = useStore();
  const state = useViewerState();
  const [open, setOpen] = useState(false);
  const [htmlOpen, setHtmlOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const menuId = useId();
  const status = saveStatus(state);
  const present = state.mode === "present";
  const reading = !present && state.perspective !== "explore";
  const view = store.view();
  const graph = !present && !reading && view?.type === "graph" ? view : undefined;

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
      const items = [...event.currentTarget.querySelectorAll<HTMLElement>("button:not(:disabled)")];
      const at = items.indexOf(document.activeElement as HTMLElement);
      const step = event.key === "ArrowDown" ? 1 : -1;
      items[(at + step + items.length) % items.length]?.focus();
    } else if (event.key === "Tab") close(false);
  };
  const run = (action: () => void) => () => {
    close(false);
    action();
  };
  const fileName = explainerFileName(state.explainer);

  return (
    <div ref={root} className="edit-menu">
      {htmlOpen && (
        <SaveHtml
          onClose={() => {
            setHtmlOpen(false);
            button.current?.focus();
          }}
          onDownload={(name, html) => download(name, html, "text/html")}
        />
      )}
      <button
        ref={button}
        type="button"
        className={"btn edit-btn" + (open || toursOpen ? " is-active" : "")}
        data-testid="edit-button"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        title="Tools to change this explainer: the diagrams, the tours, saving"
        onClick={() => (open ? close(false) : setOpen(true))}
      >
        Edit
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
          {reading && (
            <MenuItem
              testId="edit-explore"
              title="Explore the diagrams"
              hint="Every view, with filters and the details of each box"
              onClick={run(() => store.setMode("explore"))}
            />
          )}
          {!present && !reading && (
            <MenuItem
              testId="edit-read"
              title="Back to reading"
              hint="The guide, the map, the flow and the code"
              onClick={run(() => store.setPerspective(store.lastReading()))}
            />
          )}
          <MenuItem
            testId="edit-tours"
            title="Edit the guide's steps"
            hint="Add, order and write the steps of a tour"
            expanded={toursOpen}
            onClick={run(onTours)}
          />
          {graph && (
            <div className="edit-group" role="group" aria-label="This view">
              <p className="edit-group-title">This view</p>
              <StubsControl {...resolveStubPolicy(graph.stubs)} />
              <EdgeKindToggles kinds={graph.edgeKinds ?? DEFAULT_EDGE_KINDS} />
            </div>
          )}
          {canSaveHtml() && (
            <MenuItem
              testId="edit-save-html"
              title="Save as HTML"
              hint={
                state.serverMode
                  ? "A copy of this page with your edits, to share: it opens without xpl"
                  : "This page with your edits in it: open the file to see them again"
              }
              onClick={run(() => setHtmlOpen(true))}
            />
          )}
          <MenuItem
            testId="edit-download"
            title="Download explainer JSON"
            hint="The file with the edits made here"
            onClick={run(() => download(fileName, store.explainerJson(), "application/json"))}
          />
          {status && status.tone !== "ok" && (
            <p className={`edit-note is-${status.tone}`} title={status.title}>
              {status.tone === "warn"
                ? "Your edits live only in this page until you save them."
                : status.text}
            </p>
          )}
          {state.serverMode && state.save.status === "error" && (
            <MenuItem
              testId="edit-retry"
              title="Retry save"
              onClick={run(() => void store.flush())}
            />
          )}
        </div>
      )}
    </div>
  );
}

function MenuItem({
  testId,
  title,
  hint,
  expanded,
  onClick,
}: {
  testId: string;
  title: string;
  hint?: string;
  expanded?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      role="menuitem"
      className="edit-item"
      data-testid={testId}
      aria-expanded={expanded}
      aria-controls={expanded !== undefined ? "tour-panel" : undefined}
      onClick={onClick}
    >
      <span className="edit-item-title">{title}</span>
      {hint && <span className="edit-item-hint">{hint}</span>}
    </button>
  );
}

/**
 * Which tour is played (Present) or read (the Guide, when there are several). Choosing one starts it at
 * its first step.
 */
export function TourPicker({ testId = "tour-picker" }: { testId?: string }) {
  const store = useStore();
  const state = useViewerState();
  const tours = state.model.tours;
  const current = store.currentTour() ?? tours[0];
  return (
    <label className="tour-picker">
      <span className="tour-picker-label">Tour</span>
      <select
        data-testid={testId}
        value={current?.id ?? ""}
        onChange={(event) => {
          if (state.mode === "present") store.chooseTour(event.target.value);
          else store.previewStep(event.target.value, 0);
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
