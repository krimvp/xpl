# explain change: a PR, an MR or a branch diff

Use this guide when the user wants to understand or review a change: "explain PR 42", "what does this branch change", "walk me through `main..feature`", "explain my uncommitted changes". The result is the usual explainer, written for a reviewer: what changes for users first, then where, then who else is affected, then the tests and the risks.

Reviewers rely most on two kinds of claim: what the code did **before**, and what **every caller** does now. In earlier explainers these were the claims that were wrong. This guide is mostly about checking them.

The examples below use an invented change to `fixtures/ts-jobrunner` in the xpl repo: `loadConfig` now rejects a config whose `retry.maxDelayMs` is lower than `retry.baseDelayMs`.

## 1. Rules

- **Read-only on the user's repo.** Never post, comment, review, approve, label or push: no `git push`, no `gh pr comment`, `gh pr review`, `glab mr note`, and no API call that writes.
- **Fetch only when asked.** Fetch a PR or MR ref only when the user asked you to explain that PR or MR and it is not in the checkout (`git fetch origin pull/<n>/head:pr-<n>` on GitHub, `git fetch origin merge-requests/<n>/head:mr-<n>` on GitLab). Otherwise ask for the base and the head.
- **Never change the user's checkout.** No `checkout`, `switch`, `stash`, `reset` or `gh pr checkout` on their working tree.
- **Reading the base is always fine:** `git show <base>:<path>`, `git diff`, `git log`, `git grep <pattern> <base>`.
- **Running a quick check on the base is fine without asking**, in a copy outside the repo: `git archive <base> <paths> | tar -x -C <scratch dir>`, then run a script or one test there. Do the same for the head when you need both. Test dependencies may come from a throwaway environment outside the repo (for example `uv run --no-project --with pytest ...`, or `npx` in the scratch dir). Never install into the repo or write inside it (`.explainer/` aside).
- **Ask first** only for what changes git state or the user's files: `git worktree add`, a checkout, a branch.
- **Anchors resolve at head only.** The index is built from the working tree. Base code cannot be anchored, so every "before" claim is checked by hand (section 4).

## 2. Find the base and the head

| The user gives                               | Base                                                        | Head             |
| -------------------------------------------- | ----------------------------------------------------------- | ---------------- |
| a range `A..B`                               | `A`                                                         | `B`              |
| a branch name                                | `git merge-base <target> <branch>` (target: usually `main`) | the branch       |
| one commit `C`                               | `C^`                                                        | `C`              |
| a PR or MR number, and asked you to fetch it | the merge base with its target branch                       | the fetched ref  |
| "my changes", nothing else                   | `HEAD`                                                      | the working tree |

Write the base as a commit id (`git rev-parse --short <base>`) and use that id in every command below. For uncommitted changes, drop `..<head>` from the commands: `git diff <base>` compares with the working tree.

The explainer describes the head, and `xpl index` reads the working tree. When the head is checked out, work there. Otherwise ask the user to check it out, or ask before you add a separate worktree (`git worktree add --detach ../<repo>-head <head>`, then `--root` on every `xpl` command).

## 3. Read the change

1. **Size and files:** `git diff --stat <base>..<head>`. Note the counts for the summary: files, added and removed lines, test files.
2. **Intent:** `git log --format='%h %s%n%b' <base>..<head>`, and the PR or MR description when the user gave one. The summary may say why the change was made only from these sources, and says so ("The commit message says ...").
3. **Hunks:** `git diff <base>..<head>`. For each hunk, note the symbol that holds it (the `@@` line usually names it; `xpl search` finds a line). A symbol that exists only in the base cannot be anchored: describe it as "Before: ..." and anchor the head code that replaced it.
4. Read each changed symbol at head with `xpl show <id> --refs`, and at base with `git show <base>:<path>`.

## 4. Check every "before" claim in the base code

A "before" claim is any sentence about the old code: "used to", "no longer", "already", "now", "instead of", "before this change".

