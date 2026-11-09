# Create a guide

## Install

Install from npm (Node 22.12 or newer), then install the skill and check the setup:

```sh
npm install --global @krimvp/xpl
xpl skill install
xpl doctor --agent claude
```

Claude Code is the default target. For another harness, pass `--agent codex`, `pi`, `droid` or `devin` to both
commands. `--dir <path>` sets another destination.

| Harness       | Skill directory                           | Invoke it with           |
| ------------- | ----------------------------------------- | ------------------------ |
| Claude Code   | `~/.claude/skills/code-explainer`         | `/code-explainer`        |
| Codex         | `~/.agents/skills/code-explainer`         | `$code-explainer`        |
| Pi            | `~/.agents/skills/code-explainer`         | `/skill:code-explainer`  |
| Factory Droid | `~/.agents/skills/code-explainer`         | `/code-explainer`        |
| Devin         | `<project>/.agents/skills/code-explainer` | `@skills:code-explainer` |

The invocations of the harnesses other than Claude Code have not been tested live. Each agent needs its own sign-in and provider access.

**Devin** runs in a remote environment. Install Node 22.12 or newer and xpl there first. Then run
`xpl skill install --agent devin` there, in the target repo. The launcher records an absolute CLI path and has
no PATH fallback, so a local install does not set up xpl remotely. `xpl doctor` checks Devin's project skill
files, but it cannot check Devin's cloud discovery or sign-in.

