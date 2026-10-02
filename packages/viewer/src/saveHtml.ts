/**
 * "Save as HTML" (Edit menu): the page as it was loaded, with the explainer edited here put into its
 * `<script id="xpl-data">` instead of the one it came with. Everything else of the page (the viewer, the
 * index, the embedded files) is kept as it is, so the saved file opens like the original with the edits
 * in it: a presenter's edits survive a reload of the saved file.
 *
 * A copy of the document is taken when the viewer starts (`rememberPage`), before React renders into it:
 * what is saved is the page as loaded, not the rendered one. The data script is found as an element of
 * that copy, never by searching the page's text (the viewer's own code may contain the same words).
 */
import { BUNDLE_SCRIPT_ID, parseBundle, serializeBundle, type Explainer } from "@xpl/core";
import type { ViewerState } from "./store.js";

let page: { doctype: string; root: Element; name: string | undefined } | undefined;

/** Keeps a copy of the page as loaded, for `savedPage`. Call before rendering. */
export function rememberPage(doc: Document = document): void {
  if (!doc.getElementById(BUNDLE_SCRIPT_ID)) return;
  const file = decodeURIComponent(doc.location?.pathname.split("/").pop() ?? "");
  page = {
    doctype: doc.doctype ? `<!doctype ${doc.doctype.name}>\n` : "",
    root: doc.documentElement.cloneNode(true) as Element,
    name: /\.html?$/i.test(file) ? file : undefined,
  };
}

/** Source text the page loaded after it opened (under `xpl view`: files and base files fetched on demand). */
export interface LoadedTexts {
  files?: Readonly<Record<string, string>>;
  baseFiles?: Readonly<Record<string, string>>;
}

/**
 * The text of a data script with `explainer` in place of its explainer. The rest of the bundle (index,
 * files, base files, mode, tour) is kept, with the texts the page loaded since added to it; `server` is
 * dropped: a saved file has no server behind it. Undefined when the text is not a bundle.
 */
export function withExplainer(
  text: string,
  explainer: Explainer,
  loaded: LoadedTexts = {},
): string | undefined {
  try {
    const { server: _server, ...rest } = parseBundle(text);
    void _server;
    const files = { ...rest.files, ...loaded.files };
    const baseFiles = { ...rest.baseFiles, ...loaded.baseFiles };
    return serializeBundle({
      ...rest,
      explainer,
      files,
      ...(Object.keys(baseFiles).length > 0 ? { baseFiles } : {}),
    });
  } catch {
    return undefined;
  }
}

/**
 * Whether "Save as HTML" can work here: the page was loaded with its data in it (a bundle, or `xpl view`'s
 * page). Under `xpl view` the edits are saved by the server already; the HTML file is a copy to share.
 */
export function canSaveHtml(): boolean {
  return page !== undefined;
}

/**
 * The page to save: the page as loaded, with the explainer as edited and the source text loaded since (a page
 * from `xpl view` fetches files when they are opened: the saved copy keeps the ones that were).
 */
export function savedPage(
  state: Pick<ViewerState, "explainer"> & Partial<Pick<ViewerState, "files" | "baseFiles">>,
): string {
  if (!page) return "";
  const root = page.root.cloneNode(true) as Element;
  const script = root.querySelector(`#${BUNDLE_SCRIPT_ID}`);
  const text =
    script &&
    withExplainer(script.textContent ?? "", state.explainer, {
      ...(state.files ? { files: state.files } : {}),
      ...(state.baseFiles ? { baseFiles: state.baseFiles } : {}),
    });
  if (script && text !== undefined) script.textContent = text;
  return page.doctype + root.outerHTML;
}

/** The saved file's name: the page's own file name, else `<slug of the repo or title>.html`. */
export function htmlFileName(explainer: Explainer): string {
  if (page?.name) return page.name;
  const base = (explainer.repo?.name || explainer.title || "explainer")
    .split("/")
    .pop()!
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return `${base || "explainer"}.html`;
}
