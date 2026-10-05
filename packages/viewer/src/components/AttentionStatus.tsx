import { useState } from "react";
import { useStore, useViewerState } from "../hooks.js";
import { messageOf } from "../data.js";

/** Attention is a live report, never a readiness decision or an automatic revision. */
export function AttentionStatus() {
  const store = useStore();
  const { attention, attentionError, connection, serverMode } = useViewerState();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  if (!connection.attachment?.instanceId || !serverMode || !attention) return null;
  const watch = attention.watch;
  const affected = attention.guides.filter(
    (g) => g.errors.length || (g.counts && g.counts.drifted + g.counts.missing > 0),
  );
  const label = !attention.enabled
    ? "Watching off"
    : watch?.state === "paused"
      ? "Paused"
      : watch?.state === "building"
        ? "Building index"
        : watch?.state === "failed"
          ? "Watch failed"
          : watch?.state === "current"
            ? "Watching"
            : "Checking changes";
  const connected = connection.status === "connected";
  const change = async (action: "pause" | "resume" | "stop") => {
    setBusy(true);
    setError(undefined);
    try {
      await store.controlWatch(action);
    } catch (error) {
      setError(messageOf(error));
    } finally {
      setBusy(false);
    }
  };
  return (
    <section
      className="attention-status"
      data-testid="attention-status"
      aria-label="Source watch and guide attention"
    >
      <details>
        <summary>
          <strong>{label}</strong> ·{" "}
          {affected.length === 1
            ? "1 guide needs attention"
            : `${affected.length} guides need attention`}
        </summary>
        <p>
          Locations follow unchanged code. Watching never rewrites prose, accepts proposals or
          removes feedback.
        </p>
        {watch?.stale && (
          <p>
            Last index is out of date.{" "}
            {watch.state === "paused"
              ? "Resume to check source changes."
              : "Wait for a checked build or stop the service to index manually."}
          </p>
        )}
        {watch?.error && (
          <p role="alert">
            {watch.error} Retry by pausing and resuming, or restart the watched service.
          </p>
        )}
        {!attention.enabled && (
          <p>
            Start the service with <code>--watch</code> to enable source watching.
          </p>
        )}
        {attention.guides.map((g) => (
          <article key={g.name}>
            <h3>
              {g.title} <small>({g.name})</small>
            </h3>
            {g.counts && (
              <p>
                {g.counts.moved} moved · {g.counts.drifted} drifted · {g.counts.missing} missing
              </p>
            )}
            {g.errors.map((message, i) => (
              <p role="alert" key={i}>
                {message} Inspect and repair this guide before export.
              </p>
            ))}
            <ul>
              {g.elements.map((element, i) => (
                <li key={i}>
                  <code>{element.id}</code> · <code>{element.file}</code>
                  <p>
                    {element.status === "moved"
                      ? "Moved: locations followed unchanged code. Keep the prose."
                      : element.status === "drifted"
                        ? "Drifted: inspect the changed code and revise its explanation."
                        : "Missing: restore the code or explicitly replace/remove its evidence."}
                  </p>
                  {g.path === connection.attachment!.guide && (
                    <button className="btn" onClick={() => store.select([element.id])}>
                      Inspect element
                    </button>
                  )}
                </li>
              ))}
            </ul>
            {g.counts && g.counts.drifted + g.counts.missing === 0 && !g.errors.length && (
              <p>
                No changed or missing evidence. Moved locations can be saved with{" "}
                <code>xpl resolve {g.name} --write</code>.
              </p>
            )}
            {(g.errors.length > 0 || (g.counts && g.counts.drifted + g.counts.missing > 0)) && (
              <details className="revision-offer">
                <summary>Offer revision</summary>
                <p>
                  Create or choose feedback in the Feedback panel, then replace{" "}
                  <code>&lt;request-id&gt;</code> with the IDs you select.
                </p>
                <pre>{g.revisionCommand}</pre>
                <p>
                  This starts the explicit revision workflow. Inspect its diff and decisions. Accept
                  a proposal separately; no changes are applied here.
                </p>
              </details>
            )}
          </article>
        ))}
      </details>
      <div className="attention-actions">
        {attention.enabled && (
          <button
            className="btn"
            disabled={busy || !connected}
            onClick={() => void change(watch?.state === "paused" ? "resume" : "pause")}
          >
            {watch?.state === "paused" ? "Resume watch" : "Pause watch"}
          </button>
        )}
        <button className="btn" disabled={busy || !connected} onClick={() => void change("stop")}>
          Stop service
        </button>
        {busy && <span role="status">Finishing watch operation…</span>}
      </div>
      {(error || attentionError) && (
        <p role="alert">
          {error || attentionError} Attention may be out of date; retry after reconnecting.
        </p>
      )}
    </section>
  );
}
