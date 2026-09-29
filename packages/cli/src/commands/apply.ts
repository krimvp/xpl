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
    "Applies an ExplainerPatch (JSON) to the explainer: elements, views and tours are upserted by id,",
    "anchors are checked against the index (hashes and resolved ranges are filled in), `remove` deletes",
    "ids. The whole patch is rejected if anything is wrong (nothing is written); every error names the",
    "path into the patch and says how to fix it, with suggestions for unknown files, symbols and ids.",
    "The explainer file is written atomically only on success. Use `-` to read the patch from stdin.",
    "--actor llm (default) never modifies or removes user-authored elements or fields the user edited.",
    "Patch: { title?, nodes?, edges?, concepts?, views?, tours?, remove?: [ids] }. An anchor is",
    '  { "file": "src/runner.ts", "symbol": "Runner.dispatch", "span": {"from": 34, "to": 36}, "role": "call-site" }',
    'where span = 0-based line offsets from `xpl show`, or use "find": "<text on one or more lines>" instead of span',
    "(it must occur exactly once in the symbol or file), and role is definition | call-site | usage | config | test.",
    "Never write hashes: they are computed. Merge rules and required fields: packages/core/src/patch.ts.",
    "Exit codes: 0 applied (or dry run passed), 1 rejected, 2 usage error.",
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
    const write = result.ok && !dryRun && result.changed.length > 0;
    if (write) await atomicWrite(loaded.abs, jsonFile(result.explainer));

    if (ctx.json) {
      ctx.emit({
        ok: result.ok,
        applied: write,
        dryRun,
        actor,
        path: loaded.rel,
        changed: result.changed,
        issues: result.issues,
        ...(result.ok
          ? {}
          : { error: `patch rejected: ${plural(errors, "error")}, nothing applied` }),
      });
      return result.ok ? 0 : 1;
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
    ctx.out(lines.join("\n"));
    return 0;
  },
};
