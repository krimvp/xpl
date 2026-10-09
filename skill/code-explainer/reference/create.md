# Create a guide

## Install

Install from npm (Node 22.12 or newer):

```sh
npm install --global @krimvp/xpl
xpl skill install --agent pi
xpl doctor --agent pi
```

Choose one agent: Claude is the default; pass `--agent codex`, `pi`, `droid` or `devin` for another
harness. Codex, Pi and Factory Droid use `~/.agents/skills/code-explainer`; Devin uses the target
project's `.agents/skills/code-explainer`. `--dir <path>` overrides the destination.
Invoke with `/code-explainer` in Claude Code or Factory Droid, `$code-explainer` in Codex,
`/skill:code-explainer` in Pi, or `@skills:code-explainer` in Devin. Harness invocation has not had live QA.
For Devin, run `xpl skill install --agent devin` inside the connected remote environment and target repo
before using the launcher. This writes its absolute CLI binding; there is no PATH fallback. Install Node
22.12 or newer and the xpl npm package inside that environment first. A local install does not provision
xpl remotely.

Alternatively, from the public [source repository](https://github.com/krimvp/xpl),
run `npm install && npm run build`, then `npm pack ./packages/cli/dist` and install the tarball with
`npm install -g --ignore-scripts ./krimvp-xpl-0.3.0.tgz`. For an offline tarball, use
`npm install -g --offline --ignore-scripts <tarball>`.

Use the installed skill's `bin/xpl` launcher for the commands below. Run from the repository root, or pass `--root /absolute/path/to/repo`. The authoring agent reads the code and writes the JSON patch; the user supplies the intent.

## Start with the intent

Gather these choices from the request, and state any inferred defaults before work:

- Repository root: the source tree to explain. For a change, it must contain the local git history and match the range's head.
- Audience: who will read the guide and what they already know.
- Question: what the guide should answer; an overview still needs a purpose, such as onboarding a maintainer.
- Name and target: a new kebab-case guide name, or the intended existing explanation to extend.
- Analysis mode: default `xpl index` tries optional precise tools; `--precise off` skips them for fast or offline indexing.

List `.explainer/*.explainer.json` before choosing the target. A name collision means choose another name or ask whether that existing guide is the intended target. Do not delete it, recreate it or silently extend it. Read existing views, tours and `userFields` before adding to a selected guide. Use fresh view and tour ids and the default `llm` actor; protected user text stays in place.

After installing the selected harness and running `xpl doctor --agent <name>`, explicitly invoke one of
these in that harness. For Devin, diagnosis checks project skill files but cannot verify cloud discovery
or authentication. If you installed the skill into a custom `--dir`, pass that folder to diagnosis with
`--skill-dir <folder>`.

```text
<harness-token> explain repo. Root: /work/orders. Audience: new maintainers. Question: how do requests reach storage? New guide: orders-overview. Use --precise off.
<harness-token> explain how failed jobs are retried. Root: /work/jobs. Audience: backend engineers. New guide: job-retries. Use --precise off.
<harness-token> explain change HEAD~1..HEAD. Root: /work/jobs. Audience: reviewers. Question: what changes for callers and what can fail? New guide: retry-change. Use --precise off.
```

Replace `<harness-token>` with `/code-explainer` for Claude Code or Factory Droid, `$code-explainer`
for Codex, `/skill:code-explainer` for Pi, or `@skills:code-explainer` for Devin.

To add another question to a known guide, say `Existing guide: orders-overview` instead of `New guide`. The agent can infer the root from its current directory and propose the audience or name when the request makes them clear. Ask one short question when a missing choice would change the result.

## Author through the installed commands

For GitHub input, run `xpl pr create <url> --name <guide> --audience "<reader>" --question "<intent>"`
with an outside `--cache-dir` and the installed `--skill-dir` when needed. It prepares exact commits,
creates the guide/change/draft through that installed launcher and returns a prompt for the installed
skill. Prefix it with the selected harness token listed above. Run that prompt in the installed agent;
no model starts automatically. Read `handoff.json`
and use its `command` prefix for every authoring command: owned Git paths and the installed CLI are
pinned, while inherited developer Git overrides are removed. Preserve the prepared head index and
existing scaffold; skip `index`, `new` and `change` below unless repair requires them. Complete the
outside draft through the installed skill, then use `xpl pr finish <input-directory> --cache-dir <cache>`.
Finish runs shared readiness/local export and rechecks both API commits; a changed base/head yields a
historical superseded result, never current. API failures promote no result. Explicitly create the new
PR input when it changes. `pr prepare` remains available for input-only local change authoring.

1. Run `xpl doctor` when setup is uncertain, then `xpl index` with the chosen mode. Report actual coverage, skipped analysis and `precise` or `heuristic` references. A valid anchor checks a location and freshness; it does not prove prose or runtime coverage.
2. For a new guide, run `xpl new <name> --title "<title>"`. For an existing guide, read it and run `xpl status <name>` before patching. A change also needs `xpl change <name> <base>..<head>`; follow `explain-change.md`.
3. Draft `repo`, `path` or `change`, with `--audience "<reader>" --question "<question>" -o /absolute/scratch/draft.json`. For a subsystem, find the entry id with `search` and `show` first. Put scratch outside the source root; a patch inside it changes the indexed snapshot.
4. Read the anchors' code. Use `quick.md`'s question-to-picture table to choose each view: a map for parts and relationships, a flow for decisions, a sequence for an anchored path in order. Set `scope.question` on each view, explain its visible participants and arrows, replace required TODOs with checked text, and write the tour. Preserve user-owned fields. Lint the candidate before applying it: `xpl lint <name> --patch /absolute/scratch/draft.json && xpl apply <name> /absolute/scratch/draft.json`.
5. Run `xpl validate <name>`, `xpl status <name>` until nothing required is unexplained, and `xpl anchors <name> tour:<slug>`. Do the accuracy pass and a newcomer re-read from `SKILL.md`; lint the stored guide again.
6. Run `xpl ready <name>` and fix every blocker. For intentional omissions or warning decisions, supply `--note "<reason>"` and pass the same note to export. Notes do not override errors; readiness checks source locations, freshness and required content, not prose truth or exhaustive runtime coverage.
7. Run `xpl bundle <name> -o /absolute/scratch/<name>.html` (`--files boundary` for a subsystem or change). The command rechecks readiness before writing. Open `xpl view <name>` locally for review, or inspect the saved HTML when working remotely. The snapshot works disconnected and carries its checked source and readiness report. Return the guide name, analysis/omission limits, export path and what was actually checked.

## Recover and explicitly rerun

| Failure                                      | Next action                                                                                                                                                                                                                                                                                                                   |
| -------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Node, launcher or bundled asset unavailable  | Run `xpl doctor`. Repair Node or reinstall the npm package or tarball; rerun `xpl skill install --dir <same-skill-dir>` after moving/updating the CLI. Preserve local skill edits by moving that directory aside before reinstalling.                                                                                         |
| Precise tools cannot run                     | Show the tool failure. If precise results are required, repair its toolchain/dependencies and retry. Otherwise explicitly rerun `xpl index --precise off` and keep `heuristic` labels; confirm calls by reading source.                                                                                                       |
| Index failed or reports a stale working tree | Fix the reported root, file or tool problem, then rerun indexing with the selected mode. Keep the existing guide. After source changes, follow `SKILL.md`'s anchor repair workflow before applying old patches.                                                                                                               |
| Agent stopped or provider access failed      | Repair authentication/provider access and explicitly invoke the same scope, root and guide again. Read the stored guide and outside patch first; do not rerun `new` over it. If lint passed but apply was interrupted, inspect status and the saved fields before retrying the patch.                                         |
| Guide name already exists                    | Keep it. Choose a fresh name, or use it only after the user selects it as the target.                                                                                                                                                                                                                                         |
| Local git range cannot be recorded           | Check `git rev-parse <base>` and `<head>` locally. Use a separate checkout at the requested head if the current source differs; preserve the user's checkout and uncommitted work. Index that head, then rerun `change`. Do not fetch or change branches without authorization.                                               |
| Lint/apply rejects the patch                 | Read the listed errors and anchor hints, repair the outside patch, lint it, then retry. An apply rejection writes nothing. A protected-field warning means the user's edit was kept; use a new view/tour when the protected one cannot accept the addition.                                                                   |
| Completion or freshness checks fail          | Read the blockers, finish the missing text and recheck the source. Rerun `xpl ready <name>`, then `bundle`. Use `bundle --draft` only for an explicitly requested repair preview, and label it as a draft. Do not use a drift override to make a ready export. Keep the existing guide and export until a replacement passes. |

Never recover by deleting `.explainer/`, rewriting an explainer JSON file, clearing user ownership or inventing anchor hashes. Preserve unfinished scratch so a later invocation can resume. Reader/export operations and `--precise off` indexing use installed assets without hosted xpl infrastructure. Agent authoring still needs its separately configured provider access. Creation starts no background generation service and publishes nothing.
