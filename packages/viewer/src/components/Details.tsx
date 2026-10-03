/**
 * Details of the selected element: label and kind, summary and detail (markdown), provenance, anchors
 * with their status, and actions ("Explain this", open children, collapse, add a stub's target).
 *
 * `reader` (Read mode, under "Where this is in the code"): what a reader needs, in plain words. No element
 * id, no provenance, no author actions, the kind only for a piece of code, roles as "defined here" /
 * "called here", and a status only when it is not "ok".
 */
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { opensView } from "@xpl/core";
import { callersOf, callerSubject, changeSummary, type Caller } from "../callers.js";
import { describeElement, type AnchorRow, type ElementInfo } from "../details.js";
import { changeOf } from "../diff.js";
import { explainCommand, messageOf } from "../data.js";
import { useDerived, useStore, useViewerState } from "../hooks.js";
import { renderInline, renderMarkdown } from "../markdown.js";
import { readerBadge, roleWords } from "../readerWords.js";
import { GhostTargetList } from "./GhostTargets.js";

const MAX_ANCHOR_ROWS = 8;

/** Facts that only matter to the author of the explainer. */
const AUTHOR_FACTS = new Set(["Origin", "Resolution"]);

/**
 * `untitled`: the title and the summary are already on screen right above (the topic column says them): the
 * details start with where the element is in the code, not with the same words again.
 */
