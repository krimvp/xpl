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

Then run `test-audit` (strongly recommended): gate every test the change adds or touches, and check the
tests that own the changed code. Fix what it finds before pushing, and mention the result in the PR.

## 2. Keep the record true

- Docs, help text and the product skill match the change (`docs-sync`).
- `.explainer/xpl.explainer.json` still resolves: if `self-explainer.test.ts` fails, re-anchor in the same PR.
- Fixture explainers and acceptance tests are regenerated if a fixture changed.

## 3. Screenshots

`scripts/needs-screenshots.sh` decides. When it says they are needed, run
`scripts/pr-screenshots.sh origin/main --publish` (the `pr-screenshots` skill) without asking and paste the
printed Screenshots section into the PR description, with one line per image on what to look at. With no
visible change it prints a section saying so; paste that. CI posts the same images as a PR comment.

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