- Read the base code of the claim: `git show <base>:<path>`. Read what decided the old behaviour too: the callers (`git grep -n <name> <base> -- <dir>`), the defaults, the exception paths, and the library calls that can fail. In the example, the hunk only adds a check to `loadConfig`. What happened before is in `backoffDelay`, which the diff does not touch: `Math.min(baseDelayMs * 2 ** (attempt - 1), maxDelayMs)` returned `maxDelayMs` for every retry.
- **Never infer old behaviour from the hunk alone.** Removed lines show what the old code said, not what it did for every input. A removed `split(":")[0]` cuts at the first `:`, not the last; an old lookup may have raised an exception that a caller turned into a 500. Read the code, and run it on the base when the result depends on a library or on input values (section 1).
- Write the claim as **"Before: ... Now: ..."**, with the input that shows the difference: "Before: `maxDelayMs: 100` with `baseDelayMs: 500` made each retry wait 100 ms. Now: `loadConfig` throws `config: retry.maxDelayMs must be at least retry.baseDelayMs`."
- When you could neither read nor run what decides a claim, leave the claim out and list it as not checked in your reply.
- Re-check every before/after claim once more at the end (SKILL.md, "Final checks").

## 5. Who else is affected (blast radius)

For each changed symbol, in this order:

1. **Direct callers:** `xpl refs <id> --in --kind call`. When it finds none for a method reached through a variable (an object called as a function, a stored handler), use `search` (SKILL.md, "Tracing traps"). Anchor each caller that changes behaviour, and say why. List the others in one note as unaffected, with the reason. (Example: `main` and the config test call `loadConfig`.)
2. **Consumers of a changed result:** when the change alters what a function returns or builds (a value, a URL, a status, an error), follow one more level: `xpl refs <caller> --in`, or `refs <type> --in --kind call` for a constructor. (Example: `runnerConfig` passes the retry settings to `Runner`, so `backoffDelay` sees only valid values now.)
3. **Public entry points:** is the symbol exported? `search` for its name in `index.ts`, `__init__.py`, `__all__`, `export {`, and the package's public files. A change to an exported function affects users outside the repo.
4. **Siblings:** other code that does the same job without the changed helper. `search -i` for the key, header, error text or concept. Say whether each one already behaves the new way, and anchor it. (Example: does anything else read `retry.*` keys?)

Unchanged code that you show for context is described as unchanged: "Unchanged: `backoffDelay` still caps the delay at `maxDelayMs`." Never title a view "Code changed by ..." when it shows unchanged code.

## 6. Tests and gaps

- Anchor **every changed file at least once, test files too** (role `test`). To compare, list the anchored files with `xpl anchors <name> --json` (`elements[].anchors[].file`) next to `git diff --name-only <base>..<head>`.
- Find the tests that use the changed symbols: `xpl refs <id> --in` lines in test files, `xpl search <name> --under 'test/**'`.
- For each behaviour change and each new branch (every `if`, early return or skip condition the change adds or moves), name the test that covers it, new or old. Name each branch that no test covers ("no test sends a non-HTTP scope through the new check"). Check a gap with `search` in the tests before you claim it.
- A test that also passes on the base **does not show the old bug**. It can still guard the new code: say what it checks ("checks that an error from `send` reaches the caller"). Do not call a test useless or redundant without evidence, such as a change to the new code that the test does not catch.

## 7. The tour: review order

One tour in this order (understanding the change is the main review task, and files shown last get fewer comments). A change tour may have up to 12 steps.

| Step | Title says                        | Shows                                                                           |
| ---- | --------------------------------- | ------------------------------------------------------------------------------- |
| 1    | what changes for users            | the map of the change; `code`: the 1-2 hunks that make the change               |
| 2    | where the change enters           | the public function, command or route that reaches the change (often unchanged) |
| 3+   | each changed piece, one step each | the hunk, in call order from the entry; notes written "Before: ... Now: ..."    |
| next | who else is affected              | callers, consumers, public exports and siblings (section 5)                     |
| next | tests and gaps                    | the changed test files; what no test covers                                     |
| last | risks and open questions          | the worst realistic failure, edge cases, inputs that still behave the old way   |