export function Details({
  reader = false,
  untitled = false,
  factsAbove = false,
}: {
  reader?: boolean;
  untitled?: boolean;
  /** What the change did and who calls it are already on screen above (`TopicFacts`). */
  factsAbove?: boolean;
}) {
  const store = useStore();
  const state = useViewerState();
  const derived = useDerived();
  const selection = state.selection;
  const [chosen, setChosen] = useState<string | undefined>();
  const [explain, setExplain] = useState<{ id: string; phase: ExplainPhase; note?: string }>({
    id: "",
    phase: { kind: "idle" },
  });
  const [feedback, setFeedback] = useState({ id: "", text: "" });
  const activeId =
    chosen !== undefined && selection.includes(chosen) ? chosen : selection[selection.length - 1];

  const info = useMemo(
    () =>
      activeId === undefined ? undefined : describeElement(activeId, state.model, derived.view),
    [activeId, state.model, derived.view],
  );

  if (activeId === undefined || !info) {
    return (
      <section className="details" aria-label="Details">
        <h2 className="panel-title">Details</h2>
        <p className="empty">
          Select a box, an arrow, a step or a concept to see what it is and where its code lives.
        </p>
      </section>
    );
  }

  const graphNode = derived.view.graph?.nodes.find((n) => n.id === info.id);
  const kind = reader ? (info.type === "node" ? readerBadge(info.kind) : undefined) : info.kind;
  const facts = reader ? info.facts.filter((fact) => !AUTHOR_FACTS.has(fact.label)) : info.facts;
  return (
    <section className="details" aria-label="Details" data-details-id={info.id}>
      {!untitled && (
        <header className="details-head">
          {kind && <span className={`kind-pill kind-${kind.split(" ")[0]}`}>{kind}</span>}
          <h2 className="details-title">{info.title}</h2>
          {info.provenance && !reader && <ProvenanceBadge info={info} />}
        </header>
      )}
      {info.where && <p className="where">{info.where}</p>}
      {!reader && (
        <p className="element-id">
          <code>{info.id}</code>
        </p>
      )}
      {(store.canZoomInto(info.id) || store.canExpandInPlace(info.id)) && (
        <div className="actions">
          {store.canZoomInto(info.id) && (
            <button type="button" className="btn" onClick={() => store.zoomInto(info.id)}>
              See what is inside: {opensView(state.model, info.id)?.title}
            </button>
          )}
          {store.canExpandInPlace(info.id) && (
            <button type="button" className="btn" onClick={() => store.toggleExpanded(info.id)}>
              {store.isExpanded(info.id) ? "Fold back into one box" : "Show the inside here"}
            </button>
          )}
        </div>
      )}

      {!reader && (
        <textarea
          className="feedback"
          data-testid="feedback"
          aria-label="What should Claude change?"
          placeholder="What should Claude change? Empty: explain this in more depth."
          rows={2}
          value={feedback.id === info.id ? feedback.text : ""}
          onChange={(event) => setFeedback({ id: info.id, text: event.target.value })}
        />
      )}
      {!reader && (
        <div className="actions">
          <ExplainButton
            id={info.id}
            note={feedback.id === info.id ? feedback.text : ""}
            onPhase={(phase, note) => {
              setExplain({ id: info.id, phase, ...(note ? { note } : {}) });
              if (phase.kind === "queued") setFeedback({ id: "", text: "" });
            }}
          />
          {info.stub && !info.targets && (
            <button type="button" className="btn" onClick={() => store.expandStub(info.stub!)}>
              Add {info.stub.ghostLabel} to the view
            </button>
          )}
          {graphNode && store.canDrillIn(graphNode.id) && (
            <button type="button" className="btn" onClick={() => store.drillIn(graphNode.id)}>
              Open children
            </button>
          )}
          {graphNode?.container && (
            <button type="button" className="btn" onClick={() => store.collapse(graphNode.id)}>
              Collapse
            </button>
          )}
        </div>
      )}

      {!reader && explain.id === info.id && (
        <ExplainNote id={info.id} phase={explain.phase} note={explain.note} />
      )}

      {selection.length > 1 && (
        <div className="selected-chips" aria-label="Selected elements">
          {selection.map((id) => (
            <button
              key={id}
              type="button"
              className={"chip" + (id === activeId ? " is-active" : "")}
              onClick={() => setChosen(id)}
              title={id}
            >
              {state.model.label(id)}
            </button>
          ))}
        </div>
      )}

      {info.summary && !untitled && (
        <p className="summary" dangerouslySetInnerHTML={{ __html: renderInline(info.summary) }} />
      )}
      {info.targets && !reader && (
        <div className="ghost-details">
          <h3>Add to the view</h3>
          <GhostTargetList
            targets={info.targets}
            onPick={(target) => store.expandStub({ ghost: target })}
          />
        </div>
      )}
      {info.detail && (
        <div
          className="markdown"
          dangerouslySetInnerHTML={{ __html: renderMarkdown(info.detail) }}
        />
      )}

      {facts.length > 0 && (
        <dl className="facts">
          {facts.map((fact) => (
            <div key={fact.label}>
              <dt>{fact.label}</dt>
              <dd>{fact.value}</dd>
            </div>
          ))}
        </dl>
      )}

      {!factsAbove && <ChangeOfElement id={info.id} />}

      {info.related.length > 0 && (
        <div className="related">
          <h3>Related</h3>
          <div className="chips">
            {info.related.map((id) => (
              <button
                key={id}
                type="button"
                className="chip"
                title={id}
                onClick={() => store.select([id])}
              >
                {state.model.label(id)}
              </button>
            ))}
          </div>
        </div>
      )}

      <Anchors rows={info.anchors} reader={reader} />
      {!factsAbove && <CallersList id={info.id} />}
    </section>
  );
}

function ProvenanceBadge({ info }: { info: ElementInfo }) {
  const provenance = info.provenance!;
  const parts = [`origin: ${provenance.origin}`];
  if (provenance.commit) parts.push(`commit ${provenance.commit}`);
  if (provenance.userFields?.length)
    parts.push(`edited by you: ${provenance.userFields.join(", ")}`);
  return (
    <span className={`badge origin-${provenance.origin}`} title={parts.join("\n")}>
      {provenance.origin}
    </span>
  );
}

