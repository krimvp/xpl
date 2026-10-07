# xpl documentation

<p class="eyebrow">Follow the idea. Find the code.</p>

xpl is a code explainer. It makes a page where diagrams are linked both ways to the source. Click a box, an
arrow or a step and the editor highlights the exact code. Put the cursor in the code and the diagram
elements that cover it light up.

An agent writes the explanation, and xpl checks every claim against an index of your repository. An anchor
that points at code which is not there, or code that changed since it was explained, is reported, and a
ready export refuses until it is fixed.

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

To contribute code, read [CONTRIBUTING.md](https://github.com/krimvp/xpl/blob/main/CONTRIBUTING.md) and the
[architecture guide](https://github.com/krimvp/xpl/blob/main/docs/ARCHITECTURE.md).
