import { resolve } from "node:path";
import {
  applyPatch,
  shortSha,
  type AnchorInput,
  type ExplainerPatch,
  type IndexModel,
  type IndexedSymbol,
} from "@xpl/core";
import { ParserPool } from "@xpl/indexer";
import type { CommandSpec } from "../command.js";
import { controlBlocksOf } from "../control-blocks.js";
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
import { MAP_LIMITS, draftMap } from "../draft-map.js";
import { CLASS_ENTRY_KINDS, CLASS_LIMITS, draftClass } from "../draft-class.js";
import { STATES_LIMITS, draftStates } from "../draft-states.js";
import { DATA_LIMITS, draftData } from "../draft-data.js";
import { CliError, UsageError, errorMessage } from "../errors.js";
import { resolveCommit } from "../git.js";
import { plural, renderIssues, withArticle } from "../format.js";
import { atomicWrite, displayPath, jsonFile } from "../fsutil.js";
import { loadReadExplainer, openWorkspace } from "../repo.js";
import { REPO_TARGET, resolveTarget, type Target } from "../target.js";

const KINDS: readonly DraftKind[] = ["change", "repo", "path", "map", "class", "states", "data"];

/** What a draft holds, for the summary line and `--json`. */
export interface DraftCounts {
  views: number;
  /** Graph views (maps). */
  maps: number;
  boxes: number;
  /** Of `boxes`, the rows of a data map's tables (included ids whose parent is included). */
  rows: number;
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
  let rows = 0;
  let maps = 0;
  let participants = 0;
  let sequenceSteps = 0;
  for (const view of views) {
    if (view.type === "graph") {
      maps++;
      const include = view.include ?? [];
      boxes += include.length;
      if (view.boxText === "members")
        rows += include.filter((id) => include.includes(id.slice(0, id.lastIndexOf(".")))).length;
    } else {
      participants += view.participants?.length ?? 0;
      sequenceSteps += view.steps?.length ?? 0;
    }
  }
  return {
    views: views.length,
    maps,
    boxes,
    rows,
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
    kind === "states"
      ? `a flow of ${plural(counts.sequenceSteps, "step")} (one per state, one per transition)`
      : kind === "path"
        ? (counts.views - counts.maps > 1
            ? `${counts.views - counts.maps} sequences of ${plural(counts.sequenceSteps, "call")} in all`
            : `a sequence of ${plural(counts.sequenceSteps, "call")} between ${plural(counts.participants, "participant")}`) +
          (counts.maps > 0 ? ` after a map of the ${plural(counts.boxes, "file")} it crosses` : "")
        : kind === "data"
          ? `a data map of ${plural(counts.boxes - counts.rows, "type")} with ${plural(counts.rows, "field row")}`
          : counts.maps > 1
            ? `${counts.maps} maps of ${plural(counts.boxes, "box", "boxes")} in all`
            : `a map of ${plural(counts.boxes, "box", "boxes")}`;
  return (
    `draft ${kind} for ${name}: ${picture}, ${plural(counts.overlays, "summary", "summaries")}` +
    (counts.groups > 0 ? `, ${plural(counts.groups, "group")}` : "") +
    `, a tour of ${plural(counts.tourSteps, "step")}` +
    // the step budgets are ceilings: a small type or a quick map takes fewer steps
    (counts.tourSteps > 0 && counts.tourSteps < 5
      ? " (short is right for a small subject: do not pad it)"
      : "") +
    `, ${plural(counts.anchors, "anchor")}, ` +
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
  usage:
    "xpl draft change|repo|path|map|class|states|data [explainer] [<entry id> ...] [--audience <reader>] [--question <question>] [-o <file>]",
  summary:
    "Print a patch skeleton for a change, a repo, a path, a map, a class, the states of a type or a data model; you write the TODO text",
  details: [
    "Builds a provisional patch from indexed references and the change record, with",
    "`TODO: <what to write>` in every text a person must write. `xpl apply` accepts it as it is; `xpl lint` reports",
    "each TODO left (`todo-left`). Write the text, check it against the code, then apply.",
    "Use --audience and --question to focus the draft. Imports suggest architecture; they do not prove",
    "who uses the project. Path sequences list selected call sites, not every call the code can make.",
    "  change <explainer>        needs the change record (`xpl change <explainer> <base>..<head>` first). A map of",
    `                            the change (changed symbols, or their files when many; direct callers outside`,
    `                            tests; one group box for the tests), and a tour in review order: what changes for`,
    `                            users, where it enters, one step per changed piece, who else is affected, tests,`,
    `                            risks (at most ${DRAFT_LIMITS.changeSteps} steps). Every changed file is anchored, tests too.`,
    `  repo <explainer>          two levels. A system map: the project as a service box (one per program under`,
    `                            services/, apps/ or cmd/), who reaches it and what it relies on (databases, caches,`,
    `                            queues, other APIs, found from the import lines). A web server found from its start`,
    `                            call (Go ListenAndServe, Node createServer, Python serve_forever) gets a Clients box`,
    `                            there. A program with a main function (Java: a main method) and no web server or`,
    `                            command-line framework gets an Operator box, with an arrow to each part that holds a`,
    `                            main. The settings files the code loads get one Settings box, anchored at the file`,
    `                            and the line that loads it. Each service box opens a map of its parts: the top-level`,
    `                            folders or files (below src in a src layout; at most ${DRAFT_LIMITS.mapBoxes} boxes) and the outside`,
    `                            systems they use; code that several services share is on the map of each. A tour`,
    `                            from the top down that ends on where to go next (at most ${DRAFT_LIMITS.repoSteps} steps). It needs a`,
    "                            supported source language; unsupported files stay text and cannot form repository",
    "                            levels. Inspect text with `xpl show file:<path>`.",
    "  path <explainer> <entry> [<entry> ...]",
    "                            a sequence of the calls the entry symbol makes (depth 1, in source order, at most",
    `                            ${DRAFT_LIMITS.participants} participants and ${DRAFT_LIMITS.pathCalls} calls), with a loop, alt or opt frame where the code loops`,
    "                            or branches around them. A tour of at most " +
      DRAFT_LIMITS.pathSteps +
      " steps: a map of the files the path",
    "                            crosses (when it crosses two or more; its calls only, those through an interface",
    "                            too), the big picture, one step per main call (a branch with two outcomes is one",
    "                            step), and where to go next. Calls to helpers of the entry's own class get a",
    "                            lifeline of their own; recursion is a call to itself; one-line helpers, type",
    "                            conversions and data built from a type are left out (the notes list them), and so",
    "                            are the calls that reach the least code when there are too many.",
    "                            Several entries: one sequence each, in one tour (a question with two halves). A",
    "                            method a class inherits (`sym:a.py#Child.run`) starts at the base that defines it,",
    "                            and self calls go where the class's method order finds them.",
    "  map <explainer>           a quick map of every code file outside tests: one map per folder, a folder box opens",
    "                            the map of its files. Each box gets a name and one sentence to write; a file's TODO",
    "                            holds its header comment, what it defines, who uses it and what it uses. A start tour,",
    "                            and with a change recorded a tour of the changed files (how each serves the request).",
    `                            Run again after the code changed: only new files are drafted, boxes of files that`,
    `                            are gone are removed, written text stays (a moved file keeps its own), and the map's`,
    `                            tours drop what is gone. Maps over ${MAP_LIMITS.boxes} boxes get a note; a new map over`,
    `                            ${MAP_LIMITS.matrixBoxes} boxes opens as a dependency matrix (render: "matrix").`,
    "  class <explainer> <entry>",
    "                            the type hierarchy around a class or interface: what it extends and implements (all",
    "                            the way up) and what extends or implements it (two levels down), on one map of",
    `                            extends and implements arrows (at most ${CLASS_LIMITS.boxes} boxes), each with a summary TODO that`,
    "                            names its kind, links and methods; a tour: the entry, then each type next to it.",
    "  states <explainer> <entry>",
    "                            the states of a status type on one flow: a TypeScript enum or union of string",
    "                            literals, a Python Enum class, or a Go type with a const block of its values (in its",
    "                            file). A stage per state, anchored where the code sets it (an assignment, a return,",
    "                            an object key, a React setter) and tests it (a comparison, is, case); a stage per",
    "                            transition where one function tests a state and then sets another under that test",
    "                            (both sites anchored). Comments and other strings do not count. The notes name the",
    `                            states never set or tested and the other uses. At most ${STATES_LIMITS.states} states and`,
    `                            ${STATES_LIMITS.transitions} transitions; a tour: the type, then each state.`,
    "  data <explainer> [<scope>]",
    "                            what data the code keeps and how its types relate, on one data map (`boxText:",
    '                            "members"`): a table per type (class, interface, type, enum) with a row per field and',
    "                            the type its line names, arrows from a field to the type it holds and from a type to",
    "                            what it extends or implements. The scope is the repo (the default), a folder or a file",
    "                            (tests, examples and fixtures left out), or one type to start at. It starts at the",
    "                            most used type that holds or is held by another, then adds the type with the most links",
    `                            to the boxes so far (at most ${DATA_LIMITS.boxes} boxes, ${DATA_LIMITS.rows} rows a box; the fields that link come`,
    "                            first). Each box gets a summary TODO with its fields and links; a tour of at most",
    `                            ${DATA_LIMITS.steps} steps: the first type, the next ones in the order they joined, the rest of the map.`,
    'Change, repo and path maps get `stubs: {mode: "none"}` (a folder map keeps its stubs: what uses it and what it uses);',
    "tour steps hold at most 2 code ranges. Ids already in the explainer are not reused (`view:change-map-2`; a map",
    "keeps its own view ids and updates them), and nodes it already explains get no new summary.",
    "Prints the patch on stdout (the summary on stderr), or writes it with -o and prints the summary.",
    "Then: write the text, `xpl lint <explainer> --patch <file>`, `xpl apply <explainer> <file>`.",
    "Omit the explainer when the repository has exactly one; otherwise supply its name.",
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
    { name: "change|repo|path|map|class|states|data" },
    { name: "explainer", required: false },
    { name: "entry", required: false, rest: true },
  ],
  async run(ctx, args) {
    const kind = args.positionals[0] as DraftKind;
    if (!KINDS.includes(kind)) {
      throw new UsageError(
        `unknown draft "${args.positionals[0]}": use change, repo, path, map, class, states or data`,
      );
    }
    // a guide name never holds `:`, `#` or `/`: a second argument that does is the entry, for the only guide
    const second = args.positionals[1];
    const named = second !== undefined && !/[:#/]/.test(second);
    const entryArgs = args.positionals.slice(named ? 2 : 1);
    const entryArg = entryArgs[0];
    if (kind === "path" && entryArg === undefined) {
      throw new UsageError(
        "missing <entry>: the symbol the path starts at, e.g. sym:src/runner.ts#Runner.dispatch",
      );
    }
    if (kind === "class" && entryArgs.length !== 1) {
      throw new UsageError(
        "draft class takes one <entry>: a class or an interface, e.g. sym:src/queue.ts#Queue",
      );
    }
    if (kind === "states" && entryArgs.length !== 1) {
      throw new UsageError(
        "draft states takes one <entry>: a type that enumerates states, e.g. sym:src/status.ts#Status",
      );
    }
    if (kind === "data" && entryArgs.length > 1) {
      throw new UsageError(
        "draft data takes one <scope> at most: a folder, a file or a type, e.g. dir:src or sym:src/queue.ts#Job",
      );
    }
    if (
      kind !== "path" &&
      kind !== "class" &&
      kind !== "states" &&
      kind !== "data" &&
      entryArg !== undefined
    ) {
      throw new UsageError(
        `unexpected argument "${entryArg}": only draft path, class, states and data take an entry`,
      );
    }
    const loaded = loadReadExplainer(ctx, named ? second : undefined, "draft");
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
    if (kind === "path") {
      for (const arg of entryArgs) entries.push(pathEntry(ws.model, arg));
      // the loops and branches of each entry, from its syntax tree: the frames of its sequence
      const pool = new ParserPool();
      try {
        for (const entry of entries) {
          const { file, range } = entry.symbol;
          const language = ws.model.file(file)?.language;
          const lines = ws.texts.lines(file);
          if (!language || !lines) continue;
          try {
            entry.blocks = await controlBlocksOf(pool, file, language, lines.join("\n"), {
              start: range.startLine,
              end: range.endLine,
            });
          } catch {
            // no grammar to read the file with: a sequence without frames
          }
        }
      } finally {
        await pool.dispose();
      }
    }
    let classEntry: IndexedSymbol | undefined;
    if (kind === "class") {
      const target = resolveTarget(ws.model, entryArg!);
      const sym = target.type === "symbol" ? target.symbol : undefined;
      if (!sym || !CLASS_ENTRY_KINDS.has(sym.kind)) {
        throw new CliError(
          `the entry must be a class or an interface, not ${target.id} (${withArticle(sym ? sym.kind : target.type)}): \`xpl outline --kind class,interface\` lists them`,
        );
      }
      classEntry = sym;
    }
    let statesEntry: IndexedSymbol | undefined;
    if (kind === "states") {
      const target = resolveTarget(ws.model, entryArg!);
      if (target.type !== "symbol") {
        throw new CliError(
          `the entry must be a type that enumerates states, not ${target.id}: \`xpl outline --kind enum,type,class\` lists them`,
        );
      }
      statesEntry = target.symbol;
    }

    const dataScope: Target =
      kind === "data" && entryArg !== undefined ? resolveTarget(ws.model, entryArg) : REPO_TARGET;

    // A map finds moved files by their text at the commit their box was written at: git reads it by full SHA.
    const commits = new Map<string, string>();
    if (kind === "map") {
      for (const node of loaded.explainer.nodes ?? []) {
        const commit = node.provenance?.commit;
        if (!commit || commits.has(commit) || !node.id.startsWith("file:")) continue;
        if (ws.model.hasFile(node.id.slice(5)) || !/^[0-9a-f]{7,39}$/.test(commit)) continue;
        const full = await resolveCommit(ws.root, commit);
        if (full) commits.set(commit, full);
      }
    }
    const input = { explainer: loaded.explainer, model: ws.model, texts: ws.texts, commits };
    let draft: Draft;
    try {
      draft =
        kind === "change"
          ? draftChange(input, change!)
          : kind === "repo"
            ? draftRepo(input)
            : kind === "map"
              ? draftMap(input)
              : kind === "class"
                ? draftClass(input, classEntry!)
                : kind === "states"
                  ? draftStates(input, statesEntry!)
                  : kind === "data"
                    ? draftData(input, dataScope)
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
          ...renderIssues(check.issues, loaded.name),
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
    const warnings = check.issues.map(
      (issue) => `${issue.path}: ${issue.message.replaceAll("<explainer>", loaded.name)}`,
    );
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