function Anchors({ rows, reader }: { rows: AnchorRow[]; reader: boolean }) {
  const store = useStore();
  const [expanded, setExpanded] = useState(false);
  if (rows.length === 0) return null;
  const shown = expanded ? rows : rows.slice(0, MAX_ANCHOR_ROWS);
  return (
    <div className="anchors">
      <h3>{reader ? "In the code" : "Anchors"}</h3>
      <ul>
        {shown.map((row, i) => (
          <li key={`${row.where}:${i}`}>
            <button
              type="button"
              className="anchor-row"
              data-status={row.status}
              title={`Open ${row.base ? "the code before the change of " : ""}${row.file}${row.startLine ? ` at line ${row.startLine}` : ""}`}
              onClick={() => store.openFile(row.file, row.startLine, row.base ? "base" : undefined)}
            >
              <span className={`role role-${row.role}`}>
                {reader ? roleWords(row.role) : row.role}
              </span>
              {row.base && <span className="anchor-before">before</span>}
              {/* A reader's narrow column: "Ky.ts, lines 612–634 in Ky.#retry", not the anchor's notation
                  (the title has the whole path). */}
              <span className="where">{reader ? readerWhere(row) : row.where}</span>
              {!reader && row.startLine !== undefined && (
                <span className="lines">
                  {row.endLine !== row.startLine
                    ? `L${row.startLine}–${row.endLine}`
                    : `L${row.startLine}`}
                </span>
              )}
              {!(reader && row.status === "ok") && (
                <span className={`badge status-${row.status}`} title={statusHelp(row.status)}>
                  {row.status}
                </span>
              )}
            </button>
          </li>
        ))}
      </ul>
      {rows.length > shown.length && (
        <button className="link" onClick={() => setExpanded(true)}>
          Show {rows.length - shown.length} more references
        </button>
      )}
    </div>
  );
}

/** An anchor in a reader's words: "Ky.ts, lines 612–634 in Ky.#retry", "config.yaml, line 3". */
export function readerWhere(row: AnchorRow): ReactNode {
  const name = row.file.slice(row.file.lastIndexOf("/") + 1);
  const lines =
    row.startLine === undefined
      ? ""
      : row.endLine !== undefined && row.endLine !== row.startLine
        ? `, lines ${row.startLine}–${row.endLine}`
        : `, line ${row.startLine}`;
  return (
    <>
      {name}
      {lines}
      {row.symbol && (
        <span className="anchor-in">
          {" "}
          in <code>{row.symbol}</code>
        </span>
      )}
    </>
  );
}

function statusHelp(status: AnchorRow["status"]): string {
  switch (status) {
    case "ok":
      return "Found, text unchanged";
    case "moved":
      return "Found at a new place, text unchanged";
    case "drifted":
      return "Found, but the text changed: the explanation may be stale";
    case "missing":
      return "The symbol is gone: fix or drop this anchor";
    case "unresolved":
      return "Not resolved yet";
  }
}

type ExplainPhase =
  { kind: "idle" } | { kind: "queued" } | { kind: "command" } | { kind: "error"; message: string };

/**
 * "Explain this", or with feedback typed above it "Send to Claude": with a server the request (and the
 * feedback as its note) is queued (`xpl status` shows the queue and the skill drains it); without one
 * the button shows the command to run in Claude (see ExplainNote).
 */
function ExplainButton({
  id,
  note,
  onPhase,
}: {
  id: string;
  note: string;
  onPhase: (phase: ExplainPhase, note: string) => void;
}) {
  const store = useStore();
  const text = note.trim();
  return (
    <button
      type="button"
      className="btn is-primary"
      onClick={() => {
        store.requestExplain(id, text).then(
          (result) => onPhase({ kind: result }, text),
          (error: unknown) => onPhase({ kind: "error", message: messageOf(error) }, text),
        );
      }}
    >
      {text ? "Send to Claude" : "Explain this"}
    </button>
  );
}

