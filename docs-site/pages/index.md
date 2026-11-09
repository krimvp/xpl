# xpl documentation

<p class="eyebrow">Understand the code. Review the change.</p>

xpl makes a guide to your code: diagrams linked to the source in both directions. Select a box, an arrow or
a step to see its code. Put the cursor in the code to see the boxes and steps that cover it. A repository
guide shows how a system fits together; a change guide follows a diff and the code around it.

xpl checks that every code link points at indexed code and reports the links whose code changed. This
checks where a guide points, not whether its text is right. A person reviews the text.

![A sequence of how a job is dispatched. The Runner.dispatch lifeline is selected, and its code in runner.ts is highlighted beside it.](../../site/images/jobrunner-light.png#only-light)
![A sequence of how a job is dispatched. The Runner.dispatch lifeline is selected, and its code in runner.ts is highlighted beside it.](../../site/images/jobrunner-dark.png#only-dark)

[Open this example](https://krimvp.github.io/xpl/demo/) in your browser. It is a real guide to a small
job runner, in one HTML file.

## Where to start

- [Getting started](getting-started.md): install the CLI and the skill, make a first guide, view it and
  export it as HTML.
- [Concepts](concepts/index.md): guides, diagrams and tours, code links, trust labels and readiness.
- Workflows: [explain a question or a repository](workflows/explain.md),
  [explain a change](workflows/change.md), [search and saved versions](workflows/find-and-share.md),
  [editing and author review](workflows/edit-and-review.md), [feedback and revision](workflows/feedback.md),
  [GitHub pull requests](workflows/pull-requests.md) and [the local service](workflows/service.md).
- [CLI reference](reference/index.md) and the [help text of every command](reference/commands.md).
- [The skill](skill/index.md): what the code-explainer skill does and how to install it.
  [What a good guide looks like](skill/writing.md) is the writing guide the skill follows.

## Contributing

Report bugs and request features in [GitHub Issues](https://github.com/krimvp/xpl/issues). Report security
issues through [private vulnerability reporting](https://github.com/krimvp/xpl/security/advisories/new).

To contribute code, read [CONTRIBUTING.md](https://github.com/krimvp/xpl/blob/main/CONTRIBUTING.md).
