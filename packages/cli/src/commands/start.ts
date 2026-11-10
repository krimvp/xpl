import { mkdtemp, readFile, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isTestFile, type IndexModel, type IndexedSymbol, type TextCache } from "@xpl/core";
import { Args } from "../args.js";
import type { CommandSpec } from "../command.js";
import { CliError, UsageError } from "../errors.js";
import { atomicWrite, jsonFile, withFileLock } from "../fsutil.js";
import { applyCommand } from "./apply.js";
import { indexCommand } from "./build-index.js";
import { draftCommand } from "./draft.js";
import { newCommand } from "./new.js";
import { loadExplainer, openWorkspace } from "../repo.js";

const PRECISE = ["auto", "off", "require"] as const;

/**
 * Words of a question that name nothing in the code: question words and common verbs (`put`, `get`, `make`, `run`,
 * `work`), stemmed as `stem` leaves them. Flask's `Scaffold.put` is no answer to "How is Flask put together?".
 */
const STOP_WORDS = new Set(
  (
    "how why who what when where which while whose the and but for nor not are was were been being has have had " +
    "does did doing done get got gets getting set sets put puts make makes made making take took give gave " +
    "run runs ran running use uses used using work works worked working happen happens happened go goes went " +
    "come came see saw look show tell know need want can could will would shall should may might must " +
    "with from into onto over under about after before then than there their them they this that these those " +
    "its all any each some every other one two first last new old together whole overall part parts piece " +
    "thing things way ways step steps code project repo repository"
  ).split(" "),
);

/** `retried` -> `retry`, `jobs` -> `job`, `failing` -> `fail`: a rough stem, the same for the question and names. */
function stem(word: string): string {
  return word
    .toLowerCase()
    .replace(/(?:ied|ies)$/, "y")
    .replace(/(?:ing|ed|es|s)$/, "");
}

/**
 * A function or method to start the path at, guessed from the words of the question: the one (outside tests) whose
 * name and code hold the most of them (a word in the name counts twice), then the one that makes the most calls.
 * Undefined when none holds a word.
 */
function suggestEntry(
  model: IndexModel,
  texts: TextCache,
  question: string,
  project: string | undefined,
): IndexedSymbol | undefined {
  // the project's own name is in every question about it, and in much of its code
  const own = new Set((project ?? "").match(/[A-Za-z]{3,}/g)?.map(stem) ?? []);
  const common = (w: string) => STOP_WORDS.has(w) || own.has(w);
  const words = [
    ...new Set(
      (question.match(/[A-Za-z]{3,}/g) ?? [])
        .filter((w) => !common(w.toLowerCase()))
        .map(stem)
        .filter((w) => w.length >= 3 && !common(w)),
    ),
  ];
  let best: { sym: IndexedSymbol; score: number; calls: number } | undefined;
  for (const sym of model.symbols) {
    if ((sym.kind !== "function" && sym.kind !== "method") || isTestFile(sym.file)) continue;
    const name = sym.path.slice(sym.path.lastIndexOf(".") + 1);
    const parts = name
      .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
      .split(/[^A-Za-z0-9]+/)
      .map(stem);
    const body = (texts.lines(sym.file) ?? [])
      .slice(sym.range.startLine - 1, sym.range.endLine)
      .join("\n")
      .toLowerCase();
    const score = words.reduce(
      (n, w) => n + (parts.includes(w) ? 2 : 0) + (body.includes(w) ? 1 : 0),
      0,
    );
    if (score === 0) continue;
    const calls = model.refsFrom(sym.id).filter((r) => r.kind === "call").length;
    if (!best || score > best.score || (score === best.score && calls > best.calls))
      best = { sym, score, calls };
  }
  return best?.sym;
}

