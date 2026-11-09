import { applyPatch, ExplainerModel, type Explainer, type ExplainerPatch } from "@xpl/core";
import type { CommandSpec } from "../command.js";
import { plural, renderIssues } from "../format.js";
import { LINT_RULES, lintExplainer, type LintFinding, type LintRule } from "../lint.js";
import { loadReadExplainer, openWorkspace, type Workspace } from "../repo.js";
import { readPatch } from "./apply.js";

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
  usage: "xpl lint [explainer] [--patch <file|->] [--warn-only] [--strict]",
  summary:
    "Check the reader-facing text and the tour order; --patch checks a patch before you apply it",
  details: [
    "Checks the text a reader sees against the writing rules of the skill (reference/writing.md).",
    "It also checks the tour: the big picture first, every box visited, where to go next at the end.",
    "Each finding names the element, the field, a short quote and a fix. Fix them with a patch.",
    "The rules, one per finding code (todo-left, long-sentence, ...), are listed in cli.md.",
    "--patch lints the guide as it would be after `xpl apply`; nothing is written.",
    "Exit codes: 0 no findings; 1 any finding (with --warn-only, only todo-left), or a rejected patch; 2 usage.",
  ],
  options: {
    patch: {
      type: "string",
      arg: "<file|->",
      desc: "Lint the explainer as it would be after this patch (`-`: stdin); nothing is written",
    },
    "warn-only": {
      type: "boolean",
      desc: "Exit 0 when every finding is a warning (a todo-left error still exits 1)",
    },
    strict: {
      type: "boolean",
      desc: "Exit 1 when there is any finding (the default; kept for older scripts)",
    },
  },
  positionals: [{ name: "explainer", required: false }],
  async run(ctx, args) {
    const strict = !args.flag("warn-only");
    const patchSource = args.str("patch");
    const read =
      patchSource === undefined ? undefined : await readPatch(ctx, patchSource, "--patch -");
    const loaded = loadReadExplainer(ctx, args.positionals[0], "lint");

    let explainer: Explainer = loaded.explainer;
    let ws: Workspace | undefined;
    let patchInfo: { source: string; changed: string[]; protectedIds: string[] } | undefined;
    if (read !== undefined) {
      // The merge of `xpl apply` (core `applyPatch`), on a copy in memory: nothing is written.
      ws = await openWorkspace(ctx, { explainer: loaded });
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
            ...renderIssues(result.issues, loaded.name),
            `nothing linted: fix the patch, then run \`xpl lint ${loaded.name} --patch ${patchSource}\` again`,
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

    // The index (when there is one) gives the boxes and arrows of each map; lint works without it.
    if (ws === undefined) {
      try {
        ws = await openWorkspace(ctx, { explainer: loaded, skipFreshnessCheck: true });
      } catch {
        ws = undefined;
      }
    }
    const { findings, checked } = lintExplainer(
      explainer,
      ws ? new ExplainerModel(explainer, ws.model) : undefined,
    );
    const errors = findings.filter((f) => f.severity === "error").length;
    const code = (strict ? findings.length : errors) > 0 ? 1 : 0;
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
          ? errors > 0
            ? `; ${plural(errors, "error")} (todo-left)`
            : "; fix them, or keep one on purpose (say why) and run with --warn-only"
          : errors > 0
            ? `; ${plural(errors, "error")} (todo-left): exit 1 even with --warn-only`
            : "; warnings only (--warn-only)"),
    );
    ctx.out(lines.join("\n"));
    return code;
  },
};
