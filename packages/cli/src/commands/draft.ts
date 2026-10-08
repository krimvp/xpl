import { resolve } from "node:path";
import {
  applyPatch,
  shortSha,
  type AnchorInput,
  type ExplainerPatch,
  type IndexModel,
} from "@xpl/core";
import type { CommandSpec } from "../command.js";
import {
  DRAFT_LIMITS,
  draftChange,
  draftPath,
  draftProblems,
  inheritedEntry,
  type PathEntry,
  draftRepo,
  type Draft,
  type DraftKind,
} from "../draft.js";
import { CliError, UsageError, errorMessage } from "../errors.js";
import { plural, renderIssues } from "../format.js";
import { atomicWrite, displayPath, jsonFile } from "../fsutil.js";
import { loadExplainer, openWorkspace } from "../repo.js";
import { resolveTarget } from "../target.js";

const KINDS: readonly DraftKind[] = ["change", "repo", "path"];

/** What a draft holds, for the summary line and `--json`. */
export interface DraftCounts {
  views: number;
  /** Graph views (maps). */
  maps: number;
  boxes: number;
  participants: number;
  sequenceSteps: number;
  overlays: number;
  groups: number;
  tourSteps: number;
  anchors: number;
  /** `TODO` placeholders to write. */
  todos: number;
}

/** Every `TODO` in the text of a patch (each placeholder counts once). */
export function countTodos(patch: ExplainerPatch): number {
  return (JSON.stringify(patch).match(/TODO/g) ?? []).length;
}

/** Every anchor of a patch (element anchors, step anchors, tour step code). */
export function patchAnchors(patch: ExplainerPatch): AnchorInput[] {
  const out: AnchorInput[] = [];
  for (const node of patch.nodes ?? []) out.push(...(node.anchors ?? []));
  for (const edge of patch.edges ?? []) out.push(...(edge.anchors ?? []));
  for (const concept of patch.concepts ?? []) out.push(...(concept.anchors ?? []));
  for (const view of patch.views ?? []) {
    if (view.type === "graph") continue;
    for (const step of view.steps ?? []) out.push(...(step.anchors ?? []));
  }
  for (const tour of patch.tours ?? []) {
    for (const step of tour.steps ?? []) out.push(...(step.code ?? []));
  }
  return out;
}

export function draftCounts(patch: ExplainerPatch): DraftCounts {
  const views = patch.views ?? [];
  const nodes = patch.nodes ?? [];
  let boxes = 0;
  let maps = 0;
  let participants = 0;
  let sequenceSteps = 0;
  for (const view of views) {
    if (view.type === "graph") {
      maps++;
      boxes += view.include?.length ?? 0;
    } else {
      participants += view.participants?.length ?? 0;
      sequenceSteps += view.steps?.length ?? 0;
    }
  }
  return {
    views: views.length,
    maps,
    boxes,
    participants,
    sequenceSteps,
    overlays: nodes.filter((n) => !n.id.startsWith("grp:")).length,
    groups: nodes.filter((n) => n.id.startsWith("grp:")).length,
    tourSteps: (patch.tours ?? []).reduce((sum, t) => sum + (t.steps?.length ?? 0), 0),
    anchors: patchAnchors(patch).length,
    todos: countTodos(patch),
  };
}

function summaryLine(kind: DraftKind, name: string, counts: DraftCounts): string {
  const picture =
    kind === "path"
      ? counts.views > 1
        ? `${counts.views} sequences of ${plural(counts.sequenceSteps, "call")} in all`
        : `a sequence of ${plural(counts.sequenceSteps, "call")} between ${plural(counts.participants, "participant")}`
      : counts.maps > 1
        ? `${counts.maps} maps of ${plural(counts.boxes, "box", "boxes")} in all`
        : `a map of ${plural(counts.boxes, "box", "boxes")}`;
  return (
    `draft ${kind} for ${name}: ${picture}, ${plural(counts.overlays, "summary", "summaries")}` +
    (counts.groups > 0 ? `, ${plural(counts.groups, "group")}` : "") +
    `, a tour of ${plural(counts.tourSteps, "step")}, ${plural(counts.anchors, "anchor")}, ` +
    `${plural(counts.todos, "TODO")} to write`
  );
}

/**
 * The symbol a path starts at. A method a class inherits (`sym:url_safe.py#URLSafeTimedSerializer.dumps`) is not a
 * symbol of the index: it starts at the base class that defines it, with the class it was asked on.
 */
