/**
 * The viewer shell. Explore mode (this phase): header, then the diagram with the concept list and the
 * details panel below it on the left, the file tree and the editor stack on the right, with resizable
 * splits. Present mode is a later phase and plugs in through `mode` (see modes.ts, present/).
 */
import { useEffect, useState } from "react";
import { ConceptList } from "./components/ConceptList.js";
import { Details } from "./components/Details.js";
import { DiagramPane } from "./components/DiagramPane.js";
import { ErrorBoundary } from "./components/ErrorBoundary.js";
import { EditorStack } from "./components/EditorStack.js";
import { FileTree } from "./components/FileTree.js";
import { Header } from "./components/Header.js";
import { Splitter } from "./components/Splitter.js";
import { StoreContext, useStore, useViewerState } from "./hooks.js";
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

  useEffect(() => {
    document.title = title ? `${title} · xpl` : "xpl viewer";
  }, [title]);

  // Escape clears the selection (unless the key is meant for a form field).
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      const target = event.target as HTMLElement | null;
      if (target && /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName)) return;
      store.clearSelection();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [store]);

  return (
    <div className="app" data-mode={state.mode}>
      <Header />
      {state.mode === "present" ? <PresentMode /> : <ExploreLayout />}
    </div>
  );
}

const clamp = (value: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, value));

function ExploreLayout() {
  const [leftWidth, setLeftWidth] = useState(() =>
    Math.round(clamp(window.innerWidth * 0.52, 420, 900)),
  );
  const [lowerHeight, setLowerHeight] = useState(() =>
    Math.round(clamp(window.innerHeight * 0.36, 220, 380)),
  );
  const [treeOpen, setTreeOpen] = useState(true);

  return (
    <main
      className="explore"
      style={
        {
          "--left-width": `${leftWidth}px`,
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
        onResize={(d) => setLeftWidth((w) => clamp(w + d, 320, window.innerWidth - 360))}
      />
      <section className="right" aria-label="Code">
        <div className={"code-area" + (treeOpen ? "" : " is-tree-closed")}>
          <aside className="tree-panel">
            <div className="tree-head">
              {treeOpen && <span className="panel-title">Files</span>}
              <button
                type="button"
                className="icon-btn"
                aria-label={treeOpen ? "Collapse the file tree" : "Expand the file tree"}
                aria-expanded={treeOpen}
                title={treeOpen ? "Collapse the file tree" : "Expand the file tree"}
                onClick={() => setTreeOpen((open) => !open)}
              >
                {treeOpen ? "«" : "»"}
              </button>
            </div>
            {treeOpen && <FileTree />}
          </aside>
          <EditorStack />
        </div>
      </section>
    </main>
  );
}
