/**
 * The viewer bundle (`ViewerBundle`, ARCHITECTURE.md §5) shared by `xpl bundle` (inlined into the HTML)
 * and `xpl view` (injected into `GET /`, served at `GET /api/bundle`).
 */
import { lstatSync } from "node:fs";
import { join } from "node:path";
import {
  BUNDLE_SCHEMA,
  ExplainerModel,
  codeFocus,
  collectAnchors,
  deriveGraph,
  derivedEdgeMap,
  viewCandidates,
  type Explainer,
  type FocusOptions,
  type IndexModel,
  type TextCache,
  type ViewerBundle,
} from "@xpl/core";

/** `xpl bundle` embeds every indexed file when they total less than this, else only the referenced ones. */
export const ALL_FILES_LIMIT_BYTES = 20 * 1024 * 1024;

export type FilesChoice = "all" | "referenced";

/**
 * The files the viewer needs for this explainer: those of every anchor, and every file whose code
 * a view element, concept or tour step can focus (`codeFocus` of the view's candidates, so derived
 * edges' sites and definitions are included).
 */
export function referencedFiles(explainer: Explainer, index: IndexModel): string[] {
  const model = new ExplainerModel(explainer, index);
  const files = new Set<string>();
  for (const site of collectAnchors(explainer)) files.add(site.anchor.file);
  const focusOptions = new Map<string, FocusOptions>();
  for (const view of model.views) {
    let derived;
    let options: FocusOptions = {};
    if (view.type === "graph") {
      derived = deriveGraph(view, model);
      options = { derivedEdges: derivedEdgeMap(derived) };
      focusOptions.set(view.id, options);
    }
    for (const focus of codeFocus(viewCandidates(view, model, derived), model, options)) {
      files.add(focus.file);
    }
  }
  for (const tour of model.tours) {
    for (const step of Array.isArray(tour.steps) ? tour.steps : []) {
      const ids = Array.isArray(step.focus) ? step.focus : [];
      for (const focus of codeFocus(ids, model, focusOptions.get(step.view) ?? {})) {
        files.add(focus.file);
      }
    }
  }
  return [...files].filter((file) => index.hasFile(file)).sort();
}

export interface CollectedFiles {
  files: Record<string, string>;
  /** Which selection was used. */
  choice: FilesChoice;
  /** Total size of all indexed files on disk (bytes); only measured when the choice was automatic. */
  totalBytes?: number;
}

/** Sum of the on-disk sizes of the indexed files (missing files count as 0). */
export function indexedBytes(root: string, index: IndexModel): number {
  let total = 0;
  for (const file of index.files) {
    try {
      total += lstatSync(join(root, ...file.path.split("/"))).size;
    } catch {
      // deleted since indexing
    }
  }
  return total;
}

/**
 * Working-tree text of the files to embed. `choice` undefined = automatic: all indexed files when they
 * total under 20 MB, else the referenced ones.
 */
export function collectFiles(opts: {
  root: string;
  index: IndexModel;
  texts: TextCache;
  explainer: Explainer;
  choice?: FilesChoice;
}): CollectedFiles {
  const totalBytes = opts.choice === undefined ? indexedBytes(opts.root, opts.index) : undefined;
  const choice: FilesChoice =
    opts.choice ?? (totalBytes! < ALL_FILES_LIMIT_BYTES ? "all" : "referenced");
  const paths =
    choice === "all"
      ? opts.index.files.map((file) => file.path)
      : referencedFiles(opts.explainer, opts.index);
  const files: Record<string, string> = {};
  for (const path of paths) {
    const text = opts.texts.text(path);
    if (text !== undefined) files[path] = text;
  }
  return { files, choice, ...(totalBytes !== undefined ? { totalBytes } : {}) };
}

export function makeBundle(parts: {
  explainer: Explainer;
  index: ViewerBundle["index"];
  files: Record<string, string>;
  mode?: "explore" | "present";
  tour?: string;
  server?: { api: string };
}): ViewerBundle {
  return {
    schema: BUNDLE_SCHEMA,
    explainer: parts.explainer,
    index: parts.index,
    files: parts.files,
    ...(parts.mode !== undefined ? { mode: parts.mode } : {}),
    ...(parts.tour !== undefined ? { tour: parts.tour } : {}),
    ...(parts.server !== undefined ? { server: parts.server } : {}),
  };
}
