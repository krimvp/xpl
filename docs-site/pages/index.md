# xpl documentation

<p class="eyebrow">Understand the code. Review the change.</p>

AI makes it easier to change code, so systems can change faster than people can understand them. xpl helps
you get oriented in an existing repository and see what a change or pull request does.

xpl turns an explanation into a page where diagrams link to source code. Select a box, arrow or step to see
the code it points to; select code to see the parts of the explanation that cover it. Use repository guides
to understand how a system fits together, or change guides to follow a diff and its surrounding code.

xpl checks that code anchors resolve to the indexed source and reports anchors that have drifted. This checks
where an explanation points, not whether its prose is correct. Review the explanation for accuracy.

![The Runner.dispatch box is selected in the diagram, and the dispatch function in runner.ts is highlighted beside it](../../site/images/jobrunner-light.png#only-light)
![The Runner.dispatch box is selected in the diagram, and the dispatch function in runner.ts is highlighted beside it](../../site/images/jobrunner-dark.png#only-dark)

[Try the live example](https://krimvp.github.io/xpl/) on the xpl home page. It is a real explainer of a
small job runner, built into one HTML file.

## Where to start

- [Getting started](getting-started.md): install the CLI and the skill, make a first guide, view it and
  export it as HTML.
- [Concepts](concepts/index.md): guides, views and tours, anchors, trust labels and readiness.
- Workflows: [explain a question or a repository](workflows/explain.md),
  [explain a change](workflows/change.md), [feedback and revision](workflows/feedback.md),
  [editing and author review](workflows/edit-and-review.md), [the local service](workflows/service.md),
  [GitHub pull requests](workflows/pull-requests.md) and [search and saved versions](workflows/find-and-share.md).
- [CLI reference](reference/index.md) and the [help text of every command](reference/commands.md).
- [The skill](skill/index.md): what the code-explainer skill does and how to install it.

## Contributing

Report bugs and request features in [GitHub Issues](https://github.com/krimvp/xpl/issues). Report security
issues through [private vulnerability reporting](https://github.com/krimvp/xpl/security/advisories/new).

To contribute code, read [CONTRIBUTING.md](https://github.com/krimvp/xpl/blob/main/CONTRIBUTING.md).
