import { resolve } from "node:path";
import { applyPatch, type ExplainerPatch } from "@xpl/core";
import type { CommandSpec } from "../command.js";
import type { Ctx } from "../context.js";
import { CliError } from "../errors.js";
import { issueSummary, plural, renderIssues } from "../format.js";
import { atomicWrite, jsonFile, parseJson, readTextFile } from "../fsutil.js";
import { loadExplainer, openWorkspace } from "../repo.js";

async function defaultReadStdin(): Promise<string> {
  if (process.stdin.isTTY) {
    throw new CliError(
      "the patch should come from stdin (`-`), but stdin is a terminal: pipe the JSON in, or pass a file",
    );
  }
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk as Uint8Array));
  return Buffer.concat(chunks).toString("utf8");
}

async function readPatch(ctx: Ctx, source: string): Promise<{ patch: unknown; label: string }> {
  if (source === "-") {
    const text = await (ctx.io.readStdin ?? defaultReadStdin)();
    return { patch: parseJson(text, "the patch on stdin"), label: "stdin" };
  }
  const path = resolve(ctx.cwd, source);
  return { patch: parseJson(readTextFile(path, "patch file"), `patch ${source}`), label: source };
}

export const applyCommand: CommandSpec = {
  name: "apply",
  usage: "xpl apply <explainer> <patch.json|-> [--actor llm|user] [--dry-run]",
  summary: "Validate and apply a patch; print issues; exit 1 on error",
  details: [
    "Validates a patch (JSON) and merges it into .explainer/<explainer>.explainer.json, atomically: on any error",
    "nothing is written. `-` reads the patch from stdin; --dry-run only checks. Every error names the path into",
    "the patch and says how to fix it.",
    "",
    'Patch: { "title"?, "nodes"?, "edges"?, "concepts"?, "views"?, "tours"?, "remove"?: [ids] }. Every key is',
    "  optional; other top-level keys are rejected. Elements, views and tours are upserted by id: a new id needs its",
    "  required fields (group: label + members; edge: from, to, kind, label; concept: label; graph view: type,",
    "  title, include; sequence view: type, title, participants, steps; tour: title, steps), an existing id is",
    "  shallow-merged.",
    'Anchor (AnchorInput): { "file": "src/runner.ts", "symbol"?: "Runner.dispatch", "span"?: {"from": 34, "to": 36},',
    '  "find"?: "<text that occurs once>", "role": "definition|call-site|usage|config|test" }. symbol is the path',
    "  inside the file (not the sym: id); span = 0-based line offsets from `xpl show`, relative to the symbol's",
    "  first line (file line 1 without symbol); give span or find; never write a hash.",
    "Merge rules: fields you send replace, fields you omit stay; arrays and objects replace wholesale (members,",
    "  include, hidden, participants, steps, frames, anchors, related, scope, layout): resend the whole list; null",
    "  clears an optional field (summary, detail, members, related, edgeKinds, hidden, excludeFiles, stubs, layout, frames).",
    "  A node's kind and a view's type never change; step ids are never renumbered.",
    "Graph views also take includeAdd / includeRemove (edit `include` without resending it) and excludeFiles (globs,",
    '  e.g. ["**/*_test.go", "**/test/**"]: derived edges and stubs ignore references that start or end in them).',
    'Sequence views also take stepsUpdate: [{ "id": "dispatch:4", "summary": "..." }], which merges the fields you',
    "  send into the existing steps with those ids (anchors as AnchorInput, replacing the step's; null clears summary",
    "  or edge; an unknown step id is an error that names the view's steps): fix one step without resending them all.",
    "Ownership: --actor llm (default) never changes or removes user-authored elements, views or tours, the fields",
    "  listed in provenance.userFields (a tour's title and steps, a view's steps for stepsUpdate too), or elements",
    "  that carry userFields: they are skipped with a `protected` warning. includeAdd is the one edit still allowed on",
    "  a view whose include the user curated. A patch that changes nothing because of that exits 1 and names the",
    "  protected ids: use a new view or includeAdd, or ask the user.",
    "One pass: a patch is judged whole. An anchor that does not resolve and a reference to an id that does not exist",
    "  are reported by the same apply (what depends on a failed anchor, such as an llm edge's evidence, waits until it",
    "  is fixed). A span that starts or ends on a blank line is a warning: it is probably off by one.",
    "Reference (a template per element, examples, every rejection message): reference/patch-format.md in the",
    "  code-explainer skill, next to SKILL.md.",
    "Output streams: what a patch did goes to stdout: `applied ...`, `no changes`, `dry run`, and a rejection, which",
    "  lists every error (`rejected: N errors ...`), or the refusal when everything was protected, both with exit 1.",
    "  Fatal errors (unreadable patch or explainer file, invalid JSON, no index, usage errors) go to stderr as",
    "  `error: ...`, and so do `warning:` lines (an index that does not match the working tree). With --json every",
    "  result, rejections and fatal errors included, is one JSON object on stdout (`ok`, `error`, `issues`).",
    "Exit codes: 0 applied or dry run passed (warnings allowed), 1 rejected, or nothing applied because everything",
    "  was protected, or a fatal error, 2 usage error.",
  ],
  options: {
    actor: {
      type: "string",
      arg: "llm|user",
      desc: "Who is writing (default llm): llm never touches user-authored elements",
    },
    "dry-run": {
      type: "boolean",
      desc: "Check the patch and print what would change; write nothing",
    },
  },
  positionals: [{ name: "explainer" }, { name: "patch.json|-" }],
  async run(ctx, args) {
    const actor = args.choice("actor", ["llm", "user"] as const) ?? "llm";
    const dryRun = args.flag("dry-run");
    const loaded = loadExplainer(ctx, args.positionals[0]!);
    const { patch, label } = await readPatch(ctx, args.positionals[1]!);
    const ws = await openWorkspace(ctx, { explainer: loaded });
    const result = applyPatch(loaded.explainer, patch as ExplainerPatch, ws.model, ws.texts, {
      actor,
    });
    const errors = result.issues.filter((issue) => issue.severity === "error").length;
    const protectedIssues = result.issues.filter((issue) => issue.code === "protected");
    const protectedIds = [
      ...new Set(protectedIssues.map((issue) => issue.elementId).filter((id) => id !== undefined)),
    ] as string[];
    // Everything the patch changes belongs to the user: that is not "no changes", it is a refusal.
    const allProtected = result.ok && result.changed.length === 0 && protectedIssues.length > 0;
    const write = result.ok && !dryRun && result.changed.length > 0;
    if (write) await atomicWrite(loaded.abs, jsonFile(result.explainer));

    if (ctx.json) {
      ctx.emit({
        ok: result.ok && !allProtected,
        applied: write,
        dryRun,
        actor,
        path: loaded.rel,
        changed: result.changed,
        issues: result.issues,
        ...(protectedIds.length > 0 ? { protectedIds } : {}),
        ...(result.ok
          ? allProtected
            ? { error: `nothing applied: ${protectedSummary(protectedIds)}` }
            : {}
          : { error: `patch rejected: ${plural(errors, "error")}, nothing applied` }),
      });
      return result.ok && !allProtected ? 0 : 1;
    }

    const lines: string[] = [];
    if (!result.ok) {
      lines.push(
        `rejected: ${plural(errors, "error")}, nothing was applied to ${loaded.rel} (patch from ${label})`,
        ...renderIssues(result.issues),
      );
      ctx.out(lines.join("\n"));
      return 1;
    }
    if (allProtected) {
      lines.push(
        `nothing was applied to ${loaded.rel} (patch from ${label}): ${protectedSummary(protectedIds)}`,
        ...renderIssues(result.issues),
        PROTECTED_ADVICE,
      );
      ctx.out(lines.join("\n"));
      return 1;
    }
    if (result.changed.length === 0) {
      lines.push(`no changes: the patch matches ${loaded.rel}${dryRun ? " (dry run)" : ""}`);
    } else if (dryRun) {
      lines.push(
        `dry run: the patch is valid and would change ${plural(result.changed.length, "id")} in ${loaded.rel}; nothing written`,
      );
    } else {
      lines.push(
        `applied to ${loaded.rel} (actor ${actor}): ${plural(result.changed.length, "id")} changed`,
      );
    }
    if (result.changed.length > 0) lines.push("changed:", ...result.changed.map((id) => `  ${id}`));
    if (result.issues.length > 0) {
      lines.push(`issues (${issueSummary(result.issues)}):`, ...renderIssues(result.issues));
    }
    // The warnings that matter most go last, where they are read.
    if (protectedIds.length > 0) {
      lines.push(
        `skipped as protected (${protectedIds.join(", ")}): the user owns those parts, so they stay as the user left them. ` +
          `That is not an error and not something to work around: ${PROTECTED_ADVICE_SHORT}`,
      );
    }
    ctx.out(lines.join("\n"));
    return 0;
  },
};

/** "everything this patch changes is owned by the user (protected): a, b" */
function protectedSummary(ids: readonly string[]): string {
  return `everything this patch would change is owned by the user (skipped as protected): ${ids.join(", ")}`;
}

const PROTECTED_ADVICE_SHORT =
  "put new content in a new view (new slug) or new elements, grow a user-curated view with includeAdd, or ask the user.";

const PROTECTED_ADVICE = [
  "what to do: the user's edits win over Claude's.",
  "  - new nodes for a view the user curated: put them in a NEW view (new slug), or add them with `includeAdd` (allowed even when the user owns `include`; a whole `include` and `includeRemove` are not),",
  "  - a summary or anchors the user rewrote: leave them, or ask the user (`--actor user` only for a change the user dictates),",
  "  - never re-create an element under another id to replace theirs.",
].join("\n");
