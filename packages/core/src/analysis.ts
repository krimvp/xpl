import type { AnalysisCapability, ChangeRecord, SymbolIndex } from "./schema.js";
import { CODE_LANGUAGE_NAMES } from "./languages.js";

export const RELATIONSHIP_CAPABILITIES = [
  "call",
  "import",
  "extends",
  "implements",
  "type-ref",
  "read",
  "write",
] as const;
/** The limit the heuristic resolver reports on every relationship; a language tool's references lift it. */
export const HEURISTIC_REFS_LIMIT = "References matched by name are hints; some can be missing.";
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
  request: "web requests",
};

/** Known omissions for this change, based only on the loaded index's recorded coverage. */
export function changeOmissions(change: ChangeRecord, index: SymbolIndex): string[] {
  const limit = 5;
  const headPaths = new Set(change.files.filter((f) => f.status !== "deleted").map((f) => f.path));
  const indexed = new Set(index.files.map((f) => f.path));
  const omissions =
    /^[0-9a-f]{7,}$/i.test(index.commit) && !change.head.startsWith(index.commit)
      ? [
          `Loaded index ${index.commit.slice(0, 7)} differs from change head ${change.head.slice(0, 7)}; head analysis coverage is unknown here.`,
        ]
      : [];
  omissions.push(
    ...change.files.flatMap((file) => {
      if (file.status === "deleted")
        return [
          `${file.path}: removed from the head; the loaded index cannot inspect its old code.`,
        ];
      return indexed.has(file.path)
        ? []
        : [`${file.path}: absent from the loaded index; source analysis is not recorded there.`];
    }),
  );
  const languageOf = new Map(index.files.map((f) => [f.path, f.language]));
  for (const report of index.analysis ?? []) {
    const changed = report.files.filter((path) => headPaths.has(path));
    if (changed.length === 0) continue;
    // a language tool checked the references of these files: the name matcher's partial result is not the limit
    const precise = changed.every((path) => {
      const language = languageOf.get(path);
      return language !== undefined && index.languages?.[language]?.refs === "precise";
    });
    for (const result of report.results) {
      if (result.status === "supported") continue;
      if (precise && result.limitations.includes(HEURISTIC_REFS_LIMIT)) continue;
      const analyzed = changed.filter((path) => result.analyzedFiles.includes(path)).length;
      const names = result.capabilities.map((capability) => labels[capability]).join(", ");
      const detail = result.limitations[0] ? ` Reported limit: ${result.limitations[0]}` : "";
      omissions.push(
        `${report.provider} report: ${names} ${result.status}; ${analyzed} of ${changed.length} changed paths in its scope analyzed.${detail}`,
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
        "File anchors are available for indexed files. What the analysis covered was not recorded, so an empty result does not prove there is none.",
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

/** The diagrams' words for each kind of relationship, in the order a reader meets them. */
const ARROW_WORDS: Record<(typeof RELATIONSHIP_CAPABILITIES)[number], string> = {
  call: "calls",
  import: "imports",
  extends: "inherits",
  implements: "implements",
  "type-ref": "type uses",
  read: "reads",
  write: "writes",
};
const DATA_NAMES: Record<string, string> = { json: "JSON", yaml: "YAML", toml: "TOML" };

function wordList(words: readonly string[], last: "and" | "or"): string {
  return words.length < 2
    ? (words[0] ?? "")
    : `${words.slice(0, -1).join(", ")} ${last} ${words.at(-1)}`;
}

const fileCount = (n: number) => `${n} ${n === 1 ? "file" : "files"}`;

/**
 * What xpl could read, for readers: a summary and one plain line per language, in the diagrams' words
 * ("names", "arrows", "matched by name"). `describeAnalysis` keeps the analyzer's own report for authors.
 */
export function readerCoverage(index: SymbolIndex): { summary: string; lines: string[] } {
  if (!index.analysis)
    return { summary: "What xpl could read was not recorded (an older index).", lines: [] };
  const results = index.analysis.flatMap((report) =>
    report.results.map((result) => ({ result, scope: new Set(report.files) })),
  );
  const groups = new Map<string, string[]>();
  const data: string[] = [];
  const dataNames = new Set<string>();
  const text: string[] = [];
  for (const file of index.files) {
    const name = CODE_LANGUAGE_NAMES[file.language];
    if (name) groups.set(name, [...(groups.get(name) ?? []), file.path]);
    else if (DATA_NAMES[file.language]) {
      data.push(file.path);
      dataNames.add(DATA_NAMES[file.language]!);
    } else text.push(file.path);
  }
  /** For each file, the best way the analysis covered `capability` there. */
  const coverage = (files: readonly string[], capability: AnalysisCapability) => {
    let full = 0;
    let precise = 0;
    let some = 0;
    let failed = false;
    for (const file of files) {
      let best: "precise" | "full" | "some" | undefined;
      for (const { result, scope } of results) {
        if (!result.capabilities.includes(capability) || !scope.has(file)) continue;
        if (result.status === "failed") failed = true;
        if (!result.analyzedFiles.includes(file) || result.status === "failed") continue;
        if (result.status === "unsupported") continue;
        const here =
          result.resolution === "precise" && result.status === "supported"
            ? "precise"
            : result.status === "supported" && result.resolution !== "heuristic"
              ? "full"
              : "some";
        if (here === "precise" || best === undefined || (here === "full" && best === "some"))
          best = here;
      }
      if (best === "precise") precise++;
      if (best === "full" || best === "precise") full++;
      if (best) some++;
    }
    return { full, precise, some, failed };
  };
  let limited = false;
  let failedAny = false;
  let byName = false;
  const lines: string[] = [];
  for (const [name, files] of [...groups].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
    const parts: string[] = [];
    const names = STRUCTURE_CAPABILITIES.map((c) => coverage(files, c));
    if (names.every((c) => c.full === files.length)) parts.push("names in full");
    else if (names.some((c) => c.some > 0)) parts.push("names in part");
    else parts.push("no names");
    if (!parts[0]!.endsWith("in full")) limited = true;
    const arrows = RELATIONSHIP_CAPABILITIES.map((c) => ({ c, ...coverage(files, c) }));
    const found = arrows.filter((a) => a.some > 0);
    const missing = arrows.filter((a) => a.some === 0).map((a) => ARROW_WORDS[a.c]);
    const precise = Math.min(...arrows.map((a) => a.precise));
    let how: string;
    if (found.length > 0 && found.every((a) => a.precise === files.length))
      how = "checked by a language tool";
    else if (precise > 0)
      how = `checked by a language tool in ${fileCount(precise)}, matched by name in the rest, so some can be missing`;
    else how = "matched by name, so some can be missing";
    if (found.length > 0 && !how.startsWith("checked by a language tool")) byName = true;
    if (precise > 0 && found.some((a) => a.precise < files.length)) byName = true;
    if (found.length === 0) parts.push("no arrows");
    else if (missing.length === 0) parts.push(`arrows ${how}`);
    else
      parts.push(
        `${wordList(
          found.map((a) => ARROW_WORDS[a.c]),
          "and",
        )} ${how}`,
      );
    if (missing.length > 0) {
      limited = true;
      if (found.length > 0) parts.push(`no ${wordList(missing, "or")}`);
    }
    if ([...names, ...arrows].some((c) => c.failed)) {
      failedAny = true;
      parts.push("the analysis failed in part");
    }
    lines.push(`${name} (${fileCount(files.length)}): ${parts.join("; ")}.`);
  }
  if (data.length > 0)
    lines.push(
      `${[...dataNames].sort().join(", ")} (${fileCount(data.length)}): keys only; no arrows.`,
    );
  if (text.length > 0) lines.push(`Text (${fileCount(text.length)}): the whole file only.`);
  const summary = `What xpl could read: ${fileCount(index.files.length)}.${
    failedAny
      ? " The analysis failed in part."
      : limited
        ? " Some languages only in part."
        : byName
          ? " Some arrows are matched by name and can be missing."
          : ""
  }`;
  return { summary, lines };
}
