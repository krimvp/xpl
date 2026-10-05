/** Resolve every repository guide against one index. Locations and reports are copies; prose is never saved. */
import {
  collectAnchors,
  reresolveExplainer,
  validateExplainer,
  type IndexModel,
  type TextCache,
} from "@xpl/core";
import { errorMessage } from "./errors.js";
import type { RepoEnv } from "./context.js";
import { loadRepositoryGuides } from "./repo.js";

export function guideInventory(env: RepoEnv, index: IndexModel, texts: TextCache) {
  return loadRepositoryGuides(env).map((entry) => {
    const { name } = entry;
    if ("error" in entry) return { name, attention: true, error: entry.error };
    try {
      const { loaded } = entry;
      const { explainer, report } = reresolveExplainer(loaded.explainer, index, texts);
      const issues = validateExplainer(explainer, index, texts, { mode: "lenient" });
      const broken = issues.filter((i) => i.code === "unknown-id");
      const errors = issues.filter((i) => i.severity === "error");
      return {
        name,
        path: loaded.rel,
        title: explainer.title,
        attention: report.counts.drifted + report.counts.missing + errors.length > 0,
        anchors: {
          total: report.total,
          counts: report.counts,
          affected: collectAnchors(explainer)
            .filter((s) => s.anchor.resolved?.status !== "ok")
            .map((s) => ({
              elementId: s.elementId,
              path: s.path,
              origin: s.origin ?? null,
              file: s.anchor.file,
              resolved: s.anchor.resolved,
            })),
        },
        drifted: report.drifted,
        driftedOther: report.driftedOther,
        missing: report.missing,
        broken,
        errors,
      };
    } catch (error) {
      return { name, attention: true, error: errorMessage(error) };
    }
  });
}
