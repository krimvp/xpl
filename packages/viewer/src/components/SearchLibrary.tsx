import { createPortal } from "react-dom";
import { useEffect, useMemo, useRef, useState, type MouseEvent } from "react";
import { describeAnalysis, guideCatalog, type GuideDescriptor, type Range } from "@xpl/core";
import SearchWorker from "../search-worker.ts?worker&inline";
import type {
  SearchMessage,
  SearchReply,
  SearchResult,
  SearchPages,
  SearchHit,
} from "../search-worker.js";
import { containedGuides } from "../library.js";
import { ServerApi, messageOf } from "../data.js";
import { useStore, useViewerState } from "../hooks.js";
import "../search.css";

const NAVIGATION = [
  "mode",
  "tour",
  "step",
  "step-id",
  "view",
  "focus",
  "perspective",
  "file",
  "range",
  "side",
  "snapshot",
];
const rangeText = (range: Range) =>
  `${range.startLine}${range.startCol === undefined ? "" : `:${range.startCol}`}-${range.endLine}${range.endCol === undefined ? "" : `:${range.endCol}`}`;

/** Real links remain useful when copied, reopened or used in a new tab. */
function destination(guide: string, hit?: SearchHit): string {
  const params = new URLSearchParams(location.search);
  for (const key of NAVIGATION) params.delete(key);
  params.set("guide", guide);
  if (hit?.kind === "source" || hit?.kind === "symbol") {
    params.set("snapshot", hit.commit);
    params.set("perspective", "code");
    params.set("file", hit.file);
    params.set("range", rangeText(hit.range));
  } else if (hit && "tour" in hit) {
    params.set("perspective", "guide");
    params.set("tour", hit.tour);
    if ("step" in hit) params.set("step-id", hit.step);
    else params.set("step", "1");
  } else if (hit?.kind === "concept" || (hit?.kind === "step" && "element" in hit)) {
    params.set("perspective", hit.kind === "concept" ? "code" : "explore");
    params.set("focus", hit.element);
    if ("view" in hit) params.set("view", hit.view);
  }
  return `?${params}`;
}

type CatalogGuide = GuideDescriptor | { id: string; metadataError: string };

