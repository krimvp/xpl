import { useEffect, useRef, useState } from "react";
import type { Job, RevisionDecision, RevisionReview, RevisionSource } from "@xpl/core";
import { useStore, useViewerState } from "../hooks.js";
import { messageOf } from "../data.js";
import { ProposalChanges } from "./ProposalChanges.js";

function Source({ before, after }: { before: RevisionSource[]; after: RevisionSource[] }) {
  return (
    <details className="job-source">
      <summary>Source before/after</summary>
      {after.map((source) => (
        <section key={`${source.side}:${source.file}`}>
          <h4>
            {source.file} ({source.side})
          </h4>
          <div className="job-comparison">
            <pre aria-label="Source before">
              {before.find((old) => old.file === source.file && old.side === source.side)?.text ??
                "Not included"}
            </pre>
            <pre aria-label="Source after">{source.text ?? "Not included"}</pre>
          </div>
        </section>
      ))}
    </details>
  );
}
function JobReview({ job, onClose }: { job: Job; onClose: () => void }) {
  const store = useStore();
  const { model } = useViewerState();
  const dialog = useRef<HTMLDialogElement>(null);
  const [review, setReview] = useState<RevisionReview>();
  const [choices, setChoices] = useState<RevisionDecision[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [inspected, setInspected] = useState(false);
  useEffect(() => {
    dialog.current?.showModal();
    let active = true;
    void store
      .reviewJob(job)
      .then((result) => {
        if (active) {
          setReview(result);
          setChoices(
            result.requests.map(
              (request) =>
                result.decisions.find((d) => d.id === request.id) ?? {
                  id: request.id,
                  status: "unresolved",
                  reason: "",
                },
            ),
          );
          setInspected(["reviewed", "committing", "committed"].includes(result.state));
        }
      })
      .catch((e) => active && setError(messageOf(e)));
    return () => {
      active = false;
    };
  }, [store, job.id, job.owner?.attemptId]);
  const act = async (accept = false) => {
    setBusy(true);
    setError(undefined);
    try {
      const result = await store.reviewJob(job, accept ? { accept: true } : { decisions: choices });
      setReview(result);
      setInspected(true);
      if (result.state === "done") onClose();
    } catch (e) {
      setError(messageOf(e));
      setInspected(false);
    } finally {
      setBusy(false);
    }
  };
  const update = (id: string, patch: Partial<RevisionDecision>) => {
    setInspected(false);
    setChoices((old) => old.map((d) => (d.id === id ? { ...d, ...patch } : d)));
  };
  const recovering = !!review && ["committing", "committed"].includes(review.state);
  return (
    <dialog
      ref={dialog}
      className="job-review-dialog"
      aria-label="Review job proposal"
      onCancel={onClose}
    >
      <header>
        <h2>Review job proposal</h2>
        <button className="btn" onClick={onClose} disabled={busy}>
          Close review
        </button>
      </header>
      <p>
        Review each selected request, then review the combined decisions before accepting. Source
        stays read-only.
      </p>
      {error && <p role="alert">{error}</p>}
      {review && (
        <>
          <Source before={review.sourceBefore} after={review.source} />
          {review.requests.map((request) => {
            const decision = choices.find((d) => d.id === request.id)!;
            const proposal = review.proposals.find((p) => p.id === request.id);
            return (
              <fieldset key={request.id} disabled={busy || recovering}>
                <legend>{request.note ?? request.label ?? request.elementId}</legend>
                {request.contextReason && <p role="alert">{request.contextReason}</p>}
                <ProposalChanges changes={proposal?.changes ?? []} />
                {!proposal && <p>No proposal for this request. Keep it unresolved or reject it.</p>}
                <div className="job-decision">
                  <h4>Decision for this request</h4>
                  <label>
                    Decision
                    <select
                      value={decision.status}
                      onChange={(e) =>
                        update(request.id, { status: e.target.value as RevisionDecision["status"] })
                      }
                    >
                      <option value="unresolved">Leave unresolved</option>
                      <option value="addressed">Accept change</option>
                      <option value="rejected">Reject change</option>
                      <option value="outdated">Context outdated</option>
                    </select>
                  </label>
                  <label>
                    Reason (required)
                    <textarea
                      required
                      value={decision.reason}
                      onChange={(e) => update(request.id, { reason: e.target.value })}
                    />
                  </label>
                  {[...new Set(review.resolve.missing.map((site) => site.elementId))].map((id) => (
                    <label key={id}>
                      Missing evidence: {model.label(id)}
                      <select
                        value={decision.missing?.find((m) => m.id === id)?.action ?? ""}
                        onChange={(e) =>
                          update(request.id, {
                            missing: [
                              ...(decision.missing ?? []).filter((m) => m.id !== id),
                              ...(e.target.value
                                ? [{ id, action: e.target.value as "reanchor" | "remove" }]
                                : []),
                            ],
                          })
                        }
                      >
                        <option value="">No repair permission</option>
                        <option value="reanchor">Allow replacing missing evidence</option>
                        <option value="remove">Allow removing missing evidence</option>
                      </select>
                    </label>
                  ))}
                  {request.contextReason && (
                    <label>
                      Reconciliation
                      <textarea
                        value={decision.reconciliation ?? ""}
                        onChange={(e) => update(request.id, { reconciliation: e.target.value })}
                      />
                    </label>
                  )}
                </div>
              </fieldset>
            );
          })}
          {inspected && (
            <section aria-label="Reviewed revision">
              <h3>Reviewed revision</h3>
              <ProposalChanges changes={review.changes} />
              <p>
                {review.readiness?.ready
                  ? "Ready for explicit acceptance."
                  : "Readiness blocks acceptance. Inspect the reported issues."}
              </p>
              {review.readiness && !review.readiness.ready && (
                <ul>
                  {review.readiness.findings.map((finding, i) => (
                    <li key={i}>
                      {finding.message} {finding.hint}
                    </li>
                  ))}
                </ul>
              )}
            </section>
          )}
          <div className="job-review-actions">
            <button
              className="btn"
              disabled={busy || recovering || choices.some((d) => !d.reason.trim())}
              onClick={() => void act()}
            >
              Review decisions
            </button>
            <button
              className="btn primary"
              disabled={
                busy ||
                !inspected ||
                (!recovering &&
                  choices.some((d) => d.status === "addressed") &&
                  !review.readiness?.ready)
              }
              onClick={() => void act(true)}
            >
              {recovering ? "Recover acceptance" : "Accept reviewed revision"}
            </button>
          </div>
        </>
      )}
    </dialog>
  );
}
export function JobsPanel() {
  const store = useStore();
  const { jobs, jobError, feedback, connection } = useViewerState();
  const [selected, setSelected] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [review, setReview] = useState<Job>();
  if (!connection.attachment?.instanceId) return null;
  const available = connection.status === "connected";
  const requests = feedback.filter((request) =>
    ["pending", "unresolved", "outdated"].includes(request.outcome.status),
  );
  const act = async (action: () => Promise<void>) => {
    setBusy(true);
    setError(undefined);
    try {
      await action();
    } catch (e) {
      setError(messageOf(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <details
      className="jobs-status"
      name="service-status"
      onToggle={(event) => {
        if (event.currentTarget.open) {
          void store.refreshJobs();
          void store.refreshFeedback().catch((error) => setError(messageOf(error)));
        }
      }}
    >
      <summary className="btn" role="button">
        Jobs
      </summary>
      <section className="service-disclosure jobs-panel" data-testid="jobs-panel" aria-label="Jobs">
        <h3>Jobs</h3>
        <p>Generated changes await your review and explicit acceptance.</p>
        {(!jobs?.available || !available) && (
          <p>
            {!available
              ? "Reconnect to start, retry or review jobs."
              : (jobs?.reason ?? "Loading job availability…")}
          </p>
        )}
        {(error ?? jobError) && <p role="alert">{error ?? jobError}</p>}
        <fieldset disabled={busy || !available || !jobs?.available}>
          <legend>Select feedback</legend>
          {requests.map((request) => (
            <label key={request.id}>
              <input
                type="checkbox"
                checked={selected.includes(request.id)}
                onChange={(e) =>
                  setSelected((ids) =>
                    e.target.checked ? [...ids, request.id] : ids.filter((id) => id !== request.id),
                  )
                }
              />
              {request.note ?? request.label ?? request.elementId}
            </label>
          ))}
          <button
            className="btn"
            disabled={!selected.length}
            onClick={() =>
              void act(async () => {
                await store.startJob(selected);
                setSelected([]);
              })
            }
          >
            Start selected job
          </button>
        </fieldset>
        <ol>
          {jobs?.jobs.map((job) => (
            <li key={job.id} data-job-state={job.state}>
              <strong>
                {job.result?.accepted
                  ? "Accepted"
                  : job.state[0]!.toUpperCase() + job.state.slice(1)}
              </strong>{" "}
              · attempt {job.attempt}
              <div>
                <code>{job.id}</code>
              </div>
              {job.progress.map((p, i) => (
                <p key={i}>{p.message}</p>
              ))}
              {job.error && <p role="alert">{job.error}</p>}
              <div className="job-actions">
                {["queued", "running", "completed"].includes(job.state) &&
                  !job.result?.accepted && (
                    <button
                      className="btn"
                      disabled={busy || !available}
                      onClick={() => void act(() => store.controlJob(job, "cancel"))}
                    >
                      Cancel job
                    </button>
                  )}
                {["failed", "interrupted"].includes(job.state) && (
                  <button
                    className="btn"
                    disabled={busy || !available || !jobs.available}
                    onClick={() => void act(() => store.controlJob(job, "retry"))}
                  >
                    Retry job
                  </button>
                )}
                {job.state === "completed" && !job.result?.accepted && (
                  <button
                    className="btn"
                    disabled={busy || !available}
                    onClick={() => setReview(job)}
                  >
                    Review proposal
                  </button>
                )}
              </div>
            </li>
          ))}
        </ol>
      </section>
      {review && <JobReview job={review} onClose={() => setReview(undefined)} />}
    </details>
  );
}
