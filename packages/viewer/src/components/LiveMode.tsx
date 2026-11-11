/**
 * The live page (`xpl live`, ARCHITECTURE §6 "Live"): a second window next to a coding session. Left, "What
 * changed": the status line, the totals, the explanation and the changed parts; then the map, which starts at
 * the top level and carries the change's marks; the code of what the reader picks comes in on the right.
 * The lens (Before, Changes, Now) is in the header (`LensSwitch`).
 */
import { useEffect, useMemo, useState } from "react";
import {
  boxChangeWords,
  designLevel,
  LIVE_TOUR_ID,
  liveSummary,
  quietText,
  type BoxChange,
  type LiveFile,
} from "@xpl/core";
import { changeAt, changeOf, firstChangedLine } from "../diff.js";
import { useDerived, useStore, useViewerState } from "../hooks.js";
import {
  agoWords,
  baseWords,
  explanationWords,
  freshFiles,
  isRemovedId,
  LENSES,
  liveViewTitle,
} from "../live.js";
import { renderMarkdown } from "../markdown.js";
import { CodeArea } from "./CodeArea.js";
import { DiagramPane } from "./DiagramPane.js";
import { Splitter } from "./Splitter.js";
import "../live.css";

const clamp = (value: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, value));

export function LiveLayout() {
  const store = useStore();
  const state = useViewerState();
  const panes = useDerived().panes.length;
  const [codeWidth, setCodeWidth] = useState(() =>
    Math.round(clamp(window.innerWidth * 0.36, 360, 720)),
  );
  // The reader looked: a click or a key anywhere on the page clears what was new to them.
  useEffect(() => {
    const seen = () => store.markSeen();
    window.addEventListener("pointerdown", seen, true);
    window.addEventListener("keydown", seen, true);
    return () => {
      window.removeEventListener("pointerdown", seen, true);
      window.removeEventListener("keydown", seen, true);
    };
  }, [store]);
  const code = panes > 0;
  return (
    <main
      className={`live${code ? " has-code" : ""}`}
      data-lens={state.live?.lens}
      style={{ "--code-width": `${codeWidth}px` } as React.CSSProperties}
    >
      <LivePanel />
      <section className="live-map" aria-label="Map">
        <DiagramPane />
      </section>
      {code && (
        <>
          <Splitter
            orientation="col"
            label="Resize the map and the code"
            onResize={(d) => setCodeWidth((w) => clamp(w - d, 300, window.innerWidth - 560))}
          />
          <section className="live-code" aria-label="Code">
            <div className="live-code-head">
              <span className="panel-title">
                {state.live?.lens === "before" ? "Code before the change" : "Code"}
              </span>
              <button
                type="button"
                className="btn is-small"
                onClick={() => store.clearSelection()}
                title="Close the code and give the map the room"
              >
                Close
              </button>
            </div>
            <CodeArea tree="hidden" />
          </section>
        </>
      )}
    </main>
  );
}

