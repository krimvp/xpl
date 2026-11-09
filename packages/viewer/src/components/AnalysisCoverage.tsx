import { useMemo } from "react";
import { describeAnalysis, type SymbolIndex } from "@xpl/core";
import { useViewerState } from "../hooks.js";

/**
 * A bar above the page, only when the analysis missed code a reader may rely on: a tool failed, or a
 * programming language was not analysed (in full). Data files (JSON, YAML, text) have no calls to find, and
 * names matched by name are what every dashed arrow already says: neither earns a bar on every page. The full
 * list is in "About this guide" (`AnalysisDetails`).
 */
export function AnalysisCoverage() {
  const index = useViewerState().model.index.index;
  const coverage = useMemo(() => describeAnalysis(index), [index]);
  if (!coverageGap(index)) return null;
  return (
    <details className="analysis-coverage" data-testid="analysis-coverage">
      <summary>{coverage.summary}</summary>
      <ul>
        {coverage.details.map((detail, i) => (
          <li key={i}>{detail}</li>
        ))}
      </ul>
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

/** True when a tool failed, or a programming language was left out of an analysis (or part of it). */
export function coverageGap(index: SymbolIndex): boolean {
  if (!index.analysis) return false;
  const languageOf = new Map(index.files.map((file) => [file.path, file.language]));
  return index.analysis.some((report) => {
    const code = report.files.some((path) => !DATA_LANGUAGES.has(languageOf.get(path) ?? "text"));
    return report.results.some(
      (result) =>
        result.status === "failed" ||
        (code &&
          (result.status === "unsupported" || result.analyzedFiles.length < report.files.length)),
    );
  });
}
