# explain change: a PR, an MR or a branch diff

Use this guide when the user wants to understand or review a change: "explain PR 42", "what does this branch change", "walk me through `main..feature`", "explain my uncommitted changes". The result is an explainer written for a reviewer: what changes for users first, then where, then who else is affected, then the tests and the risks.

Reviewers rely most on two kinds of claim: what the code did **before**, and what **every caller** does now. In earlier explainers these were the claims that were wrong. This guide is mostly about checking them.

The examples use an invented change to `fixtures/ts-jobrunner` in the xpl repo: `loadConfig` now rejects a config whose `retry.maxDelayMs` is lower than `retry.baseDelayMs`.

## 1. Rules

- **Read-only** (SKILL.md, hard rule 3). For a change this means no `git push`, `gh pr comment`, `gh pr review`, `glab mr note` or other API call that writes, and no `checkout`, `switch`, `stash` (push or pop), `reset` or `gh pr checkout` in the user's working tree.
- **Fetch only when asked.** For a requested GitHub PR, use `xpl pr prepare <url>` (or `owner/repo <number>`) with an outside `--cache-dir`. It uses existing `gh`/git access, resolves full base/head commits and prepares a separate detached repository; never fetch into the developer's tree. For a GitLab MR, fetch `merge-requests/<n>/head` only in a separate scratch clone. Otherwise ask for a local base and head.
- **Reading the base is always fine:** `xpl show --at base`, `git show <base>:<path>`, `git diff`, `git log`, `git grep <pattern> <base>`.
- **A quick run on the base is fine without asking**, in a copy outside the repo: `git archive <base> <paths> | tar -x -C <scratch dir>`, then run a script or one test there. Do the same for the head when you need both. Test dependencies may come from a throwaway environment outside the repo (`uv run --no-project --with pytest ...`, or `npx` in the scratch dir). Never install into the repo or write inside it (`.explainer/` aside).
- **Ask first** for anything that changes git state or the user's files: a worktree, a checkout, a branch.

## 2. Record the change

For a prepared GitHub input, use the returned `repository` as the root and `input.json`'s full
`pr.base.sha..pr.head.sha` range. Its head index already exists. Preparation does not invoke an agent,
recheck the PR or produce a ready artifact; installed creation/current-head promotion is future work.
Any manually authored guide is a walkthrough of those recorded commits. Do not claim it reflects the
current PR without a fresh API check. Cleanup removes the owned input; keep it while the guide needs git
for its base anchors. See `cli.md` for manifest fields and failure recovery.

`xpl change <name> <base>..<head>` needs an index built from the head commit. Find the base and the head:

| The user gives                               | Range for `xpl change`                                          |
| -------------------------------------------- | --------------------------------------------------------------- |
| a range `A..B`                               | `A..B`                                                          |
| a branch name                                | `<target>...<branch>` (from the merge base; target: often main) |
| one commit `C`                               | `C^..C`                                                         |
| a PR or MR number, and asked you to fetch it | `<target>...pr-<n>`                                             |
| "my changes" (uncommitted work)              | `HEAD..<sha>`, with the recipe below                            |

- **The head is checked out:** `xpl index`, then `xpl change`. When the head is not checked out, `xpl change` stops and says so. Do not check it out yourself: clone the repo into the scratch dir (`git clone -q <repo> <dir>`, then `git -C <dir> checkout -q <head commit id>`) and run every `xpl` command with `--root <dir>`, or ask the user.
- **Uncommitted changes:** `git stash create` prints the id of a commit that holds the tracked changes. It adds no stash entry and leaves the files as they are. Then `xpl index --commit <that sha>` and `xpl change <name> HEAD..<that sha>`. New files that git does not track are not in that commit: name them in the reply.

`xpl change` prints the changed files with `+/-` counts, the **changed symbols** (`new` or `changed`), the **direct callers** of each outside tests, the **tests** that reference each, the symbols with **no test found**, and the changed lines outside any symbol. `xpl change <name>` prints it again. Read the intent too: `git log --format='%h %s%n%b' <base>..<head>`, and the PR or MR description when the user gave one. The text may say why the change was made only from these sources, and says so ("The commit message says ...").

