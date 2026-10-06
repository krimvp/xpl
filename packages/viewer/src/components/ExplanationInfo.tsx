import { checkReview, reviewShapeIssues, type PublishedVersion } from "@xpl/core";
import { snapshotTexts } from "../snapshot.js";
import { useStore, useViewerState } from "../hooks.js";
import { searchFor, versionUrl } from "../url.js";

function VersionDetails({ version }: { version: PublishedVersion }) {
  return (
    <details>
      <summary>Source and version details</summary>
      <p>
        Version: <code>{version.version}</code>; snapshot: <code>{version.commits.index}</code>.
      </p>
      {version.commits.base && (
        <p>
          Base: <code>{version.commits.base}</code>; head: <code>{version.commits.head}</code>.
        </p>
      )}
      <p>
        Included source: {version.includedSource.head.length} head,{" "}
        {version.includedSource.base.length} base files.
      </p>
      <p>Head: {version.includedSource.head.join(", ") || "none"}</p>
      <p>Base: {version.includedSource.base.join(", ") || "none"}</p>
    </details>
  );
}

/** Reader guidance belongs beside the story, rather than behind the author tools. */
export function ExplanationInfo() {
  const state = useViewerState();
  const store = useStore();
  const publication = state.dirty ? undefined : store.library.publication;
  const link = publication && versionUrl(location.href, publication.current.version);
  if (link)
    link.search = searchFor(state, `?version=${publication!.current.version}`, store.library.mode);
  const latest = link && new URL(link.href);
  if (latest) {
    latest.pathname = latest.pathname.replace(/\/[^/]+\/index\.html$/, "/current/index.html");
    latest.search = "";
    latest.hash = "";
  }
  const record = state.explainer.review;
  const review = record && reviewShapeIssues(record).length === 0 ? record : undefined;
  const status = checkReview(state.explainer, state.model.index.index, snapshotTexts(state)).status;
  const label = status === "out-of-date" ? "out of date" : status;
  return (
    <details className="guide-about" data-testid="explanation-info">
      <summary>
        About this explanation <span data-testid="review-status">Author review: {label}</span>
      </summary>
      {publication && (
        <section aria-label="Staged versions">
          <p>
            Staged{" "}
            <time dateTime={publication.current.createdAt}>
              {new Date(publication.current.createdAt).toLocaleString(undefined, {
                dateStyle: "medium",
                timeStyle: "short",
              })}
            </time>
            .
            {link && (
              <>
                {" "}
                <a href={link.href}>Link to this state</a>.
              </>
            )}
            {latest && (
              <>
                {" "}
                <a href={latest.href}>Open latest version</a>.
              </>
            )}
          </p>
          <VersionDetails version={publication.current} />
          <details>
            <summary>Earlier versions ({publication.previous.length})</summary>
            <ul>
              {publication.previous.map((version) => {
                const url = versionUrl(location.href, version.version);
                if (url) url.search = `?version=${version.version}`;
                const time = new Date(version.createdAt).toLocaleString(undefined, {
                  dateStyle: "medium",
                  timeStyle: "short",
                });
                return (
                  <li key={version.version}>
                    {url ? (
                      <a href={url.href}>Open version staged {time}</a>
                    ) : (
                      <span>Staged {time}</span>
                    )}
                    ; author review: {version.review?.status ?? "unchecked"}.
                    <VersionDetails version={version} />
                  </li>
                );
              })}
            </ul>
          </details>
          <p>
            Version links require the staged directory tree. This page captures history at staging;
            it does not contact a repository service.
          </p>
        </section>
      )}
      {review && (
        <>
          <p>
            {review.reviewer} (self-reported), reviewed {review.reviewedAt}. Content:{" "}
            {review.scope.content === "all"
              ? "all stored explanation content"
              : review.scope.content.join(", ")}
            . Evidence:{" "}
            {review.scope.source === "repository"
              ? "all indexed repository files and attached anchors"
              : "attached anchors"}
            {review.scope.files?.length ? ` plus ${review.scope.files.join(", ")}` : ""}.{" "}
            {review.omissions.length
              ? `Named omissions: ${review.omissions.join("; ")}`
              : "No omissions named."}{" "}
            {status === "out-of-date" &&
              "Reviewed content or evidence changed, or evidence is unavailable in this snapshot."}
          </p>
          <details>
            <summary>Review source snapshot</summary>
            <p>
              <code>{review.sourceCommit}</code>
            </p>
          </details>
        </>
      )}
      <p>
        A review is an author inspection record. Names are not authenticated; a record does not
        automatically verify prose or runtime coverage. Narrow scopes cover only named stored items
        and their own anchors, not dependencies.
      </p>
      <p>
        This explanation was written by an author. Source anchors check code locations and changes;
        they do not verify the claims or prove that every execution path is covered. Use the linked
        code and tests to check important conclusions.
      </p>
      {state.exportInfo && (
        <p>
          Saved as {state.exportInfo.status === "draft" ? "a draft preview" : "ready HTML"}; checked
          against{" "}
          {state.exportInfo.report.scope === "workspace"
            ? "the workspace at export time"
            : "the embedded source snapshot"}
          . Team review policy:{" "}
          {state.exportInfo.report.review?.required
            ? "requires a current all-content review"
            : "off"}
          . An offline page cannot detect later repository changes.
          {state.exportInfo.report.decisionNote && (
            <> Author decision: {state.exportInfo.report.decisionNote}</>
          )}
        </p>
      )}
      <p>
        Guide tells the story. Map shows relationships. Flow follows steps. Code opens the source.
        Present walks through a tour. Reference hints can include unresolved or indirect behavior.
      </p>
      <p>
        {state.serverMode
          ? "Explain this queues a request. The author runs /code-explainer feedback in Claude Code; applied changes appear here automatically."
          : "Explain this gives you a command to run in Claude Code. A saved HTML page stays at the version it was exported from."}
      </p>
    </details>
  );
}
