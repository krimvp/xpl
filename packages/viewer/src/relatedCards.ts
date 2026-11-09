import type { ElementId, ExplainerModel, FocusRange, RelatedFileSet } from "@xpl/core";

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

/**
 * A box that holds other code (a system, a service, a group, a folder) keeps only the cards about the box
 * itself: arrows drawn from or to it, and setting and test cards for files that its own code links (or its
 * step's) name. A file read, or a setting linked, somewhere
 * inside it is a fact about that code, not about the whole box; on the box it reads as a claim about the
 * system. A selection with any box of code (a file, a symbol, an arrow, a concept) keeps every card.
 */
export function ownCards(
  links: readonly RelatedFileSet[],
  ids: readonly ElementId[],
  model: ExplainerModel,
  ownFiles: ReadonlySet<string> = new Set(),
): RelatedFileSet[] {
  const holds = (id: ElementId) => {
    const node = model.node(id);
    return !!node && (node.kind === "group" || node.kind === "dir" || node.kind === "repo");
  };
  if (ids.length === 0 || !ids.every(holds)) return [...links];
  const selected = new Set(ids);
  return links.filter((link) => {
    if (link.id.startsWith("anchor:")) return link.files.every((file) => ownFiles.has(file));
    const edge = model.edge(link.id);
    return !!edge && (selected.has(edge.from) || selected.has(edge.to));
  });
}
