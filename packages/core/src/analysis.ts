import type { AnalysisCapability, SymbolIndex } from "./schema.js";

export const RELATIONSHIP_CAPABILITIES = [
  "call",
  "import",
  "extends",
  "implements",
  "type-ref",
  "read",
  "write",
] as const;
export const STRUCTURE_CAPABILITIES = ["symbols", "declarationRanges", "nesting"] as const;
const labels: Record<AnalysisCapability, string> = {
  fileAnchors: "file anchors",
  symbols: "named symbols",
  declarationRanges: "full declaration ranges",
  nesting: "nesting",
  call: "calls",
  import: "imports",
  extends: "inheritance",
  implements: "implementations",
  "type-ref": "type references",
  read: "reads",
  write: "writes",
};

/** Describes the original analysis run, even when a bundle has pruned symbols and references. */
export function describeAnalysis(index: SymbolIndex): { summary: string; details: string[] } {
  if (!index.analysis)
    return {
      summary: "Analysis coverage unknown (legacy index).",
      details: [
        "File anchors are available for indexed files. Symbol and relationship coverage was not recorded; an empty result does not establish complete analysis.",
      ],
    };
  const issues = index.analysis.flatMap((report) =>
    report.results.filter((r) => r.status !== "supported"),
  );
  const failed = issues.filter((r) => r.status === "failed").length;
  const summary = `Analysis coverage: ${index.files.length} files; ${failed > 0 ? "some analysis failed; " : ""}${issues.length > 0 ? "some analysis is limited or unavailable." : "reported analysis succeeded."}`;
  const languageOf = new Map(index.files.map((f) => [f.path, f.language]));
  const details = index.analysis.flatMap((report) => {
    const languages = [...new Set(report.files.map((f) => languageOf.get(f)).filter(Boolean))]
      .sort()
      .join("/");
    return report.results.map((result) => {
      const names = result.capabilities.map((c) => labels[c]).join(", ");
      return `${languages || "files"}: ${names} ${result.status} (${result.analyzedFiles.length}/${report.files.length} files analyzed).${result.limitations.length ? ` ${result.limitations.join(" ")}` : ""}`;
    });
  });
  return { summary, details };
}
