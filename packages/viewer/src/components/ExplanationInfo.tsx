import { checkReview, reviewShapeIssues, type PublishedVersion } from "@xpl/core";
import { snapshotTexts } from "../snapshot.js";
import { AnalysisDetails } from "./AnalysisCoverage.js";
import { useStore, useViewerState } from "../hooks.js";
import { asSentence } from "../readerWords.js";
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

/** What each reading tab holds, in one line, above "About this guide": a first-time reader needs it first. */
export const TABS_LINE =
  "Tour: the steps, in order. Map: the parts and what each calls. Flow: what runs, in order. Code: the files.";

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
  // A review status, in words a reader does not take for a failed check.
  const label =
    status === "reviewed"
      ? "Reviewed by a person"
      : status === "out-of-date"
        ? "Changed since a person reviewed it"
        : "Not yet reviewed by a person";
  return (
    <details className="guide-about" data-testid="explanation-info">
      <summary>
        About this guide <span data-testid="review-status">{label}</span>
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
            The version links work only next to the staged folder. This page holds the history from
            when it was staged; it does not ask a server for more.
          </p>
        </section>
      )}
      {review && (
        <>
          <p>
            {review.reviewer} (self-reported), reviewed {review.reviewedAt}. Text checked:{" "}
            {review.scope.content === "all" ? "all of the guide" : review.scope.content.join(", ")}.
            Code checked against:{" "}
            {review.scope.source === "repository"
              ? "the whole repository and the code links"
              : "the code links"}
            {review.scope.files?.length ? ` and ${review.scope.files.join(", ")}` : ""}.{" "}
            {review.omissions.length
              ? `Not checked: ${asSentence(review.omissions.join("; "))}`
              : "Nothing left out."}{" "}
            {status === "out-of-date" &&
              "The reviewed text or its code changed, or the code is not in this page."}
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
        Present shows the tour as slides. A dashed arrow is matched by name, so it can be wrong.
      </p>
      <p>
        {state.serverMode
          ? "\u201cExplain this\u201d saves a request. The author runs /code-explainer feedback in their agent, and the changes show here."
          : "\u201cAsk the author to explain this\u201d saves your question in this browser. Nothing is sent: export it from Feedback and give the file to the author. A saved HTML page stays at the version it was saved from."}
      </p>
      <AnalysisDetails />
    </details>
  );
}
