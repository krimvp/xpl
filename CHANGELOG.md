# Changelog

User-facing changes are listed here. Versions link to their changes on GitHub.

## [Unreleased]

New commands and drafts:

- `xpl draft map` drafts a quick map of every code file, one map per folder, with a plain name and one
  sentence per box. Run it again and it drafts only new files and keeps the text already written. With a
  change recorded, it adds a tour of the changed files. A folder map with more than 30 boxes groups the files
  that use each other. (#231, #235)
- `xpl update <guide> --since <rev>` brings a map up to date in one run: it indexes, re-resolves the code
  links, records the change and drafts the map again. (#235)
- `xpl draft class <guide> <type>` maps what a class or interface extends and implements, and what extends or
  implements it. (#233)
- `xpl draft states <guide> <type>` drafts a flow of the states of a status type (a TypeScript enum or union
  of string literals, a Python Enum, a Go const block) and the functions that move it between them. (#237)
- `xpl health` lists committed secrets, secrets in variables sent to the browser, committed `.env` files,
  code files over 1,000 lines and files nothing uses. It shows at most the first 4 characters of a secret
  and exits 0 with or without findings. (#236)

Guides and the viewer:

- Sketch boxes show an idea or a plan before there is code. They are drawn dotted, labelled "sketch" and
  linked to no code. (#233)
- Select a box and choose "What it leads to" or "What leads to it" to light up every box reached along its
  arrows. (#233)
- A map can show each box's one-sentence summary on the box. The header has a theme button: Auto, Light or
  Dark. (#231)
- "Save image" downloads a diagram as a PNG, as it looks on screen, in either theme. (#239)
- A tour summary gives the answer first, then up to four reasons; `xpl lint` checks for it. A tour note can
  hold a small table. (#239)
- An answer from the local service offers "Show on the map", which selects the boxes whose code holds the
  answer. (#235)
- The guide tab is now **Tour**. A tour step shows its diagram before its code, and steps are numbered. When
  nothing is selected, the right column lists the parts of the diagram ("On this map"). Trust labels read
  "precise (checked by a language tool)" and "heuristic (matched by name)". An arrow to code outside the map
  is drawn only while you point at it or select it.
- **Matrix** in a map's toolbar shows the map as a dependency matrix: a row and a numbered column per box,
  and in each cell the arrows from the row's box to the column's, with their count. A cell below the
  diagonal goes back up the order; with its mirror cell it marks a cycle. A view with `"render": "matrix"`
  opens that way.
- Trust is never shown by colour alone. Heuristic arrows are dashed, partly matched arrows are dash-dot and
  arrows to code outside the map are dotted, in both themes. A key line under the diagram's caption names
  the marks the map draws now. With something selected, the arrows that touch none of it are dimmed.
- A large map starts at a readable zoom. "Fit all" then counts the boxes out of sight, and after a fit it
  offers "Readable size". A flow keeps its main path straight down, and sequence frames show their condition.
- The parts list beside a map says which boxes of the map each box uses and is used by.

Indexing:

- Web requests (`fetch`, axios, `requests`, `httpx`, Go `net/http`) link to the route that answers them in
  Express, Koa, Hono, Fastify, Next.js, FastAPI, Flask, net/http, chi, gin and echo. Maps draw these links
  as `requests` arrows. They are always heuristic. (#238)
- A request path built from a file's string constant reads the constant's value. `xpl draft map` leaves out
  code files that define and use nothing. (#240)

Drafts and lint:

- `xpl draft path` starts its tour on a map of the files the path crosses. `xpl draft repo` adds a box for
  the person who starts the program, and one for the settings files the code loads. Both drafts end on a
  "where to go next" step. `xpl draft path` frames the calls that sit in a loop or a branch and keeps at most
  8 steps; `xpl draft repo` keeps at most 9. A program that starts a standard-library server (`net/http`,
  `node:http`, `http.server`) gets a box for its clients.
- `xpl lint` checks more of the text: summaries over 2 sentences or 45 words (`long-summary`), long detail
  paragraphs, passive voice, "we", tool words such as "anchor" in a tour, views no tour uses, too many
  concepts and repeated steps. It knows more filler words, and a tour note may have at most 50 words. New
  rules also check that a note starts with a `### title`, that a title has at most 12 words, that a longer
  tour ends on its map (`tour-ends`), and that a note does not open with "So", "But" or "And".
- The skill puts its hard rules first, starts every guide from its purpose, and gives each scope a tour shape
  and a length budget. Its writing guide follows Orwell's rules and ASD-STE100 Simplified Technical English.

Command-line messages:

- Help text wraps at 110 columns. An unknown command or option suggests the nearest name, for example
  `Did you mean "--depth"?`. `xpl ready` prints each finding as the problem, then "fix:" and the fix.
  Errors use the right article ("an interface", "an enum"). The `xpl draft states` error names the command
  that lists candidates.

Docs:

- The README starts with what xpl does and a picture, then a short quick start. "Try it without Claude" now
  works for an npm install: it points to the published examples and to `xpl start --entry`. The fixture
  command is for a source checkout only.
- The README, Getting started and the landing page show the two install commands and link to the
  [install options](skill/code-explainer/reference/create.md#install). The landing page shows the default
  agent, Claude Code.
- The README and the docs site use one word for each thing: guide, tour, diagram (map, flow, sequence), box,
  arrow and code link. The workflow pages own their text, and the explain and change pages have a picture.
  The docs site adds the writing guide and orders the workflows as a newcomer meets them.
- SECURITY.md names the supported line (0.3.x) and says that only `xpl view` takes `--host`. The README and
  the docs list every supported language, including Rust, and give the exit codes of `xpl health`.

## [0.3.0]

- xpl indexes Java repositories and named Ruby, PHP and Rust declarations. Rust support also resolves bounded
  same-file calls. Relationships are still labeled as heuristic when precise evidence is unavailable.
- Watched input capture reuses file-local extraction for unchanged files and passes changed-file facts to
  the snapshot build. It still resolves references and records configuration reads afresh.
- Authors can create an index-backed first draft with `xpl start` and complete commands and local guide names
  in the shell. Repository drafts can mark imported systems optional and include nested declarations.
- The existing Claude skill installer now also targets Codex, Pi, Factory Droid and Devin. An opt-in CI
  workflow can publish a source-linked PR preview.
- Readers can search supplied source across contained guide snapshots, navigate diagrams and linked code
  with arrow keys, inspect source excerpts while reading, and view diagram relationships as text.
- Published examples now cover xpl and Cobra alongside refreshed Vite and Zod guides. Phone maps and focused
  flows keep their controls and selected branches more accessible.

The `v0.2.3` and `v0.2.4` tags were failed release attempts and did not publish npm packages. This release
follows the last published package, 0.2.2.

## [0.2.2]

- The website adds four self-contained examples from Vite and Zod. Readers can open them in a browser or
  save them for offline reading, with links to each source revision and license.

## [0.2.1]

- The landing page links to the public GitHub repository. The shorter README points to the docs for detailed workflows.

## [0.2.0]

- Authors can keep a local xpl service connected to a repository, watch source changes, and find guides that
  need attention.
- Authors can edit guide text and source evidence in the viewer, group and move map items, and save reviews
  and questions with their guide.
- xpl can prepare commit-bound GitHub pull request inputs, create a guide from a PR, and stage and link
  versioned previews.
- Readers can search guides and supplied source offline, navigate saved versions, and answer source-linked
  questions.
- The xpl website now includes user documentation.

## [0.1.0] - 2026-10-05

First npm release of the xpl CLI, viewer, tree-sitter grammars, and code-explainer skill as
[`@krimvp/xpl`](https://www.npmjs.com/package/@krimvp/xpl), under the MIT license.

- Install the CLI globally with npm and install its bundled code-explainer skill with `xpl skill install`.
- Build source-linked explainers for TypeScript/JavaScript, Python and Go, with configuration file support.
- Explore explanations in the interactive viewer or export them as a self-contained HTML file.
- Node 22.12 or newer is required. The packaged artifact was exercised on Linux x64 under WSL2 with Node
  22.23.1; other platforms were not verified.

[Unreleased]: https://github.com/krimvp/xpl/compare/v0.3.0...HEAD
[0.3.0]: https://github.com/krimvp/xpl/compare/v0.2.2...v0.3.0
[0.2.2]: https://github.com/krimvp/xpl/compare/v0.2.1...v0.2.2
[0.2.1]: https://github.com/krimvp/xpl/compare/v0.2.0...v0.2.1
[0.2.0]: https://github.com/krimvp/xpl/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/krimvp/xpl/releases/tag/v0.1.0
