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

A CI workflow can do the steps above for each PR. The xpl repository has
`.github/workflows/pr-preview.yml` and `scripts/pr-preview.mjs`; copy both to use them elsewhere. The
workflow runs only when you dispatch **Publish PR preview** by hand from the default branch, with the
repository variable `XPL_CI_PREVIEWS` set to `true`. It never runs a workflow, an install or tests from the
PR.

Set it up as follows:

1. Create a protected Actions environment `xpl-previews`. Restrict it to the default branch, and require a
   review before it releases secrets.
2. Start a dedicated, ephemeral Linux runner with the label `xpl-previews`, Node, git, gh and your author
   executable. Give it no other credentials or work: PR code is data, and the runner does not sandbox it.
3. Set these values on the environment:

| Setting                    | Value                                                                                 |
| -------------------------- | ------------------------------------------------------------------------------------- |
| Variable `XPL_AUTHOR`      | Absolute path of the author executable on the runner.                                 |
| Secret `XPL_AUTHOR_TOKEN`  | The credential that executable uses for its agent.                                    |
| Secret `XPL_READ_TOKEN`    | A GitHub token that can read the repository and the PR.                               |
| Secret `XPL_PUBLISH_TOKEN` | A GitHub token that can write PR comments, owned by an owner, member or collaborator. |
| Variable `XPL_PREVIEW_DIR` | Absolute path of the mounted folder that your host serves.                            |
| Variable `XPL_PREVIEW_URL` | The HTTP(S) URL of that folder, with no credentials, query or fragment.               |

The author executable gets one argument, the absolute path of a `handoff.json`. It runs the installed skill
with the handoff's `command` prefix, makes its accuracy pass, and exits 0 when the guide is written. It
stops before the prompt's `finish` step: the script runs `finish`, `stage` and `pr link`. The executable
gets only its own token and a fresh `HOME`, and has 20 minutes.

Your host controls who can open a preview; the `team` label in the comment does not. Keep the preview folder
between runs, serve symlinks, and use storage that supports atomic renames and locks.

If the PR moves during a run, the run fails and marks the old comment as old. A run hides the output of the
commands it starts, because it can hold source or credentials. A failure names its phase, and the inputs
stay under `$RUNNER_TEMP/xpl-pr-inputs` until you dispose of the runner. The
[architecture notes](https://github.com/krimvp/xpl/blob/main/docs/ARCHITECTURE.md) ("Optional CI preview
authoring") have the full design.
