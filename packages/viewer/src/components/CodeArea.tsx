/**
 * The code side of both modes: the file tree next to the stack of editors.
 *
 *   collapsible   Explore: the tree can be folded away to a thin strip
 *   open          Present, for a tour step that asks for the tree (`editor.hideFileTree: false`)
 *   hidden        Present by default: the code gets the whole width
 */
import { useState } from "react";
import { EditorStack } from "./EditorStack.js";
import { FileTree } from "./FileTree.js";

export type TreeMode = "collapsible" | "open" | "hidden";

export function CodeArea({ tree }: { tree: TreeMode }) {
  const [folded, setFolded] = useState(false);
  const collapsible = tree === "collapsible";
  const treeOpen = !collapsible || !folded;
  const classes =
    "code-area" + (tree === "hidden" ? " has-no-tree" : treeOpen ? "" : " is-tree-closed");

  return (
    <div className={classes}>
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
      <EditorStack />
    </div>
  );
}
