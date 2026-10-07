/**
 * The Guide (Read mode): the tour as a page. Under the tour's title and summary, one section per step: its
 * title, its note, a still picture of the step's diagram framed on what the step is about (with "Open in
 * Map / Flow"), the interaction or the parts it focuses, and the tests it points at, gathered in one
 * "Tests" list. A tour picker sits above the title when the explainer has several tours.
 *
 * The contents (and, through `onReading`, the breadcrumb) follow the scrolling: they mark the section being
 * read, not only the one last clicked.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import {
  changeOmissions,
  codeFocus,
  isTestFile,
  type ExplainerModel,
  type TourStep,
} from "@xpl/core";
import { ExplanationInfo } from "./ExplanationInfo.js";
import { callersOf, changeSummary, type Caller } from "../callers.js";
import { overrideFocus } from "../derive.js";
import { changeFiles, changeOf, STATUS_WORDS } from "../diff.js";
import { readLaunchParams } from "../data.js";
import { useStore, useViewerState } from "../hooks.js";
import { renderInline, renderMarkdown } from "../markdown.js";
import { stepTests } from "../stepTests.js";
import { stepText, stepTitle } from "../stepTitle.js";
import { TourPicker } from "./Header.js";
import { Snapshot } from "./Snapshot.js";
import { GuideSource } from "./GuideSource.js";

export function Guide({ onReading }: { onReading?: (stepId: string | undefined) => void } = {}) {
  const store = useStore();
  const state = useViewerState();
  const tour = store.currentTour() ?? state.model.tours[0];
  const [linked] = useState(() => {
    const params = readLaunchParams();
    return params.perspective === "guide" ? params : undefined;
  });
  const linkedStep = linked?.stepId;
  const staleLink =
    !!linkedStep &&
    ((linked?.tour !== undefined &&
      linked.tour !== tour?.id &&
      linked.tour !== tour?.id.slice(5)) ||
      !tour?.steps.some((step) => step.id === linkedStep));
  const body = useRef<HTMLDivElement>(null);
  const staleNotice = useRef<HTMLParagraphElement>(null);
  const initialized = useRef(false);
  /** The step the page opened on: the guide starts at its top (title, summary), not scrolled to it. */
  const opening = useRef<string | undefined>(undefined);
  const active =
    state.applied && state.applied.tourId === tour?.id ? state.applied.stepId : undefined;

  // The section being read: the last one whose top has passed a third of the way down the scroller.
  const [reading, setReading] = useState<string | undefined>(undefined);
  useEffect(() => {
    const element = body.current;
    if (!element) return;
    const scroller =
      getComputedStyle(element).overflowY === "auto"
        ? element
        : element.closest<HTMLElement>(".workspace-columns");
    if (!scroller) return;
    const update = () => {
      const line = scroller.getBoundingClientRect().top + scroller.clientHeight / 3;
      let current: string | undefined;
      for (const section of element.querySelectorAll<HTMLElement>("[data-section-id]")) {
        if (section.getBoundingClientRect().top <= line) current = section.dataset.sectionId;
      }
      // At the very bottom the last section is the one being read, however short it is.
      if (scroller.scrollTop + scroller.clientHeight >= scroller.scrollHeight - 2) {
        const all = element.querySelectorAll<HTMLElement>("[data-section-id]");
        current = all[all.length - 1]?.dataset.sectionId ?? current;
      }
      setReading(scroller.scrollTop > 0 ? current : undefined);
    };
    update();
    scroller.addEventListener("scroll", update, { passive: true });
    return () => scroller.removeEventListener("scroll", update);
  }, [tour?.id]);
  const current = reading ?? active;
  useEffect(() => onReading?.(reading), [reading, onReading]);

  useEffect(() => {
    if (
      !initialized.current &&
      tour &&
      !state.applied &&
      state.selection.length === 0 &&
      !state.canGoBack &&
      !state.canGoForward
    ) {
      initialized.current = true;
      const at = state.tour?.step ?? 0;
      if (at === 0) opening.current = tour.steps[0]?.id;
      store.previewStep(tour.id, at);
    }
  }, [
    store,
    tour,
    state.applied,
    state.selection.length,
    state.tour?.step,
    state.canGoBack,
    state.canGoForward,
  ]);

  useEffect(() => {
    if (active === undefined) return;
    // The first section, applied as the page opens: the reader starts with the title and the summary.
    if (active === opening.current) {
      opening.current = undefined;
      return;
    }
    opening.current = undefined;
    const section =
      active &&
      body.current?.querySelector<HTMLElement>(`[data-section-id="${CSS.escape(active)}"]`);
    if (!section || !body.current) return;
    const scroller =
      getComputedStyle(body.current).overflowY === "auto"
        ? body.current
        : body.current.closest<HTMLElement>(".workspace-columns");
    if (!scroller) return;
    const at = section.getBoundingClientRect(),
      viewport = scroller.getBoundingClientRect();
    if (at.top < viewport.top || at.bottom > viewport.bottom)
      scroller.scrollTop += at.top - viewport.top - 24;
    if (active === linkedStep && !staleLink)
      section.querySelector<HTMLElement>("h3")?.focus({ preventScroll: true });
  }, [active, linkedStep, staleLink]);

  useEffect(() => {
    if (staleLink) staleNotice.current?.focus({ preventScroll: true });
  }, [staleLink]);

  if (!tour)
    return (
      <div className="guide-fallback">
        <p className="eyebrow">Start here</p>
        <h2>{state.explainer.title}</h2>
        <Audience />
        <ExplanationInfo />
        <p>Choose a topic below, or open the map to see the parts of the code.</p>
        {state.model.views.map((view) => (
          <section className="guide-section" key={view.id}>
            <h3>{view.title}</h3>
            <p>{view.scope?.question}</p>
            {state.model.concepts.map((concept) => (
              <p key={concept.id}>
                <button className="link" onClick={() => store.select([concept.id])}>
                  {concept.label}
                </button>{" "}
                — {concept.summary}
              </p>
            ))}
            <button
              className="btn"
              onClick={() => {
                store.setView(view.id);
                store.setPerspective(view.type === "graph" ? "map" : "flow");
              }}
            >
              Show this topic
            </button>
          </section>
        ))}
        {state.model.views.length === 0 && <p>This explainer has no topics yet.</p>}
      </div>
    );

  const title = (step: TourStep) => stepTitle(step, state.model);
  const summary =
    typeof tour.summary === "string" && tour.summary.trim() ? tour.summary : undefined;
  return (
    <div className="guide-layout" data-testid="guide">
      <nav className="guide-contents" aria-label="Guide contents">
        <p className="eyebrow">In this guide</p>
        {tour.steps.map((step, index) => (
          <button
            key={step.id}
            type="button"
            aria-current={step.id === current ? "step" : undefined}
            onClick={() => store.previewStep(tour.id, index)}
          >
            <span>{index + 1}</span>
            {title(step)}
          </button>
        ))}
      </nav>
      <div className="guide-body" ref={body}>
        {staleLink && (
          <p className="guide-link-notice" role="alert" tabIndex={-1} ref={staleNotice}>
            This linked step is no longer in this guide. Start at the guide's beginning or choose a
            step below.
          </p>
        )}
        {/* A phone: the steps as one picker that scrolls away with the text (the list above is hidden). */}
        <label className="guide-step-picker">
          <span className="sr-only">Go to a step</span>
          <select
            data-testid="guide-step-picker"
            value={Math.max(
              0,
              tour.steps.findIndex((step) => step.id === current),
            )}
            onChange={(event) => store.previewStep(tour.id, Number(event.target.value))}
          >
            {tour.steps.map((step, index) => (
              <option key={step.id} value={index}>
                Step {index + 1} of {tour.steps.length}: {title(step)}
              </option>
            ))}
          </select>
        </label>
        {/* Several tours: which one is read, above its title. */}
        {state.model.tours.length > 1 && (
          <div className="guide-tours">
            <TourPicker testId="guide-tour-picker" />
            <span className="guide-tours-count">{state.model.tours.length} tours</span>
          </div>
        )}
        <h2>{tour.title}</h2>
        <Audience />
        {/* The summary comes first: what this is and why it matters, before any detail. */}
        {summary && (
          <div
            className="guide-summary markdown"
            data-testid="tour-summary"
            dangerouslySetInnerHTML={{ __html: renderMarkdown(summary) }}
          />
        )}
        <ChangeOmissions />
        <ExplanationInfo />
        <ChangeFiles />
        {tour.steps.map((step, index) => (
          <GuideSection
            key={step.id}
            step={step}
            index={index}
            tourId={tour.id}
            active={step.id === active}
            linked={step.id === linkedStep && !staleLink}
          />
        ))}
      </div>
    </div>
  );
}

