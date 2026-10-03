/**
 * Details of the selected element: label and kind, summary and detail (markdown), provenance, anchors
 * with their status, and actions ("Explain this", open children, collapse, add a stub's target).
 *
 * `reader` (Read mode, under "Where this is in the code"): what a reader needs, in plain words. No element
 * id, no provenance, no author actions, the kind only for a piece of code, roles as "defined here" /
 * "called here", and a status only when it is not "ok".
 */
import { useEffect, useMemo, useState } from "react";
import { opensView } from "@xpl/core";
import { describeElement, type AnchorRow, type ElementInfo } from "../details.js";
import { explainCommand, messageOf } from "../data.js";
import { useDerived, useStore, useViewerState } from "../hooks.js";
import { renderInline, renderMarkdown } from "../markdown.js";
import { readerBadge, roleWords } from "../readerWords.js";
import { GhostTargetList } from "./GhostTargets.js";

const MAX_ANCHOR_ROWS = 8;

/** Facts that only matter to the author of the explainer. */
const AUTHOR_FACTS = new Set(["Origin", "Resolution"]);

export function Details({ reader = false }: { reader?: boolean }) {
  const store = useStore();
  const state = useViewerState();
  const derived = useDerived();
  const selection = state.selection;
  const [chosen, setChosen] = useState<string | undefined>();
  const [explain, setExplain] = useState<{ id: string; phase: ExplainPhase }>({
    id: "",
    phase: { kind: "idle" },
  });
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
      <header className="details-head">
        {kind && <span className={`kind-pill kind-${kind.split(" ")[0]}`}>{kind}</span>}
        <h2 className="details-title">{info.title}</h2>
        {info.provenance && !reader && <ProvenanceBadge info={info} />}
      </header>
      {info.where && <p className="where">{info.where}</p>}
      {!reader && (
        <p className="element-id">
          <code>{info.id}</code>
        </p>
      )}
      {store.canZoomInto(info.id) && (
        <div className="actions">
          <button type="button" className="btn" onClick={() => store.zoomInto(info.id)}>
            See what is inside: {opensView(state.model, info.id)?.title}
          </button>
        </div>
      )}

      {!reader && (
        <div className="actions">
          <ExplainButton id={info.id} onPhase={(phase) => setExplain({ id: info.id, phase })} />
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

      {!reader && explain.id === info.id && <ExplainNote id={info.id} phase={explain.phase} />}

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

      {info.summary && (
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
              <span className="where">{row.where}</span>
              {row.startLine !== undefined && (
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
 * "Explain this": with a server the request is queued (`xpl status` shows the queue and the skill
 * drains it); without one the button shows the command to run in Claude (see ExplainNote).
 */
function ExplainButton({ id, onPhase }: { id: string; onPhase: (phase: ExplainPhase) => void }) {
  const store = useStore();
  return (
    <button
      type="button"
      className="btn is-primary"
      onClick={() => {
        store.requestExplain(id).then(
          (result) => onPhase({ kind: result }),
          (error: unknown) => onPhase({ kind: "error", message: messageOf(error) }),
        );
      }}
    >
      Explain this
    </button>
  );
}

function ExplainNote({ id, phase }: { id: string; phase: ExplainPhase }) {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 1500);
    return () => clearTimeout(timer);
  }, [copied]);

  const command = explainCommand(id);
  switch (phase.kind) {
    case "idle":
      return null;
    case "queued":
      return (
        <p className="note explain-note" role="status">
          Queued. Claude picks the request up the next time it runs the code-explainer skill.
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
