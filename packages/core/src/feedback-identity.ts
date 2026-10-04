// Temporary #25 identity shim; removed when integrating core/readiness.ts.
import type { Explainer, SymbolIndex } from "./schema.js";
import { hashText } from "./text.js";

export interface ArtifactIdentity {
  explainerHash: string;
  sourceHash: string;
}

/** Sorted object keys; array order remains meaningful. Missing and undefined fields are equivalent. */
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([, v]) => v !== undefined)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([k, v]) => [k, canonical(v)]),
    );
  }
  return value;
}

/**
 * Portable identity, independent of HTML, server URL, launch mode and embedding/pruning choices.
 * Explanation includes all stored text, provenance, anchors and index metadata. Source includes the full
 * indexed path/hash manifest and change base/head (base commits identify the before-source). Pruning retains
 * every file entry, so the source identity survives a pruned bundle. Re-resolved explanation fields change
 * explainerHash; reindexing unchanged source does not change sourceHash.
 */
export function artifactIdentity(explainer: Explainer, index: SymbolIndex): ArtifactIdentity {
  return {
    explainerHash: hashText(JSON.stringify(canonical(explainer))),
    sourceHash: hashText(
      JSON.stringify(
        canonical({
          files: index.files
            .map(({ path, hash }) => ({ path, hash }))
            .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0)),
          ...(explainer.change ? { base: explainer.change.base, head: explainer.change.head } : {}),
        }),
      ),
    ),
  };
}
