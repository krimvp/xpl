# GitHub pull requests

PR input is opt-in. Run either `xpl pr prepare` or `xpl pr create` for a PR, not both. Each fetches the PR's full base and head into a separate detached repository, indexes the head with `--precise off` by default and writes an immutable `input.json` containing the before and after source. Your working checkout stays untouched.

```sh
xpl pr prepare https://github.com/owner/repo/pull/42
# Or prepare the input and print an authoring prompt in one command:
xpl pr create https://github.com/owner/repo/pull/42 \
  --name pr-guide --audience reviewers --question "What changes?"
```

`xpl pr create` scaffolds a guide and prints an agent invocation; it does not start a model. After authoring, finish and validate the guide:

```sh
xpl pr finish <input-directory>
```

Use the input directory printed by `prepare` or `create` as `<input-directory>`. `finish` checks readiness, exports HTML and rechecks both GitHub commits. Its result manifest is valid only while the PR still points to those commits. A changed PR supersedes the result; no command here publishes anything. Network access and existing `gh` and git access are required. Remove retained input with `xpl pr cleanup <input-directory>`.

Preparation isolates Git reads from the developer checkout and refuses filters or line-ending conversion that alter the fetched source bytes. Do not place the cache inside the working repository.

## Share a preview

Use the result manifest reported by `finish` and the prepared repository path reported by `prepare` or
`create` to stage the checked version directly in the folder your static host serves:

```sh
xpl stage pr-guide --dir /srv/previews/pr-42 --pr-result <result.json> \
  --root <prepared-repository>
```

See [Search and saved versions](find-and-share.md) for staging and version-history behavior. Add or update
the PR comment with the same staged directory:

```sh
xpl pr link /srv/previews/pr-42 \
  --url https://previews.example/pr-42 --visibility team
```

The command rechecks the PR base and head and links to both `current/index.html` and the immutable version. For private target repositories, use `--visibility team`; the host controls who can open the preview. Configure a PR workflow to run `xpl pr check-link owner/repo#42` on new commits so the comment stops describing an old preview as current. See the [CLI reference](../reference/commands.md).

## Optional CI authoring and publishing

The repository includes `.github/workflows/pr-preview.yml` and `scripts/pr-preview.mjs`. Copy both into
your xpl source checkout to use this workflow elsewhere. It runs only by manual dispatch from the default
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
folder across runs so immutable versions and the `current` symlink remain available. The host must serve
symlinks, and its storage must support the atomic rename and locking used by `xpl stage`.

The author executable receives exactly one argument: an absolute `handoff.json` path. It reads the
`invocation`, invokes the installed skill with its chosen harness, writes and applies patches using the
handoff's `command` prefix, completes its accuracy pass, and exits zero when authoring is complete.
The runner script owns `finish`, staging and linking. The wrapper must tell its agent to stop before
the handoff prompt's manual `finish` instruction, and wait for all of its child processes before exiting. Configure the executable itself with the intended
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
