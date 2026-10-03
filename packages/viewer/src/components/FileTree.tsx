/**
 * The repo's files as a collapsible tree. With a focus, files outside it are greyed (`is-dimmed`);
 * files in it are marked (`is-focus`). Click a file to show it in the editor stack. In a change explainer each
 * changed file carries a mark (A new, M changed, R renamed, D removed: the removed files are listed too, and
 * open as they were before the change), and its directories a dot, so the tree says where the change is.
 * A filter above the tree lists the files whose path contains what is typed, flat.
 *
 * A static bundle (no server) lists only the files it embeds: `xpl bundle` puts in what the explainer
 * needs, and a file that is not there cannot be opened. A footer says how many of the indexed files that is
 * and how to get the rest. Under `xpl view` every indexed file is listed and fetched when it is opened.
 */
import type { IndexedFile } from "@xpl/core";
import { useEffect, useMemo, useState } from "react";
import { contextFiles } from "../callers.js";
import { changeFiles, changeOf, STATUS_WORDS, type ChangeFileRow } from "../diff.js";
import { useDerived, useStore, useViewerState } from "../hooks.js";

/** A row of the tree: an indexed file, or a file the change removed (not in the head index). */
type TreeFile = Pick<IndexedFile, "path">;

interface TreeDir {
  type: "dir";
  name: string;
  path: string;
  dirs: TreeDir[];
  files: TreeFile[];
}

const MARK_LETTERS: Record<ChangeFileRow["status"], string> = {
  added: "A",
  modified: "M",
  renamed: "R",
  deleted: "D",
};

function buildTree(files: readonly TreeFile[]): TreeDir {
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
  const change = changeOf(state.explainer);
  const changed = useMemo(
    () => new Map((change ? changeFiles(change) : []).map((row) => [row.path, row])),
    [change],
  );
  // A static page that carries files only for context (`xpl bundle --files boundary`) says which, and why.
  const context = useMemo(
    () =>
      serverMode
        ? new Map<string, string>()
        : contextFiles(
            model,
            listed.map((file) => file.path),
            change,
          ),
    [model, listed, serverMode, change],
  );
  const tree = useMemo(() => {
    const removed = [...changed.values()]
      .filter((row) => row.status === "deleted" && !listed.some((file) => file.path === row.path))
      .map((row) => ({ path: row.path }));
    const all = [...listed, ...removed].sort((a, b) => a.path.localeCompare(b.path));
    return buildTree(all);
  }, [listed, changed]);
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set());
  const [query, setQuery] = useState("");
  const matches = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return undefined;
    const all: TreeFile[] = [
      ...listed,
      ...[...changed.values()].filter((row) => row.status === "deleted"),
    ];
    return all.filter((file) => file.path.toLowerCase().includes(needle));
  }, [query, listed, changed]);
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
  const dirHasChange = (dir: TreeDir) =>
    [...changed.keys()].some((file) => file.startsWith(dir.path + "/"));

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
          {dirHasChange(dir) && (
            <span className="tree-change-dot" title="Has changed files" aria-label="has changes" />
          )}
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

  const renderFile = (file: TreeFile, depth: number, match = false) => {
    const inFocus = focusFiles.has(file.path);
    const row = changed.get(file.path);
    const why = context.get(file.path);
    const slash = file.path.lastIndexOf("/");
    const classes =
      "tree-row is-file" +
      (hasFocus && !inFocus ? " is-dimmed" : "") +
      (inFocus ? " is-focus" : "") +
      (row ? ` is-${row.status}` : "") +
      (why !== undefined ? " is-context" : "") +
      (match ? " is-filter-result" : "") +
      (state.openedFile === file.path ? " is-open" : "");
    const contextWords = `Context: not part of the explanation${why ? `; ${why}` : ""}`;
    return (
      <li key={"f:" + file.path} role="none">
        <button
          type="button"
          className={classes}
          style={{ paddingLeft: 8 + depth * 14 + 14 }}
          role="treeitem"
          data-path={file.path}
          title={
            row
              ? `${file.path}: ${STATUS_WORDS[row.status].toLowerCase()}` +
                (row.oldPath ? ` from ${row.oldPath}` : "") +
                `, +${row.added} −${row.deleted}`
              : why !== undefined
                ? `${file.path}. ${contextWords}`
                : file.path
          }
          onClick={() => store.openFile(file.path, row?.line)}
        >
          {match ? (
            // A filter result: the name, and under it its folder, dim, cut from the left so its end shows.
            <span className="tree-match">
              <span className="name">{base(file.path)}</span>
              {slash !== -1 && (
                <span className="tree-dir">
                  <bdi>{file.path.slice(0, slash)}</bdi>
                </span>
              )}
            </span>
          ) : (
            <span className="name">{base(file.path)}</span>
          )}
          {row && (
            <span
              className={`tree-change-mark is-${row.status}`}
              data-testid="tree-change-mark"
              aria-label={STATUS_WORDS[row.status]}
            >
              {MARK_LETTERS[row.status]}
            </span>
          )}
          {why !== undefined && !row && (
            <span className="tree-context" data-testid="tree-context" aria-label={contextWords}>
              context
            </span>
          )}
        </button>
      </li>
    );
  };

  return (
    <>
      <input
        type="search"
        className="tree-filter"
        data-testid="tree-filter"
        placeholder="Filter files"
        aria-label="Filter files"
        value={query}
        onChange={(event) => setQuery(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Escape" && query) {
            event.stopPropagation();
            setQuery("");
          }
        }}
      />
      <nav className="tree" aria-label="Files">
        {matches ? (
          <ul role="tree">
            {matches.map((file) => renderFile(file, 0, true))}
            {matches.length === 0 && <li className="tree-none">No file matches</li>}
          </ul>
        ) : (
          <ul role="tree">
            {tree.dirs.map((dir) => renderDir(dir, 0))}
            {tree.files.map((file) => renderFile(file, 0))}
          </ul>
        )}
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
