import type { SymbolIndex } from "@xpl/core";

export * from "./wasm.js";

/** Options of `buildIndex` (ARCHITECTURE.md §3). */
export interface BuildIndexOptions {
  /** Directory to index; paths in the index are relative to it. */
  root: string;
  /** Commit id override. Default: short HEAD when clean, else `wt-<hash>` (see §3). */
  commit?: string;
  /** SCIP usage: "auto" falls back to heuristic refs with a warning, "require" fails instead. */
  precise?: "auto" | "off" | "require";
  /** Restrict to these languages (`IndexedFile.language` values). Default: all. */
  languages?: string[];
}

export interface BuildIndexResult {
  index: SymbolIndex;
  warnings: string[];
}

/** Build the symbol index of `opts.root`. Not implemented yet. */
export async function buildIndex(_opts: BuildIndexOptions): Promise<BuildIndexResult> {
  throw new Error("buildIndex: not implemented");
}

/** Write `<root>/.explainer/index-<commit>.json` and return its path. Not implemented yet. */
export async function writeIndex(_root: string, _index: SymbolIndex): Promise<string> {
  throw new Error("writeIndex: not implemented");
}
