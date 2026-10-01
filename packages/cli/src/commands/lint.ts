import type { CommandSpec } from "../command.js";
import { plural } from "../format.js";
import {
  ABSOLUTE_WORDS,
  LINT_LIMITS,
  LINT_RULES,
  lintExplainer,
  type LintFinding,
  type LintRule,
} from "../lint.js";
import { loadExplainer } from "../repo.js";

/** `(tour step)`, `(flow step in view:x)`: what an element is, after its id in the text output. */
function kindText(f: LintFinding): string {
  if (f.kind === "explainer") return "";
  if (f.kind === "step") return ` (step in ${f.view ?? "a view"})`;
  return ` (${f.kind === "tour-step" ? "tour step" : f.kind})`;
}

/** Findings grouped by element, in the order they were found (the order of the explainer). */
function byElement(findings: readonly LintFinding[]): Map<string, LintFinding[]> {
  const out = new Map<string, LintFinding[]>();
  for (const finding of findings) {
    const list = out.get(finding.elementId);
    if (list) list.push(finding);
    else out.set(finding.elementId, [finding]);
  }
  return out;
}

/** `2 tours without a summary, 5 sentences over 25 words, ...`: the count per rule, in rule order. */
function countLine(findings: readonly LintFinding[]): string {
  const counts = new Map<LintRule, number>();
  for (const f of findings) counts.set(f.rule, (counts.get(f.rule) ?? 0) + 1);
  return (Object.keys(LINT_RULES) as LintRule[])
    .filter((rule) => counts.has(rule))
    .map((rule) => `${rule} ${counts.get(rule)}`)
    .join(", ");
}

export const lintCommand: CommandSpec = {
  name: "lint",
  usage: "xpl lint <explainer> [--strict]",
  summary:
    "Check the reader-facing text: summaries, titles, sentence length, vague or filler words",
  details: [
    "Reads the explainer only (no index) and checks the text a reader sees against the plain-language rules of",
    "the skill (reference/writing.md). Text checked: the explainer title; tour titles, summaries and step notes;",
    "view titles; flow and sequence step labels and summaries; the summaries and details of nodes, edges and",
    "concepts, and the labels of groups and concepts. Findings:",
    "  tour-summary       a tour without a `summary` (readers see it first)",
    '  note-heading       a tour note that does not start with a "### Plain title" line',
    "  code-title         a title (explainer, tour, view, note heading, group or concept label) that looks like",
    "                     code: a call, an identifier with _, a dotted name, a # in a name, one camelCase word",
    '  placeholder-title  a title such as "Fix 1", "Note" or "Step 3"',
    `  long-sentence      a sentence over ${LINT_LIMITS.sentenceWords} words`,
    `  long-average       a field whose sentences average over ${LINT_LIMITS.averageWords} words`,
    '  bare-it            a sentence that starts with "It" or "This" and a verb ("It calls ...")',
    "  filler-word        marketing or filler words (seamless, robust, leverage, simply, just, crucial, ...)",
    `  absolute-word      ${ABSOLUTE_WORDS.join(", ")}: needs evidence`,
    "  repeats-summary    a note sentence that repeats the summary of an element the step focuses",
    "  flow-label-code    a flow step label written as code (flows name stages; sequences may show calls)",
    "  markdown-in-plain  **bold**, __bold text__, a # heading or a [text](link) in a field the viewer shows as",
    "                     plain text (titles, labels, summaries of elements and steps); markdown works only in a",
    "                     tour summary, a step note and a detail",
    "Code spans (`...`) are left out of the word checks. Each finding names the element, the field, a short",
    "quote and a fix. Fix them with a patch (`xpl apply`); a finding you keep on purpose needs no change.",
    "Exit codes: 0 (findings are warnings), 1 with --strict when there is any finding, 2 usage error.",
  ],
  options: {
    strict: { type: "boolean", desc: "Exit 1 when there is any finding" },
  },
  positionals: [{ name: "explainer" }],
  async run(ctx, args) {
    const loaded = loadExplainer(ctx, args.positionals[0]!);
    const { findings, checked } = lintExplainer(loaded.explainer);
    const strict = args.flag("strict");
    const code = strict && findings.length > 0 ? 1 : 0;
    const counts: Record<string, number> = {};
    for (const f of findings) counts[f.rule] = (counts[f.rule] ?? 0) + 1;

    if (ctx.json) {
      ctx.emit({
        ok: code === 0,
        path: loaded.rel,
        strict,
        checked,
        total: findings.length,
        counts,
        findings,
      });
      return code;
    }

    if (findings.length === 0) {
      ctx.out(`ok: ${loaded.rel}: ${plural(checked, "text")} checked, no findings`);
      return 0;
    }
    const lines = [`${loaded.rel}: ${plural(checked, "text")} checked`];
    for (const [elementId, list] of byElement(findings)) {
      lines.push("", `${elementId}${kindText(list[0]!)}`);
      for (const f of list) {
        lines.push(`  ${f.field}  ${f.rule}: ${f.message}`);
        lines.push(`    "${f.quote}"`);
        lines.push(`    fix: ${f.hint}`);
      }
    }
    const elements = byElement(findings).size;
    lines.push(
      "",
      `${plural(findings.length, "finding")} in ${plural(elements, "element")} (${countLine(findings)})` +
        (strict ? "" : "; warnings only, --strict exits 1"),
    );
    ctx.out(lines.join("\n"));
    return code;
  },
};