/** Before | Changes | Now, in the header of a live page. */
export function LensSwitch() {
  const store = useStore();
  const state = useViewerState();
  const lens = state.live?.lens;
  // (with nothing changed the three are the same picture)
  const none = !changeOf(state.explainer);
  return (
    <div className="lens-switch" role="radiogroup" aria-label="Show the architecture">
      {LENSES.map((option) => (
        <button
          key={option.id}
          type="button"
          role="radio"
          aria-checked={lens === option.id}
          className={lens === option.id ? "is-on" : undefined}
          title={none ? "Nothing changed since the base: the three show the same" : option.hint}
          disabled={none}
          data-lens={option.id}
          onClick={() => store.setLens(option.id)}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

/**
 * Design | Folders, on the level under the system map of a guide with a design level: the change as the design
 * concepts it touches, or as the folders that hold it. The choice is remembered for the next zoom into the service.
 */
export function LevelSwitch({ viewId }: { viewId: string }) {
  const store = useStore();
  const state = useViewerState();
  const level = useMemo(() => designLevel(state.model), [state.model]);
  if (!state.live || !level || (viewId !== level.view.id && viewId !== level.of.id)) return null;
  const on = viewId === level.view.id ? "design" : "folders";
  const options = [
    { id: "design", label: "Design", hint: "The change as the design concepts it touches" },
    { id: "folders", label: "Folders", hint: "The change as the folders and files that hold it" },
  ] as const;
  return (
    <div
      className="lens-switch level-switch"
      role="radiogroup"
      aria-label="Show this level as"
      data-testid="level-switch"
    >
      {options.map((option) => (
        <button
          key={option.id}
          type="button"
          role="radio"
          aria-checked={on === option.id}
          className={on === option.id ? "is-on" : undefined}
          title={option.hint}
          data-level={option.id}
          onClick={() => store.setLiveLevel(option.id)}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

/** One line under the map's caption that says what a lens can and cannot show. */
export function LensNote() {
  const state = useViewerState();
  const lens = state.live?.lens;
  const change = changeOf(state.explainer);
  if (!lens || !change) return null;
  if (lens === "before")
    return (
      <p className="lens-note" data-testid="lens-note">
        Before the change: what it added is hidden, what it removed is back. Arrows come from the
        code as it is now (xpl reads only that), so an arrow the change removed is missing.
      </p>
    );
  if (lens === "now")
    return (
      <p className="lens-note" data-testid="lens-note">
        The code as it is now, without the change's marks.
      </p>
    );
  return null;
}

/** The status of `xpl live`: watching, rebuilding or failed, when the guide last matched the code, the base. */
function LiveStatusLine() {
  const state = useViewerState();
  const live = state.live!;
  const status = live.status;
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  const lost =
    state.connection.status === "disconnected" || state.connection.status === "unavailable";
  if (!state.serverMode || state.connection.status === "offline")
    return (
      <p className="live-status" data-state="snapshot" data-testid="live-status">
        <span className="live-dot" aria-hidden="true" />
        <strong>Snapshot</strong> · not updating
      </p>
    );
  const word = lost
    ? "Disconnected"
    : !status
      ? "Connecting"
      : status.state === "building"
        ? "Updating…"
        : status.state === "failed"
          ? "Update failed"
          : "Watching";
  const stateName = lost ? "lost" : (status?.state ?? "connecting");
  return (
    <div className="live-status-block">
      <p
        className="live-status"
        data-state={stateName}
        data-testid="live-status"
        role="status"
        title={status?.index ? `Index ${status.index}` : undefined}
      >
        <span className="live-dot" aria-hidden="true" />
        <strong>{word}</strong>
        {status?.updatedAt && (
          <span className="live-ago" title={status.updatedAt}>
            {" "}
            · last update {agoWords(status.updatedAt, now)}
          </span>
        )}
      </p>
      {lost && (
        <p className="live-status-error" role="alert">
          The page lost <code>xpl live</code>; it shows the last state it had and keeps trying.
        </p>
      )}
      {!lost && status?.state === "failed" && status.error && (
        <p className="live-status-error" role="alert">
          {status.error} The map shows the last good state; the next edit tries again.
        </p>
      )}
    </div>
  );
}

/** "What changed": the first thing the eye lands on next to the map. */
function LivePanel() {
  const store = useStore();
  const state = useViewerState();
  const live = state.live!;
  const change = changeOf(state.explainer);
  const tour = state.model.tour(LIVE_TOUR_ID);
  const files = state.files;
  const summary = useMemo(
    () => (change ? liveSummary(state.model, change, tour, (path) => files[path]) : undefined),
    [state.model, change, tour, files],
  );
  const fresh = useMemo(() => freshFiles(live.seen, change), [live.seen, change]);
  const partName = (part: Row) =>
    quietText(part.label) || part.id.replace(/^(dir|file|removed):/, "");
  // names two boxes of a part's map share (`src` of two packages), changed or not
  const twins = useMemo(() => {
    const names = new Set<string>();
    const out = new Set<string>();
    for (const viewId of new Set((summary?.parts ?? []).map((part) => part.view))) {
      const view = state.model.view(viewId);
      for (const id of view?.type === "graph" && Array.isArray(view.include) ? view.include : []) {
        const name = quietText(state.model.label(id));
        if (names.has(`${viewId} ${name}`)) out.add(name);
        names.add(`${viewId} ${name}`);
      }
    }
    return out;
  }, [summary, state.model]);
  const since = baseWords(live.status?.base, change);
  const explanation = explanationWords(live.status, tour !== undefined);
  const noBase = live.status !== undefined && live.status.base === null;

  return (
    <aside className="live-panel" aria-label="What changed" data-testid="live-panel">
      <LiveStatusLine />
      <h2 className="live-heading">What changed</h2>
      {!summary ? (
        <div className="live-empty" data-testid="live-empty">
          <p className="live-totals">
            {noBase
              ? "No commit to compare with yet: the map shows the code as it is."
              : `No changes ${since || "yet"}.`}
          </p>
          <p className="live-hint">
            Edit a file: the map marks what changes, from the top level down, within a few seconds.
          </p>
        </div>
      ) : (
        <>
          <p className="live-totals" data-testid="live-totals">
            {count(summary.totals.files, "file")} ·{" "}
            <span className="live-plus">+{summary.totals.added}</span>{" "}
            <span className="live-minus">−{summary.totals.removed}</span>
            {since && ` · ${since}`}
          </p>
          {explanation && (
            <p className={`live-explanation is-${explanation.tone}`} data-testid="live-explanation">
              {explanation.text}
              {explanation.command && (
                <>
                  {" "}
                  <code className="live-command">{explanation.command}</code>.
                </>
              )}
            </p>
          )}
          {tour?.summary && (
            <div className="live-summary" data-testid="live-summary">
              {tour.title && !tour.title.includes("TODO") && (
                <h3 className="live-summary-title">{tour.title}</h3>
              )}
              <div
                className="markdown"
                dangerouslySetInnerHTML={{ __html: renderMarkdown(quietText(tour.summary)) }}
              />
            </div>
          )}
          {summary.design && (
            <section className="live-design" aria-label="Design" data-testid="live-design">
              <h3 className="live-section">Design</h3>
              <ol className="live-parts">
                {summary.design.boxes.map((box) =>
                  boxRow({ ...box, view: summary.design!.view }, fresh, true),
                )}
              </ol>
              {summary.design.outside.length > 0 && (
                <details className="live-elsewhere">
                  <summary>
                    {count(summary.design.outside.length, "changed file")}{" "}
                    {summary.design.outside.length === 1 ? "is" : "are"} in no design box
                  </summary>
                  <ul className="live-files">
                    {summary.design.outside.map((file) => fileRow(file, fresh))}
                  </ul>
                </details>
              )}
            </section>
          )}
          {summary.design ? (
            <details className="live-by-folder" data-testid="live-by-folder">
              <summary>
                By folder: {count(summary.parts.length, "part")}
                {summary.elsewhere.length > 0 &&
                  `, ${count(summary.elsewhere.length, "file")} elsewhere`}
              </summary>
              {folders()}
            </details>
          ) : (
            folders()
          )}
        </>
      )}
      <p className="live-foot">
        <a href="?mode=explore" target="_blank" rel="noopener">
          Open the full Explore page
        </a>
      </p>
    </aside>
  );

  /** The changed parts, then the files no part holds: "What changed" by folder. */
  function folders() {
    return (
      <>
        <ol className="live-parts" data-testid="live-parts">
          {summary!.parts.map((part) => boxRow(part, fresh))}
        </ol>
        {summary!.elsewhere.length > 0 && (
          <details className="live-elsewhere" open={summary!.parts.length === 0}>
            <summary>
              Elsewhere: {count(summary!.elsewhere.length, "file")} (tests, settings, files on no
              map)
            </summary>
            <ul className="live-files">{summary!.elsewhere.map((file) => fileRow(file, fresh))}</ul>
          </details>
        )}
      </>
    );
  }

  /** A changed part, or a design box (`design`: its files folded under its note). */
  function boxRow(part: Row, fresh: ReadonlySet<string>, design = false) {
    const isNew = part.files.some((file) => fresh.has(file.path));
    const path = /^(dir|file|removed):/.test(part.id) ? part.id.replace(/^[a-z]+:/, "") : undefined;
    const name = partName(part);
    const note = part.note ? quietText(part.note) : "";
    // a part that is one file is that file's row: its diff and its symbols, without a list of one
    const own = !design && part.files.length === 1 && part.id === `file:${part.files[0]!.path}`;
    const only = own ? part.files[0]! : undefined;
    return (
      <li
        key={part.id}
        className={`live-part is-${part.change.status}${isNew ? " is-fresh" : ""}`}
        data-part-id={part.id}
      >
        <div className="live-part-head">
          <button
            type="button"
            className="live-part-name"
            onClick={() => store.showLiveBox(part.view, part.id)}
            title={`Show ${name} on the map (${liveViewTitle(state.model, part.view)})`}
          >
            <span className={isRemovedId(part.id) ? "live-name is-removed" : "live-name"}>
              {name}
            </span>
            {/* (two parts can have the same name: `src` of two packages) */}
            {path && path !== name && twins.has(name) && <span className="live-path">{path}</span>}
            <span className={`live-mark is-${part.change.status}`}>
              {boxChangeWords(part.change)}
            </span>
            {isNew && <span className="live-fresh">just changed</span>}
          </button>
          {only ? (
            diffButton(only)
          ) : (
            <span className="live-lines">
              <span className="live-plus">+{part.change.lines.added}</span>{" "}
              <span className="live-minus">−{part.change.lines.removed}</span>
            </span>
          )}
        </div>
        {note && (
          <div
            className="live-note markdown"
            data-testid="live-note"
            dangerouslySetInnerHTML={{ __html: renderMarkdown(note) }}
          />
        )}
        {only ? (
          symbolsLine(only, true)
        ) : design ? (
          <details className="live-box-files">
            <summary>{count(part.files.length, "file")}</summary>
            <ul className="live-files">{part.files.map((file) => fileRow(file, fresh))}</ul>
          </details>
        ) : (
          <ul className="live-files">{part.files.map((file) => fileRow(file, fresh))}</ul>
        )}
      </li>
    );
  }

  function diffButton(file: LiveFile) {
    const changed = changeAt(change, file.path);
    return (
      <button
        type="button"
        className="live-diff"
        title={
          file.status === "deleted"
            ? `Open the code ${file.path} had before the change`
            : `Open the diff of ${file.path}`
        }
        aria-label={`Diff of ${file.path}`}
        onClick={() =>
          store.openFile(
            file.path,
            file.status === "deleted" || !changed ? 1 : firstChangedLine(changed),
            file.status === "deleted" ? "base" : undefined,
          )
        }
      >
        <span className="live-plus">+{file.added}</span>{" "}
        <span className="live-minus">−{file.removed}</span>
      </button>
    );
  }

  function symbolsLine(file: LiveFile, flush = false) {
    const shown = file.symbols.slice(0, 3);
    const more = file.symbols.length - shown.length;
    if (shown.length === 0) return null;
    return (
      <p className={`live-symbols${flush ? " is-flush" : ""}`}>
        {shown.map((sym, i) => (
          <span key={sym.name}>
            {i > 0 && ", "}
            <code>{sym.name}</code>
            {sym.status === "new" && " (new)"}
          </span>
        ))}
        {more > 0 && `, +${more} more`}
      </p>
    );
  }

  function fileRow(file: LiveFile, fresh: ReadonlySet<string>) {
    const name = file.path.slice(file.path.lastIndexOf("/") + 1);
    return (
      <li
        key={file.path}
        className={`live-file${fresh.has(file.path) ? " is-fresh" : ""}`}
        data-file={file.path}
      >
        <button
          type="button"
          className="live-file-name"
          title={file.box ? `Show ${file.path} on its map` : file.path}
          disabled={!file.box}
          onClick={() => file.box && store.showLiveBox(file.box.view, file.box.id)}
        >
          <span className={`live-status-word is-${file.status}`}>{STATUS[file.status]}</span>
          <span className={file.status === "deleted" ? "live-name is-removed" : "live-name"}>
            {name}
          </span>
          {fresh.has(file.path) && <span className="live-fresh">just changed</span>}
        </button>
        {diffButton(file)}
        {symbolsLine(file)}
      </li>
    );
  }
}

/** A row of "What changed": a changed part, or a changed design box. */
interface Row {
  id: string;
  view: string;
  label: string;
  change: BoxChange;
  note?: string;
  files: LiveFile[];
}

const STATUS: Record<LiveFile["status"], string> = {
  added: "New",
  modified: "Changed",
  deleted: "Removed",
  renamed: "Renamed",
};

const count = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;
