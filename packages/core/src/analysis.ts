import type { AnalysisCapability, ChangeRecord, SymbolIndex } from "./schema.js";

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

/** Known omissions for this change, based only on the head index's recorded coverage. */
export function changeOmissions(change: ChangeRecord, index: SymbolIndex): string[] {
  const limit = 5;
  const headPaths = new Set(change.files.filter((f) => f.status !== "deleted").map((f) => f.path));
  const indexed = new Set(index.files.map((f) => f.path));
  const omissions = change.files.flatMap((file) => {
    if (file.status === "deleted")
      return [
        `${file.path}: removed from the head; head-index analysis cannot inspect its old code.`,
      ];
    return indexed.has(file.path)
      ? []
      : [`${file.path}: absent from the head index; source analysis was not checked.`];
  });
  for (const report of index.analysis ?? []) {
    const changed = report.files.filter((path) => headPaths.has(path));
    if (changed.length === 0) continue;
    for (const result of report.results) {
      if (result.status === "supported") continue;
      const analyzed = changed.filter((path) => result.analyzedFiles.includes(path)).length;
      const names = result.capabilities.map((capability) => labels[capability]).join(", ");
      const scope = `${changed.length} changed ${changed.length === 1 ? "file" : "files"}`;
      const detail = result.limitations[0] ? ` ${result.limitations[0]}` : "";
      omissions.push(
        `${report.provider}: ${names} ${result.status} for ${scope} (${analyzed} analyzed).${detail}`,
      );
    }
  }
  return omissions.length > limit
    ? [
        ...omissions.slice(0, limit),
        `${omissions.length - limit} more recorded ${omissions.length - limit === 1 ? "limit" : "limits"}.`,
      ]
    : omissions;
}

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
      return `${languages || "files"} (${report.provider}): ${names} ${result.status} (${result.analyzedFiles.length}/${report.files.length} files analyzed).${result.limitations.length ? ` ${result.limitations.join(" ")}` : ""}`;
    });
  });
  return { summary, details };
}
