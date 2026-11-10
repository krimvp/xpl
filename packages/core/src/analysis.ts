import { EXCLUSION_REASONS } from "./constants.js";
import { CODE_LANGUAGE_NAMES } from "./languages.js";
import type {
  AnalysisCapability,
  ChangedFile,
  ChangeRecord,
  ExclusionReason,
  FilePath,
  SymbolIndex,
} from "./schema.js";

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

/** One line of what a change guide did not check, and the changed files it is about (none for a tool's report). */
export interface ChangeOmission {
  text: string;
  files: FilePath[];
}

/** Why files were left out, as the middle of "N files … were not analyzed." ("1 MB": `MAX_FILE_BYTES` of the indexer.) */
const EXCLUDED_FILES: Record<ExclusionReason | "unknown", string> = {
  oversized: "over the 1 MB size limit",
  generated: "made by xpl itself (guides, patches, exported pages)",
  lockfile: "listing pinned dependency versions (lockfiles)",
  binary: "in a binary format, not text",
  dependency: "of installed dependencies",
  "non-file": "stored as links or submodules, not plain files",
  unreadable: "that xpl could not read",
  unknown: "missing from the index",
};

/** Why one file was left out, in a few words ("no diff: over the 1 MB size limit"). */
const EXCLUDED_FILE: Record<ExclusionReason | "unknown", string> = {
  oversized: "over the 1 MB size limit",
  generated: "made by xpl itself",
  lockfile: "a lockfile",
  binary: "not a text file",
  dependency: "an installed dependency",
  "non-file": "not a plain file",
  unreadable: "xpl could not read it",
  unknown: "not in the index",
};

/** Why the index has no analysis of a changed file, in a few words: its `excluded` reason, else "not in the index". */
export function notAnalyzedReason(file: Pick<ChangedFile, "excluded">): string {
  return EXCLUDED_FILE[file.excluded ?? "unknown"];
}

const files = (n: number) => `${n} ${n === 1 ? "file" : "files"}`;
const were = (n: number) => (n === 1 ? "was" : "were");

/**
 * What a change guide did not check, from the change record and the loaded index's recorded coverage, for a reader:
 * one line per reason the index left changed files out (`ChangedFile.excluded`), with those files; one for the
 * removed files (the index holds the head only); one per partial, unsupported or failed report of a tool. Every
 * changed file the index lacks is in exactly one line's `files`.
 */
export function changeOmissions(change: ChangeRecord, index: SymbolIndex): ChangeOmission[] {
  const headPaths = new Set(change.files.filter((f) => f.status !== "deleted").map((f) => f.path));
  const indexed = new Set(index.files.map((f) => f.path));
  const omissions: ChangeOmission[] =
    /^[0-9a-f]{7,}$/i.test(index.commit) && !change.head.startsWith(index.commit)
      ? [
          {
            text: `The index is of commit ${index.commit.slice(0, 7)}, not of the change's last commit ${change.head.slice(0, 7)}: what it says about the changed code may be out of date.`,
            files: [],
          },
        ]
      : [];
  const left = new Map<ExclusionReason | "unknown", FilePath[]>();
  const removed: FilePath[] = [];
  for (const file of change.files) {
    if (file.status === "deleted") removed.push(file.path);
    else if (!indexed.has(file.path)) {
      const reason = file.excluded ?? "unknown";
      left.set(reason, [...(left.get(reason) ?? []), file.path]);
    }
  }
  // the reason with the most files first (a stable sort: ties in `EXCLUSION_REASONS` order)
  const reasons = ([...EXCLUSION_REASONS, "unknown"] as const)
    .filter((reason) => left.has(reason))
    .sort((a, b) => left.get(b)!.length - left.get(a)!.length);
  for (const reason of reasons) {
    const paths = left.get(reason)!;
    omissions.push({
      text: `${files(paths.length)} ${EXCLUDED_FILES[reason]} ${were(paths.length)} not analyzed.`,
      files: paths,
    });
  }
  if (removed.length > 0)
    omissions.push({
      text: `${removed.length} removed ${removed.length === 1 ? "file" : "files"} ${were(removed.length)} not analyzed: the index holds the code after the change only.`,
      files: removed,
    });
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
      omissions.push({
        text: `${report.provider} report: ${names} ${result.status}; ${analyzed} of ${changed.length} changed paths in its scope analyzed.${detail}`,
        files: [],
      });
    }
  }
  return omissions;
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
