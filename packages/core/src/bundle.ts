/**
 * The data the viewer reads (ARCHITECTURE.md §5). `xpl bundle` inlines it into the viewer HTML for a
 * self-contained file; `xpl view` injects it too, with `server` set and `files` possibly partial (the
 * viewer then fetches missing files from `${server.api}/file?path=`).
 */
import { isPackedIndex, packIndex, unpackIndex } from "./index-pack.js";
import type { Explainer, FilePath, SymbolIndex } from "./schema.js";

export const BUNDLE_SCHEMA = "code-explainer/bundle@0";

/** `<script id="xpl-data" type="application/json">` holds the serialized bundle. */
export const BUNDLE_SCRIPT_ID = "xpl-data";

export interface ViewerBundle {
  schema: typeof BUNDLE_SCHEMA;
  explainer: Explainer;
  index: SymbolIndex;
  /** Source text by repo-relative path. May be partial in server mode. */
  files: Record<FilePath, string>;
  /**
   * The code before the change, when the explainer has a change record (`explainer.change`): the base text of
   * every changed file that is modified, renamed or deleted, keyed by `ChangedFile.path` (the new path of a
   * renamed file). Added files have none. Absent without a change record. Under `xpl view` it may be partial
   * (absent); the viewer fetches the base text from `${server.api}/base-file?path=`.
   */
  baseFiles?: Record<FilePath, string>;
  /** Initial mode; URL params (`?mode=`, `?tour=`, `?step=`) override it. */
  mode?: "explore" | "present";
  /** Initial tour id for present mode. */
  tour?: string;
  /** Set by `xpl view`: base URL of the local API (e.g. "/api"). Absent in a static bundle. */
  server?: { api: string };
  /** Live workspace warning when source and index differ. Never implies prose was verified. */
  sourceWarning?: string;
}

export interface SerializeOptions {
  /**
   * Write the index packed (`packIndex`): about a fifth of the size, for a page that is a file of its own (`xpl
   * bundle`, Save as HTML). `parseBundle` unpacks it.
   */
  packIndex?: boolean;
}

/** JSON that is safe inside a `<script>` element (`<` escaped, plus the JS line separators). */
export function serializeBundle(bundle: ViewerBundle, options: SerializeOptions = {}): string {
  const LS = String.fromCharCode(0x2028);
  const PS = String.fromCharCode(0x2029);
  const data =
    options.packIndex && !isPackedIndex(bundle.index)
      ? { ...bundle, index: packIndex(bundle.index) }
      : bundle;
  return JSON.stringify(data)
    .replace(/</g, "\\u003c")
    .split(LS)
    .join("\\u2028")
    .split(PS)
    .join("\\u2029");
}

/** Inserts the bundle script right before `</head>` (or `</body>`, or at the end). Replaces an existing one. */
export function injectBundle(
  html: string,
  bundle: ViewerBundle,
  options: SerializeOptions = {},
): string {
  const script = `<script id="${BUNDLE_SCRIPT_ID}" type="application/json">${serializeBundle(bundle, options)}</script>`;
  const existing = new RegExp(`<script id="${BUNDLE_SCRIPT_ID}"[^>]*>[\\s\\S]*?</script>`);
  if (existing.test(html)) return html.replace(existing, () => script);
  for (const tag of ["</head>", "</body>"]) {
    const at = html.lastIndexOf(tag);
    if (at !== -1) return html.slice(0, at) + script + html.slice(at);
  }
  return html + script;
}

/** Parses the text content of the bundle script, a packed index unpacked. Throws on a wrong schema. */
export function parseBundle(text: string): ViewerBundle {
  const bundle = JSON.parse(text) as ViewerBundle;
  if (bundle?.schema !== BUNDLE_SCHEMA) {
    throw new Error(`not a ${BUNDLE_SCHEMA} payload (schema: ${String(bundle?.schema)})`);
  }
  if (isPackedIndex(bundle.index)) bundle.index = unpackIndex(bundle.index);
  return bundle;
}
