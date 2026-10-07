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
