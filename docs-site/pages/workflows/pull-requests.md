# GitHub pull requests

xpl reads a pull request only when you ask. Run either `xpl pr prepare` or `xpl pr create` for a PR, not
both. Each fetches the PR's base and head into a separate folder, indexes the head (with `--precise off` by
default) and writes `input.json` with the code before and after. That file never changes. Your own checkout
stays as it is.

```sh
xpl pr prepare https://github.com/owner/repo/pull/42
# Or prepare the input and print an authoring prompt in one command:
xpl pr create https://github.com/owner/repo/pull/42 \
  --name pr-guide --audience reviewers --question "What changes?"
```

`xpl pr create` also creates an empty guide and prints the prompt for your agent; it does not start the
agent. When the guide is written, finish and check it:

```sh
xpl pr finish <input-directory>
```

`<input-directory>` is the folder that `prepare` or `create` printed. `finish` checks readiness, exports HTML
and checks both GitHub commits again. Its result manifest is valid only while the PR still points at those
commits; a new push makes it old. No command on this page publishes anything. You need network access and
working `gh` and git access. `xpl pr cleanup <input-directory>` removes the input.

The prepared folder does not read your checkout's git settings, and it refuses git filters or line-ending
conversion that would change the fetched code. Do not put the cache inside your repository.

## Share a preview

Stage the checked version in the folder that your static host serves. Pass the result manifest that `finish`
printed and the prepared folder that `prepare` or `create` printed:

```sh
xpl stage pr-guide --dir /srv/previews/pr-42 --pr-result <result.json> \
  --root <prepared-repository>
```

[Search and saved versions](find-and-share.md) says how staging keeps versions. Add or update the PR comment
with the same staged folder:

```sh
xpl pr link /srv/previews/pr-42 \
  --url https://previews.example/pr-42 --visibility team
```

The command checks the PR base and head again, then links to `current/index.html` and to this version. For a
private repository, use `--visibility team`; your host controls who can open the preview. Run
`xpl pr check-link owner/repo#42` from a PR workflow on each new commit, so that the comment marks an old
preview as old. See the [CLI reference](../reference/index.md).

## Set up CI previews (optional)

A CI workflow can write, stage and link a preview for each PR. You need it only to automate the steps above.
The xpl repository has `.github/workflows/pr-preview.yml` and `scripts/pr-preview.mjs`; copy both into your
xpl source checkout to use them elsewhere. It runs only by manual dispatch from the default
branch, after the repository variable `XPL_CI_PREVIEWS` is set to `true`. It builds that trusted branch;
it does not execute a workflow, package install or tests from the target PR.

Create a protected Actions environment named `xpl-previews`, restrict it to the default branch and require
review before dispatching secrets. Provision a dedicated ephemeral Linux runner with the `xpl-previews`
label, Node, git, gh and a trusted authoring executable. Configure these environment values:

| Setting                    | Value                                                                                           |
| -------------------------- | ----------------------------------------------------------------------------------------------- |
| Variable `XPL_AUTHOR`      | Absolute path to the runner's trusted authoring executable.                                     |
| Secret `XPL_AUTHOR_TOKEN`  | Credential consumed by that executable for its authoring provider.                              |
| Secret `XPL_READ_TOKEN`    | GitHub token with read access to this repository and PR source.                                 |
| Secret `XPL_PUBLISH_TOKEN` | GitHub token with PR comment write access, owned by a repository owner, member or collaborator. |
| Variable `XPL_PREVIEW_DIR` | Absolute path to this repository's dedicated, mounted destination folder.                       |
| Variable `XPL_PREVIEW_URL` | HTTP(S) base URL serving that folder, without credentials, query or fragment.                   |

The destination uses the runner's filesystem identity and a preauthenticated mount, provisioned by the
runner operator. No destination credential is inferred from the PR or passed as a command argument.
The host must enforce team access. The workflow always records visibility as `team`; that label does not
implement authentication. It creates `pr-<number>` under the configured folder and URL. Preserve the
folder between runs so the staged versions and the `current` symlink stay available. The host must serve
symlinks, and its storage must support the atomic rename and locking used by `xpl stage`.

The author executable receives exactly one argument: an absolute `handoff.json` path. It reads the
`invocation`, invokes the installed skill with its chosen harness, writes and applies patches using the
handoff's `command` prefix, completes its accuracy pass, and exits zero when authoring is complete.
The runner script owns `finish`, staging and linking. The wrapper must tell its agent to stop before
the handoff prompt's manual `finish` instruction, and wait for all of its child processes before exiting.
Configure the executable itself with the intended
provider/model and noninteractive approval policy; it must accept `XPL_AUTHOR_TOKEN` and a fresh `HOME`.
The workflow does not guess a provider or install an agent. Author execution is limited to 20 minutes.

The author process receives an allowlisted environment with its author credential and a temporary home;
it does not inherit the source or publishing tokens or unrelated Actions secrets. This is not an OS
sandbox. The author executable and its policy remain trusted, and the runner can access the mounted
preview directory. Treat PR source as data and reject instructions embedded in source. Use an ephemeral
runner without other credentials or workloads; environment filtering alone cannot isolate hostile code.

Dispatch **Publish PR preview** with the PR number. Runs for the same PR are serialized. The script
prepares the current API base/head, authors a guide, finishes it, stages the ready result, then updates
one PR comment. Both commits are rechecked by the existing commands. If either moves, the run fails and
attempts `check-link` so the prior comment is marked outdated. A move after a successful run still needs
the usual `check-link` workflow on new commits. Keep that workflow's writers serialized too.

Child output is suppressed because it can contain source or credentials. A failure reports its phase;
inspect retained inputs and results under `$RUNNER_TEMP/xpl-pr-inputs` before disposing of the runner.
Nothing is uploaded as an Actions artifact. A failed author or readiness check cannot publish a draft.
Network failures can prevent updating a stale comment; rerun `xpl pr check-link` when access returns.
