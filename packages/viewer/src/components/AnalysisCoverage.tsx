import { useMemo } from "react";
import {
  collectAnchors,
  readerCoverage,
  parseId,
  type Explainer,
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
  const count = `${gap.files.length} ${gap.files.length === 1 ? "file" : "files"}`;
  return (
    <details className="analysis-coverage" data-testid="analysis-coverage">
      <summary>
        {gap.failed
          ? `Some arrows may be missing: the code analysis failed in ${count} this guide links to.`
          : `Some arrows may be missing: xpl could not analyze all the code in ${count} this guide links to.`}
      </summary>
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
 * `failed` when a tool failed on one of them.
 */
export function coverageGap(
  index: SymbolIndex,
  linked: ReadonlySet<FilePath>,
): { files: FilePath[]; failed: boolean } {
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
  return { files: [...files].sort(), failed };
}
