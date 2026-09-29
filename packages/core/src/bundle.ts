/**
 * The data the viewer reads (ARCHITECTURE.md §5). `xpl bundle` inlines it into the viewer HTML for a
 * self-contained file; `xpl view` injects it too, with `server` set and `files` possibly partial (the
 * viewer then fetches missing files from `${server.api}/file?path=`).
 */
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
  /** Initial mode; URL params (`?mode=`, `?tour=`, `?step=`) override it. */
  mode?: "explore" | "present";
  /** Initial tour id for present mode. */
  tour?: string;
  /** Set by `xpl view`: base URL of the local API (e.g. "/api"). Absent in a static bundle. */
  server?: { api: string };
}

/** JSON that is safe inside a `<script>` element (`<` escaped, plus the JS line separators). */
export function serializeBundle(bundle: ViewerBundle): string {
  const LS = String.fromCharCode(0x2028);
  const PS = String.fromCharCode(0x2029);
  return JSON.stringify(bundle)
    .replace(/</g, "\\u003c")
    .split(LS)
    .join("\\u2028")
    .split(PS)
    .join("\\u2029");
}

/** Inserts the bundle script right before `</head>` (or `</body>`, or at the end). Replaces an existing one. */
export function injectBundle(html: string, bundle: ViewerBundle): string {
  const script = `<script id="${BUNDLE_SCRIPT_ID}" type="application/json">${serializeBundle(bundle)}</script>`;
  const existing = new RegExp(`<script id="${BUNDLE_SCRIPT_ID}"[^>]*>[\\s\\S]*?</script>`);
  if (existing.test(html)) return html.replace(existing, () => script);
  for (const tag of ["</head>", "</body>"]) {
    const at = html.lastIndexOf(tag);
    if (at !== -1) return html.slice(0, at) + script + html.slice(at);
  }
  return html + script;
}

/** Parses the text content of the bundle script. Throws on a wrong schema. */
export function parseBundle(text: string): ViewerBundle {
  const bundle = JSON.parse(text) as ViewerBundle;
  if (bundle?.schema !== BUNDLE_SCHEMA) {
    throw new Error(`not a ${BUNDLE_SCHEMA} payload (schema: ${String(bundle?.schema)})`);
  }
  return bundle;
}
