/** Offline selection preserves every contained snapshot and never transfers a live attachment. */
import type { GuideSnapshot, ViewerBundle } from "@xpl/core";

export function containedGuides(bundle: ViewerBundle): GuideSnapshot[] {
  const { explainer, index, files, baseFiles, feedback, exportInfo, sourceWarning } = bundle;
  return [
    {
      guideId: bundle.guideId ?? "current",
      explainer,
      index,
      files,
      baseFiles,
      feedback,
      exportInfo,
      sourceWarning,
    },
    ...(bundle.guides ?? []),
  ];
}

export function selectGuide(bundle: ViewerBundle, id: string | null): ViewerBundle {
  if (!id || id === (bundle.guideId ?? "current")) return bundle;
  const guides = containedGuides(bundle);
  const selected = guides.find((guide) => guide.guideId === id);
  if (!selected) throw new Error(`Guide "${id}" is not included in this export.`);
  return {
    schema: bundle.schema,
    ...selected,
    guides: guides.filter((guide) => guide.guideId !== id),
    readOnlyGuide: bundle.readOnlyGuide,
  };
}
