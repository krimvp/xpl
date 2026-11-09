# Getting started

xpl needs Node 22.12 or newer. The full install test runs on Linux x64. CI also checks the packed install,
the local service and offline reading of HTML on macOS and Windows. To write guides with an agent, install
and sign in to the agent separately.

## Install

Install the CLI and the skill, then check the setup (Claude Code, the default agent):

```sh
npm install --global @krimvp/xpl
xpl skill install
xpl doctor --agent claude
```

For Codex, Pi, Factory Droid or Devin, run `xpl skill install --agent <codex|pi|droid|devin>`. Run
`xpl skill install` again after you update or move the CLI. [Install options](skill/create.md#install) has
the install folder of each agent, the Devin setup and the install from a source checkout.

For shell completion, add `source <(xpl completion bash)` to `~/.bashrc`, or `source <(xpl completion zsh)`
to `~/.zshrc` after `compinit`. For fish, run `xpl completion fish > ~/.config/fish/completions/xpl.fish`.

## Make your first guide

In Claude Code, in a repository in a [supported language](concepts/languages.md), ask a question and name
the reader:

```text
/code-explainer explain How does a failed job get retried? Root: /absolute/path/to/repo. Audience: maintainers. New guide: job-retries.
```

Other agents use another prefix; [The skill](skill/index.md) lists them. The agent indexes the repository,
writes the guide as a patch, and `xpl` checks every code link before it saves
`.explainer/job-retries.explainer.json`. Commit that file; the indexes beside it are git-ignored.
[Create a guide](skill/create.md) has more prompts and what to do when a run stops.

### Without an agent

`xpl start` drafts a guide from the index. You write the text:

```sh
xpl start job-retries --question "How does a failed job get retried?" --audience maintainers --precise off
xpl view job-retries
```

`xpl start` indexes the repository, creates the guide and applies a checked draft. It prints the path of
the draft patch and of its notes, both outside the repository. Read the notes first: they name the parts of
the draft that are provisional or left out. Add `--entry src/runner.ts#Runner.dispatch` when the question
starts at a known function; then the draft is a call sequence, not a repository map. Write the TODO text,
check each claim against its code, then run `xpl lint job-retries` and `xpl ready job-retries`.

## View it and export HTML

<!-- include README.md "### View and export a guide" -->

## Try it without Claude

<!-- include README.md "### Try it without Claude" -->
