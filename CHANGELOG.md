# Changelog

User-facing changes are listed here. Versions link to their GitHub releases.

## [0.2.0] - Unreleased

Prepared for release from the `v0.2.0` tag. The package has not been published yet.

- Authors can keep a local xpl service connected to a repository, watch source changes, and find guides that
  need attention.
- Authors can edit guide text and source evidence in the viewer, group and move map items, and save reviews
  and questions with their guide.
- xpl can prepare commit-bound GitHub pull request inputs, create a guide from a PR, and stage and link
  versioned previews.
- Readers can search guides and supplied source offline, navigate saved versions, and answer source-linked
  questions.
- The xpl website now includes user documentation.

## [0.1.0] - 2026-10-05

First npm release of the xpl CLI, viewer, tree-sitter grammars, and code-explainer skill as
[`@krimvp/xpl`](https://www.npmjs.com/package/@krimvp/xpl), under the MIT license.

- Install the CLI globally with npm and install its bundled code-explainer skill with `xpl skill install`.
- Build source-linked explainers for TypeScript/JavaScript, Python and Go, with configuration file support.
- Explore explanations in the interactive viewer or export them as a self-contained HTML file.
- Node 22.12 or newer is required. The packaged artifact was exercised on Linux x64 under WSL2 with Node
  22.23.1; other platforms were not verified.

[0.2.0]: https://github.com/krimvp/xpl/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/krimvp/xpl/releases/tag/v0.1.0
