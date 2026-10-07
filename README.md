# xpl — code explainer

[Try the live example](https://krimvp.github.io/xpl/) or open the
[documentation](https://krimvp.github.io/xpl/docs/).

xpl links diagrams to source code and source code back to diagrams. An authoring agent writes an explanation as
data; xpl checks each source anchor against a static index before the guide can be exported. Share
it as a live view or one self-contained HTML file.

## Quick start

Install the public npm package with Node 22.12 or newer, then install the authoring skill:

```sh
npm install --global @krimvp/xpl
xpl skill install
```

Claude Code is the default target. For Codex, Pi, Factory Droid or Devin, select the harness with
`xpl skill install --agent <name>`. Codex, Pi and Droid install to `~/.agents/skills/code-explainer`;
Devin installs to the project `.agents/skills/code-explainer`. Use `--dir <path>` to choose a destination
for any harness. The npm package bundles the CLI and skill; harness setup and provider access are separate.

In the selected harness, invoke `code-explainer` with a reader and question. For example, in the
default Claude Code target:

```text
/code-explainer explain How does X work? Root: /path/to/repo. Audience: maintainers.
```

xpl checks that source locations exist and are current; it cannot verify the explanation's factual
claims or coverage. Install and configure the selected harness and its provider separately.

See [Getting started](https://krimvp.github.io/xpl/docs/getting-started/) for the first guide and
the [CLI reference](skill/code-explainer/reference/cli.md) for command options.

To create a checked draft directly from the CLI, run `xpl start <name> --question "..." --audience "..."`
in your repository, then `xpl view <name>` and complete the TODO text.

### GitHub pull requests

Prepare a PR's base and head as an isolated input with `xpl pr prepare`; author a guide and run `xpl
pr finish` to check it and export HTML. These commands do not publish. Optional
[CI preview publishing](docs-site/pages/workflows/pull-requests.md#optional-ci-authoring-and-publishing)
runs an explicitly configured author and updates the PR preview. A private target repository requires a
team-visible preview, with access controlled by the host. See the [CLI
reference](skill/code-explainer/reference/cli.md) for the full command options.

### Search, libraries and saved versions

Use the viewer's Search panel to find symbols, source, concepts and tour steps. `xpl bundle` can
include several checked guides for offline browsing; `xpl stage` stores immutable versions locally.
See [Find and share](https://krimvp.github.io/xpl/docs/workflows/find-and-share/).

### View and export a guide

Use `xpl view <guide>` for a local interactive view or `xpl bundle <guide> -o guide.html` for a
self-contained export. In Read mode, each step shows a short source excerpt beside its explanation;
"Open full code" opens the complete source range.

### Feedback and revision

Readers can attach feedback to source ranges. Import exported feedback with `xpl feedback <guide>
--import <file>`; review and accept proposed edits explicitly.

### Try it without Claude

The source repository includes a sample project:

```sh
cp -r fixtures/ts-jobrunner /tmp/jobrunner && cd /tmp/jobrunner
xpl index && xpl view jobrunner
```

## Optional repository service

`xpl service start <guide>` adds source-linked questions and feedback to the local viewer. It is
opt-in and runs on your machine. See the [CLI reference](skill/code-explainer/reference/cli.md) for
options.

## Using the CLI directly

The CLI can index, validate, lint, draft, view, bundle and revise guides without an authoring agent.
Run `xpl --help` or see the [CLI reference](skill/code-explainer/reference/cli.md).

### Editing in the viewer

The local viewer can save edits to the guide. Saved HTML is a snapshot; export it again after
changes. See [Edit and review](https://krimvp.github.io/xpl/docs/workflows/edit-and-review/).

### Author review

Review readiness and source anchors before sharing. `xpl ready <guide>` reports whether the guide
can be exported. See [Edit and
review](https://krimvp.github.io/xpl/docs/workflows/edit-and-review/).

### Explaining a change

Use `xpl change` to explain a diff between commits. Before-code claims are checked against the base
commit. The viewer marks changed lines and the changed words within paired rewrites. See the
[change workflow](https://krimvp.github.io/xpl/docs/workflows/change/).

### Architecture maps

Use `xpl draft repo` to build a starting map from the index, then add reader-focused explanations.
See [Architecture maps](https://krimvp.github.io/xpl/docs/workflows/explain/).

## Languages and precision

xpl indexes TypeScript, JavaScript, Python, Go, YAML, JSON and TOML. References are labeled precise
(SCIP) or heuristic. Use `--precise off` when optional semantic tools are unavailable. See [language
support](https://krimvp.github.io/xpl/docs/concepts/languages/).

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

See [CONTRIBUTING.md](CONTRIBUTING.md) and [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for
contributor guidance and design details.

## Docs

- [User documentation](https://krimvp.github.io/xpl/docs/)
- [Architecture](docs/ARCHITECTURE.md)
- [Product skill](skill/code-explainer/README.md)

## Feedback and security

Report bugs in [GitHub Issues](https://github.com/krimvp/xpl/issues). For security issues, use
[private vulnerability reporting](https://github.com/krimvp/xpl/security/advisories/new). See
[SECURITY.md](SECURITY.md) for supported versions.
