# Changelog

User-facing changes are listed here. Versions link to their GitHub releases.

## [0.3.0]

- xpl indexes Java repositories and named Ruby, PHP and Rust declarations. Rust support also resolves bounded
  same-file calls. Relationships are still labeled as heuristic when precise evidence is unavailable.
- Watched input capture reuses file-local extraction for unchanged files and passes changed-file facts to
  the snapshot build. It still resolves references and records configuration reads afresh.
- Authors can create an index-backed first draft with `xpl start` and complete commands and local guide names
  in the shell. Repository drafts can mark imported systems optional and include nested declarations.
- The existing Claude skill installer now also targets Codex, Pi, Factory Droid and Devin. An opt-in CI
  workflow can publish a source-linked PR preview.
- Readers can search supplied source across contained guide snapshots, navigate diagrams and linked code
  with arrow keys, inspect source excerpts while reading, and view diagram relationships as text.
- Published examples now cover xpl and Cobra alongside refreshed Vite and Zod guides. Phone maps and focused
  flows keep their controls and selected branches more accessible.

The `v0.2.3` and `v0.2.4` tags were failed release attempts and did not publish npm packages. This release
follows the last published package, 0.2.2.

## [0.2.2]

- The website adds four self-contained examples from Vite and Zod. Readers can open them in a browser or
  save them for offline reading, with links to each source revision and license.

## [0.2.1]

- The landing page links to the public GitHub repository. The shorter README points to the docs for detailed workflows.

## [0.2.0]

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

[0.3.0]: https://github.com/krimvp/xpl/compare/v0.2.2...v0.3.0
[0.2.2]: https://github.com/krimvp/xpl/compare/v0.2.1...v0.2.2
[0.2.1]: https://github.com/krimvp/xpl/compare/v0.2.0...v0.2.1
[0.2.0]: https://github.com/krimvp/xpl/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/krimvp/xpl/releases/tag/v0.1.0
