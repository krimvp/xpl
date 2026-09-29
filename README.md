# xpl — code explainer

Interactive diagrams linked both ways to code: click a box, an arrow or a concept and the editor
focuses the relevant code; select code and the matching diagram elements light up.

- `docs/ARCHITECTURE.md` is the build contract (interfaces, algorithms, package ownership).
- `docs/handoff.md` is the original design brief (schema draft and worked example in the appendices).

## Layout

| Path               | What                                                                    |
| ------------------ | ----------------------------------------------------------------------- |
| `packages/core`    | `@xpl/core`: schema types and pure logic. Browser-safe (no `node:*`).   |
| `packages/indexer` | `@xpl/indexer`: tree-sitter (WASM) symbol index, reference resolution.  |
| `packages/cli`     | `@xpl/cli`: the `xpl` command, bundled to `packages/cli/dist/xpl.mjs`.  |
| `packages/viewer`  | `@xpl/viewer`: React + CodeMirror 6 + elkjs, built to one `index.html`. |
| `fixtures/`        | Tiny real repos (with committed explainers) used as test targets.       |

Workspace packages export their TypeScript sources; vitest, tsx and vite read them directly, so there
is no build step between packages in development.

## Development

Node 22.12 or newer.

```sh
npm install          # dependency install scripts are disabled on purpose, see .npmrc
npm run typecheck    # tsc --noEmit in every package
npm test             # vitest: unit tests of all packages (packages/*/test)
npm run build        # viewer (Vite single file) first, then the CLI bundle
npm run test:e2e     # builds the viewer, then Playwright against dist/index.html
npm run format       # prettier --write . (format:check to verify)
```

After `npm run build`:

```sh
node packages/cli/dist/xpl.mjs --help
node packages/cli/dist/xpl.mjs __smoke   # hidden: loads every tree-sitter grammar from dist/wasm
```

Notes:

- The tree-sitter grammars are the `.wasm` files shipped inside their npm packages (versions are pinned
  exactly: the wasm ABI has to match `web-tree-sitter`). Use `initParser()` / `loadLanguage()` from
  `packages/indexer/src/wasm.ts`, never `Parser.init()` directly. `XPL_WASM_DIR` or `setWasmDir()`
  redirect the wasm files; the built CLI loads them from `dist/wasm/`.
- Playwright must match the browsers preinstalled in `PLAYWRIGHT_BROWSERS_PATH` (`/opt/pw-browsers` in
  the sandbox), hence `@playwright/test@1.56.1`. Do not run `playwright install` there.
- `.npmrc` sets `ignore-scripts=true`, so npm also skips `pre*`/`post*` scripts of our own packages.
