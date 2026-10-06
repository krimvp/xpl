# Explain a change

Ask the skill to explain a pull request or a branch. It reads the diff locally with git and never posts
anything:

```text
/code-explainer explain change main...my-branch. Root: /work/jobs. Audience: reviewers. Question: what changes for callers and what can fail? New guide: retry-change.
```

The guide says what changes for users, where, who else is affected, and which tests cover it. The page
shows the diff, the code before the change, and which boxes are new or changed. For a pull request on GitHub,
see [GitHub pull requests](pull-requests.md).

## The commands behind it

<!-- include README.md "### Explaining a change" -->
