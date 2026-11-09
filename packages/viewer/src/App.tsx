/**
 * The viewer shell. Explore mode: header, then the diagram with the concepts as one line of chips under it
 * on the left, the details panel above the file tree and the editor stack on the right, with resizable
 * splits. Present
 * mode (present/PresentMode.tsx) plays a tour: the diagram and a caption on the left, the code on the
 * right, no file tree. The keys of both modes are handled here, in one place.
 */
import { useEffect, useRef, useState } from "react";
import { CodeArea } from "./components/CodeArea.js";
import { ConceptList } from "./components/ConceptList.js";
import { Details } from "./components/Details.js";
import { DiagramPane } from "./components/DiagramPane.js";
import { DriftBanner } from "./components/DriftBanner.js";
import { AttentionStatus } from "./components/AttentionStatus.js";
import { JobsPanel } from "./components/JobsPanel.js";
import { ConnectionStatus } from "./components/ConnectionStatus.js";
import { AnalysisCoverage } from "./components/AnalysisCoverage.js";
import { ErrorBoundary } from "./components/ErrorBoundary.js";
import { Header } from "./components/Header.js";
import { Workspace } from "./components/Workspace.js";
import "./workspace.css";
import { Splitter } from "./components/Splitter.js";
import { StoreContext, useDerived, useStore, useViewerState } from "./hooks.js";
import { codeFirstView } from "./workspace.js";
import { isFormField, ownsKeys, tourKeyAction } from "./present/keys.js";
import { PresentMode } from "./present/PresentMode.js";
import type { ViewerStore } from "./store.js";

export function App({ store }: { store: ViewerStore }) {
  return (
    <StoreContext.Provider value={store}>
      <ErrorBoundary
        fallback={(error) => (
          <main className="no-data">
            <h1>xpl viewer</h1>
            <p role="alert">The viewer hit an unexpected error: {error.message}</p>
            <p>
              The explainer file may be malformed; check it with <code>xpl validate</code>.
            </p>
          </main>
        )}
      >
        <Shell />
      </ErrorBoundary>
    </StoreContext.Provider>
  );
}

function Shell() {
  const store = useStore();
  const state = useViewerState();
  const title = state.explainer.title;
  // The splits live here, not in ExploreLayout, so that a round trip through Present keeps them.
  const [leftWidth, setLeftWidth] = useState(() =>
    Math.round(clamp(window.innerWidth * 0.52, 420, 900)),
  );
  // The narrow outline column of a code-first view (the code takes the rest), sized apart from the diagram's.
  const [outlineWidth, setOutlineWidth] = useState(() =>
    Math.round(clamp(window.innerWidth * 0.27, 340, 480)),
  );
  const [lowerHeight, setLowerHeight] = useState(() =>
    Math.round(clamp(window.innerHeight * 0.36, 220, 380)),
  );

  // The tab says what is being read: the tour while one is open (the Guide shows one, Present plays one),
  // else the explainer.
  const tour =
    state.mode === "present" || state.perspective === "guide"
      ? (store.currentTour() ?? (state.perspective === "guide" ? state.model.tours[0] : undefined))
      : undefined;
  const pageTitle = tour?.title.trim() || title;
  // Back from a talk to the reading screens: the code that was on the slide stays on screen.
  const previousMode = useRef(state.mode);
  const fromPresent = previousMode.current === "present" && state.mode !== "present";
  useEffect(() => {
    previousMode.current = state.mode;
  }, [state.mode]);
  useEffect(() => {
    document.title = pageTitle ? `${pageTitle} · xpl` : "xpl viewer";
  }, [pageTitle]);

  // Explore and the Map and Flow tabs: Escape clears the selection (unless the key is meant for a form field
  // or a panel). (The Tour's selection is its step's: it stays.)
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      const { mode, perspective } = store.getState();
      if (mode !== "explore" || isFormField(event.target)) return;
      if (perspective !== "explore" && perspective !== "map" && perspective !== "flow") return;
      store.clearSelection();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [store]);

  // Present: the tour keys. Registered for the capture phase so that they win over the diagram (which
  // pans with the arrows), the editors (caret keys) and a focused button (Space); a text field or a
  // menu keeps its own keys. A held key steps once, not a dozen times.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (store.getState().mode !== "present") return;
      const action = tourKeyAction(event);
      if (!action || ownsKeys(event.target)) return;
      event.preventDefault();
      event.stopPropagation();
      if (event.repeat) return;
      switch (action) {
        case "next":
          store.nextStep();
          break;
        case "prev":
          store.prevStep();
          break;
        case "first":
          store.goToStep(0);
          break;
        case "last":
          store.goToStep(Number.MAX_SAFE_INTEGER);
          break;
        case "exit":
          // after a detour, Esc first goes back to the step
          if (!store.returnFromDetour()) store.exitPresent();
          break;
      }
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [store]);

  return (
    <div className="app" data-mode={state.mode}>
      {/* the first Tab offers a jump past the header to the guide, the diagram or the slide. */}
      <a className="skip-link" href="#" onClick={skipToContent}>
        Skip to the content
      </a>
      <Header />
      <div className="workspace-warnings">
        {state.readOnlyGuide && (
          <p className="read-only-guide">
            Read-only guide preview. To edit this guide, first stop the current repository service:
            <br />
            <code>{state.readOnlyGuide.stopCommand ?? "xpl service stop"}</code>
            <br />
            Then start this guide's service:
            <br />
            <code>{state.readOnlyGuide.command}</code>
          </p>
        )}
        <div className="service-status">
          <ConnectionStatus />
          <AttentionStatus />
          <JobsPanel />
        </div>
        {/* Notes for the author, not the audience: not on a slide. A draft with nothing to fix is a pill in
            the header (Header.tsx), not a bar. */}
        {state.mode !== "present" && <AnalysisCoverage />}
        {state.mode !== "present" &&
          state.exportInfo?.status === "draft" &&
          state.exportInfo.report.errors + state.exportInfo.report.warnings > 0 && (
            <div className="drift-banner" role="status" data-testid="draft-banner">
              <p>
                <strong>Draft.</strong> {count(state.exportInfo.report.errors, "problem")} to fix
                before this page is finished, and{" "}
                {count(state.exportInfo.report.warnings, "warning")} for readers.
              </p>
            </div>
          )}
        {state.sourceWarning && (
          <div className="drift-banner" role="alert" data-testid="source-warning">
            <p>
              <strong>Source changed since indexing.</strong> {state.sourceWarning}
            </p>
          </div>
        )}
        {state.mode !== "present" && <DriftBanner explainer={state.explainer} />}
      </div>
      {state.mode === "present" ? (
        <PresentMode />
      ) : state.perspective !== "explore" ? (
        <Workspace showSource={fromPresent} />
      ) : (
        <ExploreLayout
          leftWidth={leftWidth}
          setLeftWidth={setLeftWidth}
          outlineWidth={outlineWidth}
          setOutlineWidth={setOutlineWidth}
          lowerHeight={lowerHeight}
          setLowerHeight={setLowerHeight}
        />
      )}
    </div>
  );
}

