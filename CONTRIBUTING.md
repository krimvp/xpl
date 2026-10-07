# Contributing

Thanks for helping improve xpl. Before opening a pull request, read the relevant section of
[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) and follow the repository guidance in [AGENTS.md](AGENTS.md).

## Set up

Use Node 22.12 or newer. Install dependencies with `npm install`. The repository sets
`ignore-scripts=true` so package install hooks do not run; xpl builds its required assets explicitly.

Run these checks before pushing:

```sh
npm run typecheck
npm test
npm run format:check
```

Run `npm run test:e2e` for viewer changes. CI runs the checks for pull requests.

## Keep in mind

- Fixture line numbers are used by tests and explainers. Do not reformat files in `fixtures/`.
- Files in `docs/` are hand-formatted; keep their existing style.
- Do not hand-edit `*.explainer.json`. Use `xpl apply` or `xpl change`.
- Changes to code described by xpl's own explainer may require updating its anchors. The
  `packages/cli/test/self-explainer.test.ts` test identifies stale references.
- Tree-sitter grammar versions must match the pinned `web-tree-sitter` ABI. Playwright is pinned to the
  preinstalled browser version; do not run `playwright install` locally.

## Pull requests

Use [the pull request template](.github/pull_request_template.md). Explain what changes for a user, then list
the checks you ran. Add before-and-after screenshots for viewer changes and changes that affect what a map
shows at system, service or code level. CI checks this requirement and can publish screenshots.

Use a conventional commit subject scoped to the package, such as `fix(indexer): keep heuristic references
labeled`. Open a branch from `main`, and follow the required checks and reviews shown by GitHub. Release tags
use the `v*` format and are created by maintainers as part of a release.

For a pull request from a fork, a maintainer must approve the workflow run before CI uses the self-hosted
runner. Maintainers review workflow changes before approving it.

## More detail

- [AGENTS.md](AGENTS.md) has the full commands, invariants and review process.
- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) describes the package boundaries and system design.
- [SECURITY.md](SECURITY.md) explains how to report a vulnerability.