Keep the first step (the behaviour change) and the last (risks) in place. To fit a small change, merge the rest:

- When each changed piece is itself an entry point (three handlers, each changed), drop step 2: each piece's step says how a request reaches it.
- Two small pieces that change for the same reason share one step.
- "Who else is affected" and "tests and gaps" may share a step when both are short.

**The risk** names the worst realistic failure the change can cause, with the input that triggers it, checked against the code: what a caller or a wrapper of the changed code does that now fails, hangs or behaves differently. Do not narrow it to tests when real callers can hit it too, and do not inflate it beyond what the code allows. The tour summary carries it (`writing.md` section 4), as do the last step and the reply.

Views:

- **Map of the change** (graph, 4-8 boxes): the changed symbols or files, their direct callers, and the tests. Several changed test files, or several changed tests in one file, become one group box ("tests of this change"). Start each box summary with `New:`, `Changed:` or `Unchanged:`, as plain text (summaries are not markdown); a box that is partly new uses `Changed:` and says what is new. Title it plainly: "What this change touches". Stubs: SKILL.md, "Maps".
- **A flow** of the new behaviour, only when the change adds or moves a decision. Label the boxes with plain stage names ("Check the retry delays", "Reject the config"). A branch that belongs to one caller says so in its label. A flow step summary may start with `New:` when the step is new behaviour.

## 8. A large change

Above about 10 changed source files, or with parts that do not depend on each other, say so first. Ask which part to explain, or make one tour per part and name the parts you left out. A short tour of one part is more useful than a long tour of everything.

## 9. Title, bundle and reply

- Title the explainer and the tour after the change ("PR 42: config rejects invalid retry delays"), not after the repo: the page shows the explainer title (SKILL.md, "Setup").

- Bundle with `--files boundary` (SKILL.md, "Boundary and bundle"). Anchor the changed symbols with `symbol`, so the boundary starts from them; changed test files are embedded because you anchored them (section 6). The base versions are not embedded.
- The reply follows SKILL.md, "Show the result".

## 10. Worked outline (the invented `loadConfig` change: 2 files, +14 -0)

Summary:

> Before this change, a config file could set `retry.maxDelayMs` lower than `retry.baseDelayMs`, and every retry then waited `maxDelayMs`. Now `loadConfig` rejects such a file with an error that names both keys. Risk: a deployed config with such values now stops the program at start. Two new tests cover the check; no test covers a `maxDelayMs` of 0.

Steps:

1. `### Invalid retry delays now stop the program`: the map; `code`: the new check in `loadConfig`.
2. `### The check runs when the config is loaded`: unchanged; `main` calls `loadConfig` before it creates the queue, so a bad file stops the program before any job runs.
3. `### The config loader compares the two delays`: "Before: any two numbers were accepted. Now: `loadConfig` throws when `maxDelayMs < baseDelayMs`."
4. `### Who else reads the retry settings`: `runnerConfig` passes them to `Runner` (unchanged); `backoffDelay` now sees only valid values. No other code reads `retry.*` keys (checked with `search`).
5. `### Two new tests, one gap`: both tests are in `test/retry.test.ts`; one fails on the base, the other also passes there. That second test does not show the old bug, but it checks that a valid config still loads. No test covers `maxDelayMs: 0`, which passes the new check when `baseDelayMs` is 0 too.
6. `### Risk: configs that loaded before now stop the program`: the worst realistic failure is a deployed config with `maxDelayMs` below `baseDelayMs`; the program now exits at start instead of retrying with short delays. Open question: equal delays are accepted, so every retry waits the same time. Is that intended?
