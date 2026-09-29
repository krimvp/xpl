/**
 * Shared bookkeeping of the config-format packs (YAML, JSON, TOML): every mapping key becomes a symbol of kind
 * `key` whose path is the dotted key path (sequence items are addressed by index, `workers.0.name`).
 */
import type { Span, SymbolDraft } from "./types.js";

/** Keys nested deeper than this are not symbols (ARCHITECTURE.md §3). */
export const MAX_KEY_DEPTH = 6;
/** Safety cap per file: data-like documents (translations, fixtures) would otherwise flood the index. */
export const MAX_KEYS_PER_FILE = 2000;
/** Hard bound on nesting we descend into (keys and sequence indices together). */
export const MAX_NESTING = 64;

export class KeyCollector {
  readonly drafts: SymbolDraft[] = [];
  /** Number of keys that were dropped because of `MAX_KEYS_PER_FILE`. */
  skipped = 0;

  /** Record a key symbol; false when the per-file cap is reached (the key is dropped). */
  add(path: string, span: Span, parentPath: string | undefined): boolean {
    if (this.drafts.length >= MAX_KEYS_PER_FILE) {
      this.skipped++;
      return false;
    }
    const draft: SymbolDraft = { path, kind: "key", range: span };
    if (parentPath !== undefined) draft.parentPath = parentPath;
    this.drafts.push(draft);
    return true;
  }

  warnings(): string[] {
    return this.skipped > 0
      ? [`${this.skipped} keys beyond the first ${MAX_KEYS_PER_FILE} were not indexed`]
      : [];
  }
}
