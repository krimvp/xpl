/** Read-only catalog and opt-in export snapshots. Evidence loading never depends on catalog eligibility. */
import {
  EXPLAINER_SCHEMA,
  guideCatalog,
  type GuideDescriptor,
  type GuideSnapshot,
} from "@xpl/core";
import type { RepoEnv } from "./context.js";
import { loadRepositoryGuides, type LoadedExplainer } from "./repo.js";
import { workspaceReadiness, describeReadiness } from "./readiness.js";
import {
  collectFiles,
  collectBaseFiles,
  embedIndex,
  defaultIndexChoice,
  type FilesChoice,
  type IndexChoice,
} from "./bundle-data.js";
import { CliError } from "./errors.js";

export const LIBRARY_MAX_GUIDES = 8;
export const LIBRARY_MAX_BYTES = 20 * 1024 * 1024;

export function localGuideCatalog(env: RepoEnv) {
  const guides: (
    (GuideDescriptor & { path: string }) | { id: string; path: string; metadataError: string }
  )[] = [];
  const errors: { id: string; error: string }[] = [];
  for (const entry of loadRepositoryGuides(env)) {
    if ("error" in entry) {
      errors.push({ id: entry.name, error: entry.error });
      continue;
    }
    const { name, loaded } = entry;
    const e = loaded.explainer;
    if (
      e.schema !== EXPLAINER_SCHEMA ||
      typeof e.title !== "string" ||
      typeof e.repo?.commit !== "string" ||
      typeof e.index?.commit !== "string" ||
      (e.scope?.audience !== undefined && typeof e.scope.audience !== "string") ||
      !Array.isArray(e.views) ||
      e.views.some(
        (v) =>
          !v ||
          typeof v.scope?.root !== "string" ||
          (v.scope.question !== undefined && typeof v.scope.question !== "string"),
      ) ||
      (e.change !== undefined &&
        (typeof e.change?.base !== "string" || typeof e.change?.head !== "string"))
    ) {
      guides.push({ id: name, path: loaded.rel, metadataError: "invalid guide metadata" });
      errors.push({ id: name, error: "invalid guide metadata" });
    } else guides.push({ ...guideCatalog([{ id: name, explainer: e }])[0]!, path: loaded.rel });
  }
  return { guides, errors };
}

/** A separate bounded source snapshot, checked through the existing export readiness seam. */
export async function guideSnapshot(
  env: RepoEnv,
  loaded: LoadedExplainer,
  options: {
    draft: boolean;
    choice?: FilesChoice;
    indexChoice?: IndexChoice;
    boundaryMax?: number;
    note?: string;
    requireReview?: boolean;
  },
): Promise<GuideSnapshot> {
  const { ws, explainer, report } = await workspaceReadiness(
    env,
    loaded,
    options.note,
    options.requireReview ?? false,
  );
  if ((!report.ready || ws.stale) && !options.draft)
    throw new CliError(
      `${loaded.rel}: ${describeReadiness(report)}. Repair this guide or use --draft.`,
      1,
      { readiness: report },
    );
  const collected = collectFiles({
    root: env.root,
    index: ws.model,
    texts: ws.texts,
    explainer,
    choice: options.choice,
    boundaryMax: options.boundaryMax,
  });
  const index = embedIndex({
    index: ws.index,
    model: ws.model,
    explainer,
    files: collected.paths,
    choice: options.indexChoice ?? defaultIndexChoice(collected.choice),
  }).index;
  const base = collectBaseFiles(explainer, ws.texts);
  return {
    guideId: loaded.name,
    explainer,
    index,
    files: collected.files,
    ...(base ? { baseFiles: base.files } : {}),
    ...(ws.stale ? { sourceWarning: ws.stale.message } : {}),
    exportInfo: { status: options.draft ? "draft" : "ready", report },
  };
}
