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

[Install options](skill/create.md#install) covers the other agents (Codex, Pi, Factory Droid, Devin), the
install folders, updates and the install from a source checkout.

For shell completion, add `source <(xpl completion bash)` to `~/.bashrc`, or `source <(xpl completion zsh)`
to `~/.zshrc` after `compinit`. For fish, run `xpl completion fish > ~/.config/fish/completions/xpl.fish`.

## Make your first guide

In Claude Code, in a repository in a [supported language](concepts/languages.md), ask a question and name
the reader:

```text
/code-explainer explain How does a failed job get retried? Audience: maintainers. New guide: job-retries.
```

Other agents use another prefix; [The skill](skill/index.md) lists them. The agent indexes the repository,
writes the guide as a patch, and `xpl` checks every code link before it saves
`.explainer/job-retries.explainer.json`. Commit that file; the indexes beside it are git-ignored.
[Create a guide](skill/create.md) has more prompts and what to do when a run stops.

### Without an agent

To read a finished guide first, open one of the [examples](https://krimvp.github.io/xpl/#more-examples).
To draft your own, index the repository and find the id of the function where the answer starts. Then run
`xpl start`. It drafts the guide from the index, and you write the text:

```sh
xpl index --precise off
xpl outline --kind function,method --depth 9
xpl start job-retries --question "How does a failed job get retried?" \
  --entry src/runner.ts#Runner.dispatch --audience maintainers --precise off
xpl view job-retries
```

`--entry` takes an id as `xpl outline` prints it, with or without `sym:`. The draft is then a call sequence
from that function. Without `--entry`, `xpl start` drafts a map of the whole repository.

`xpl start` creates the guide and applies a checked draft. It prints the path of the draft patch and of its
notes, both outside the repository. Read the notes first: they name the parts of the draft that are
provisional or left out. Then write the TODO text in one of two ways:

- in `xpl view`, under Edit > **Edit the tour**, and in each box's details;
- in the draft patch, then run `xpl apply job-retries <draft patch>` to save it into the guide.

Check each claim against its code, then run `xpl lint job-retries` and `xpl ready job-retries`.

## View it and export HTML

<!-- include README.md "### View and export a guide" -->
