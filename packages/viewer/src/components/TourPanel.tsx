/**
 * The tour panel (Explore mode, opened from the header): "a useful exploration becomes a talk by adding
 * a tour". It adds the current view and selection as a step to a tour (or to a new one, named here),
 * lists the steps of that tour with an editable note each, and lets you reorder or delete them. Every
 * edit goes through the store, which persists it (`PUT /api/tours/<id>`) or keeps it in memory.
 */
import type { Tour, TourStep } from "@xpl/core";
import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { useStore, useViewerState } from "../hooks.js";
import { focusIds, focusLabel } from "../tours.js";

/** The value of the target menu's "New tour…" entry. */
const NEW_TOUR = "\u0000new";

export function TourPanel({ onClose }: { onClose: () => void }) {
  const store = useStore();
  const state = useViewerState();
  const { model } = state;
  const tours = model.tours;
  const [chosen, setChosen] = useState<string>(
    () => state.tour?.tourId ?? tours[0]?.id ?? NEW_TOUR,
  );
  const [title, setTitle] = useState("");
  const [removed, setRemoved] = useState<{ tourId: string; step: TourStep; index: number }>();
  const [added, setAdded] = useState<string>();

  const isNew = chosen === NEW_TOUR || model.tour(chosen) === undefined;
  const tour = isNew ? undefined : model.tour(chosen);
  const view = state.viewId === undefined ? undefined : model.view(state.viewId);
  const focus = focusIds(state.selection, model);
  const panel = useRef<HTMLElement>(null);

  // A fresh step gets the caret in its note: the next thing to do is to say what it shows.
  useEffect(() => {
    if (added === undefined) return;
    const row = panel.current?.querySelector<HTMLElement>(`[data-step-id="${CSS.escape(added)}"]`);
    row?.scrollIntoView({ block: "nearest" });
    row?.querySelector<HTMLTextAreaElement>("textarea")?.focus();
    setAdded(undefined);
  }, [added, tour?.steps.length]);

  // The undo offer goes away by itself.
  useEffect(() => {
    if (!removed) return;
    const timer = setTimeout(() => setRemoved(undefined), 8000);
    return () => clearTimeout(timer);
  }, [removed]);

  const canAdd = view !== undefined && (!isNew || title.trim() !== "");
  const add = () => {
    if (!canAdd) return;
    const result = store.addToTour(isNew ? { title } : { tourId: chosen });
    if (!result) return;
    setChosen(result.tourId);
    setTitle("");
    setAdded(result.stepId);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    if (event.key !== "Escape") return;
    event.preventDefault();
    onClose();
  };

  return (
    <section
      ref={panel}
      id="tour-panel"
      className="tour-panel"
      data-testid="tour-panel"
      aria-label="Tours"
      onKeyDown={onKeyDown}
    >
      <header className="tp-head">
        <h2>Tours</h2>
        <button
          type="button"
          className="icon-btn"
          aria-label="Close the tour panel"
          onClick={onClose}
        >
          ×
        </button>
      </header>
      <p className="tp-intro">
        Pick what you want to show (a view and, in it, boxes, arrows, steps or concepts), then add
        it as a step. Present mode plays the steps in order.
      </p>

      <div className="tp-target">
        <label>
          <span>Tour</span>
          <select
            data-testid="tour-target"
            value={isNew ? NEW_TOUR : chosen}
            onChange={(event) => {
              setChosen(event.target.value);
              setRemoved(undefined);
            }}
          >
            {tours.map((t) => (
              <option key={t.id} value={t.id}>
                {t.title}
              </option>
            ))}
            <option value={NEW_TOUR}>New tour…</option>
          </select>
        </label>
        {isNew && (
          <input
            type="text"
            data-testid="tour-new-title"
            aria-label="Title of the new tour"
            placeholder="Title of the new tour"
            value={title}
            maxLength={120}
            onChange={(event) => setTitle(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                add();
              }
            }}
          />
        )}
      </div>

      <button
        type="button"
        className="btn is-primary tp-add"
        data-testid="tour-add"
        disabled={!canAdd}
        title={
          view
            ? "Append a step for the current view and selection"
            : "This explainer has no view to add"
        }
        onClick={add}
      >
        <span className="tp-add-title">Add to tour</span>
        <span className="tp-add-what">
          {view?.title ?? "no view"} ·{" "}
          {focus.length > 0 ? `${focus.length} selected` : "nothing selected"}
        </span>
      </button>

      {tour ? (
        <>
          <h3 className="tp-steps-title">
            Steps <span className="count">{tour.steps.length}</span>
          </h3>
          {tour.steps.length === 0 ? (
            <p className="empty">No steps yet.</p>
          ) : (
            <ol className="tp-steps">
              {tour.steps.map((step, i) => (
                <StepRow key={step.id} tour={tour} step={step} index={i} onRemoved={setRemoved} />
              ))}
            </ol>
          )}
          {removed && removed.tourId === tour.id && (
            <p className="tp-undo" role="status">
              Step removed.{" "}
              <button
                type="button"
                className="link"
                data-testid="tour-undo"
                onClick={() => {
                  store.restoreStep(removed.tourId, removed.step, removed.index);
                  setRemoved(undefined);
                }}
              >
                Undo
              </button>
            </p>
          )}
          <div className="tp-foot">
            <button
              type="button"
              className="btn"
              data-testid="tour-present"
              disabled={tour.steps.length === 0}
              onClick={() => {
                onClose();
                store.present(tour.id, 0);
              }}
            >
              Present this tour
            </button>
          </div>
        </>
      ) : (
        <p className="empty tp-empty">
          {tours.length === 0
            ? "There is no tour yet. Name one above and add the first step."
            : "Name the new tour above, then add its first step."}
        </p>
      )}
    </section>
  );
}

