import type { FocusRange, RelatedFileSet } from "@xpl/core";

/**
 * A card made from the step's own setting or test anchor in a file whose code the step already shows (an
 * anchor of another role in that file): it would only name that file again, so the Related files panel
 * leaves it out.
 */
export function repeatsShownCode(link: RelatedFileSet, focus: readonly FocusRange[]): boolean {
  if (!link.id.startsWith("anchor:")) return false;
  const shown = new Set(
    focus.filter((range) => range.role !== "config" && range.role !== "test").map((r) => r.file),
  );
  return link.files.every((file) => shown.has(file));
}

/**
 * One card per (kind, label, files): two links that read the same file from two places in the code are one
 * card, with both places under "Where the code makes this link". Order is kept: the first card stays where it
 * was.
 */
export function mergeSameCards(links: readonly RelatedFileSet[]): RelatedFileSet[] {
  const byKey = new Map<string, RelatedFileSet>();
  for (const link of links) {
    const key = JSON.stringify([link.kind, link.label, [...link.files].sort()]);
    const first = byKey.get(key);
    if (!first) {
      byKey.set(key, { ...link, evidence: [...link.evidence] });
      continue;
    }
    for (const site of link.evidence)
      if (!first.evidence.some((seen) => seen.file === site.file && seen.line === site.line))
        first.evidence.push(site);
    first.summary ??= link.summary;
  }
  return [...byKey.values()];
}