/** One compact header entry opens both search and the bounded local library. */
export function SearchLibrary({ onClose }: { onClose: () => void }) {
  const store = useStore();
  const state = useViewerState();
  const current = store.library.guideId ?? "current";
  const [pattern, setPattern] = useState("");
  const [pages, setPages] = useState<SearchPages>({});
  const [result, setResult] = useState<SearchResult>();
  const [error, setError] = useState("");
  const [catalogError, setCatalogError] = useState("");
  const [catalog, setCatalog] = useState<CatalogGuide[]>();
  const [busy, setBusy] = useState(false);
  const worker = useRef<Worker | undefined>(undefined);
  const request = useRef(0);
  const input = useRef<HTMLInputElement>(null);
  const panel = useRef<HTMLElement>(null);
  const embedded = useMemo(
    () => containedGuides({ ...store.library, explainer: state.explainer }),
    [store, state.explainer],
  );
  const guides =
    catalog ?? guideCatalog(embedded.map((g) => ({ id: g.guideId, explainer: g.explainer })));
  const index = state.model.index.index;
  const coverage = useMemo(() => describeAnalysis(index), [index]);
  const missing = useMemo(
    () => index.files.filter((f) => !(f.path in state.files)).length,
    [index, state.files],
  );
  const included = index.files.length - missing;
  const blocked =
    state.dirty || state.editDraft || state.editBusy || state.save.status === "saving";

  useEffect(() => {
    setPages({});
    setResult(undefined);
    const controller = new SearchWorker();
    worker.current = controller;
    controller.onmessage = (event: MessageEvent<SearchReply>) => {
      if (event.data.id !== request.current) return;
      setBusy(false);
      if ("error" in event.data) {
        setError(event.data.error);
        setResult(undefined);
      } else {
        setError("");
        setResult(event.data.result);
      }
    };
    controller.onerror = () => {
      setError("Search could not start in this browser.");
      setBusy(false);
    };
    controller.postMessage({
      kind: "snapshot",
      snapshots: embedded.map((g) => ({
        id: g.guideId,
        explainer: g.explainer,
        index: g.guideId === current ? index : g.index,
        files: g.guideId === current ? state.files : g.files,
      })),
    } satisfies SearchMessage);
    return () => {
      request.current++;
      controller.terminate();
      worker.current = undefined;
    };
  }, [index, state.files, embedded]);

  useEffect(() => {
    const id = ++request.current;
    setError("");
    const text = pattern.trim();
    setBusy(!!text);
    if (!text) return;
    const timer = setTimeout(
      () =>
        worker.current?.postMessage({
          kind: "query",
          id,
          pattern: text,
          pages,
        } satisfies SearchMessage),
      150,
    );
    return () => clearTimeout(timer);
  }, [pattern, pages, index, state.files, embedded]);

  useEffect(() => {
    input.current?.focus();
    const api = state.serverMode && store.library.server;
    if (!api) return;
    let active = true;
    void new ServerApi(api.api, api.attachment)
      .guides()
      .then((data) => {
        if (!active) return;
        setCatalog(data.guides);
        setCatalogError(data.errors.map((e) => `${e.id}: ${e.error}`).join("; "));
      })
      .catch((e) => {
        if (active)
          setCatalogError(`Local catalog unavailable: ${messageOf(e)}. Showing contained guides.`);
      });
    return () => {
      active = false;
    };
  }, [store, state.serverMode]);

  // Keep Tab inside the dialog; Escape returns focus to its header entry.
  const keyDown = (event: React.KeyboardEvent<HTMLElement>) => {
    if (event.key === "Escape") {
      event.stopPropagation();
      event.preventDefault();
      onClose();
    }
    if (event.key === "Tab") {
      const focusable = [
        ...panel.current!.querySelectorAll<HTMLElement>(
          "input:not(:disabled), button:not(:disabled), a[href]",
        ),
      ];
      const first = focusable[0],
        last = focusable.at(-1);
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last?.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first?.focus();
      }
    }
  };
  const open = (event: MouseEvent<HTMLAnchorElement>, guide: string, hit?: SearchHit) => {
    const switching = guide !== current;
    const sourceLink = hit?.kind === "source" || hit?.kind === "symbol";
    const leavesPage = switching || (sourceLink && state.serverMode);
    if (leavesPage && blocked) {
      event.preventDefault();
      setError("Save or cancel drafts and pending edits before opening another snapshot.");
      return;
    }
    if (leavesPage || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
    if (!hit) {
      onClose();
      return;
    }
    if (hit.kind === "source" || hit.kind === "symbol") {
      if (hit.commit !== index.commit) {
        setError(
          "This search result belongs to an earlier snapshot. Search again in the current guide.",
        );
        return;
      }
      store.openRange(hit.file, hit.range);
    } else if ("tour" in hit) {
      store.setPerspective("guide");
      const tour = state.model.tour(hit.tour);
      const at = "step" in hit ? tour?.steps.findIndex((s) => s.id === hit.step) : 0;
      if (at !== undefined && at >= 0) store.previewStep(hit.tour, at);
    } else if (hit.kind === "concept" || (hit.kind === "step" && "element" in hit)) {
      store.setPerspective(hit.kind === "concept" ? "code" : "explore");
      if ("view" in hit) store.setView(hit.view);
      store.select([hit.element]);
    } else store.setPerspective("guide");
    try {
      history.replaceState(history.state, "", destination(guide, hit));
    } catch {
      /* sandboxed frames may refuse URL updates */
    }
    onClose();
  };

  return createPortal(
    <div className="search-backdrop" onClick={onClose}>
      <section
        ref={panel}
        className="tour-panel search-library"
        role="dialog"
        aria-modal="true"
        aria-label="Search and guides"
        onKeyDown={keyDown}
        onClick={(e) => e.stopPropagation()}
      >
        <header className="search-head">
          <h2>Search and guides</h2>
          <button className="icon-btn" type="button" aria-label="Close search" onClick={onClose}>
            ×
          </button>
        </header>
        <div className="search-layout">
          <div className="search-main">
            <label className="search-label">
              Search guide snapshots
              <input
                ref={input}
                type="search"
                value={pattern}
                onChange={(e) => {
                  setPattern(e.target.value);
                  setPages({});
                  setResult(undefined);
                }}
                placeholder="A symbol, source text or phrase from a guide"
              />
            </label>
            <p className="search-scope">
              Snapshot <code>{index.commit}</code> · {included} of {index.files.length} indexed
              files supplied in the current guide. Search covers source, symbols and text in{" "}
              {embedded.length} contained {embedded.length === 1 ? "guide" : "guides"}.
            </p>
            <div className="search-limits">
              {embedded
                .filter((g) => g.guideId !== current)
                .map((g) => (
                  <p key={g.guideId}>
                    {g.explainer.title || g.guideId} · snapshot <code>{g.index.commit}</code>:{" "}
                    {g.index.files.filter((f) => f.path in g.files).length} of{" "}
                    {g.index.files.length} indexed files supplied.
                    {g.index.files.some((f) => !(f.path in g.files))
                      ? " Missing source is not searched or opened from another guide."
                      : ""}
                    {g.index.pruned ? " Index pruned; omitted symbols cannot be searched." : ""}
                    {!g.index.analysis?.length ? " Analysis unavailable." : ""}
                    {g.sourceWarning ? ` ${g.sourceWarning}` : ""}
                  </p>
                ))}
              {catalog && (
                <p>
                  Catalog-only guides have no source snapshot in this page; open a guide to search
                  its available source.
                </p>
              )}
              {missing > 0 && (
                <p>
                  {missing} indexed files{" "}
                  {state.serverMode
                    ? "not loaded; open them to include their supplied text"
                    : "not included in this export"}
                  .
                </p>
              )}
              {index.pruned && (
                <p>
                  Index pruned: {index.symbols.length} of {index.pruned.symbols} symbols and{" "}
                  {index.refs.length} of {index.pruned.refs} references retained. Omitted analysis
                  is not evidence of absence.
                </p>
              )}
              {!index.analysis?.length && (
                <p>Analysis unavailable: this snapshot records no analysis coverage.</p>
              )}
              <details>
                <summary>Analysis coverage and limits</summary>
                <ul>
                  {coverage.details.map((detail, i) => (
                    <li key={i}>{detail}</li>
                  ))}
                </ul>
              </details>
            </div>
            <p role="status" className="search-status">
              {busy
                ? "Searching supplied snapshots…"
                : result
                  ? result.total
                    ? `${result.total} matches across result groups`
                    : "No matches in the supplied snapshots."
                  : "Type to search source, symbols, concepts and tour steps."}
            </p>
            {error && <p role="alert">{error}</p>}
            {result?.groups
              .filter((group) => group.total > 0)
              .map((group) => (
                <section className="search-group" aria-label={group.title} key={group.id}>
                  <header className="search-group-head">
                    <h3>{group.title}</h3>
                    <span>
                      {group.offset + 1}–{group.offset + group.hits.length} of {group.total} matches
                    </span>
                  </header>
                  <div className="search-pages">
                    <button
                      type="button"
                      className="btn"
                      aria-label={`Previous ${group.title} results`}
                      disabled={busy || group.offset === 0}
                      onClick={() =>
                        setPages((p) => ({ ...p, [group.id]: (p[group.id] ?? 0) - 1 }))
                      }
                    >
                      Previous
                    </button>
                    <button
                      type="button"
                      className="btn"
                      aria-label={`Next ${group.title} results`}
                      disabled={busy || group.offset + group.hits.length >= group.total}
                      onClick={() =>
                        setPages((p) => ({ ...p, [group.id]: (p[group.id] ?? 0) + 1 }))
                      }
                    >
                      Next
                    </button>
                  </div>
                  <ul className="search-results">
                    {group.hits.map((hit, i) => {
                      const guide = hit.guide;
                      const snapshot = embedded.find((g) => g.guideId === guide);
                      const files = guide === current ? state.files : (snapshot?.files ?? {});
                      const unavailable =
                        (hit.kind === "source" || hit.kind === "symbol") && !(hit.file in files);
                      const label =
                        hit.kind === "step"
                          ? "tour" in hit
                            ? "Tour step"
                            : "Flow step"
                          : hit.kind;
                      const context =
                        "file" in hit
                          ? `${snapshot?.explainer.title || guide} · ${hit.commit} · ${hit.file}:${rangeText(hit.range)}`
                          : `${embedded.find((g) => g.guideId === guide)?.explainer.title || guide}${"tour" in hit ? ` · ${hit.tour}` : ""}${"step" in hit ? ` · ${hit.step}` : ""}`;
                      const content = (
                        <>
                          <span className="search-kind">{label}</span>
                          <span className="search-result-text">{hit.text}</span>
                          <small>
                            {context}
                            {unavailable ? " · source not supplied" : ""}
                          </small>
                        </>
                      );
                      return (
                        <li key={`${hit.kind}:${i}`}>
                          {unavailable ? (
                            <div className="search-result is-unavailable" data-kind={hit.kind}>
                              {content}
                            </div>
                          ) : (
                            <a
                              className="search-result"
                              data-kind={hit.kind}
                              href={destination(guide, hit)}
                              onClick={(e) => open(e, guide, hit)}
                            >
                              {content}
                            </a>
                          )}
                        </li>
                      );
                    })}
                  </ul>
                </section>
              ))}
          </div>
          <aside className="search-guides" aria-label="Guide library">
            <h3>{catalog ? "Repository guides" : "Contained guides"}</h3>
            {state.readOnlyGuide && /^https?:$/.test(location.protocol) && (
              <a href="./">Back to library</a>
            )}
            {!catalog && <p>Only guides contained in this page are available offline.</p>}
            {catalogError && <p role="alert">{catalogError}</p>}
            {blocked && <p>Save or cancel drafts and pending edits before switching guides.</p>}
            <ul>
              {guides.map((g) => (
                <li key={g.id}>
                  {"metadataError" in g ? (
                    <p>
                      {g.id}: {g.metadataError}
                    </p>
                  ) : (
                    <a
                      href={destination(g.id)}
                      aria-current={g.id === current ? "page" : undefined}
                      onClick={(e) => open(e, g.id)}
                    >
                      <strong>{g.title || "Untitled guide"}</strong>
                      <small>
                        {g.kind} · {g.commit}
                      </small>
                      {g.audience && <span>For {g.audience}</span>}
                      {g.questions.map((q) => (
                        <span key={q}>{q}</span>
                      ))}
                    </a>
                  )}
                </li>
              ))}
            </ul>
          </aside>
        </div>
      </section>
    </div>,
    document.body,
  );
}
