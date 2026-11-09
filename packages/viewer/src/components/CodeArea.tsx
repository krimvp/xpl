/**
 * The code side of both modes: the file tree next to the stack of editors.
 *
 *   collapsible   Explore: the tree can be folded away to a thin strip
 *   open          Present, for a tour step that asks for the tree (`editor.hideFileTree: false`)
 *   hidden        Present by default: the code gets the whole width
 *
 * `idle` (Explore): while no code is on screen the area is the file tree alone (a strip when folded)
 * with a line that says how to fill it, and the diagram beside it takes the rest of the width. The first
 * selection, or a file clicked in the tree, brings the code, and the column then stays.
 */
import { useEffect, useState, type CSSProperties } from "react";
import { changeOf, changeTreeWidth } from "../diff.js";
import { useDerived, useViewerState } from "../hooks.js";
import { EditorStack } from "./EditorStack.js";
import { FileTree } from "./FileTree.js";

export type TreeMode = "collapsible" | "open" | "hidden";

export function CodeArea({ tree, idle = false }: { tree: TreeMode; idle?: boolean }) {
  const [folded, setFolded] = useState(false);
  const shown = useDerived().panes.length;
  // Once code has been on screen the column stays: clearing the selection does not move the diagram again.
  const [opened, setOpened] = useState(false);
  useEffect(() => {
    if (shown > 0) setOpened(true);
  }, [shown]);
  const waiting = idle && shown === 0 && !opened;
  // A change explainer's tree is as wide as the names of its changed files need (`changeTreeWidth`).
  const treeWidth = changeTreeWidth(changeOf(useViewerState().explainer));
  const collapsible = tree === "collapsible";
  const treeOpen = !collapsible || !folded;
  const classes =
    "code-area" +
    (tree === "hidden" ? " has-no-tree" : treeOpen ? "" : " is-tree-closed") +
    (waiting ? " is-idle" : "");

  return (
    <div
      className={classes}
      style={
        treeWidth !== undefined
          ? ({ "--tree-width": `${treeWidth}px` } as CSSProperties)
          : undefined
      }
    >
      {tree !== "hidden" && (
        <aside className="tree-panel">
          <div className="tree-head">
            {treeOpen && <span className="panel-title">Files</span>}
            {collapsible && (
              <button
                type="button"
                className="icon-btn"
                aria-label={treeOpen ? "Collapse the file tree" : "Expand the file tree"}
                aria-expanded={treeOpen}
                title={treeOpen ? "Collapse the file tree" : "Expand the file tree"}
                onClick={() => setFolded((was) => !was)}
              >
                {treeOpen ? "«" : "»"}
              </button>
            )}
          </div>
          {treeOpen && <FileTree />}
        </aside>
      )}
      {waiting ? (
        <p className="code-idle-hint" data-testid="code-idle">
          Click a box, an arrow or a step to see its code.
        </p>
      ) : (
        <EditorStack />
      )}
    </div>
  );
}
