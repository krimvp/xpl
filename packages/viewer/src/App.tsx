/**
 * The viewer shell. Explore mode: header, then the diagram with the concept list and the details panel
 * below it on the left, the file tree and the editor stack on the right, with resizable splits. Present
 * mode (present/PresentMode.tsx) plays a tour: the diagram and a caption on the left, the code on the
 * right, no file tree. The keys of both modes are handled here, in one place.
 */
import { useEffect, useRef, useState } from "react";
import { CodeArea } from "./components/CodeArea.js";
import { ConceptList } from "./components/ConceptList.js";
import { Details } from "./components/Details.js";
import { DiagramPane } from "./components/DiagramPane.js";
import { DriftBanner } from "./components/DriftBanner.js";
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

  // Explore: Escape clears the selection (unless the key is meant for a form field or a panel).
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      if (store.getState().mode !== "explore" || isFormField(event.target)) return;
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
      <Header />
      {state.mode !== "present" && <DriftBanner explainer={state.explainer} />}
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
      <section className="left" aria-label="Diagram and details">
        <DiagramPane />
        <Splitter
          orientation="row"
          label="Resize the diagram and the panels below it"
          onResize={(d) => setLowerHeight((h) => clamp(h - d, 120, window.innerHeight - 220))}
        />
        <div className="lower">
          <ConceptList />
          <Details />
        </div>
      </section>
      <Splitter
        orientation="col"
        label="Resize the diagram and the code"
        onResize={(d) => setWidth((w) => clamp(w + d, 280, window.innerWidth - 360))}
      />
      <section className="right" aria-label="Code">
        <CodeArea tree="collapsible" />
      </section>
    </main>
  );
}
