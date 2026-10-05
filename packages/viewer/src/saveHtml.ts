/**
 * "Save as HTML" (Edit menu): the page as it was loaded, with the explainer edited here put into its
 * `<script id="xpl-data">` instead of the one it came with. Everything else of the page (the viewer, the
 * assets) is preserved. Live saves request a current complete snapshot; offline saves check the embedded
 * snapshot. Both run shared readiness before ready serialization and record the checked scope.
 *
 * A copy of the document is taken when the viewer starts (`rememberPage`), before React renders into it:
 * what is saved is the page as loaded, not the rendered one. The data script is found as an element of
 * that copy, never by searching the page's text (the viewer's own code may contain the same words).
 */
import {
  BUNDLE_SCRIPT_ID,
  checkReadiness,
  reviewSourceFiles,
  type ReviewScope,
  type ReadinessReport,
  type ReadinessOptions,
  type ViewerBundle,
  type Explainer,
  parseBundle,
  serializeBundle,
} from "@xpl/core";
import { snapshotTexts } from "./snapshot.js";
import type { ViewerStore } from "./store.js";
import { ServerApi } from "./data.js";

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

/**
 * Whether "Save as HTML" can work here: the page was loaded with its data in it (a bundle, or `xpl view`'s
 * page). Under `xpl view` the edits are saved by the server already; the HTML file is a copy to share.
 */
export function canSaveHtml(): boolean {
  return page !== undefined;
}

/** Check a complete snapshot, including base text for renamed changed files. */
export function snapshotReadiness(
  bundle: ViewerBundle,
  options: ReadinessOptions,
): ReadinessReport {
  const texts = snapshotTexts(bundle);
  return checkReadiness(bundle.explainer, bundle.index, texts, {
    ...options,
    ...(bundle.sourceWarning ? { sourceWarning: bundle.sourceWarning } : {}),
  });
}

/** A live save refreshes referenced and previously loaded source after persisting pending edits. */
export async function prepareHtmlSave(
  store: ViewerStore,
  reviewScope?: ReviewScope,
): Promise<ViewerBundle> {
  if (store.getState().editBusy || store.getState().editDraft)
    throw new Error("Save or cancel the text edit before exporting HTML.");
  const script = page?.root.querySelector(`#${BUNDLE_SCRIPT_ID}`);
  if (!script) throw new Error("This page has no embedded snapshot to save.");
  const original = parseBundle(script.textContent ?? "");
  // Reread browser records and live disk outcomes without changing any request's original context.
  await store.refreshFeedback();
  if (store.getState().serverMode) {
    await store.flush();
    const state = store.getState();
    if (state.dirty || state.save.status === "error")
      throw new Error("Save the pending edits before exporting HTML.");
    if (!original.server) throw new Error("The live workspace API is unavailable.");
    const api = new ServerApi(original.server.api, original.server.attachment);
    const bundle = await api.exportBundle();
    const indexed = new Set(bundle.index.files.map(({ path }) => path));
    // Keep loaded paths, never their old text: /export already refreshes the referenced source.
    await Promise.all(
      [
        ...new Set([
          ...Object.keys(state.files),
          ...(reviewScope ? reviewSourceFiles(reviewScope, bundle.index) : []),
        ]),
      ]
        .filter((path) => indexed.has(path) && !(path in bundle.files))
        .map(async (path) => {
          bundle.files[path] = await api.file(path);
        }),
    );
    return {
      ...bundle,
      feedback: store.feedbackFile(bundle.feedback),
    };
  }
  const state = store.getState();
  return {
    ...original,
    explainer: state.explainer,
    files: state.files,
    baseFiles: state.baseFiles,
    index: state.model.index.index,
    sourceWarning: state.sourceWarning,
    feedback: store.feedbackFile(original.feedback),
  };
}

/** Ready output is gated here too; callers cannot silently download an unfinished ready page. */
export function savedPage(
  bundle: ViewerBundle,
  options: ReadinessOptions & { draft?: boolean },
): string {
  if (!page) throw new Error("This page has no embedded snapshot to save.");
  const report = snapshotReadiness(bundle, options);
  if (!report.ready && !options.draft)
    throw new Error("Not ready: repair the findings or save an explicit draft preview.");
  const { server: _server, ...offline } = bundle;
  void _server;
  const root = page.root.cloneNode(true) as Element;
  const script = root.querySelector(`#${BUNDLE_SCRIPT_ID}`);
  if (!script) throw new Error("This page has no embedded snapshot to save.");
  script.textContent = serializeBundle(
    { ...offline, exportInfo: { status: options.draft ? "draft" : "ready", report } },
    { packIndex: true },
  );
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
