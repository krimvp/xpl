import { useMemo } from "react";
import {
  CODE_LANGUAGE_NAMES,
  collectAnchors,
  readerCoverage,
  parseId,
  type Explainer,
  type FileLanguage,
  type FilePath,
  type SymbolIndex,
} from "@xpl/core";
import { useViewerState } from "../hooks.js";

/**
 * A bar above the page, only when the analysis missed code that this guide links to: a tool failed on it,
 * or a programming language was not analyzed (in full) there. A kind of relationship the language cannot
 * have (Python has no `implements`) is no gap. Data files (JSON, YAML, text) have no calls
 * to find, files the guide does not point at put none of its arrows at risk, and names matched by name are
 * what every dashed arrow already says: none of these earns a bar on every page. One plain line; the full
 * report is in "About this guide" (`AnalysisDetails`).
 */
export function AnalysisCoverage() {
  const state = useViewerState();
  const index = state.model.index.index;
  const linked = useMemo(() => linkedFiles(state.explainer), [state.explainer]);
  const gap = useMemo(() => coverageGap(index, linked), [index, linked]);
  if (gap.files.length === 0) return null;
  return (
    <details className="analysis-coverage" data-testid="analysis-coverage">
      <summary>{coverageSummary(gap)}</summary>
      <ul>
        {gap.files.slice(0, 8).map((file) => (
          <li key={file}>
            <code>{file}</code>
          </li>
        ))}
        {gap.files.length > 8 && <li>and {gap.files.length - 8} more</li>}
      </ul>
      <p>The full report is under About this guide.</p>
    </details>
  );
}

/** The bar's one line: what the gap means for the arrows the reader sees. */
export function coverageSummary(gap: ReturnType<typeof coverageGap>): string {
  const count = `${gap.files.length} ${gap.files.length === 1 ? "file" : "files"}`;
  if (gap.failed)
    return `Some arrows may be missing: the code analysis failed in ${count} this guide links to.`;
  // a language xpl reads no calls of: no arrow there is xpl's, so none can be missing from what it found
  if (gap.noCalls)
    return `xpl finds no calls in ${gap.noCalls.join(" or ")} code: every arrow between the ${count} this guide links to was drawn by the author.`;
  return `Some arrows may be missing: xpl could not analyze all the code in ${count} this guide links to.`;
}

/**
 * What xpl could read, inside "About this guide": one plain line per language. The analyzer's own report
 * is for authors (`xpl index --verbose`).
 */
export function AnalysisDetails() {
  const index = useViewerState().model.index.index;
  const coverage = useMemo(() => readerCoverage(index), [index]);
  return (
    <details data-testid="analysis-details">
      <summary>{coverage.summary}</summary>
      <ul>
        {coverage.lines.map((line, i) => (
          <li key={i}>{line}</li>
        ))}
      </ul>
    </details>
  );
}

/** Languages with no calls or imports to find: their missing relationship analysis is no gap. */
const DATA_LANGUAGES = new Set(["json", "yaml", "toml", "text", "markdown", "xml", "ini", "csv"]);

/** Kinds of relationship a language does not have: the analysis leaving them out misses nothing. */
const NOT_IN_LANGUAGE: Record<string, ReadonlySet<string>> = {
  python: new Set(["implements"]),
  javascript: new Set(["implements"]),
  ruby: new Set(["implements"]),
};

/** The files this guide points at: its code links, and the files and symbols its diagrams draw. */
export function linkedFiles(explainer: Explainer): Set<FilePath> {
  const files = new Set(collectAnchors(explainer).map((site) => site.anchor.file));
  for (const view of explainer.views) {
    const ids = (view.type === "graph" ? view.include : view.participants) ?? [];
    for (const id of ids) {
      const parsed = parseId(id);
      if (parsed.type === "file") files.add(parsed.path);
      else if (parsed.type === "symbol") files.add(parsed.file);
    }
  }
  return files;
}

/**
 * The code files among `linked` that the analysis left out, or failed on, for some kind of relationship;
 * `failed` when a tool failed on one of them. `noCalls`: the languages of those files, when xpl read calls
 * in no file of any of them (Ruby, PHP): every arrow between such files is the author's.
 */
export function coverageGap(
  index: SymbolIndex,
  linked: ReadonlySet<FilePath>,
): { files: FilePath[]; failed: boolean; noCalls?: string[] } {
  const languageOf = new Map(index.files.map((file) => [file.path, file.language]));
  const reports = index.analysis ?? [];
  // The reports split their files over several results per kind of relationship (the tree-sitter pack for
  // most, a SCIP tool for the rest): a file is left out of a kind when no result of any report that did not
  // fail analyzed it, or when a tool failed on it.
  const covered = new Map<string, Set<FilePath>>();
  for (const report of reports)
    for (const result of report.results)
      for (const capability of result.capabilities) {
        const set = covered.get(capability) ?? new Set<FilePath>();
        if (result.status !== "failed") for (const path of result.analyzedFiles) set.add(path);
        covered.set(capability, set);
      }
  const files = new Set<FilePath>();
  let failed = false;
  for (const report of reports) {
    const code = report.files.filter(
      (path) => linked.has(path) && !DATA_LANGUAGES.has(languageOf.get(path) ?? "text"),
    );
    for (const result of report.results)
      for (const capability of result.capabilities) {
        // (a tool that failed is always reported, even where another one gave hints: those are no match for
        // what it would have found)
        const missed = code.filter(
          (path) =>
            (result.status === "failed" && !result.analyzedFiles.includes(path)) ||
            (!covered.get(capability)!.has(path) &&
              !NOT_IN_LANGUAGE[languageOf.get(path) ?? ""]?.has(capability)),
        );
        if (missed.length > 0 && result.status === "failed") failed = true;
        for (const path of missed) files.add(path);
      }
  }
  const languages = new Set([...files].map((path) => languageOf.get(path) ?? "text"));
  const calls = covered.get("call");
  const readsCalls = (language: string) =>
    index.files.some((file) => file.language === language && calls?.has(file.path));
  const noCalls =
    !failed && files.size > 0 && ![...languages].some(readsCalls)
      ? [
          ...new Set(
            [...languages].map(
              (language) => CODE_LANGUAGE_NAMES[language as FileLanguage] ?? language,
            ),
          ),
        ]
      : undefined;
  return { files: [...files].sort(), failed, ...(noCalls ? { noCalls } : {}) };
}