function pathEntry(model: IndexModel, arg: string): PathEntry {
  let target: ReturnType<typeof resolveTarget>;
  try {
    target = resolveTarget(model, arg);
  } catch (error) {
    const hash = arg.indexOf("#");
    const file = arg.slice(0, Math.max(0, hash)).replace(/^sym:/, "").replace(/^\.\//, "");
    const inherited = hash !== -1 ? inheritedEntry(model, file, arg.slice(hash + 1)) : undefined;
    if (inherited) return inherited;
    throw error;
  }
  if (target.type !== "symbol") {
    throw new CliError(
      `the entry must be a symbol (a function or a method), not ${target.id}: \`xpl outline --under ${target.id}\` lists its symbols`,
    );
  }
  return { symbol: target.symbol };
}

export const draftCommand: CommandSpec = {
  name: "draft",
  usage: "xpl draft change|repo|path <explainer> [<entry id> ...] [-o <file>]",
  summary: "Print a patch skeleton for a change, a repo or a path; you write the TODO text",
  details: [
    "Builds a provisional patch from indexed references and the change record, with",
    "`TODO: <what to write>` in every text a person must write. `xpl apply` accepts it as it is; `xpl lint` reports",
    "each TODO left (`todo-left`). Write the text, check it against the code, then apply.",
    "Use --audience and --question to focus the draft. Imports suggest architecture; they do not prove",
    "who uses the project. Path sequences list selected call sites, not every runtime branch or invocation.",
    "  change <explainer>        needs the change record (`xpl change <explainer> <base>..<head>` first). A map of",
    `                            the change (changed symbols, or their files when many; direct callers outside`,
    `                            tests; one group box for the tests), and a tour in review order: what changes for`,
    `                            users, where it enters, one step per changed piece, who else is affected, tests,`,
    `                            risks (at most ${DRAFT_LIMITS.changeSteps} steps). Every changed file is anchored, tests too.`,
    `  repo <explainer>          two levels. A system map: the project as a service box (one per program under`,
    `                            services/, apps/ or cmd/), who reaches it and what it relies on (databases, caches,`,
    `                            queues, other APIs, found from the import lines). Each service box opens a map of its`,
    `                            parts: the top-level folders or files (below src in a src layout; at most`,
    `                            ${DRAFT_LIMITS.mapBoxes} boxes) and the outside systems they use. A tour from the top down.`,
    "                            It needs a supported source language; unsupported files such as .java stay text and",
    "                            cannot form repository levels. Inspect text with `xpl show file:<path>`; Java SCIP",
    "                            data alone does not enable Java levels.",
    "  path <explainer> <entry> [<entry> ...]",
    "                            a sequence of the calls the entry symbol makes (depth 1, in source order, at most",
    `                            ${DRAFT_LIMITS.participants} participants and ${DRAFT_LIMITS.pathCalls} calls), and a tour with one step per main call.`,
    "                            Calls to helpers of the entry's own class get a lifeline of their own; recursion is a",
    "                            call to itself; one-line helpers, type conversions and data built from a type are left",
    "                            out (the notes list them), and so are the calls that reach the least code when there",
    "                            are too many. Several entries: one sequence each, in one tour (a question with two",
    "                            halves). A method a class inherits (`sym:a.py#Child.run`) starts at the base that",
    "                            defines it, and self calls go where the class's method order finds them.",
    'Graph views get `stubs: {mode: "none"}`; tour steps hold at most 2 code ranges. Ids already in the explainer',
    "are not reused (`view:change-map-2`), and nodes it already explains get no new summary.",
    "Prints the patch on stdout (the summary on stderr), or writes it with -o and prints the summary.",
    "Then: write the text, `xpl lint <explainer> --patch <file>`, `xpl apply <explainer> <file>`.",
    "Exit codes: 0 ok, 1 no change recorded, an unknown entry, or nothing to draft, 2 usage error.",
  ],
  options: {
    out: { type: "string", short: "o", arg: "<file>", desc: "Write the patch to a file" },
    audience: { type: "string", arg: "<reader>", desc: "Who this explanation is for" },
    question: {
      type: "string",
      arg: "<question>",
      desc: "The question the explanation should answer",
    },
  },
  positionals: [
    { name: "change|repo|path" },
    { name: "explainer" },
    { name: "entry", required: false, rest: true },
  ],
  async run(ctx, args) {
    const kind = args.positionals[0] as DraftKind;
    if (!KINDS.includes(kind)) {
      throw new UsageError(`unknown draft "${args.positionals[0]}": use change, repo or path`);
    }
    const name = args.positionals[1]!;
    const entryArgs = args.positionals.slice(2);
    const entryArg = entryArgs[0];
    if (kind === "path" && entryArg === undefined) {
      throw new UsageError(
        "missing <entry>: the symbol the path starts at, e.g. sym:src/runner.ts#Runner.dispatch",
      );
    }
    if (kind !== "path" && entryArg !== undefined) {
      throw new UsageError(`unexpected argument "${entryArg}": only draft path takes an entry`);
    }
    const loaded = loadExplainer(ctx, name);
    const change = loaded.explainer.change;
    if (kind === "change" && !change) {
      throw new CliError(
        `${loaded.rel} has no change recorded: run \`xpl change ${loaded.name} <base>..<head>\` first (e.g. main..HEAD), then \`xpl draft change ${loaded.name}\``,
      );
    }
    const ws = await openWorkspace(ctx, { explainer: loaded });
    if (
      kind === "change" &&
      change &&
      /^[0-9a-f]{7,}$/i.test(ws.index.commit) &&
      !change.head.startsWith(ws.index.commit)
    ) {
      ctx.warn(
        `the recorded change ends at ${shortSha(change.head)}, but the index is ${ws.index.commit}: the draft uses the symbols of ${ws.index.commit}. ` +
          `Check out ${shortSha(change.head)} and run \`xpl index\`, or record the change again.`,
      );
    }
    const entries: PathEntry[] = [];
    if (kind === "path") for (const arg of entryArgs) entries.push(pathEntry(ws.model, arg));

    const input = { explainer: loaded.explainer, model: ws.model, texts: ws.texts };
    let draft: Draft;
    try {
      draft =
        kind === "change"
          ? draftChange(input, change!)
          : kind === "repo"
            ? draftRepo(input)
            : draftPath(input, entries);
    } catch (error) {
      throw new CliError(`nothing to draft: ${errorMessage(error)}`);
    }
    const audience = args.str("audience")?.trim();
    const question = args.str("question")?.trim();
    if (audience === "" || question === "")
      throw new UsageError("--audience and --question must contain text");
    if (audience) draft.patch.scope = { ...draft.patch.scope, audience };
    if (question) {
      for (const view of draft.patch.views ?? []) {
        if (view.scope) view.scope.question = question;
      }
      for (const tour of draft.patch.tours ?? []) {
        tour.summary = `TODO: answer ${JSON.stringify(question)}${audience ? ` for ${audience}` : ""}. State the scope and excluded behavior.`;
      }
    }

    // The draft must apply as it is: check it the way `xpl apply` does, in memory.
    const check = applyPatch(loaded.explainer, draft.patch, ws.model, ws.texts, { actor: "llm" });
    if (!check.ok) {
      throw new CliError(
        [
          `the draft does not apply to ${loaded.rel} (a bug in xpl draft; please report it):`,
          ...renderIssues(check.issues),
        ].join("\n"),
        1,
        { issues: check.issues },
      );
    }
    // and what apply does not check: no id named that exists nowhere, every focus on its step's view
    const problems = draftProblems(draft, loaded.explainer, ws.model);
    if (problems.length > 0) {
      throw new CliError(
        ["the draft is not sound (a bug in xpl draft; please report it):", ...problems].join("\n"),
        1,
      );
    }
    const warnings = check.issues.map((issue) => `${issue.path}: ${issue.message}`);
    const counts = draftCounts(draft.patch);
    const outOption = args.str("out");
    const outPath = outOption !== undefined ? resolve(ctx.cwd, outOption) : undefined;
    if (outPath) await atomicWrite(outPath, jsonFile(draft.patch));

    if (ctx.json) {
      ctx.emit({
        kind,
        path: loaded.rel,
        ...(outPath ? { out: displayPath(ctx.cwd, outPath) } : {}),
        counts,
        notes: draft.notes,
        ...(warnings.length > 0 ? { applyWarnings: warnings } : {}),
        patch: draft.patch,
      });
      return 0;
    }
    const target = outOption ?? "<file>";
    const lines = [
      summaryLine(kind, loaded.name, counts),
      ...draft.notes.map((n) => `note: ${n}`),
      ...warnings.map((w) => `apply warning: ${w}`),
      `next: ${outOption ? "" : "save the patch to a file outside the repo (or use -o), "}write each TODO, then ` +
        `\`xpl lint ${loaded.name} --patch ${target}\` and \`xpl apply ${loaded.name} ${target}\``,
    ];
    if (outPath) {
      ctx.out([`wrote ${outOption}`, ...lines].join("\n"));
    } else {
      ctx.out(JSON.stringify(draft.patch, null, 2));
      for (const line of lines) ctx.io.err(line);
    }
    return 0;
  },
};
