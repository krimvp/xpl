import { useMemo } from "react";
import {
  collectAnchors,
  describeAnalysis,
  parseId,
  type Explainer,
  type FilePath,
  type SymbolIndex,
} from "@xpl/core";
import { useViewerState } from "../hooks.js";

/**
 * A bar above the page, only when the analysis missed code that this guide links to: a tool failed on it,
 * or a programming language was not analysed (in full) there. Data files (JSON, YAML, text) have no calls
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
          : `Some arrows may be missing: xpl could not analyse all the code in ${count} this guide links to.`}
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

/** What the analysis covered, inside "About this guide". */
export function AnalysisDetails() {
  const index = useViewerState().model.index.index;
  const coverage = useMemo(() => describeAnalysis(index), [index]);
  return (
    <details data-testid="analysis-details">
      <summary>{coverage.summary}</summary>
      <ul>
        {coverage.details.map((detail, i) => (
          <li key={i}>{detail}</li>
        ))}
      </ul>
    </details>
  );
}

/** Languages with no calls or imports to find: their missing relationship analysis is no gap. */
const DATA_LANGUAGES = new Set(["json", "yaml", "toml", "text", "markdown", "xml", "ini", "csv"]);

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
  const files = new Set<FilePath>();
  let failed = false;
  for (const report of index.analysis ?? []) {
    const code = report.files.filter(
      (path) => linked.has(path) && !DATA_LANGUAGES.has(languageOf.get(path) ?? "text"),
    );
    // A report splits its files over several results per kind of relationship (one tool for most, another
    // for the rest): a file is left out of a kind only when no result that did not fail analysed it.
    const covered = new Map<string, Set<FilePath>>();
    for (const result of report.results)
      for (const capability of result.capabilities) {
        const set = covered.get(capability) ?? new Set<FilePath>();
        if (result.status !== "failed") for (const path of result.analyzedFiles) set.add(path);
        covered.set(capability, set);
      }
    for (const result of report.results)
      for (const capability of result.capabilities) {
        const missed = code.filter((path) => !covered.get(capability)!.has(path));
        if (missed.length > 0 && result.status === "failed") failed = true;
        for (const path of missed) files.add(path);
      }
  }
  return { files: [...files].sort(), failed };
}
