# Getting started

xpl needs Node 22.12 or newer. The npm package is tested on Linux x64; other platforms have not been
verified. To write explanations you also need Claude Code, installed and signed in on its own.

## Install

Install the CLI from npm, then install the bundled code-explainer skill and check the setup:

```sh
npm install --global @krimvp/xpl
xpl skill install
xpl doctor --agent claude
```

`xpl skill install` copies the skill to `~/.claude/skills/code-explainer` and binds its launcher to the
installed CLI. Rerun it after you update or move the CLI. [The skill](skill/index.md) page has the other
install options.

## Make your first guide

Open Claude Code in a TypeScript, Python or Go repository and ask a question with the skill:

```text
/code-explainer explain How does a failed job get retried? Root: /absolute/path/to/repo. Audience: maintainers. New guide: job-retries.
```

Name the reader and the question. The agent indexes the repository, writes the explanation as a patch, and
`xpl` checks every anchor before it saves `.explainer/job-retries.explainer.json`. Commit that file; the
indexes beside it are git-ignored. [Create a guide](skill/create.md) has more prompts and what to do when a
run stops.

## View it and export HTML

<!-- include README.md "### View and export a guide" -->

## Try it without Claude

<!-- include README.md "### Try it without Claude" -->
