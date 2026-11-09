import { resolve } from "node:path";
import { applyPatch, type ExplainerPatch } from "@xpl/core";
import type { CommandSpec } from "../command.js";
import type { Ctx } from "../context.js";
import { CliError } from "../errors.js";
import { issueSummary, plural, renderIssues } from "../format.js";
import { atomicWrite, withFileLock, jsonFile, parseJson, readTextFile } from "../fsutil.js";
import {
  loadExplainer,
  openWorkspace,
  resolveExplainerPath,
  type LoadedExplainer,
} from "../repo.js";
import type { Explainer } from "@xpl/core";

/** Both ordinary apply and reviewed revision acceptance load and publish under the same lock. */
export async function withLockedExplainer<T>(
  ctx: Ctx,
  name: string,
  job: (loaded: LoadedExplainer, save: (next: Explainer) => Promise<void>) => Promise<T>,
): Promise<T> {
  return withFileLock(resolveExplainerPath(ctx, name), async () => {
    const loaded = loadExplainer(ctx, name);
    return job(loaded, (next) => atomicWrite(loaded.abs, jsonFile(next)));
  });
}

async function defaultReadStdin(arg: string): Promise<string> {
  if (process.stdin.isTTY) {
    throw new CliError(
      `the patch should come from stdin (\`${arg}\`), but stdin is a terminal: pipe the JSON in, or pass a file`,
    );
  }
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk as Uint8Array));
  return Buffer.concat(chunks).toString("utf8");
}

/** The patch of `<file|->`; `arg` is how the command spells stdin, for the error when stdin is a terminal. */
export async function readPatch(
  ctx: Ctx,
  source: string,
  arg = "-",
): Promise<{ patch: unknown; label: string }> {
  if (source === "-") {
    const text = await (ctx.io.readStdin ?? (() => defaultReadStdin(arg)))();
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
    "Checks a patch (JSON) and merges it into .explainer/<explainer>.explainer.json.",
    "On any error, nothing is written. `-` reads the patch from stdin; --dry-run only checks.",
    "Every error names the path into the patch and says how to fix it. A rejection exits 1.",
    "Elements, views and tours merge by id: fields you send replace, fields you omit stay.",
    "Arrays and objects replace wholesale: send the whole list. null clears an optional field.",
    "--actor llm (the default) never changes what the user wrote; such fields get a `protected` warning.",
    "The patch format, with templates and examples: reference/patch-format.md in the code-explainer skill.",
    "Exit codes: 0 applied or dry run passed; 1 rejected, everything protected, or fatal error; 2 usage error.",
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
    resolveExplainerPath(ctx, args.positionals[0]!);
    const { patch, label } = await readPatch(ctx, args.positionals[1]!);
    return withLockedExplainer(ctx, args.positionals[0]!, async (loaded, save) => {
      const ws = await openWorkspace(ctx, { explainer: loaded });
      const result = applyPatch(loaded.explainer, patch as ExplainerPatch, ws.model, ws.texts, {
        actor,
      });
      const errors = result.issues.filter((issue) => issue.severity === "error").length;
      const protectedIssues = result.issues.filter((issue) => issue.code === "protected");
      const protectedIds = [
        ...new Set(
          protectedIssues.map((issue) => issue.elementId).filter((id) => id !== undefined),
        ),
      ] as string[];
      // Everything the patch changes belongs to the user: that is not "no changes", it is a refusal.
      const allProtected = result.ok && result.changed.length === 0 && protectedIssues.length > 0;
      const write = result.ok && !dryRun && result.changed.length > 0;
      if (write) await save(result.explainer);

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
          ...renderIssues(result.issues, loaded.name),
        );
        ctx.out(lines.join("\n"));
        return 1;
      }
      if (allProtected) {
        lines.push(
          `nothing was applied to ${loaded.rel} (patch from ${label}): ${protectedSummary(protectedIds)}`,
          ...renderIssues(result.issues, loaded.name),
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
      if (result.changed.length > 0)
        lines.push("changed:", ...result.changed.map((id) => `  ${id}`));
      if (result.issues.length > 0) {
        lines.push(
          `issues (${issueSummary(result.issues)}):`,
          ...renderIssues(result.issues, loaded.name),
        );
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
    });
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
