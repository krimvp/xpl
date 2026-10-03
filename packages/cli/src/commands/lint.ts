import { resolve } from "node:path";
import { applyPatch, type Explainer, type ExplainerPatch } from "@xpl/core";
import type { CommandSpec } from "../command.js";
import type { Ctx } from "../context.js";
import { CliError } from "../errors.js";
import { plural, renderIssues } from "../format.js";
import { parseJson, readTextFile } from "../fsutil.js";
import {
  ABSOLUTE_WORDS,
  LINT_LIMITS,
  LINT_RULES,
  lintExplainer,
  type LintFinding,
  type LintRule,
} from "../lint.js";
import { loadExplainer, openWorkspace } from "../repo.js";

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

async function defaultReadStdin(): Promise<string> {
  if (process.stdin.isTTY) {
    throw new CliError(
      "the patch should come from stdin (`--patch -`), but stdin is a terminal: pipe the JSON in, or pass a file",
    );
  }
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk as Uint8Array));
  return Buffer.concat(chunks).toString("utf8");
}

/** The patch of `--patch <file|->`, read as `xpl apply` reads it. */
async function readPatch(ctx: Ctx, source: string): Promise<{ patch: unknown; label: string }> {
  if (source === "-") {
    const text = await (ctx.io.readStdin ?? defaultReadStdin)();
    return { patch: parseJson(text, "the patch on stdin"), label: "stdin" };
  }
  const path = resolve(ctx.cwd, source);
  return { patch: parseJson(readTextFile(path, "patch file"), `patch ${source}`), label: source };
}

