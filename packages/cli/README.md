# xpl — code explainer

xpl makes a guide to your code: diagrams linked to the source in both directions. Click a box and its code
lights up. Put the cursor in the code and the boxes that cover it light up. An agent such as Claude writes the
guide, and xpl checks that every code link points at code that exists now. A person reviews the text.

[Open an example guide](https://krimvp.github.io/xpl/demo/) in your browser.

## Install

Node 22.12 or newer. Claude Code is the default agent:

```sh
npm install --global @krimvp/xpl
xpl skill install
```

Other agents, project installs and the supported platforms are in
[Getting started](https://krimvp.github.io/xpl/docs/getting-started/).

## Make and read a guide

In Claude Code, in your repository, ask a question and name the reader:

```text
/code-explainer explain How does X work? Audience: maintainers.
```

`xpl view <guide>` opens the guide in the browser. `xpl bundle <guide> -o guide.html` writes one HTML file
that holds the guide and its code, for offline reading.

The package holds the CLI, the viewer, the grammars and the skill. After you update or move the CLI, run
`xpl skill install` again to update its launcher.

## More

- [Documentation](https://krimvp.github.io/xpl/docs/), with the CLI reference.
- [Source repository](https://github.com/krimvp/xpl).

MIT license. Copyright 2026 krimvp.
