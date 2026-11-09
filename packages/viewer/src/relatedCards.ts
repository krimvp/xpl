import {
  relatedFiles,
  type ElementId,
  type ExplainerModel,
  type FocusRange,
  type RelatedFileSet,
} from "@xpl/core";

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

/** A box that holds other code: a system, a service, a group, a folder. */
export function holdsCode(id: ElementId, model: ExplainerModel): boolean {
  const node = model.node(id);
  return !!node && (node.kind === "group" || node.kind === "dir" || node.kind === "repo");
}

/**
 * The cards for what is selected, and for the step's own code (`focus`, the code shown). A box that holds
 * other code (a system, a service, a group, a folder) adds only the arrows drawn from or to it (R3-7): a file
 * read, a setting or a test linked somewhere inside it, or by its own code links, is a fact about that code,
 * not about the whole box, and on the box it reads as a claim about the system ("Its settings are in
 * build.ts"). The rest of the selection (a file, a symbol, an arrow, a concept) and the step's own code links
 * keep every card.
 */
export function readerCards(
  ids: readonly ElementId[],
  model: ExplainerModel,
  focus: readonly FocusRange[],
): RelatedFileSet[] {
  const boxes = new Set(ids.filter((id) => holdsCode(id, model)));
  const rest = ids.filter((id) => !boxes.has(id));
  const restFocus = focus.filter((range) => !boxes.has(range.elementId));
  const cards = rest.length > 0 || restFocus.length > 0 ? relatedFiles(rest, model, restFocus) : [];
  if (boxes.size === 0) return cards;
  const arrows = relatedFiles([...boxes], model).filter((link) => {
    const edge = model.edge(link.id);
    return (
      !!edge &&
      (boxes.has(edge.from) || boxes.has(edge.to)) &&
      !cards.some((card) => card.id === link.id)
    );
  });
  return [...cards, ...arrows];
}
