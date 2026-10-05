import { useStore, useViewerState } from "../hooks.js";

/** Connection to the optional local service; loaded source remains readable after it stops. */
export function ConnectionStatus() {
  const store = useStore();
  const { connection, dirty } = useViewerState();
  const { status, attachment, message } = connection;
  if (!attachment?.instanceId) return null;
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
      </div>
      {attachment && (
        <details name="service-status">
          <summary>Connection details</summary>
          <div className="service-disclosure">
            <p>
              Guide: <code>{attachment.guide}</code>
            </p>
            {!live && <p>Reading and manual edits use loaded source.</p>}
            {failed && <p>Loaded source remains readable. Restart the service, then retry.</p>}
            {dirty && !live && <p>Download your edits before closing this page.</p>}
            <p>
              Repository: <code>{attachment.root}</code>
            </p>
            <p>
              Last service instance: <code>{attachment.instanceId}</code>
            </p>
            <p>
              {attachment.backend === "claude" && attachment.backendAvailable ? (
                "Agent: Claude Code (configured; sign-in is checked when a job runs)"
              ) : (
                <>
                  No agent is configured. Use <code>xpl revise</code> for a manual revision.
                </>
              )}
            </p>
            {message && (
              <p title={status === "disconnected" ? message : undefined}>
                {status === "disconnected" ? "Could not reach the xpl service." : message}
              </p>
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
        </details>
      )}
    </div>
  );
}
