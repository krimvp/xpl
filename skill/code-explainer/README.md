# code-explainer skill

Turns "how does X work?", "give me an overview of this repo", "explain this PR" or "help me present this code" into an interactive explainer: a short guided tour with a summary first, and maps, process flows and sequence diagrams linked both ways to the code in a built-in editor. The authoring agent writes the data (validated against a static index, so it cannot invent code); the viewer in this repo renders it.

## Install

1. Install the CLI from npm (Node >=22.12). The full install test runs on Linux x64/WSL2;
   platform CI checks packed install and offline reading on macOS and Windows:

   ```sh
   npm install --global @krimvp/xpl
   xpl doctor
   ```

2. Install the bundled skill, with a launcher bound to the installed CLI:

   ```sh
   # Choose one agent; omit --agent for the default Claude Code target
   xpl skill install --agent pi --dir <project>/.agents/skills/code-explainer
   ```

3. Check the installed launcher at `<skill-dir>/bin/xpl --version`. Claude Code is the default target. Use
   Use `--agent codex`, `--agent pi`, `--agent droid` or `--agent devin` to select one. Omit `--agent`
   for Claude Code. `--dir <path>` sets the destination. Run Devin's install from the target repo.
   Codex, Pi and Factory Droid use `~/.agents/skills/code-explainer`; Devin uses the target project's
   `.agents/skills/code-explainer`. In Devin, run `xpl skill install --agent devin` inside the connected
   remote environment and target repo before using the launcher. Install Node >=22.12 and xpl there first;
   the launcher has no PATH fallback, and a local install does not provision xpl remotely. Harness
   invocation has not had live QA.

Alternatively, from the [source repository](https://github.com/krimvp/xpl), run `npm install && npm run build`,
then `npm pack ./packages/cli/dist` and `npm install -g --ignore-scripts ./krimvp-xpl-0.3.0.tgz`.
A maintainer's tarball can also be installed with `npm install -g --offline --ignore-scripts <tarball>`.

After updating or moving the CLI, rerun `xpl skill install` with the same destination. No source checkout
or manual symlink is needed. Updates refuse unmanaged directories, symlinks and local skill edits; move
the old directory aside to preserve it, then install again. `XPL_CLI=<path to xpl.mjs>` overrides the
launcher binding. For source development, `bin/xpl` still finds `packages/cli/dist/xpl.mjs` in its checkout.

## Use

Start with [Create a guide](reference/create.md): choose the repository root, reader, question and a new or existing guide. The agent writes the patch; you do not need to construct JSON. The guide includes three installed invocation examples and recovery steps for interrupted runs.

In the repo you want to understand, ask your harness in plain words or with the skill's operations:

- `explain how a failed job gets retried`: a tour that answers the question, with a map of the code involved and a flow of the decisions, anchored to code, config keys and tests.
- `explain this repo`: what the project is, its parts on one map, and the main path; deeper nodes stay unexplained until you expand them.
- Add "quickly" for a fast answer: one picture and a 5-step tour.
- `explain change main..my-branch` (or a PR or MR you name): what changes for users, where, who else is affected, the tests and the risks. The harness reads the diff locally with git and never posts anything. The page shows the diff, the code before the change, and which boxes are new or changed.
- `expand the queue package` (or click "Explain this" in `xpl view`; the next explicit pass records selected outcomes).
- `feedback`: in `xpl view`, type what should change under "Explain this" ("too long", "show the caller") and send it; then invoke the skill with your harness token and `feedback`. Saved pages use Feedback > Export feedback JSON and `xpl feedback <name> --import feedback.json` first. Requests retain IDs, source ranges, original snapshot hashes and outcome reasons. Saving starts no generation.
- `make a tour` of the views for a talk (present mode).

The harness indexes the repo, starts from a draft that `xpl draft` builds from the index (the structure, with no text), writes and checks the text, saves `.explainer/<name>.explainer.json`, passes `xpl ready <name>`, and gives you an HTML bundle (`xpl bundle`, self-contained, the default in cloud sessions) or a local viewer (`xpl view`). `.explainer/index-*.json` is git-ignored automatically; commit the `*.explainer.json` files.

The index gets precise references from SCIP indexers when they can run (`npx` for TypeScript and Python, the Go toolchain for Go); without them it falls back to heuristic references and says so.

`xpl index --precise off`, local viewing and self-contained HTML reading/export need no hosted xpl service
after setup. Precise tool bootstrap, toolchains and dependencies may need network access. Agent authoring
has separate harness authentication and provider network requirements. Generation runs only when you
invoke the skill; no continuously running authoring worker is required.

Invoke the skill with the selected harness's token: `/code-explainer` in Claude Code or Factory Droid,
`$code-explainer` in Codex, `/skill:code-explainer` in Pi, or `@skills:code-explainer` in Devin. These
invocations have not had live QA.

## Contents

| Path                          | What                                                                                                 |
| ----------------------------- | ---------------------------------------------------------------------------------------------------- |
| `SKILL.md`                    | the skill: workflow, the three scopes, drafts, tour, accuracy, hard rules                            |
| `bin/xpl`                     | launcher bound by the installer to the installed CLI; `XPL_CLI` overrides it                         |
| `reference/create.md`         | installed creation prompts, new/existing target selection and recovery                               |
| `reference/writing.md`        | plain-language rules, what goes in which field, before/after rewrites                                |
| `reference/explain-change.md` | how to explain a PR, MR or branch diff: before/after checks, callers, tests                          |
| `reference/patch-format.md`   | every patch element with examples, merge rules, rejection messages and fixes                         |
| `reference/cli.md`            | every command with options and sample output                                                         |
| `reference/examples/`         | worked patches to imitate: `go-retry` (a question), `py-overview` (a repo, from the system map down) |