Then `xpl draft change <name> -o change.json`. The draft holds the map, the tour in review order (section 7, steps `t10`, `t20`, ...) and an anchor in every changed file.

## 3. Read each changed piece

Read each changed symbol at head (`xpl show <id> --refs`) and at base (`xpl show --at base <path> --lines a-b`). In the base output, `-` marks the lines the change removes or rewrites. A symbol that exists only in the base has no symbol id: anchor its old lines with a base anchor (section 4).

## 4. Check every "before" claim in the base code

A "before" claim is any sentence about the old code: "used to", "no longer", "already", "now", "instead of", "before this change".

- **Read what decided the old behaviour,** not only the removed lines: the callers (`git grep -n <name> <base> -- <dir>`), the defaults, the exception paths, and the library calls that can fail. In the example, the hunk only adds a check to `loadConfig`. What happened before is in `backoffDelay`, which the diff does not touch: `Math.min(baseDelayMs * 2 ** (attempt - 1), maxDelayMs)` returned `maxDelayMs` for every retry.
- **Never infer old behaviour from the hunk alone.** Removed lines show what the old code said, not what it did for every input. A removed `split(":")[0]` cuts at the first `:`, not the last. An old lookup may have raised an exception that a caller turned into a 500. Run the base when the result depends on a library or on input values (section 1).
- **Anchor it in the base.** A base anchor points at the old lines of a modified, renamed or deleted file: `{"file": "src/config.ts", "at": "base", "find": "<text from the old file>", "role": "usage"}`, or a `span` counted from line 1 of the old file (the offsets `xpl show --at base` prints). No `symbol`: the base is not indexed. Put it next to the head anchor of the same claim, in the order of SKILL.md, "The tour" (range order). Code that the change does not touch is anchored without `at`: its old code is its current code. Format: `patch-format.md` section 1.
- **Write it "Before: ... Now: ..."**, with the input that shows the difference: "Before: `maxDelayMs: 100` with `baseDelayMs: 500` made each retry wait 100 ms. Now: `loadConfig` throws `config: retry.maxDelayMs must be at least retry.baseDelayMs`."
- **The bundle shows the diff** (SKILL.md, "Show the result"), so the text explains what the change means, not which lines moved.

## 5. Who else is affected

Start from the callers and tests `xpl change` printed. It sees direct calls only, so check, for each changed symbol:

1. **Direct callers.** Read each one, anchor each caller that now behaves differently, and say why. List the others in one note as unaffected, with the reason. "Callers via instance" are a guess (SKILL.md, hard rule 2): the code builds the class, and the changed method runs when the instance is called. "Callers: none found" is common for a method reached through a variable, a framework or a library: find the callers with `search` (SKILL.md, "Reading the code", which also says when you may name a library as the caller).
2. **Consumers of a changed result.** When the change alters what a function returns or builds (a value, a URL, a status, an error), follow one more level: `xpl refs <caller> --in`. (Example: `runnerConfig` passes the retry settings to `Runner`, so `backoffDelay` sees only valid values now.)
3. **Public entry points.** `search` for the name in `index.ts`, `__init__.py`, `__all__` and `export {`. A change to an exported function affects users outside the repo.
4. **Siblings.** Other code that does the same job without the changed helper: `search -i` for the key, header, error text or concept. Say whether each one already behaves the new way, and anchor it.

Unchanged code that you show for context is described as unchanged: "Unchanged: `backoffDelay` still caps the delay at `maxDelayMs`."

## 6. Tests and gaps

- `xpl change` lists the tests that reference each changed symbol. A reference is not a check: read what each test asserts before you say what it covers.
- For each behaviour change and each new branch (every `if`, early return or skip condition the change adds or moves), name the test that covers it, new or old. Name each branch that no test covers ("no test sends a non-HTTP scope through the new check"). Check a gap with `search` in the tests before you claim it.
- "No test found" means no test names the symbol. Tests of other code may still run it: check before you call it untested.
- A test that also passes on the base **does not show the old bug**. It can still guard the new code: say what it checks. Do not call a test useless or redundant without evidence, such as a change to the new code that the test does not catch.
- The draft anchors every changed file, test files too. Keep at least one anchor in each when you edit the draft. A tour step must show the code of each changed code file (a range in its `code`, or a symbol in its focus; a one-line change is a one-line range): naming a code file in a note does not pass `change-not-shown`. Docs (readme, `*.md`), tests, lock files and renames may instead be named in a note.