**From source:** clone the public [source repository](https://github.com/krimvp/xpl) and run
`npm install && npm run build`. Then run `npm pack ./packages/cli/dist` and install the tarball with
`npm install -g --ignore-scripts ./krimvp-xpl-<version>.tgz`. For an offline tarball, use
`npm install -g --offline --ignore-scripts <tarball>`.

**Updates.** Run `xpl skill install` again after you update or move the CLI. It refuses to overwrite local edits
to the skill. The launcher warns when the skill's version differs from the CLI it runs. An older skill needs
`xpl skill install`; a newer skill needs a matching CLI.

**`xpl doctor`** checks Node, the bundled files, the skill, the optional precise tools and newer CLI versions.
Set `XPL_NO_UPDATE_CHECK=1` to skip its request to the npm registry.

**Platforms.** The full install test runs on Linux x64. CI also checks the packed install, the local service and
offline reading on macOS and Windows.

Use the installed skill's `bin/xpl` launcher for the commands below. Run it from the repository root, or pass
`--root /absolute/path/to/repo`. The agent reads the code and writes the JSON patch; the user gives the intent.

## Start with the intent

Take these choices from the request, and state each default you assume before you start:

- **Repository root:** the source tree to explain. For a change, it must hold the local git history and match the
  head of the range.
- **Audience:** who will read the guide and what they already know.
- **Question:** what the guide answers. An overview needs a purpose too, such as "onboard a new maintainer".
- **Name and target:** a new kebab-case guide name, or the existing guide to extend.
- **Analysis mode:** `xpl index` tries the optional precise tools. `--precise off` skips them, for fast or
  offline indexing. `--precise require` fails when a precise tool cannot run; then offer the heuristic path, and
  do not call it precise.

List `.explainer/*.explainer.json` before you choose the target. A name collision means: choose another name, or
ask whether the user means that guide. Do not delete it, recreate it or extend it without asking. Before you add
to a guide, read its views, tours and `userFields`. Use fresh view and tour ids and the default `llm` actor; the
user's text stays in place.

After `xpl skill install` and `xpl doctor --agent <name>`, invoke the skill in the harness with a prompt like
these. For a skill in a custom `--dir`, pass that folder to `xpl doctor` with `--skill-dir <folder>`.

```text
<harness-token> explain repo. Root: /work/orders. Audience: new maintainers. Question: how do requests reach storage? New guide: orders-overview. Use --precise off.
<harness-token> explain how failed jobs are retried. Root: /work/jobs. Audience: backend engineers. New guide: job-retries. Use --precise off.
<harness-token> explain change HEAD~1..HEAD. Root: /work/jobs. Audience: reviewers. Question: what changes for callers and what can fail? New guide: retry-change. Use --precise off.
```

Replace `<harness-token>` with the invocation from the table in "Install".

To add a question to a guide you know, say `Existing guide: orders-overview` instead of `New guide`. The agent can
take the root from its current directory. It can propose the audience or name when the request makes them clear.
It asks one short question when a missing choice would change the result.

## Author through the installed commands

**A GitHub PR.** `xpl pr create <url> --name <guide> --audience "<reader>" --question "<intent>"` prepares the
input. Give it a `--cache-dir` outside the repo, and `--skill-dir` for a skill in a custom folder.

- It fetches the exact base and head commits into a separate repository, and runs `new`, `change` and `draft`
  there through the installed launcher.
- It prints a prompt for the skill. Put the harness token in front of it and run it in the agent. No model starts
  on its own.
- Read `handoff.json`, and put its `command` prefix in front of every authoring command. The prefix pins the
  installed CLI and the owned Git paths, and drops inherited Git overrides.
- Keep the prepared head index and draft. Skip `index`, `new` and `change` below unless a repair needs them.
- End with `xpl pr finish <input-directory> --cache-dir <cache>`. It runs the ready check and the offline export,
  and checks both commits against GitHub again.
- When the base or head changed, the result is kept as superseded, never current. Create a new PR input for the
  new commits. An API failure writes no result.

`xpl pr prepare` writes only the input, for a change that you author locally.

**The steps:**

1. Run `xpl doctor` when you are not sure of the setup. Then run `xpl index` in the chosen mode. Report the
   coverage, the skipped analysis, and whether references are `precise` or `heuristic`. A valid anchor checks a
   place and its freshness; it does not prove the text or the runtime paths.
2. For a new guide, run `xpl new <name> --title "<title>"`. For an existing guide, read it and run
   `xpl status <name>` before you patch it. A change also needs `xpl change <name> <base>..<head>`; follow
   `explain-change.md`.
3. Run `xpl draft repo`, `path` or `change` with `--audience "<reader>" --question "<question>" -o
/absolute/scratch/draft.json`. For a subsystem, find the entry id with `search` and `show` first. Keep scratch
   files outside the source root: a patch inside it changes the indexed snapshot.
4. Read the code of the anchors. Choose each view with the table in `quick.md`, "Choose the diagram for the
   question". Set `scope.question` on each view, and give every box and arrow it shows a summary. Replace every
   `TODO` with checked text, and write the tour. Keep the user's fields. Lint, then apply:
   `xpl lint <name> --patch /absolute/scratch/draft.json && xpl apply <name> /absolute/scratch/draft.json`.
5. Run `xpl validate <name>`, `xpl status <name>` until it reports `to do: 0 with no text`, and
   `xpl anchors <name> tour:<slug>`. Do the accuracy pass and the newcomer re-read from `SKILL.md`. Lint the
   stored guide again.
6. Run `xpl ready <name>` and fix every error. For an omission or a warning you keep on purpose, add
   `--note "<reason>"`, and pass the same note to the export. A note does not override an error. The ready check
   covers anchors, freshness and required text; it does not prove the text true.
7. Run `xpl bundle <name> -o /absolute/scratch/<name>.html` (`--files boundary` for a subsystem or a change). The
   command runs the ready check again before it writes. Open `xpl view <name>` for a local review, or look at the
   saved HTML in a remote session. The file works offline and holds its checked source and ready report. Reply
   with the guide name, the limits of the analysis, the export path and what you checked.

## Recover and rerun

| Failure                                   | Next action                                                                                                                                                                                                                              |
| ----------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Node, launcher or bundled file missing    | Run `xpl doctor`. Repair Node, or install the npm package or tarball again. After you move or update the CLI, run `xpl skill install --dir <same-skill-dir>`. To keep local skill edits, move that directory aside first.                |
| Precise tools cannot run                  | Show the tool failure. If the user needs precise results, repair the toolchain and retry. Otherwise run `xpl index --precise off`, keep the `heuristic` labels, and confirm each call by reading the source.                             |
| Index failed, or the working tree changed | Fix the reported root, file or tool problem, then index again in the chosen mode. Keep the guide. After source changes, follow `SKILL.md`, "After the code changed", before you apply an old patch.                                      |
| Agent stopped, or provider access failed  | Repair the sign-in or provider access, then invoke the same scope, root and guide again. Read the stored guide and the outside patch first; do not run `new` over it. If apply stopped after lint, check `xpl status` first.             |
| Guide name exists already                 | Keep it. Choose a new name, or use it only after the user selects it as the target.                                                                                                                                                      |
| Git range cannot be recorded              | Check `git rev-parse <base>` and `<head>`. If the checkout differs from the head, use a separate checkout of the head, and keep the user's checkout and work. Index that head, then run `change` again. Ask before you fetch.            |
| Lint or apply rejects the patch           | Read the errors and the anchor hints, repair the outside patch, lint it, and retry. A rejected apply writes nothing. A protected-field warning means the user's edit was kept; use a new view or tour for your addition.                 |
| Ready or freshness checks fail            | Read the errors, write the missing text and check the source again. Run `xpl ready <name>`, then `bundle`. Use `bundle --draft` only for a preview the user asks for, and call it a draft. Keep the old export until the new one passes. |

Never recover by deleting `.explainer/`, rewriting an explainer JSON file, clearing user ownership or inventing
anchor hashes. Keep unfinished scratch files, so a later run can resume. Reading, export and
`index --precise off` use only the installed files, with no hosted xpl service. Agent authoring needs its own
provider access. The skill runs only when the user invokes it; it starts no background service and publishes
nothing.