/** Moves keyboard focus to the page's main area (the Tour, a diagram tab, Explore or the slide). */
function skipToContent(event: React.MouseEvent) {
  event.preventDefault();
  const main = document.querySelector<HTMLElement>(".app > main");
  if (!main) return;
  if (!main.hasAttribute("tabindex")) main.tabIndex = -1;
  main.focus();
}

const count = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

const clamp = (value: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, value));

interface ExploreLayoutProps {
  leftWidth: number;
  setLeftWidth: (update: (width: number) => number) => void;
  outlineWidth: number;
  setOutlineWidth: (update: (width: number) => number) => void;
  lowerHeight: number;
  setLowerHeight: (update: (height: number) => number) => void;
}

function ExploreLayout({
  leftWidth,
  setLeftWidth,
  outlineWidth,
  setOutlineWidth,
  lowerHeight,
  setLowerHeight,
}: ExploreLayoutProps) {
  // A code-first view (the steps of one function): the diagram is a narrow outline, the code the main pane.
  const view = useDerived().view.view;
  const codeFirst =
    codeFirstView(view) &&
    (view?.type === "flow" || (view?.type === "sequence" && view.layout === "code-first"));
  const width = codeFirst ? outlineWidth : leftWidth;
  const setWidth = codeFirst ? setOutlineWidth : setLeftWidth;
  // Concepts are one line of chips under the diagram, which keeps the height. The first
  // selection brings Details, at the top of the code column, and it stays (clearing the selection does not
  // move the diagram again).
  const picked = useViewerState().selection.length > 0;
  const [detailsOpen, setDetailsOpen] = useState(false);
  useEffect(() => {
    if (picked) setDetailsOpen(true);
  }, [picked]);
  const details = picked || detailsOpen;
  return (
    <main
      className={`explore${codeFirst ? " is-code-first" : ""}`}
      style={
        {
          "--left-width": `${width}px`,
          "--lower-height": `${lowerHeight}px`,
        } as React.CSSProperties
      }
    >
      <section className="left" aria-label="Diagram and concepts">
        <DiagramPane />
        <div className="lower is-folded" data-testid="lower-folded">
          <ConceptList compact />
          {!details && (
            <p className="lower-hint">
              Select a box, an arrow, a step or a concept to see what it is.
            </p>
          )}
        </div>
      </section>
      <Splitter
        orientation="col"
        label="Resize the diagram and the code"
        onResize={(d) => setWidth((w) => clamp(w + d, 280, window.innerWidth - 360))}
      />
      <section className={`right${details ? " has-details" : ""}`} aria-label="Details and code">
        {details && (
          <>
            <Details />
            <Splitter
              orientation="row"
              label="Resize the details and the code"
              onResize={(d) => setLowerHeight((h) => clamp(h + d, 120, window.innerHeight - 220))}
            />
          </>
        )}
        <CodeArea tree="collapsible" idle={!details} />
      </section>
    </main>
  );
}
