/** Readable head/base evidence shared by inspection, user patches and offline readiness. */
import { TextCache, basePathOf, type ViewerBundle } from "@xpl/core";

export function snapshotTexts(
  bundle: Pick<ViewerBundle, "explainer" | "files" | "baseFiles">,
): TextCache {
  return new TextCache(
    (path) => bundle.files[path],
    (commit, path) => {
      if (commit !== bundle.explainer.change?.base) return undefined;
      const file = bundle.explainer.change.files.find((f) => basePathOf(f) === path);
      return file ? bundle.baseFiles?.[file.path] : undefined;
    },
  );
}
