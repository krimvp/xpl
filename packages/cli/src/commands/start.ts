import { mkdtemp, readFile, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Args } from "../args.js";
import type { CommandSpec } from "../command.js";
import { CliError, UsageError } from "../errors.js";
import { atomicWrite, jsonFile, withFileLock } from "../fsutil.js";
import { applyCommand } from "./apply.js";
import { indexCommand } from "./build-index.js";
import { draftCommand } from "./draft.js";
import { newCommand } from "./new.js";

const PRECISE = ["auto", "off", "require"] as const;

export const startCommand: CommandSpec = {
  name: "start",
  usage:
    "xpl start <name> --question <question> --audience <reader> [--entry <symbol>] [--precise auto|off|require]",
  summary: "Create an index-backed first guide and a draft for a question and reader",
  details: [
    "Indexes the repository, creates a new guide, drafts a repository map and applies the draft.",
    "--entry starts a call sequence at one indexed function or method instead of a repository map.",
    "The draft patch and all draft notes are saved outside the repository. Up to three notes and apply",
    "warnings print here; --json returns the full lists. Review the TODO text and notes before sharing.",
    "Use --precise off when optional reference tools are unavailable. Existing guides are never overwritten.",
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

    if (ctx.json) {
      ctx.emit({
        name,
        path: `.explainer/${name}.explainer.json`,
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
          `next: complete the TODOs in \`xpl view ${name}\` or edit the draft patch, then run \`xpl lint ${name}\``,
        ].join("\n"),
      );
    }
    return 0;
  },
};
