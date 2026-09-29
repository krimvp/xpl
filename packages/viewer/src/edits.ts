/**
 * Pure view edits. The heavy lifting (`expandStub`, `drillIn`, `collapse`) is core's; this only stores
 * changed fields on a view the way `applyPatch` would for a `user` actor (ARCHITECTURE.md 4.7): the
 * changed field names are added to `provenance.userFields` of non-user views, so a regeneration by the
 * skill leaves them alone.
 */
import type { Explainer, View } from "@xpl/core";

export function withViewFields(
  explainer: Explainer,
  viewId: string,
  fields: Readonly<Record<string, unknown>>,
): Explainer {
  const names = Object.keys(fields);
  if (names.length === 0) return explainer;
  return {
    ...explainer,
    views: explainer.views.map((view) => {
      if (view.id !== viewId) return view;
      const next = { ...view, ...fields } as View;
      const provenance = view.provenance;
      if (provenance && provenance.origin !== "user") {
        next.provenance = {
          ...provenance,
          userFields: [...new Set([...(provenance.userFields ?? []), ...names])],
        };
      }
      return next;
    }),
  };
}

/** The pretty JSON the download button hands out. */
export function serializeExplainer(explainer: Explainer): string {
  return JSON.stringify(explainer, null, 2) + "\n";
}

/** A file name for the downloaded explainer: `<slug of the repo or title>.explainer.json`. */
export function explainerFileName(explainer: Explainer): string {
  const base = (explainer.repo?.name || explainer.title || "explainer")
    .split("/")
    .pop()!
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return `${base || "explainer"}.explainer.json`;
}
