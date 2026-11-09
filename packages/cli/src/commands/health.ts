import {
  HEALTH_LARGE_FILE_LINES,
  healthCheck,
  type HealthFinding,
  type HealthSeverity,
} from "@xpl/core";
import type { CommandSpec } from "../command.js";
import { plural } from "../format.js";
import { openWorkspace } from "../repo.js";

const DISCLAIMER = "a quick check, not a security audit";

export const healthCommand: CommandSpec = {
  name: "health",
  usage: "xpl health",
  summary: "Quick check for committed secrets, files over 1,000 lines and files that may be unused",
  details: [
    "Lists classic problems of code nobody reads line by line, each with its file and line, a severity, why it",
    "matters and a short fix: keys and passwords written into the code (masked: at most the first 4 characters),",
    "secrets in variables shipped to the browser (NEXT_PUBLIC_, VITE_, REACT_APP_, PUBLIC_), committed .env files,",
    `code files over ${HEALTH_LARGE_FILE_LINES.toLocaleString("en-US")} lines, and code files nothing else references (a guess from the index).`,
    "Reads the indexed files, so the index's ignore rules apply; run xpl index first. In tests, fixtures, docs",
    "and examples, key shapes are reported one severity lower and the other secret checks are skipped.",
    "It is a quick check, not a security audit: a clean report does not mean the code is safe.",
    "Exit codes: 0 with or without findings (a report, not a gate), 1 no index, 2 usage error.",
  ],
  options: {},
  positionals: [],
  async run(ctx) {
    const ws = await openWorkspace(ctx);
    const report = healthCheck(ws.model, ws.texts);
    if (ctx.json) {
      ctx.emit({ index: ws.indexRel, commit: ws.index.commit, note: DISCLAIMER, ...report });
      return 0;
    }
    const { high, medium, low } = report.counts;
    const lines = [
      `Health of ${plural(report.files, "file")}: ${DISCLAIMER}.`,
      `${high} high, ${medium} medium, ${low} low`,
    ];
    for (const severity of ["high", "medium", "low"] as const) {
      const findings = report.findings.filter((f) => f.severity === severity);
      if (findings.length > 0) lines.push("", ...section(severity, findings));
    }
    for (const note of report.notes) lines.push("", `note: ${note}`);
    if (report.findings.length === 0) {
      lines.push("", "No findings. A clean report does not mean the code is safe.");
    }
    ctx.out(lines.join("\n"));
    return 0;
  },
};

/** One severity: findings that share an explanation are listed together, then why and the fix once. */
function section(severity: HealthSeverity, findings: readonly HealthFinding[]): string[] {
  const groups = new Map<string, HealthFinding[]>();
  for (const finding of findings) {
    const group = groups.get(finding.explanation);
    if (group) group.push(finding);
    else groups.set(finding.explanation, [finding]);
  }
  const width = Math.max(...findings.map((f) => `${f.file}:${f.line}`.length));
  const out = [`${severity[0]!.toUpperCase()}${severity.slice(1)} (${findings.length})`];
  for (const group of groups.values()) {
    for (const f of group) {
      const hint = f.hint !== undefined ? ` (${f.hint})` : "";
      out.push(`  ${`${f.file}:${f.line}`.padEnd(width)}  ${f.title}${hint}`);
    }
    out.push(`    Why: ${group[0]!.explanation}`, `    Fix: ${group[0]!.fix}`);
  }
  return out;
}
