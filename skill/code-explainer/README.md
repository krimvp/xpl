# code-explainer skill

Turns "how does X work?", "give me an overview of this repo", "explain this PR" or "help me present this code" into a guide. A guide is a short tour with a summary first, and maps, flows and sequence diagrams linked both ways to the code. The agent writes the text as data. xpl checks every code link against a static index, so the guide cannot point at code that is not there.

## Install

1. Install the CLI from npm (Node 22.12 or newer), and check it:

   ```sh
   npm install --global @krimvp/xpl
   xpl doctor
   ```

2. Install the bundled skill, with a launcher bound to the installed CLI:

   ```sh
   xpl skill install
   ```

3. Check the launcher with `<skill-dir>/bin/xpl --version`.

Claude Code is the default agent. [Create a guide](reference/create.md#install) lists the other agents, their
skill directories and invocations, updates, and the install from source. `XPL_CLI=<path to xpl.mjs>` overrides
the launcher binding. In a source checkout, `bin/xpl` finds `packages/cli/dist/xpl.mjs` on its own.

## Use

Start with [Create a guide](reference/create.md): choose the repository root, the reader, the question, and a new or existing guide. The agent writes the patch; you write no JSON. That page has three example prompts, and recovery steps for interrupted runs.

In the repo you want to understand, ask your agent in plain words or with the skill's operations:

- `explain how a failed job gets retried`: a tour that answers the question, with a map of the code involved and a flow of the decisions, anchored to code, config keys and tests.
- `explain this repo`: what the project is, its parts on one map, and the main path; deeper boxes stay unexplained until you expand them.
- Add "quickly" for a fast answer: one diagram and a 5-step tour.
- `explain change main..my-branch` (or a PR or MR you name): what changes for users, where, who else is affected, the tests and the risks. The agent reads the diff locally with git and never posts anything. The page shows the diff, the code before the change, and which boxes are new or changed.
- `expand the queue package`, or click "Explain this" in `xpl view`.
- `feedback`: in `xpl view`, type what should change under "Explain this" ("too long", "show the caller") and send it. Then invoke the skill with `feedback`. From a saved page, use Feedback > Export feedback JSON, then `xpl feedback <name> --import feedback.json`. Saving a request starts no work.
- `make a tour` of the views for a presentation (Present mode).

The agent indexes the repo and starts from a draft that `xpl draft` builds from the index (the structure, with no text). It writes and checks the text, saves `.explainer/<name>.explainer.json` and passes `xpl ready <name>`. Then it gives you an HTML file (`xpl bundle`, the default in cloud sessions) or a local viewer (`xpl view`). `.explainer/index-*.json` is git-ignored automatically; commit the `*.explainer.json` files.

The index gets precise references from SCIP indexers when they can run: `npx` for TypeScript and Python, the Go toolchain for Go. Without them it falls back to heuristic references and says so.

`xpl index --precise off`, local viewing and the HTML file need no hosted xpl service after setup. Precise
tools, toolchains and dependencies may need network access. Agent authoring needs the agent's own sign-in
and provider access. The skill runs only when you invoke it, with the token from
[Create a guide](reference/create.md).

## Contents

| Path                          | What                                                                                                 |
| ----------------------------- | ---------------------------------------------------------------------------------------------------- |
| `SKILL.md`                    | the skill: hard rules, the decision path, the scopes, the tour spine and budgets, accuracy           |
| `bin/xpl`                     | launcher bound by the installer to the installed CLI; `XPL_CLI` overrides it                         |
| `reference/create.md`         | install, example prompts, new or existing target, the PR handoff and recovery                        |
| `reference/quick.md`          | what every patch needs, which diagram answers which question, what the index misses                  |
| `reference/revise.md`         | how to answer saved feedback                                                                         |
| `reference/writing.md`        | plain-language rules (Orwell, ASD-STE100), the word list, the fields, before/after rewrites          |
| `reference/explain-change.md` | how to explain a PR, MR or branch diff: before/after checks, callers, tests                          |
| `reference/explain-map.md`    | how to map every file in plain words, and keep the map current                                       |
| `reference/patch-format.md`   | every patch element with examples, merge rules, rejection messages and fixes                         |
| `reference/cli.md`            | every command with options and sample output                                                         |
| `reference/examples/`         | worked patches to imitate: `go-retry` (a question), `py-overview` (a repo, from the system map down) |