function StepRow({
  tour,
  step,
  index,
  onRemoved,
}: {
  tour: Tour;
  step: TourStep;
  index: number;
  onRemoved: (removed: { tourId: string; step: TourStep; index: number }) => void;
}) {
  const store = useStore();
  const state = useViewerState();
  const { model } = state;
  const viewTitle = model.view(step.view)?.title ?? step.view;
  const focus = (Array.isArray(step.focus) ? step.focus : []).map((id) => focusLabel(id, model));
  const current = state.tour?.tourId === tour.id && state.tour.step === index;
  const last = index === tour.steps.length - 1;
  return (
    <li
      className={"tp-step" + (current ? " is-current" : "")}
      data-testid="tour-step"
      data-step-id={step.id}
      aria-current={current ? "step" : undefined}
    >
      <div className="tp-step-head">
        <button
          type="button"
          className="tp-step-show"
          title="Show this step: its view and selection"
          onClick={() => store.previewStep(tour.id, index)}
        >
          <span className="tp-num">{index + 1}</span>
          <span className="tp-step-text">
            <span className="tp-step-view">{viewTitle}</span>
            <span className="tp-step-focus">
              {focus.length > 0 ? focus.join(", ") : "whole view"}
            </span>
          </span>
        </button>
        <span className="tp-step-tools">
          <button
            type="button"
            className="icon-btn"
            data-testid="tour-step-up"
            aria-label={`Move step ${index + 1} up`}
            title="Move up"
            disabled={index === 0}
            onClick={() => store.moveStep(tour.id, step.id, -1)}
          >
            ↑
          </button>
          <button
            type="button"
            className="icon-btn"
            data-testid="tour-step-down"
            aria-label={`Move step ${index + 1} down`}
            title="Move down"
            disabled={last}
            onClick={() => store.moveStep(tour.id, step.id, 1)}
          >
            ↓
          </button>
          <button
            type="button"
            className="icon-btn is-danger"
            data-testid="tour-step-delete"
            aria-label={`Delete step ${index + 1}`}
            title="Delete this step"
            onClick={() => {
              const removed = store.removeStep(tour.id, step.id);
              if (removed) onRemoved({ tourId: tour.id, ...removed });
            }}
          >
            ×
          </button>
        </span>
      </div>
      <textarea
        data-testid="tour-step-note"
        aria-label={`Note for step ${index + 1}`}
        placeholder="Caption shown while presenting (markdown)"
        rows={2}
        value={step.note ?? ""}
        onChange={(event) => store.setStepNote(tour.id, step.id, event.target.value)}
      />
    </li>
  );
}
