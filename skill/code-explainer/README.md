# code-explainer (Claude skill)

Turns "how does X work?", "give me an overview of this repo" or "help me present this code" into an interactive explainer: box-and-arrow and sequence diagrams plus a concept list, linked both ways to the code in a built-in editor. Claude writes the data (validated against a static index, so it cannot invent code); the viewer in this repo renders it.

## Install

1. Build the repo once (Node >= 22.12):

   ```sh
   cd <path to xpl repo>
   npm install && npm run build
   ```

2. Symlink the skill directory (a symlink, not a copy: the launcher finds the CLI relative to the real path of `bin/xpl`):

   ```sh
   # for every project
   mkdir -p ~/.claude/skills && ln -s "$PWD/skill/code-explainer" ~/.claude/skills/code-explainer
   # or for one project
   mkdir -p <project>/.claude/skills && ln -s "$PWD/skill/code-explainer" <project>/.claude/skills/code-explainer
   ```

3. Check it: `~/.claude/skills/code-explainer/bin/xpl --version` prints `0.0.0`. If it says the CLI is not built, repeat step 1. For a copy that is not inside the repo, set `XPL_CLI=<repo>/packages/cli/dist/xpl.mjs`.

## Use

In the repo you want to understand, ask Claude in plain words or with the skill's operations:

- `explain how a failed job gets retried`: a sequence view of the flow, a graph of the code involved, concepts (retry policy) anchored to code, config keys and tests.
- `explain this repo`: coarse architecture overview; deeper nodes stay unexplained until you expand them.
- `expand the queue package` (or click "Explain this" in `xpl view`; Claude drains the queue).
- `make a tour` of the views for a talk (present mode).

Claude indexes the repo, writes `.explainer/<name>.explainer.json`, and gives you an HTML bundle (`xpl bundle`, self-contained, the default in cloud sessions) or a local viewer (`xpl view`). `.explainer/index-*.json` is git-ignored automatically; commit the `*.explainer.json` files.

The index gets precise references from SCIP indexers when they can run (`npx` for TypeScript and Python, the Go toolchain for Go); without them it falls back to heuristic references and says so.

## Contents

| Path                        | What                                                                         |
| --------------------------- | ---------------------------------------------------------------------------- |
| `SKILL.md`                  | the skill: operations, workflow, hard rules                                  |
| `bin/xpl`                   | launcher for the built CLI (`packages/cli/dist/xpl.mjs`), symlink-safe       |
| `reference/patch-format.md` | every patch element with examples, merge rules, rejection messages and fixes |
| `reference/cli.md`          | every command with options and sample output                                 |
| `reference/examples/`       | worked patches to imitate: `go-retry` (a question), `py-overview` (a repo)   |
