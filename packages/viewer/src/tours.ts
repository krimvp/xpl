/**
 * Pure helpers for tours (ARCHITECTURE.md section 6, handoff "Tours"): what a step's focus may hold,
 * ids for new tours and steps, and the edits the tour panel makes. Nothing here touches the store, so
 * every edit is a plain function from a `Tour` to a `Tour` that the unit tests can check.
 */
import {
  parseId,
  type ElementId,
  type Explainer,
  type ExplainerModel,
  type Tour,
  type TourStep,
} from "@xpl/core";

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** A step the viewer can play, or undefined when it has no usable `id` and `view`. Fixes what it can. */
function soundStep(step: unknown): TourStep | undefined {
  if (!isRecord(step) || typeof step.id !== "string" || typeof step.view !== "string") {
    return undefined;
  }
  const focus = Array.isArray(step.focus) ? step.focus : [];
  const ok =
    focus.every((id) => typeof id === "string") &&
    Array.isArray(step.focus) &&
    (step.note === undefined || typeof step.note === "string") &&
    (step.code === undefined || Array.isArray(step.code)) &&
    (step.editor === undefined || isRecord(step.editor));
  if (ok) return step as unknown as TourStep;
  const { note, code, editor, ...rest } = step;
  return {
    ...rest,
    id: step.id,
    view: step.view,
    focus: focus.filter((id): id is string => typeof id === "string"),
    ...(typeof note === "string" ? { note } : {}),
    ...(Array.isArray(code) ? { code } : {}),
    ...(isRecord(editor) ? { editor } : {}),
  } as unknown as TourStep;
}

/**
 * The explainer with tours the viewer can rely on: an array of tours that have a string id and title and
 * an array of steps that have an id, a view and a focus list. Hand-edited files may lack any of that; what
 * cannot be repaired (a step without a view) is left out. The same object when nothing needs fixing.
 * The viewer builds its model from this; the explainer it exports and saves keeps what the file said,
 * apart from a tour that is edited, which is written back whole.
 */
export function sanitizeTours(explainer: Explainer): Explainer {
  const tours: unknown = explainer.tours;
  if (Array.isArray(tours)) {
    const fixed = tours.map((tour): Tour | undefined => {
      if (!isRecord(tour) || typeof tour.id !== "string") return undefined;
      const steps: unknown = tour.steps;
      const list = Array.isArray(steps) ? steps.map(soundStep) : [];
      if (
        typeof tour.title === "string" &&
        Array.isArray(steps) &&
        list.every((step, i) => step === steps[i])
      ) {
        return tour as unknown as Tour;
      }
      return {
        ...tour,
        id: tour.id,
        title: typeof tour.title === "string" ? tour.title : tour.id,
        steps: list.filter((step): step is TourStep => step !== undefined),
      } as Tour;
    });
    if (fixed.every((tour, i) => tour === tours[i])) return explainer;
    return { ...explainer, tours: fixed.filter((tour): tour is Tour => tour !== undefined) };
  }
  return { ...explainer, tours: [] };
}

/**
 * The selected ids that can be stored in a step's `focus`: elements of the model (nodes, stored and
 * derived edges, concepts, sequence steps). What only exists on screen (a stub edge, a ghost box) and
 * ids the model does not know are left out; the order is kept.
 */
export function focusIds(selection: readonly ElementId[], model: ExplainerModel): ElementId[] {
  const out: ElementId[] = [];
  for (const id of selection) {
    const type = parseId(id).type;
    if (type === "stub" || type === "ghost" || !model.hasElement(id) || out.includes(id)) continue;
    out.push(id);
  }
  return out;
}

/** `Retry policy: the "why"` -> `retry-policy-the-why`; a valid slug (letters, digits, `-`), never empty. */
export function slugFromTitle(title: string): string {
  const slug = title
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .slice(0, 48)
    .replace(/^-+|-+$/g, "");
  return slug || "tour";
}

