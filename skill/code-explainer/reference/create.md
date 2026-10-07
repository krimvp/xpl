# Create a guide

## Install

Install from npm (Node 22.12 or newer):

```sh
npm install --global @krimvp/xpl
xpl skill install
xpl doctor --agent claude
```

Alternatively, from the public [source repository](https://github.com/krimvp/xpl),
run `npm install && npm run build`, then `npm pack ./packages/cli/dist` and
`npm install -g --ignore-scripts ./krimvp-xpl-0.2.2.tgz`. Install a maintainer's tarball offline with
`npm install -g --offline --ignore-scripts <tarball>`, then run `xpl skill install`.
Claude Code needs separate installation, authentication and provider access.

Use the installed skill's `bin/xpl` launcher for the commands below. Run from the repository root, or pass `--root /absolute/path/to/repo`. The authoring agent reads the code and writes the JSON patch; the user supplies the intent.

## Start with the intent

Gather these choices from the request, and state any inferred defaults before work:

- Repository root: the source tree to explain. For a change, it must contain the local git history and match the range's head.
- Audience: who will read the guide and what they already know.
- Question: what the guide should answer; an overview still needs a purpose, such as onboarding a maintainer.
- Name and target: a new kebab-case guide name, or the intended existing explanation to extend.
- Analysis mode: default `xpl index` tries optional precise tools; `--precise off` skips them for fast or offline indexing.

List `.explainer/*.explainer.json` before choosing the target. A name collision means choose another name or ask whether that existing guide is the intended target. Do not delete it, recreate it or silently extend it. Read existing views, tours and `userFields` before adding to a selected guide. Use fresh view and tour ids and the default `llm` actor; protected user text stays in place.

After installing/authenticating Claude Code and running `xpl doctor --agent claude`, explicitly invoke one of these in that agent. If you installed the skill somewhere other than `~/.claude/skills/code-explainer` (for example a project's `.claude/skills/code-explainer` or a custom `--dir`), pass that folder: `xpl doctor --agent claude --skill-dir <folder>`.

```text
/code-explainer explain repo. Root: /work/orders. Audience: new maintainers. Question: how do requests reach storage? New guide: orders-overview. Use --precise off.
/code-explainer explain how failed jobs are retried. Root: /work/jobs. Audience: backend engineers. New guide: job-retries. Use --precise off.
/code-explainer explain change HEAD~1..HEAD. Root: /work/jobs. Audience: reviewers. Question: what changes for callers and what can fail? New guide: retry-change. Use --precise off.
```

To add another question to a known guide, say `Existing guide: orders-overview` instead of `New guide`. The agent can infer the root from its current directory and propose the audience or name when the request makes them clear. Ask one short question when a missing choice would change the result.

## Author through the installed commands

For GitHub input, run `xpl pr create <url> --name <guide> --audience "<reader>" --question "<intent>"`
with an outside `--cache-dir` and the installed `--skill-dir` when needed. It prepares exact commits,
creates the guide/change/draft through that installed launcher and returns an explicit `/code-explainer`
invocation. Run that prompt in the installed agent; no model starts automatically. Read `handoff.json`
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
4. Read the anchors' code. Replace required TODOs with checked text, explain visible participants and boxes, and write the tour. Follow `SKILL.md` and `writing.md`; preserve user-owned fields. Lint the candidate before applying it: `xpl lint <name> --patch /absolute/scratch/draft.json && xpl apply <name> /absolute/scratch/draft.json`.
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
