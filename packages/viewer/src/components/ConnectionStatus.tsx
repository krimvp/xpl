import { useStore, useViewerState } from "../hooks.js";

/** Connection to the optional local service; loaded source remains readable after it stops. */
export function ConnectionStatus() {
  const store = useStore();
  const { connection, dirty } = useViewerState();
  const { status, attachment, message } = connection;
  if (!attachment) return null;
  const live = status !== "offline";
  const failed = status === "disconnected" || status === "unavailable";
  return (
    <div className="connection-status" data-status={status} data-testid="connection-status">
      <div role="status">
        <strong>
          {status === "offline"
            ? "Offline snapshot"
            : status === "connecting"
              ? "Connecting"
              : status === "connected"
                ? "Connected"
                : status === "disconnected"
                  ? "Disconnected"
                  : "Service unavailable"}
        </strong>
        {attachment && <span> · {attachment.guide}</span>}
        {!live && <span> · Reading and manual edits use loaded source.</span>}
        {failed && <span> · Loaded source remains readable. Restart the service, then retry.</span>}
        {dirty && !live && <span> Download your edits before closing this page.</span>}
      </div>
      {attachment && (
        <details>
          <summary>Repository and backend</summary>
          <p>
            Repository: <code>{attachment.root}</code>
          </p>
          <p>
            Last service instance: <code>{attachment.instanceId}</code>
          </p>
          <p>
            Agent backend unavailable
            {attachment.backend === "claude" ? " (Claude selected)" : " (none selected)"}. No agent
            is configured. Use <code>xpl apply</code> for a manual revision.
          </p>
          {message && (
            <p title={status === "disconnected" ? message : undefined}>
              {status === "disconnected" ? "Could not reach the xpl service." : message}
            </p>
          )}
        </details>
      )}
      <div className="connection-actions">
        {(failed || (!live && store.canReconnect)) && (
          <button className="btn" onClick={() => void store.reconnect()}>
            Retry connection
          </button>
        )}
        {live && (
          <button className="btn" onClick={() => store.useOfflineSnapshot()}>
            Use loaded snapshot offline
          </button>
        )}
      </div>
    </div>
  );
}