## 7. The tour: review order

Understanding the change is the main review task, and files shown last get fewer comments. The draft builds the tour in this order:

| Step | Title says                        | Shows                                                                                     |
| ---- | --------------------------------- | ----------------------------------------------------------------------------------------- |
| 1    | what changes for users            | the map of the change; `code`: the 1-2 hunks that make the change                         |
| 2    | where the change enters           | the code that calls the change (often unchanged); none found: the changed public function |
| 3+   | each changed piece, one step each | the hunk in call order, with the base lines next to it; "Before: ... Now: ..."            |
| next | who else is affected              | callers, consumers, public exports and siblings (section 5)                               |
| next | tests and gaps                    | the changed test files; what no test covers                                               |
| last | risks and open questions          | the worst realistic failure, edge cases, inputs that still behave the old way             |

Keep the first step and the last in place. To fit a small change, merge the rest:

- When each changed piece is itself an entry point (three handlers, each changed), drop step 2: each piece's step says how a request reaches it.
- Two small pieces that change for the same reason share one step.
- "Who else is affected" and "tests and gaps" may share a step when both are short.

**The risk** names the worst realistic failure the change can cause, with the input that triggers it, checked against the code: what a caller or a wrapper of the changed code does that now fails, hangs or behaves differently. Do not narrow it to tests when real callers can hit it too, and do not inflate it beyond what the code allows. The tour summary, the last step and the reply carry it.

**Views.** The draft's map, "What this change touches", holds the changed symbols, their direct callers and one group box for the tests. Its box summaries start with `New:`, `Changed:` or `Unchanged:`; keep that word and write the rest. Add **a flow** of the new behaviour only when the change adds or moves a decision. Label its boxes with plain stage names ("Check the retry delays", "Reject the config"). A branch that belongs to one caller says so in its label.

## 8. A large change

Above about 10 changed source files, or with parts that do not depend on each other, say so first. Ask which part to explain, or make one tour per part and name the parts you left out. A short tour of one part is more useful than a long tour of everything.

## 9. Before you show it

Run the accuracy pass, then bundle and reply: SKILL.md, "Check before you show it" and "Show the result".

## 10. Worked outline (the invented `loadConfig` change: 2 files, +14 -0)

Summary:

> Before this change, a config file could set `retry.maxDelayMs` lower than `retry.baseDelayMs`, and every retry then waited `maxDelayMs`. Now `loadConfig` rejects such a file with an error that names both keys. Risk: a deployed config with such values now stops the program at start. Two new tests cover the check; no test covers a `maxDelayMs` of 0.

Steps:

1. `### Invalid retry delays now stop the program`: the map; `code`: the new check in `loadConfig`.
2. `### The check runs when the config is loaded`: unchanged; `main` calls `loadConfig` before it creates the queue, so a bad file stops the program before any job runs.
3. `### The config loader compares the two delays`: "Before: any two numbers were accepted. Now: `loadConfig` throws when `maxDelayMs < baseDelayMs`." `code`: the old lines of `loadConfig` (a base anchor), then the new check.
4. `### Who else reads the retry settings`: `runnerConfig` passes them to `Runner` (unchanged); `backoffDelay` now sees only valid values. No other code reads `retry.*` keys (checked with `search`).
5. `### Two new tests, one gap`: both tests are in `test/retry.test.ts`; one fails on the base, the other also passes there. That second test does not show the old bug, but it checks that a valid config still loads. No test covers `maxDelayMs: 0`, which passes the new check when `baseDelayMs` is 0 too.
6. `### Risk: configs that loaded before now stop the program`: the worst realistic failure is a deployed config with `maxDelayMs` below `baseDelayMs`; the program now exits at start instead of retrying with short delays. Open question: equal delays are accepted, so every retry waits the same time. Is that intended?
