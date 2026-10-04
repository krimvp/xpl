import {
  RELATIONSHIP_CAPABILITIES,
  STRUCTURE_CAPABILITIES,
  type AnalysisCapabilities,
  type AnalysisCapability,
  type AnalysisReport,
  type AnalysisResult,
  type IndexedFile,
} from "@xpl/core";
import type { LanguagePack } from "./languages/types.js";
import type { PreciseOutput, PreciseResolver } from "./precise.js";

export const STRUCTURE_SUPPORT = {
  symbols: "supported",
  declarationRanges: "supported",
  nesting: "supported",
} as const;
export const HEURISTIC_SUPPORT: AnalysisCapabilities = Object.fromEntries(
  RELATIONSHIP_CAPABILITIES.map((kind) => [kind, "partial"]),
);
export const PRECISE_SUPPORT: AnalysisCapabilities = Object.fromEntries(
  RELATIONSHIP_CAPABILITIES.map((kind) => [kind, "supported"]),
);
export interface ExtractionOutcome {
  status: "supported" | "partial" | "failed";
  limitations: string[];
  diagnostics?: string[];
}

export function extractionReports(
  files: readonly IndexedFile[],
  packs: readonly { pack: LanguagePack; language: string }[],
  outcomes: ReadonlyMap<string, ExtractionOutcome>,
): AnalysisReport[] {
  const paths = files.map((f) => f.path);
  const reports: AnalysisReport[] = [
    {
      provider: "files",
      capabilities: { fileAnchors: "supported" },
      files: paths,
      results: [
        {
          capabilities: ["fileAnchors"],
          status: "supported",
          analyzedFiles: paths,
          limitations: [],
        },
      ],
    },
  ];
  for (const { pack, language } of packs) {
    const scoped = files.filter((f) => f.language === language).map((f) => f.path);
    const results: AnalysisResult[] = [];
    // Group identical outcomes, preserving separate capabilities without duplicating their file lists.
    for (const capability of [...STRUCTURE_CAPABILITIES, ...RELATIONSHIP_CAPABILITIES]) {
      const ability = pack.capabilities[capability];
      if (!ability) {
        addResult(
          results,
          capability,
          "unsupported",
          [],
          ["Relationship analysis is unavailable."],
        );
        continue;
      }
      for (const status of ["supported", "partial", "failed"] as const) {
        const matching = scoped.filter((file) => outcomes.get(file)?.status === status);
        if (matching.length === 0) continue;
        const relationship = (RELATIONSHIP_CAPABILITIES as readonly string[]).includes(capability);
        const limitations = [
          ...new Set(matching.flatMap((file) => outcomes.get(file)!.limitations)),
        ];
        if (relationship)
          limitations.push("Heuristic relationships are hints; unresolved targets may be missing.");
        if (capability === "declarationRanges" && ability === "partial")
          limitations.push("Some declaration ranges omit leading syntax.");
        const observed =
          status === "failed"
            ? "failed"
            : status === "partial" || ability === "partial"
              ? "partial"
              : "supported";
        addResult(results, capability, observed, status === "failed" ? [] : matching, limitations);
      }
    }
    const diagnostics = scoped.flatMap((file) => outcomes.get(file)?.diagnostics ?? []);
    reports.push({
      provider: pack.id,
      capabilities: pack.capabilities,
      files: scoped,
      results,
      ...(diagnostics.length ? { diagnostics } : {}),
    });
  }
  const text = files
    .filter((f) => !packs.some((p) => p.language === f.language))
    .map((f) => f.path);
  if (text.length)
    reports.push({
      provider: "text",
      capabilities: {},
      files: text,
      results: [
        {
          capabilities: [...STRUCTURE_CAPABILITIES, ...RELATIONSHIP_CAPABILITIES],
          status: "unsupported",
          analyzedFiles: [],
          limitations: [
            "Only file anchors are available; named symbols and relationships are unavailable.",
          ],
        },
      ],
    });
  return reports;
}

function addResult(
  results: AnalysisResult[],
  capability: AnalysisCapability,
  status: AnalysisResult["status"],
  analyzedFiles: string[],
  limitations: string[],
): void {
  const same = results.find(
    (r) =>
      r.status === status &&
      JSON.stringify(r.analyzedFiles) === JSON.stringify(analyzedFiles) &&
      JSON.stringify(r.limitations) === JSON.stringify(limitations),
  );
  if (same) same.capabilities.push(capability);
  else results.push({ capabilities: [capability], status, analyzedFiles, limitations });
}

export function preciseReport(
  resolver: PreciseResolver,
  files: string[],
  output?: PreciseOutput,
  diagnostics: string[] = [],
): AnalysisReport {
  const capabilities = resolver.capabilities ?? HEURISTIC_SUPPORT;
  const results: AnalysisResult[] = [];
  const described = new Set(output?.describedFiles ?? []);
  for (const ref of output?.refs ?? []) described.add(ref.from.slice(0, ref.from.indexOf("#")));
  for (const kind of RELATIONSHIP_CAPABILITIES) {
    if (!capabilities[kind]) {
      addResult(
        results,
        kind,
        "unsupported",
        [],
        ["This relationship kind is unavailable in precise analysis; heuristic hints may remain."],
      );
    } else if (!output) {
      addResult(
        results,
        kind,
        "failed",
        [],
        ["Precise relationship analysis failed; heuristic hints remain."],
      );
    } else {
      const observation = output.coverage?.[kind];
      const analyzedFiles = files.filter((f) =>
        observation ? observation.analyzedFiles.includes(f) : described.has(f),
      );
      const complete =
        observation?.status === "supported" &&
        capabilities[kind] === "supported" &&
        analyzedFiles.length === files.length &&
        !output.blind?.length;
      const status =
        observation?.status === "failed" || observation?.status === "unsupported"
          ? observation.status
          : complete
            ? "supported"
            : "partial";
      const limitations = [...(observation?.limitations ?? [])];
      if (status === "partial")
        limitations.push(
          "Precise relationships may be missing; described files and empty results do not establish complete coverage.",
        );
      if (status !== "unsupported" && analyzedFiles.length < files.length)
        limitations.push("Files outside this analysis keep heuristic hints.");
      if (status !== "unsupported" && output.blind?.length)
        limitations.push("Some occurrences could not be linked to their targets.");
      if (!resolver.capabilities)
        limitations.push("Independent relationship support was not recorded.");
      addResult(results, kind, status, analyzedFiles, limitations);
    }
  }
  return {
    provider: resolver.id,
    capabilities,
    files,
    results,
    ...(diagnostics.length ? { diagnostics } : {}),
  };
}
