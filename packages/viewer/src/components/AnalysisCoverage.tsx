import { useMemo } from "react";
import { describeAnalysis } from "@xpl/core";
import { useViewerState } from "../hooks.js";

export function AnalysisCoverage() {
  const index = useViewerState().model.index.index;
  const coverage = useMemo(() => describeAnalysis(index), [index]);
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
