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
