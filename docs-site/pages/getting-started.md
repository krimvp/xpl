# Getting started

xpl needs Node 22.12 or newer. The npm package is tested on Linux x64; other platforms have not been
verified. To write explanations, install and configure a supported authoring harness and its provider.

## Install

Install the CLI from npm, then install the bundled code-explainer skill and check the setup:

Example for the default Claude Code target:

```sh
npm install --global @krimvp/xpl
xpl skill install
xpl doctor --agent claude
```

Claude Code is the default target. For Codex, Pi, Factory Droid or Devin, use
`xpl skill install --agent <codex|pi|droid|devin>`. Use `--dir <path>` to install into a project skill directory.

`xpl skill install` copies the skill and binds its launcher to the installed CLI. Rerun it after you
update or move the CLI. The npm package includes the CLI and skill; harness installation, authentication
and provider access are separate. Codex, Pi and Factory Droid install to `~/.agents/skills/code-explainer`;
Devin installs to the project's `.agents/skills/code-explainer`. In Devin, run
`xpl skill install --agent devin` inside the connected remote environment and target repo before using
the launcher. Install Node >=22.12 and xpl there first; the launcher has no PATH fallback. A local
project install does not provision xpl in Devin's remote environment. [The skill](skill/index.md) page
has the install options.

## Make your first guide

For example, in Claude Code, open a TypeScript, Python or Go repository and ask:

```text
/code-explainer explain How does a failed job get retried? Root: /absolute/path/to/repo. Audience: maintainers. New guide: job-retries.
```

That slash command is the Claude Code example; use the matching [harness invocation](skill/index.md)
for Codex, Pi, Factory Droid or Devin.

Name the reader and the question. The agent indexes the repository, writes the explanation as a patch, and
`xpl` checks every anchor before it saves `.explainer/job-retries.explainer.json`. Commit that file; the
indexes beside it are git-ignored. [Create a guide](skill/create.md) has more prompts and what to do when a
run stops.

## View it and export HTML

<!-- include README.md "### View and export a guide" -->

## Try it without Claude

<!-- include README.md "### Try it without Claude" -->
