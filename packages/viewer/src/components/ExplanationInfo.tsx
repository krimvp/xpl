import { checkReview, reviewShapeIssues, type PublishedVersion } from "@xpl/core";
import { snapshotTexts } from "../snapshot.js";
import { AnalysisDetails } from "./AnalysisCoverage.js";
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
        About this guide <span data-testid="review-status">Author review: {label}</span>
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
        A review records that a person read this guide and its code. xpl does not check the name. A
        review of some parts covers only those parts and their code links.
      </p>
      <p>
        xpl checks that each code link points at code that exists. It does not check that the text
        is true, or that the guide covers every path through the code. Use the linked code and tests
        to check what matters to you.
      </p>
      {state.exportInfo && (
        <p>
          Saved as {state.exportInfo.status === "draft" ? "a draft" : "a finished page"}, checked
          against{" "}
          {state.exportInfo.report.scope === "workspace"
            ? "the code on disk when it was saved"
            : "the code saved inside this page"}
          . Team review rule:{" "}
          {state.exportInfo.report.review?.required
            ? "someone must review all of the current content"
            : "off"}
          . A saved page cannot see later changes to the code.
          {state.exportInfo.report.decisionNote && (
            <> Author decision: {state.exportInfo.report.decisionNote}</>
          )}
        </p>
      )}
      <p>
        Tour: the steps, in order. Map: the parts and what each calls. Flow: what runs, in order.
        Code: the files. Present: the tour as slides. A dashed arrow is matched by name, so it can
        be wrong.
      </p>
      <p>
        {state.serverMode
          ? "\u201cExplain this\u201d saves a request. The author runs /code-explainer feedback in Claude Code, and the changes show here."
          : "\u201cExplain this\u201d gives you a command to run in Claude Code. A saved HTML page stays at the version it was saved from."}
      </p>
      <AnalysisDetails />
    </details>
  );
}