function ChangeOmissions() {
  const state = useViewerState();
  const change = changeOf(state.explainer);
  if (!change) return null;
  const omissions = changeOmissions(change, state.model.index.index);
  if (omissions.length === 0) return null;
  return (
    <section className="change-omissions" data-testid="change-omissions" aria-label="Not checked">
      <h3>Not checked</h3>
      <ul>
        {omissions.map((item) => (
          <li key={item}>{item}</li>
        ))}
      </ul>
    </section>
  );
}

/** Who the page is for (`scope.audience`), under the title; nothing when the author did not say. */
function Audience() {
  const audience = useViewerState().explainer.scope?.audience?.trim();
  if (!audience) return null;
  return (
    <p className="guide-audience" data-testid="audience">
      {audience}
    </p>
  );
}

/**
 * One section of the guide: a tour step. Its title, then the rest of its note (the title is not said
 * twice), then its diagram (a still picture framed on the focus), what it shows (the interaction it
 * focuses, the members of a group, what a concept applies to) and its tests. Each thing is said once: the
 * summaries of the focused elements only stand in for a missing note.
 */
function GuideSection({
  step,
  index,
  tourId,
  active,
  linked,
}: {
  step: TourStep;
  index: number;
  tourId: string;
  active: boolean;
  linked: boolean;
}) {
  const store = useStore();
  const state = useViewerState();
  const { title, titleMarkdown, body } = stepText(step, state.model);
  const hasNote = typeof step.note === "string" && step.note.trim() !== "";
  const view = state.model.view(step.view);
  const tests = useMemo(
    () =>
      stepTests(
        step.focus,
        state.model,
        Array.isArray(step.code) && step.code.length > 0
          ? overrideFocus({ anchors: step.code, owner: `${tourId}/${step.id}` }, state.model)
          : [],
      ),
    [step, state.model, tourId],
  );
  // A change: the code outside the step that calls what the step's parts changed (what a reviewer checks next).
  const changeCallers = useMemo((): Caller[] => {
    const change = changeOf(state.explainer);
    if (!change) return [];
    const ids = step.focus.flatMap((id) =>
      state.model.element(id)?.type === "node" && state.model.node(id)?.kind === "group"
        ? [id, ...state.model.members(id)]
        : [id],
    );
    const changed = ids.filter((id) => changeSummary(id, state.model.index, change));
    const files = new Set(
      changed
        .map((id) => codeFocus([id], state.model)[0]?.file)
        .filter((file) => file !== undefined),
    );
    const byFrom = new Map<string, Caller>();
    for (const id of changed) {
      for (const caller of callersOf(id, state.model.index)) {
        if (!files.has(caller.file) && !byFrom.has(caller.from)) byFrom.set(caller.from, caller);
      }
    }
    return [...byFrom.values()].slice(0, 8);
  }, [step, state.model, state.explainer]);
  const show = (perspective: "map" | "flow" | "code") => {
    store.previewStep(tourId, index);
    store.setPerspective(perspective);
  };
  // The steps inside one part that the section is about (from = to): one "This step" card lists them all.
  const selfSteps = step.focus.flatMap((id) => {
    const element = state.model.element(id);
    return element?.type === "step" && element.step.from === element.step.to
      ? [{ id, from: element.step.from, label: element.step.label }]
      : [];
  });
  // a11y: every step has the same buttons and lists; their names say which step they belong to
  const where = `step ${index + 1}: ${title}`;
  const link = new URL(location.href);
  for (const key of ["mode", "view", "focus", "file", "range", "side"])
    link.searchParams.delete(key);
  link.searchParams.set("perspective", "guide");
  link.searchParams.set("tour", tourId);
  link.searchParams.set("step", String(index + 1));
  link.searchParams.set("step-id", step.id);
  return (
    <section className={`guide-section${active ? " is-active" : ""}`} data-section-id={step.id}>
      <span className="section-number">Step {index + 1}</span>
      {titleMarkdown !== undefined ? (
        <h3 tabIndex={-1} dangerouslySetInnerHTML={{ __html: renderInline(titleMarkdown) }} />
      ) : (
        <h3 tabIndex={-1}>{title}</h3>
      )}
      <div className="guide-section-actions">
        <a href={link.href}>Link to this step</a>
        {linked && (
          <button type="button" className="btn" onClick={() => store.present(tourId, index)}>
            Continue from this step
          </button>
        )}
      </div>
      <div className="guide-explanation">
        <div className="guide-prose">
          {body && (
            <div
              className="markdown"
              data-testid="section-note"
              dangerouslySetInnerHTML={{ __html: renderMarkdown(body) }}
            />
          )}
          {!hasNote &&
            step.focus.map((id) => {
              const summary = summaryOf(id, state.model);
              return summary ? (
                <p key={id} data-testid="focus-summary">
                  <strong>{state.model.label(id)}</strong> —{" "}
                  <span dangerouslySetInnerHTML={{ __html: renderInline(summary) }} />
                </p>
              ) : null;
            })}
        </div>
        <GuideSource step={step} tourId={tourId} index={index} />
      </div>
      {view && (
        <Snapshot
          view={view}
          focus={step.focus}
          onOpen={() => show(view.type === "graph" ? "map" : "flow")}
          context={where}
        />
      )}
      {step.focus.map((id) => {
        const element = state.model.element(id);
        const members =
          element?.type === "node" && element.node.kind === "group"
            ? state.model.members(id)
            : element?.type === "concept"
              ? (element.concept.related ?? [])
              : [];
        // A group of tests is listed once, under "Tests", not again as parts.
        const onlyTests =
          tests.length > 0 &&
          members.length > 0 &&
          members.every((member) =>
            codeFocus([member], state.model).every((range) => isTestFile(range.file)),
          );
        if (element?.type === "step") {
          const { from, to, label } = element.step;
          // A step inside one part (from = to) is one box with what it does, not "X → X". The section's steps
          // of that kind share one card (two cards both called "This step" read as a repeat).
          if (from === to) {
            if (selfSteps[0]?.id !== id) return null;
            return (
              <figure
                className="guide-mini"
                key={id}
                aria-label={`Interaction: ${selfSteps.map((s) => s.label).join("; ")}`}
              >
                <figcaption>This step</figcaption>
                {selfSteps.map((self) => (
                  <div className="guide-mini-row" key={self.id}>
                    <button
                      className="guide-mini-node is-self"
                      data-testid="guide-mini-self"
                      onClick={() => store.select([self.from])}
                    >
                      <span className="guide-mini-name">
                        inside {state.model.label(self.from)}:
                      </span>{" "}
                      <span className="guide-mini-what">{self.label}</span>
                    </button>
                  </div>
                ))}
              </figure>
            );
          }
          return (
            <figure className="guide-mini" key={id} aria-label={`Interaction: ${label}`}>
              <figcaption>This call</figcaption>
              <div className="guide-mini-row">
                <button className="guide-mini-node" onClick={() => store.select([from])}>
                  {state.model.label(from)}
                </button>
                <button
                  className="guide-mini-link"
                  onClick={() => store.previewStep(tourId, index)}
                >
                  {label}
                  <span aria-hidden="true">→</span>
                </button>
                <button className="guide-mini-node" onClick={() => store.select([to])}>
                  {state.model.label(to)}
                </button>
              </div>
            </figure>
          );
        }
        return members.length > 0 && !onlyTests ? (
          <figure className="guide-mini" key={id}>
            <figcaption>{element?.type === "concept" ? "Where this applies" : "Parts"}</figcaption>
            <div className="guide-mini-row">
              {members.map((member) => (
                <button
                  className="guide-mini-node"
                  key={member}
                  onClick={() => store.select([member])}
                >
                  {state.model.label(member)}
                </button>
              ))}
            </div>
          </figure>
        ) : null;
      })}
      {tests.length > 0 && (
        <section
          className="guide-tests"
          data-testid="guide-tests"
          aria-label={`Tests, step ${index + 1}`}
        >
          <h4>Tests</h4>
          <ul>
            {tests.map((test) => (
              <li key={`${test.file}:${test.name}`}>
                <button
                  type="button"
                  className="guide-test"
                  title={`Open ${test.file} at line ${test.line}`}
                  onClick={() => {
                    store.previewStep(tourId, index);
                    store.openFile(test.file, test.line);
                    store.setPerspective("code");
                  }}
                >
                  <code>{test.name}</code>
                  <span className="guide-test-file">{test.file}</span>
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}
      {changeCallers.length > 0 && (
        <section
          className="guide-tests"
          data-testid="guide-callers"
          aria-label={`Code that calls what changed, step ${index + 1}`}
        >
          <h4>Code that calls what changed</h4>
          <ul>
            {changeCallers.map((caller) => (
              <li key={caller.from}>
                <button
                  type="button"
                  className="guide-test"
                  title={`Open ${caller.file} at line ${caller.line}`}
                  onClick={() => {
                    store.previewStep(tourId, index);
                    store.openFile(caller.file, caller.line);
                    store.setPerspective("code");
                  }}
                >
                  <code>{caller.label}</code>
                  <span className="guide-test-file">
                    {caller.file}, line {caller.line}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}
      <div className="section-actions">
        <button className="btn" aria-label={`Show the code, ${where}`} onClick={() => show("code")}>
          Show the code
        </button>
      </div>
    </section>
  );
}

/** The summary of a node, concept, edge or sequence step (what stands in for a missing note). */
function summaryOf(id: string, model: ExplainerModel): string | undefined {
  const element = model.element(id);
  switch (element?.type) {
    case "node":
      return element.node.summary;
    case "concept":
      return element.concept.summary;
    case "edge":
      return element.edge.summary;
    case "step":
      return element.step.summary;
    default:
      return undefined;
  }
}

/**
 * A change explainer: the files the change touches, under the tour summary. Source files first, then tests;
 * each row says what the change did (New, Changed, Removed, Renamed), how many lines it added and removed, and
 * opens the file in the Code tab at its first change.
 */
function ChangeFiles() {
  const store = useStore();
  const state = useViewerState();
  const change = changeOf(state.explainer);
  const rows = useMemo(() => (change ? changeFiles(change) : []), [change]);
  if (!change || rows.length === 0) return null;
  const added = rows.reduce((sum, row) => sum + row.added, 0);
  const deleted = rows.reduce((sum, row) => sum + row.deleted, 0);
  return (
    <section className="change-files" data-testid="change-files" aria-label="Files in this change">
      <h3>
        Files in this change{" "}
        <span className="change-files-total">
          {rows.length} {rows.length === 1 ? "file" : "files"},{" "}
          <span className="is-plus">+{added}</span> <span className="is-minus">−{deleted}</span>
        </span>
      </h3>
      <ul>
        {rows.map((row) => {
          const openable =
            row.status === "deleted"
              ? true
              : state.serverMode || Object.hasOwn(state.files, row.path);
          const slash = row.path.lastIndexOf("/");
          return (
            <li key={row.path}>
              <button
                type="button"
                className="change-file"
                data-testid="change-file"
                data-path={row.path}
                data-status={row.status}
                disabled={!openable}
                title={
                  openable
                    ? `Open ${row.path} in the code${row.status === "deleted" ? " (as it was before the change)" : ""}`
                    : `${row.path} is not included in this page`
                }
                onClick={() => {
                  store.openFile(row.path, row.line);
                  store.setPerspective("code");
                }}
              >
                <span className={`change-status is-${row.status}`}>{STATUS_WORDS[row.status]}</span>
                <span className="change-path">
                  {slash !== -1 && <span className="dir">{row.path.slice(0, slash + 1)}</span>}
                  <b>{row.path.slice(slash + 1)}</b>
                  {row.oldPath && <span className="change-old">from {row.oldPath}</span>}
                </span>
                {row.test && <span className="change-test">test</span>}
                <span
                  className="change-counts"
                  aria-label={`${row.added} lines added, ${row.deleted} removed`}
                >
                  <span className="is-plus">+{row.added}</span>{" "}
                  <span className="is-minus">−{row.deleted}</span>
                </span>
              </button>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
