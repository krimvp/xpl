---
name: open-pr
description: Checklist for committing, pushing and opening or updating a pull request in xpl - the checks to run, commit style, the PR template, screenshots for UI and abstraction-level changes, docs and self-explainer sync. Use before every commit that will be pushed and before opening a PR.
---

# Open a PR

## 1. Prove it

The repo has no CI workflow yet, so these local checks are the gate. Fix anything red before pushing:

```sh
npm run typecheck
npm test                      # includes self-explainer.test.ts and skill-examples.test.ts
npm run format:check          # npm run format to fix
npm run test:e2e              # when packages/viewer, core derivation or bundle contents changed
```

Re-read your own diff (`git diff origin/main...`) as a reviewer would: what would make this wrong? Run
`ponytail-review` on it and take the cuts that are plainly right.

## 2. Keep the record true

- Docs, help text and the product skill match the change (`docs-sync`).
- `.explainer/xpl.explainer.json` still resolves: if `self-explainer.test.ts` fails, re-anchor in the same PR.
- Fixture explainers and acceptance tests are regenerated if a fixture changed.

## 3. Screenshots

If the change touches the viewer's UI or UX, or can change abstraction levels (what a map shows at the system,
service or code level, grouping, zoom, stubs, derived edges, package boundaries), run `pr-screenshots` and put
the Before/After images in the PR's Screenshots section. Not optional: a PR in these areas without images
says why nothing visible changed and includes the zero-change `index.md`.

## 4. Commit

Conventional commits scoped by package, subject as a plain statement of the new behaviour (`writing` skill).
One logical change per commit; a re-anchor of the self-explainer may be its own `docs(explainer):` commit.
End the message with whatever attribution trailer your harness requires.

## 5. Open

- Branch from `main`; never push to `main` directly or force-push a shared branch.
- Fill `.github/pull_request_template.md`: summary for users of xpl, how it works, how it was verified (the
  commands you ran and their result), screenshots, docs touched, risks.
- Keep the PR to one concern. Follow-ups go in the description as named items, not as drive-by edits.
- After pushing, watch CI and review comments; fix red CI at the root (`diagnose`), never by skipping tests.