export const startCommand: CommandSpec = {
  name: "start",
  usage:
    "xpl start <name> --question <question> --audience <reader> [--entry <symbol>] [--precise auto|off|require]",
  summary: "Make a first guide and its draft for a question and a reader",
  details: [
    "Indexes the repository, creates a new guide, drafts a repository map and applies the draft.",
    "--entry starts a call sequence at one indexed function or method instead of a repository map: the path",
    "that answers the question. Without it, the output names where a path could start: a function the question's",
    "words name (not common words or the project's name), else the entry a package.json or pyproject.toml declares.",
    "The draft patch and all draft notes are saved outside the repository. Up to three notes and apply",
    "warnings print here; --json returns the full lists. Review the TODO text and notes before sharing.",
    "With no reference tool installed, use --precise off. It never overwrites a guide.",
    "Next: open the guide with `xpl view <name>`, complete the TODOs, then run `xpl lint <name>`.",
  ],
  options: {
    question: { type: "string", arg: "<question>", desc: "What the guide should explain" },
    audience: { type: "string", arg: "<reader>", desc: "Who will read the guide" },
    entry: { type: "string", arg: "<symbol>", desc: "Function or method where a path starts" },
    precise: {
      type: "string",
      arg: "auto|off|require",
      desc: "Reference resolution (default auto)",
    },
  },
  positionals: [{ name: "name" }],
  async run(ctx, args) {
    const name = args.positionals[0]!.replace(/\.explainer\.json$/, "");
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name))
      throw new UsageError("guide name must use letters, digits, periods, underscores or hyphens");
    const question = args.str("question")?.trim();
    const audience = args.str("audience")?.trim();
    if (!question)
      throw new UsageError("what should this guide explain? Pass --question <question>");
    if (!audience) throw new UsageError("who will read this guide? Pass --audience <reader>");
    const precise = args.choice("precise", PRECISE) ?? "auto";
    const entry = args.str("entry")?.trim();
    if (entry === "") throw new UsageError("--entry must name a source symbol");
    if (ctx.indexOption) throw new UsageError("xpl start builds its own index; omit --index");

    const stepOutput: string[] = [];
    const quiet = {
      ...ctx,
      json: false,
      out: (text: string) => stepOutput.push(text),
      emit: () => {},
    };
    await indexCommand.run(quiet, new Args({ precise }, []));
    await newCommand.run(quiet, new Args({}, [name]));
    const guidePath = join(ctx.root, ".explainer", `${name}.explainer.json`);
    const emptyGuide = await readFile(guidePath);
    let patchPath: string;
    let notesFile: string;
    let notes: string[] = [];
    let applyWarnings: string[] = [];
    let declared: { id: string; how: string } | undefined;
    try {
      const dir = await mkdtemp(join(tmpdir(), "xpl-first-guide-"));
      patchPath = join(dir, "draft.patch.json");
      notesFile = join(dir, "draft-notes.json");
      await draftCommand.run(
        {
          ...quiet,
          json: true,
          emit: (data) => {
            notes = Array.isArray(data.notes) ? data.notes : [];
            applyWarnings = Array.isArray(data.applyWarnings) ? data.applyWarnings : [];
            declared = data.entry as typeof declared;
          },
        },
        new Args(
          { question, audience, out: patchPath },
          entry ? ["path", name, entry] : ["repo", name],
        ),
      );
      await atomicWrite(notesFile, jsonFile({ notes, applyWarnings }));
      const applied = await applyCommand.run(quiet, new Args({}, [name, patchPath]));
      if (applied !== 0) throw new CliError(stepOutput.at(-1) ?? "the draft could not be applied");
    } catch (error) {
      await withFileLock(guidePath, async () => {
        const current = await readFile(guidePath).catch(() => undefined);
        if (current?.equals(emptyGuide)) await unlink(guidePath);
      });
      throw error;
    }

    // without --entry the draft is a map of the whole repository: say so, and where a path could start: a function
    // the question names, else where the project says it starts (the draft's declared entry)
    let suggested: { id: string; why: string } | undefined;
    if (!entry) {
      const loaded = loadExplainer(quiet, name);
      const ws = await openWorkspace(quiet, { explainer: loaded });
      const sym = suggestEntry(ws.model, ws.texts, question, loaded.explainer.repo?.name);
      if (sym) suggested = { id: `sym:${sym.id}`, why: "a guess from the question's words" };
      else if (declared)
        suggested = {
          id: declared.id,
          why: `where ${declared.how} starts; no word of the question names a function`,
        };
    }
    // the path hint below names the command once: the draft's own note on room for the path keeps only the room
    if (!entry) {
      notes = notes.map((note) =>
        note.startsWith("room is left") ? note.replace(/: run `xpl draft path .*$/, "") : note,
      );
      await atomicWrite(notesFile, jsonFile({ notes, applyWarnings }));
    }
    const pathHint = entry
      ? undefined
      : `drafted an overview of the whole repository, not the path that answers the question (no --entry). ` +
        (suggested
          ? `To draft that path, run \`xpl draft path ${name} ${suggested.id} -o <file>\` (${suggested.why}), or pass --entry next time.`
          : `No word of the question names a function, and no manifest names where the main path starts, so no entry is guessed: find the function the path starts at with \`xpl search <word>\`, then run \`xpl draft path ${name} <entry> -o <file>\`.`);
    if (ctx.json) {
      ctx.emit({
        name,
        path: `.explainer/${name}.explainer.json`,
        drafted: entry ? "path" : "repo",
        ...(suggested ? { suggestedEntry: suggested.id } : {}),
        draft: patchPath,
        notesFile,
        notes,
        applyWarnings,
      });
    } else {
      ctx.out(
        [
          `created .explainer/${name}.explainer.json for ${audience}`,
          `draft patch: ${patchPath}`,
          `draft notes: ${notesFile}`,
          ...notes.slice(0, 3).map((note) => `note: ${note}`),
          ...(notes.length > 3 ? [`note: ${notes.length - 3} more in ${notesFile}`] : []),
          ...applyWarnings.slice(0, 3).map((warning) => `apply warning: ${warning}`),
          ...(applyWarnings.length > 3
            ? [`apply warning: ${applyWarnings.length - 3} more in ${notesFile}`]
            : []),
          ...(pathHint ? [`note: ${pathHint}`] : []),
          // the draft is applied already: an edited patch changes nothing until it is applied again
          // the viewer edits notes and box texts, not the titles or the tour summary the draft leaves TODOs in
          `next: write the TODOs in ${patchPath} and run \`xpl apply ${name} ${patchPath}\`, then \`xpl lint ${name}\`. ` +
            `\`xpl view ${name}\` also edits the step notes (Edit > Edit the tour) and box texts (Edit text), not the titles or the tour summary`,
        ].join("\n"),
      );
    }
    return 0;
  },
};