/** `tour:<slug of the title>`, made unique among `taken` with `-2`, `-3`, ... */
export function newTourId(title: string, taken: Iterable<string>): string {
  const used = new Set(taken);
  const base = `tour:${slugFromTitle(title)}`;
  let id = base;
  for (let n = 2; used.has(id); n++) id = `${base}-${n}`;
  return id;
}

/** The next free `t<n>`: above every `t<number>` the tour has, so a deleted step's id is not reused soon. */
export function newStepId(tour: Tour): string {
  const used = new Set(tour.steps.map((step) => step.id));
  let highest = 0;
  for (const id of used) {
    const match = /^t(\d+)$/.exec(id);
    if (match) highest = Math.max(highest, Number(match[1]));
  }
  let n = highest + 1;
  while (used.has(`t${n}`)) n++;
  return `t${n}`;
}

/** The tour with a step `{ view, focus }` at the end. */
export function appendStep(
  tour: Tour,
  view: string,
  focus: readonly ElementId[],
): { tour: Tour; stepId: string } {
  const stepId = newStepId(tour);
  const step: TourStep = { id: stepId, view, focus: [...focus] };
  return { tour: { ...tour, steps: [...tour.steps, step] }, stepId };
}

/** The explainer with `tour` replacing the tour of the same id (or appended when it is new). */
export function withTour(explainer: Explainer, tour: Tour): Explainer {
  const tours: readonly Tour[] = Array.isArray(explainer.tours) ? explainer.tours : [];
  const at = tours.findIndex((t) => t.id === tour.id);
  return {
    ...explainer,
    tours: at === -1 ? [...tours, tour] : tours.map((t, i) => (i === at ? tour : t)),
  };
}

/** Moves a step up (`-1`) or down (`+1`); the same tour when it cannot move. */
export function moveStep(tour: Tour, stepId: string, delta: number): Tour {
  const from = tour.steps.findIndex((step) => step.id === stepId);
  const to = from + delta;
  if (from === -1 || to < 0 || to >= tour.steps.length || delta === 0) return tour;
  const steps = [...tour.steps];
  const [moved] = steps.splice(from, 1);
  steps.splice(to, 0, moved!);
  return { ...tour, steps };
}

export function removeStep(tour: Tour, stepId: string): Tour {
  const steps = tour.steps.filter((step) => step.id !== stepId);
  return steps.length === tour.steps.length ? tour : { ...tour, steps };
}

/** Puts a step (back) at `index` (clamped); the same tour when a step with that id is already there. */
export function insertStep(tour: Tour, step: TourStep, index: number): Tour {
  if (tour.steps.some((s) => s.id === step.id)) return tour;
  const at = Math.min(Math.max(0, Math.floor(index)), tour.steps.length);
  const steps = [...tour.steps];
  steps.splice(at, 0, step);
  return { ...tour, steps };
}

/** Sets the note of a step; text that is only whitespace removes it. Kept as typed otherwise. */
export function setStepNote(tour: Tour, stepId: string, note: string): Tour {
  const at = tour.steps.findIndex((step) => step.id === stepId);
  if (at === -1) return tour;
  const step = tour.steps[at]!;
  if ((step.note ?? "") === note || (note.trim() === "" && step.note === undefined)) return tour;
  const { note: _dropped, ...rest } = step;
  const next: TourStep = note.trim() === "" ? rest : { ...rest, note };
  return { ...tour, steps: tour.steps.map((s, i) => (i === at ? next : s)) };
}

/** What a focus id is called in the tour panel: labels, and `A calls B` for a derived edge. */
export function focusLabel(id: ElementId, model: ExplainerModel): string {
  const parsed = parseId(id);
  if (parsed.type === "derived-edge") {
    return `${model.label(parsed.from)} ${parsed.kind} ${model.label(parsed.to)}`;
  }
  return model.label(id);
}