function ExplainNote({ id, phase, note }: { id: string; phase: ExplainPhase; note?: string }) {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 1500);
    return () => clearTimeout(timer);
  }, [copied]);

  const command = explainCommand(id, note);
  switch (phase.kind) {
    case "idle":
      return null;
    case "queued":
      return (
        <p className="note explain-note" role="status">
          Queued. Run <code>/code-explainer feedback</code> in Claude Code: this page updates by
          itself once the change is applied.
        </p>
      );
    case "error":
      return (
        <p className="note explain-note is-error" role="alert">
          Could not queue the request: {phase.message}
        </p>
      );
    case "command":
      return (
        <div className="command explain-note" role="status">
          <p className="note">Ask Claude to explain this: paste this into Claude Code.</p>
          <div className="command-line">
            <code data-testid="explain-command">{command}</code>
            <button
              type="button"
              className="btn"
              onClick={() => {
                navigator.clipboard?.writeText(command).then(
                  () => setCopied(true),
                  () => undefined,
                );
              }}
            >
              {copied ? "Copied" : "Copy"}
            </button>
          </div>
        </div>
      );
  }
}

/**
 * What the picked element is in the code that a reader asks first, shown unfolded under the topic summary:
 * what the change did to it, and who calls it.
 */
export function TopicFacts({ id }: { id: string }) {
  return (
    <div className="topic-facts" data-testid="topic-facts">
      <ChangeOfElement id={id} />
      <CallersList id={id} />
    </div>
  );
}

/** What the explainer's change did to the picked file or symbol, with a way to the lines. */
function ChangeOfElement({ id }: { id: string }) {
  const store = useStore();
  const state = useViewerState();
  const summary = useMemo(
    () => changeSummary(id, state.model.index, changeOf(state.explainer)),
    [id, state.model.index, state.explainer],
  );
  if (!summary) return null;
  return (
    <div className="element-change" data-testid="element-change">
      <span>{summary.words}</span>
      <span aria-hidden="true">·</span>
      <span className="element-change-count">
        <span className="is-add">+{summary.added}</span>{" "}
        <span className="is-del">−{summary.deleted}</span>
      </span>
      <span className="element-change-open">
        <span aria-hidden="true">· </span>
        <button
          type="button"
          className="link"
          onClick={() => store.openFile(summary.file, summary.line)}
        >
          Show the change
        </button>
      </span>
    </div>
  );
}

/** How many callers are listed before "N more". */
const CALLERS_SHOWN = 6;

/**
 * "Called from": the code that calls the picked file or symbol (for a flow step, the symbol that holds it),
 * each row opening the call.
 */
function CallersList({ id }: { id: string }) {
  const state = useViewerState();
  const subject = useMemo(() => callerSubject(id, state.model), [id, state.model]);
  const callers = useMemo(
    () => (subject ? callersOf(subject, state.model.index) : []),
    [subject, state.model.index],
  );
  const [all, setAll] = useState(false);
  if (!subject || callers.length === 0) return null;
  const shown = all ? callers : callers.slice(0, CALLERS_SHOWN);
  return (
    <div className="callers" data-testid="callers">
      <h3>
        Called from
        {subject !== id && (
          <>
            {" "}
            (who calls <code>{state.model.label(subject)}</code>)
          </>
        )}
      </h3>
      <CallerRows callers={shown} />
      {callers.length > shown.length && (
        <button className="link" onClick={() => setAll(true)}>
          Show {callers.length - shown.length} more
        </button>
      )}
    </div>
  );
}

/** One button per caller: its name and file, opening the line of the call. */
export function CallerRows({ callers }: { callers: readonly Caller[] }) {
  const store = useStore();
  return (
    <ul className="caller-rows">
      {callers.map((caller) => (
        <li key={caller.from}>
          <button
            type="button"
            className="anchor-row"
            title={`Open ${caller.file} at line ${caller.line}`}
            onClick={() => store.openFile(caller.file, caller.line)}
          >
            <code className="caller-name">{caller.label}</code>
            <span className="where">{caller.file.slice(caller.file.lastIndexOf("/") + 1)}</span>
            <span className="lines">L{caller.line}</span>
          </button>
        </li>
      ))}
    </ul>
  );
}
