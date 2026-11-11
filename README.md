# xpl — code explainer

xpl makes a guide to your code: diagrams linked to the source in both directions. Click a box and its code
lights up. Put the cursor in the code and the boxes that cover it light up. An agent such as Claude writes the
guide, and xpl checks that every code link points at code that exists now. xpl does not check that the text is
true; a person reviews that. Share a guide as a local page or as one HTML file.

![A sequence of how a job is dispatched. The Runner.dispatch lifeline is selected, and its code in runner.ts is highlighted beside it.](site/images/jobrunner-light.png#gh-light-mode-only)
![A sequence of how a job is dispatched. The Runner.dispatch lifeline is selected, and its code in runner.ts is highlighted beside it.](site/images/jobrunner-dark.png#gh-dark-mode-only)

A guide opens on its tour: steps in order, each with a small diagram and the code it links to. The Map, Flow
and Code tabs show the whole diagrams and the files. [Open this example](https://krimvp.github.io/xpl/demo/)
in your browser, or read the [documentation](https://krimvp.github.io/xpl/docs/).

## Quick start

Install the CLI and the skill (Node 22.12 or newer; Claude Code is the default agent):

```sh
npm install --global @krimvp/xpl
xpl skill install
```

In Claude Code, in your repository, ask a question and name the reader:

```text
/code-explainer explain How does X work? Audience: maintainers.
```

`/code-explainer` is a chat command in Claude Code, not a shell command. The agent indexes the repository (xpl
lists its files, its symbols and the references between them), writes the guide and opens it. Other agents (Codex, Pi, Factory Droid, Devin) are in the
[install options](https://krimvp.github.io/xpl/docs/skill/create/#install). Shell completion and the
supported platforms are in [Getting started](https://krimvp.github.io/xpl/docs/getting-started/).

### View and export a guide

`xpl view <guide>` opens a guide in the browser and saves your edits to it. `xpl bundle <guide> -o guide.html`
writes one HTML file that holds the guide and its code, for offline reading. Each tour step shows a short
excerpt of its code; "Show code" opens the full range.

### Watch a change while you make it

Run `xpl live` in your repository and keep the page it opens in a second window while you or an AI assistant
edit the code. After every edit, within a few seconds and without a reload, the page shows:

- **What changed**, on the left: how many files and lines since the base ("since origin/main", or "since you
  started"), then each changed part of the project with its files, the functions the change added or edited,
  and the explanation once your assistant wrote one. A part or file the last edit touched says "just changed"
  until you click the page. Click an entry to see its box; click its `+3 −1` to see its diff.
- **The map**, always opened at the top: who uses the project, the project, what it relies on. A box that
  holds a change is outlined and says what it holds ("2 changed · 1 new"); a new box is filled teal, a changed
  one orange; a deleted file is a dashed, struck-through box that says "Removed" and opens its old code. Open a
  box to go down a level: its parts, then a folder's files, then the code with the diff.
- **Before | Changes | Now**, in the header: the architecture before the change (what it added hidden, what it
  removed back, the code before), with the change marked, or as it is now.

Ask your assistant to "explain live" after each task (`/code-explainer explain live`), or start
`xpl live --backend claude` to have Claude Code write the explanation once the code has been quiet for a while.

### Try it without Claude

Open a finished guide in your browser: the [examples](https://krimvp.github.io/xpl/#more-examples) explain
Vite, Zod, Cobra and xpl itself. Each one is a single HTML file that you can save and open offline.

To make a draft of your own repository without an agent, run these commands in the repository. `xpl index`
builds the index. `xpl outline` lists the ids; pick the function where the answer starts (with or without its
`sym:` prefix):

```sh
xpl index --precise off
xpl outline --kind function,method --depth 9
xpl start first-guide --question "How does a request reach the database?" \
  --entry src/api.ts#handleOrder --audience maintainers --precise off
xpl view first-guide
```

The draft holds the boxes, the steps and their code links, with TODO text for you to write. Without
`--entry`, `xpl start` drafts a map of the whole repository instead of the path that answers the question.
Write the text in the draft patch that `xpl start` prints, and run `xpl apply first-guide <draft patch>`.
`xpl view` can also edit the step notes (Edit > **Edit the tour**) and each box's text (**Edit text** in its
details), but not the titles or the tour summary. `xpl lint first-guide` and `xpl ready first-guide` list what is
still missing.

From a source checkout of xpl, you can also open the sample job runner:

```sh
cp -r fixtures/ts-jobrunner /tmp/jobrunner && cd /tmp/jobrunner
xpl index && xpl view jobrunner
```

## What you can explain

- **A question** about part of a project: "How does a failed job get retried?" One map and one flow, then a
  tour. See [Explain a question or a repository](https://krimvp.github.io/xpl/docs/workflows/explain/).
- **A whole repository**, from the top down: the system, the services inside it, then the code.
  `xpl draft repo` drafts the maps from the index.
- **A change** between two commits or a pull request: the diff, the code before, and the boxes that are new or
  changed. See [Explain a change](https://krimvp.github.io/xpl/docs/workflows/change/) and
  [GitHub pull requests](https://krimvp.github.io/xpl/docs/workflows/pull-requests/).
- **Every file**, in plain words: `xpl draft map` drafts one map per folder, with one sentence per file, for
  code you did not write line by line. `xpl update` brings it up to date after the code changes.
- **What you are changing, while you change it**: `xpl live` runs next to your editor or AI assistant. After
  every edit it redraws the maps from the system down to the files and marks what changed since the base. Ask
  your assistant to explain the change after each task (`reference/live.md`), or let `--backend claude` do it.
- **An idea or a plan** before the code exists: sketch boxes, drawn dotted and linked to no code.
- **A type**: `xpl draft class` maps what a class extends and implements; `xpl draft states` maps the states
  of a status type and the functions that change them.
- **The data**: `xpl draft data` maps what data the code keeps. Each type is a table with a row per field,
  and an arrow goes from a field to the type it holds. Click a row to see the field's code.

`xpl health` lists common problems in a repository: secrets in the code or in variables sent to the browser,
committed `.env` files, code files over 1,000 lines and files that nothing uses. It is a quick check, not a
security audit. It exits 0 with or without findings, and 1 when there is no index.

Readers can search a guide, leave feedback on a box or on lines of code, and ask questions through the
optional local service. See
[Search and saved versions](https://krimvp.github.io/xpl/docs/workflows/find-and-share/),
[Feedback and revision](https://krimvp.github.io/xpl/docs/workflows/feedback/) and
[The local service](https://krimvp.github.io/xpl/docs/workflows/service/).

## Languages and precision

xpl indexes TypeScript, JavaScript, Python, Go and Java, and the keys of YAML, JSON and TOML files. Rust has
experimental declarations, some heuristic calls and the `mod` and `use` imports within the package. Ruby and
PHP have named declarations and no references.

Every reference has one of two labels. **precise** (checked by a language tool): from a SCIP indexer.
**heuristic** (matched by name): from xpl's own matching by name and scope, a hint to confirm in the code. Web
requests (`fetch`, axios, `requests`, `httpx`, Go `net/http`) link to the route that answers them, and these
links are always heuristic. See
[Languages and precision](https://krimvp.github.io/xpl/docs/concepts/languages/).

## Using the CLI directly

The CLI indexes, drafts, checks, views, exports and revises guides without an agent. Run `xpl --help`, or see
the [CLI reference](skill/code-explainer/reference/cli.md).

## Repository layout

- `packages/core`: schema, anchors, validation and graph logic.
- `packages/indexer`: file discovery and language analysis.
- `packages/cli`: the `xpl` command.
- `packages/viewer`: interactive diagrams and source view.
- `skill/code-explainer`: the installable authoring skill.
- `docs/`: architecture and project notes.

## Development

Use Node 22.12 or newer. From the repository root:

```sh
npm install
npm run build
npm run typecheck
npm test
npm run format:check
```

See [CONTRIBUTING.md](CONTRIBUTING.md) for contributor guidance.

## Docs

- [User documentation](https://krimvp.github.io/xpl/docs/)
- [Product skill](skill/code-explainer/README.md)

## Feedback and security

Report bugs in [GitHub Issues](https://github.com/krimvp/xpl/issues). For security issues, use
[private vulnerability reporting](https://github.com/krimvp/xpl/security/advisories/new). See
[SECURITY.md](SECURITY.md) for supported versions.
