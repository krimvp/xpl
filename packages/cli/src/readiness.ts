import { checkReadiness, type ReadinessReport } from "@xpl/core";
import { freshAnchors } from "./bundle-data.js";
import type { RepoEnv } from "./context.js";
import { openWorkspace, type LoadedExplainer } from "./repo.js";

/** The shared CLI adapter always compares working-tree hashes, even with XPL_SKIP_STALE_CHECK. */
export async function workspaceReadiness(
  env: RepoEnv,
  loaded: LoadedExplainer,
  decisionNote?: string,
  requireReview = false,
) {
  const ws = await openWorkspace(env, {
    explainer: loaded,
    deferStaleWarning: true,
    requireFreshIndex: true,
  });
  const { explainer, drift } = freshAnchors(loaded.explainer, ws.model, ws.texts);
  const report = checkReadiness(explainer, ws.index, ws.texts, {
    scope: "workspace",
    requireReview,
    ...(ws.stale ? { sourceWarning: ws.stale.message } : {}),
    ...(decisionNote ? { decisionNote } : {}),
  });
  return { ws, explainer, drift, report };
}

const lowerFirst = (text: string) => text.charAt(0).toLowerCase() + text.slice(1);

export function describeReadiness(report: ReadinessReport): string {
  return [
    `${report.ready ? "ready" : "not ready"}: ${report.errors} errors, ${report.warnings} warnings. xpl checks the code links, not whether the text is true.`,
    ...(report.review
      ? [
          `Author review: ${report.review.status}; team policy ${report.review.required ? "requires all content" : "off"}. xpl does not check reviewer names.`,
        ]
      : []),
    ...report.findings.map(
      (f) =>
        `${f.severity} ${f.elementId === "(explainer)" ? "the guide" : f.elementId}, field ${f.field} (${f.code}): ${lowerFirst(f.message.replace(/\.$/, ""))}${f.hint ? `; fix: ${f.hint}` : ""}`,
    ),
    ...(report.decisionNote ? [`Author decision: ${report.decisionNote}`] : []),
  ].join("\n");
}
