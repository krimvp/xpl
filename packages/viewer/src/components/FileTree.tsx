/**
 * The repo's files as a collapsible tree. With a focus, files outside it are greyed (`is-dimmed`);
 * files in it are marked (`is-focus`). Click a file to show it in the editor stack.
 *
 * A static bundle (no server) lists only the files it embeds: `xpl bundle` puts in what the explainer
 * needs, and a file that is not there cannot be opened. A footer says how many of the indexed files that is
 * and how to get the rest. Under `xpl view` every indexed file is listed and fetched when it is opened.
 */
import type { IndexedFile } from "@xpl/core";
import { useEffect, useMemo, useState } from "react";
import { useDerived, useStore, useViewerState } from "../hooks.js";

interface TreeDir {
  type: "dir";
  name: string;
  path: string;
  dirs: TreeDir[];
  files: IndexedFile[];
}

function buildTree(files: readonly IndexedFile[]): TreeDir {
  const root: TreeDir = { type: "dir", name: "", path: "", dirs: [], files: [] };
  const dirs = new Map<string, TreeDir>([["", root]]);
  const dirFor = (path: string): TreeDir => {
    const known = dirs.get(path);
    if (known) return known;
    const slash = path.lastIndexOf("/");
    const parent = dirFor(slash === -1 ? "" : path.slice(0, slash));
    const dir: TreeDir = { type: "dir", name: path.slice(slash + 1), path, dirs: [], files: [] };
    parent.dirs.push(dir);
    dirs.set(path, dir);
    return dir;
  };
  for (const file of files) {
    const slash = file.path.lastIndexOf("/");
    dirFor(slash === -1 ? "" : file.path.slice(0, slash)).files.push(file);
  }
  return root;
}

const base = (path: string) => path.slice(path.lastIndexOf("/") + 1);

export function FileTree() {
  const store = useStore();
  const state = useViewerState();
  const derived = useDerived();
  const { model, files, serverMode } = state;
  const indexed = model.index.files;
  const listed = useMemo(
    () => (serverMode ? indexed : indexed.filter((file) => Object.hasOwn(files, file.path))),
    [indexed, files, serverMode],
  );
  const tree = useMemo(() => buildTree(listed), [listed]);
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set());
  const focusFiles = derived.selection.focusFiles;
  const hasFocus = focusFiles.size > 0;

  // Reveal the focused files: open the directories above them.
  useEffect(() => {
    if (focusFiles.size === 0) return;
    setCollapsed((current) => {
      const next = new Set(current);
      for (const file of focusFiles) {
        for (let at = file.lastIndexOf("/"); at > 0; at = file.lastIndexOf("/", at - 1)) {
          next.delete(file.slice(0, at));
        }
      }
      return next.size === current.size ? current : next;
    });
  }, [focusFiles]);

  const toggle = (path: string) =>
    setCollapsed((current) => {
      const next = new Set(current);
      if (!next.delete(path)) next.add(path);
      return next;
    });

  const dirHasFocus = (dir: TreeDir) =>
    [...focusFiles].some((file) => file.startsWith(dir.path + "/"));

  const renderDir = (dir: TreeDir, depth: number) => {
    const open = !collapsed.has(dir.path);
    return (
      <li key={"d:" + dir.path} role="none">
        <button
          type="button"
          className={"tree-row is-dir" + (hasFocus && !dirHasFocus(dir) ? " is-dimmed" : "")}
          style={{ paddingLeft: 8 + depth * 14 }}
          role="treeitem"
          aria-expanded={open}
          data-path={dir.path}
          onClick={() => toggle(dir.path)}
        >
          <span className="chevron" aria-hidden="true">
            {open ? "▾" : "▸"}
          </span>
          <span className="name">{dir.name}</span>
        </button>
        {open && (
          <ul role="group">
            {dir.dirs.map((child) => renderDir(child, depth + 1))}
            {dir.files.map((file) => renderFile(file, depth + 1))}
          </ul>
        )}
      </li>
    );
  };

  const renderFile = (file: IndexedFile, depth: number) => {
    const inFocus = focusFiles.has(file.path);
    const classes =
      "tree-row is-file" +
      (hasFocus && !inFocus ? " is-dimmed" : "") +
      (inFocus ? " is-focus" : "") +
      (state.openedFile === file.path ? " is-open" : "");
    return (
      <li key={"f:" + file.path} role="none">
        <button
          type="button"
          className={classes}
          style={{ paddingLeft: 8 + depth * 14 + 14 }}
          role="treeitem"
          data-path={file.path}
          title={file.path}
          onClick={() => store.openFile(file.path)}
        >
          <span className="name">{base(file.path)}</span>
        </button>
      </li>
    );
  };

  return (
    <>
      <nav className="tree" aria-label="Files">
        <ul role="tree">
          {tree.dirs.map((dir) => renderDir(dir, 0))}
          {tree.files.map((file) => renderFile(file, 0))}
        </ul>
      </nav>
      {listed.length < indexed.length && (
        <p
          className="tree-foot"
          data-testid="tree-foot"
          title="This page carries the source of only some of the repo's files, so the others cannot be opened here. Run `xpl bundle --files all` to embed every file."
        >
          {state.perspective === "explore" ? (
            <>
              {listed.length} of {indexed.length} files included · rebuild with{" "}
              <code>--files all</code>
            </>
          ) : (
            // A reader cannot rebuild the page: say what is there, not how to change it.
            <>
              {listed.length} of {indexed.length} files are in this page
            </>
          )}
        </p>
      )}
    </>
  );
}
