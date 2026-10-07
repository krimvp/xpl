# xpl — code explainer

Interactive diagrams linked to code in both directions. Click a box or step to see its code;
select code to see the matching diagram elements. Claude writes explanations as data, and
xpl checks their source locations against a static index of your repository.

[Try the live example](https://krimvp.github.io/xpl/).

[npm package](https://www.npmjs.com/package/@krimvp/xpl).

## Install

Install from npm (Node 22.12 or newer):

```sh
npm install --global @krimvp/xpl
xpl skill install
xpl doctor --agent claude
```

Claude Code needs its own installation, authentication and provider access. In your project, ask:

```text
/code-explainer explain How does a failed job get retried?
```

Then open or export the guide:

```sh
xpl view <guide-name>
xpl bundle <guide-name> -o guide.html
```

The package includes the CLI, viewer, WASM grammars and authoring skill. Reading and exporting
use bundled assets; `xpl index --precise off` works without downloading precise tools.
After updating or moving the CLI, rerun `xpl skill install` to update its launcher.
The workflow has been checked on Linux x64; other platforms have not been verified.

The [source repository](https://github.com/krimvp/xpl) is public. `npm install && npm run build` builds the
CLI; `npm pack ./packages/cli/dist` creates a local tarball that you can install with
`npm install -g --ignore-scripts ./krimvp-xpl-0.2.0.tgz`.
See the bundled `skill/code-explainer/README.md` for authoring and recovery instructions.

MIT license. Copyright 2026 krimvp.