export const lintCommand: CommandSpec = {
  name: "lint",
  usage: "xpl lint <explainer> [--patch <file|->] [--strict]",
  summary:
    "Check the reader-facing text and the tour order; --patch checks a patch before you apply it",
  details: [
    "Reads the explainer only (no index) and checks the text a reader sees against the plain-language rules of",
    "the skill (reference/writing.md). Text checked: the explainer title; tour titles, summaries and step notes;",
    "view titles; flow and sequence step labels and summaries; the summaries and details of nodes, edges and",
    "concepts, and the labels of groups and concepts. Findings:",
    "  todo-left            a TODO placeholder left in any of these texts or in a view's question (`xpl draft`",
    "                       writes them): the one error-level finding, still exit 0 without --strict",
    `  tour-summary         a tour without a \`summary\`, or one of fewer than ${LINT_LIMITS.summaryMinSentences} or more than ${LINT_LIMITS.summarySentences} sentences`,
    "  tour-first-step      the first step of a tour does not show the big picture: it focuses a test, only a",
    "                       concept that lights up nothing, opens on a flow when the tour has a map, or its title",
    '                       says "edge case", "corner case", "gotcha" or "open question"',
    `  tour-covers-map      a map of at most ${LINT_LIMITS.mapBoxes} boxes that a tour uses has a box no step focuses (directly, by a`,
    "                       member, a step or edge end, or a concept's related ids) and no note or summary names",
    `  tour-length          a tour of more than ${LINT_LIMITS.tourSteps} steps`,
    '  note-heading         a tour note that does not start with a "### Plain title" line',
    "  code-title           a title (explainer, tour, view, note heading, group or concept label) that looks like",
    "                       code: a call, an identifier with _, a dotted name, a # in a name, one camelCase word",
    '  placeholder-title    a title such as "Fix 1", "Note" or "Step 3"',
    `  long-sentence        a sentence over ${LINT_LIMITS.sentenceWords} words`,
    `  long-average         a field whose sentences average over ${LINT_LIMITS.averageWords} words`,
    '  bare-it              a sentence that starts with "It" or "This" and a verb ("It calls ...")',
    "  filler-word          marketing or filler words (seamless, robust, leverage, simply, just, crucial, ...)",
    `  absolute-word        ${ABSOLUTE_WORDS.join(", ")}: needs evidence`,
    "  repeats-summary      a note sentence that repeats the summary of an element the step focuses",
    `  long-note            a note whose text under its title is over ${LINT_LIMITS.noteWords} words`,
    `  code-heavy           more different code names (code spans) than the reader can follow: over`,
    `                       ${LINT_LIMITS.noteCodeNames} in a note, ${LINT_LIMITS.architectureCodeNames} in a note on an architecture map (a map with a box that`,
    `                       has a role), ${LINT_LIMITS.summaryCodeNames} in a tour summary`,
    "  flow-label-code      a flow step label written as code (flows name stages; sequences may show calls)",
    "  markdown-in-plain    **bold**, __bold text__, a # heading or a [text](link) in a title or a label, which",
    "                       the viewer shows as plain text",
    "  markdown-in-summary  a # heading line or a [text](link) in the summary of an element or a step (inline",
    "                       markdown such as code spans, **bold** and *emphasis* is fine there)",
    "Code spans (`...`) are left out of the word checks. Each finding names the element, the field, a short",
    "quote and a fix. Fix them with a patch (`xpl apply`); a finding you keep on purpose needs no change.",
    "",
    "--patch <file|->: lint the explainer as it would be after `xpl apply <explainer> <file>`: the patch is merged",
    "in memory the way apply merges it (same checks, --actor llm), and nothing is written. A patch that apply would",
    "reject prints the rejection, as apply prints it, and exits 1. Fix the findings in the patch, then apply it.",
    "Exit codes: 0 (findings are warnings), 1 with --strict when there is any finding, or a rejected patch,",
    "2 usage error.",
  ],
  options: {
    patch: {
      type: "string",
      arg: "<file|->",
      desc: "Lint the explainer as it would be after this patch (`-`: stdin); nothing is written",
    },
    strict: { type: "boolean", desc: "Exit 1 when there is any finding" },
  },
  positionals: [{ name: "explainer" }],
  async run(ctx, args) {
    const strict = args.flag("strict");
    const patchSource = args.str("patch");
    const read = patchSource === undefined ? undefined : await readPatch(ctx, patchSource);
    const loaded = loadExplainer(ctx, args.positionals[0]!);

    let explainer: Explainer = loaded.explainer;
    let patchInfo: { source: string; changed: string[]; protectedIds: string[] } | undefined;
    if (read !== undefined) {
      // The merge of `xpl apply` (core `applyPatch`), on a copy in memory: nothing is written.
      const ws = await openWorkspace(ctx, { explainer: loaded });
      const result = applyPatch(
        loaded.explainer,
        read.patch as ExplainerPatch,
        ws.model,
        ws.texts,
        {
          actor: "llm",
        },
      );
      if (!result.ok) {
        const errors = result.issues.filter((issue) => issue.severity === "error").length;
        // the rejection as `xpl apply` prints it
        if (ctx.json) {
          ctx.emit({
            ok: false,
            path: loaded.rel,
            patch: read.label,
            strict,
            changed: [],
            issues: result.issues,
            error: `patch rejected: ${plural(errors, "error")}, nothing applied`,
          });
          return 1;
        }
        ctx.out(
          [
            `rejected: ${plural(errors, "error")}, nothing was applied to ${loaded.rel} (patch from ${read.label})`,
            ...renderIssues(result.issues),
            "nothing linted: fix the patch, then run `xpl lint --patch` again",
          ].join("\n"),
        );
        return 1;
      }
      explainer = result.explainer;
      const protectedIds = [
        ...new Set(
          result.issues
            .filter((issue) => issue.code === "protected")
            .map((issue) => issue.elementId)
            .filter((id): id is string => id !== undefined),
        ),
      ];
      patchInfo = { source: read.label, changed: result.changed, protectedIds };
    }

    const { findings, checked } = lintExplainer(explainer);
    const code = strict && findings.length > 0 ? 1 : 0;
    const counts: Record<string, number> = {};
    for (const f of findings) counts[f.rule] = (counts[f.rule] ?? 0) + 1;

    if (ctx.json) {
      ctx.emit({
        ok: code === 0,
        path: loaded.rel,
        ...(patchInfo
          ? {
              patch: patchInfo.source,
              changed: patchInfo.changed,
              ...(patchInfo.protectedIds.length > 0
                ? { protectedIds: patchInfo.protectedIds }
                : {}),
            }
          : {}),
        strict,
        checked,
        total: findings.length,
        counts,
        findings,
      });
      return code;
    }

    // `.explainer/x.explainer.json with patch p.json (3 ids changed, nothing written)`
    const subject = patchInfo
      ? `${loaded.rel} with patch ${patchInfo.source} (${plural(patchInfo.changed.length, "id")} changed, nothing written` +
        (patchInfo.protectedIds.length > 0
          ? `; skipped as protected: ${patchInfo.protectedIds.join(", ")}`
          : "") +
        ")"
      : loaded.rel;
    if (findings.length === 0) {
      ctx.out(`ok: ${subject}: ${plural(checked, "text")} checked, no findings`);
      return 0;
    }
    const lines = [`${subject}: ${plural(checked, "text")} checked`];
    for (const [elementId, list] of byElement(findings)) {
      lines.push("", `${elementId}${kindText(list[0]!)}`);
      for (const f of list) {
        lines.push(
          `  ${f.field}  ${f.severity === "error" ? "error " : ""}${f.rule}: ${f.message}`,
        );
        lines.push(`    "${f.quote}"`);
        lines.push(`    fix: ${f.hint}`);
      }
    }
    const elements = byElement(findings).size;
    lines.push(
      "",
      `${plural(findings.length, "finding")} in ${plural(elements, "element")} (${countLine(findings)})` +
        (strict
          ? ""
          : findings.some((f) => f.severity === "error")
            ? `; ${plural(findings.filter((f) => f.severity === "error").length, "error")} (todo-left), --strict exits 1`
            : "; warnings only, --strict exits 1"),
    );
    ctx.out(lines.join("\n"));
    return code;
  },
};
