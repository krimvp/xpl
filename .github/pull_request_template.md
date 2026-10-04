## Summary

<!-- What changes for a user of xpl (a reader of an explainer, someone running the CLI, Claude using the
skill), in 2-4 plain sentences. Then how it works, briefly. -->

## Verification

<!-- The commands you ran and what they showed. -->

- [ ] `npm run typecheck`
- [ ] `npm test` (includes the self-explainer and skill-examples checks)
- [ ] `npm run format:check`
- [ ] `npm run test:e2e` (viewer, graph derivation or bundle changes)
- [ ] `test-audit` skill run on the tests this change adds or touches (strongly recommended): <!-- result -->
- [ ] Ran the real thing: <!-- e.g. `xpl index && xpl validate` on a fixture copy, a real repository -->

## Screenshots

<!-- Required when the PR changes the viewer's UI or UX, or can change abstraction levels (what a map shows
at the system, service or code level; grouping, zoom/opens, stubs, lifted or derived edges, draft levels,
package boundaries). Before/After from `scripts/pr-screenshots.sh origin/main --publish` (prints this section), see
.claude/skills/pr-screenshots/SKILL.md. Above each image, write one or two sentences explaining the previous
behaviour, the expected behaviour after the change, and where to look when the difference is subtle.
If nothing visible changed, say why and paste the compare/index.md summary. Otherwise write "n/a". -->

## Docs

- [ ] `docs/ARCHITECTURE.md`, README, `--help` text and `skill/code-explainer` match the change, or need no change
- [ ] `.explainer/xpl.explainer.json` re-anchored if code under its anchors moved

## Risks and follow-ups

<!-- What could break, what you did not check, named follow-ups. -->
