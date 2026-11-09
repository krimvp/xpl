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
- `xpl draft data <guide> [<scope>]` drafts a data map: a table per type with a row per field and its type,
  and arrows from a field to the type it holds (`boxText: "members"` on any map). Rows link to their code
  both ways. It maps the largest groups of linked types, 6 boxes in all, and gives each group left off a note
  with the command that maps it. In Python the attributes `__init__` sets on `self` are fields.
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
- An `alt` frame in a sequence draws its arms: a dashed line between two choices, each with its condition in
  brackets. Click a condition to select its steps and their code. `xpl draft path` drafts the arms, and a
  patch sets them with `arms`. An `if` that ends in `continue`, `return`, `break`, `raise` or `throw` is drafted
  as an `alt` whose other arm is the rest of the loop body or function.
- A data map names a field's arrow "holds" everywhere: the map, the Key, the text view, the matrix, the
  Details and its accessible name (with the type that owns the field). Its matrix has one row and column per
  type, and a cell names the fields. A field row needs no text: it shows the field's declaration. Go structs
  and fields are "struct" and "field" on the box, its icon, the Key and the Details.
- A data map is laid out top to bottom when that draws it larger. A map too big to read whole opens on the
  box its tour starts on, all of it in sight.
- Present widens the diagram column, up to about two thirds of the slide, so that a map keeps 12 px text.
- A precise language tool now clears the "Some arrows may be missing" bar for what it covers, also when the
  tree-sitter pack of that language does not.
- A data map is one Tab stop per table, starting at the tour's first table. Down goes into its rows; "-"
  folds a table to one box and "+" shows its rows again.
- On Map and Flow, the diagram takes the full width until you select something; then the code column opens.
- In Present the text card is as tall as its text and the diagram gets the rest; the Fit chip never covers a
  box.
- In a change guide a flow step whose code the change added or edits carries a "New" or "Changed" pill, as
  a map box does. A group whose code the change added in full (a box of new tests) is "New".
- Until you first select something, Concepts and Details fold to one line under the diagram, so a tall
  sequence or flow opens whole. Present keeps the lifelines that send a sequence's drawn arrows in frame.
- Folding a table of a data map keeps its arrows, which then start at the folded table, and keeps every other
  box where it was.
- A guide with no map of its own gets a Map tab only when its flow has 3 parts or more. That map's title is
  "Parts of" and the flow's title, and its boxes are not drawn larger than normal size.
- Two arrow labels on one line, in opposite directions, sit on either side of the line, so they no longer
  read as one label.
- An `implements` arrow lifted to a file or a folder reads "implements an interface in". A value declared
  `const` is a "constant". A tour step on a group lists only the tests among its members that are test code.
- On a phone, the Map and Flow tabs open on the diagram, not on the code a Tour step opened.
- A flow too tall for its pane is also laid out left to right, or in 2-4 parts side by side, and the shape
  that reads larger wins. A decision diamond is as big as its words, and its arrows meet its outline.
- A flow of states (`xpl draft states`) draws the states as pills and the moves between them as flat dotted
  boxes, with no step numbers.
- On a Go map an embedded field or interface reads "embeds" (or "embeds a type in"), not "extends".
- Explore keeps the diagram's height when you select something: Details open at the top of the code column,
  and the file tree stays beside the code.
- A Present slide whose focus covers nearly all of a map shows the whole map, even when its text is then
  smaller than 12 px.
- Search names each result's kind and file in plain words and says how many files the page holds. What it
  cannot find in this page is listed under "What search cannot find here".
- J and K step through the Tour. The Code tab with nothing selected has no empty column.
- The box, arrow or step whose code holds the caret is magenta, so it is not confused with the orange "called
  here" mark in the code.

Indexing:

- Web requests (`fetch`, axios, `requests`, `httpx`, Go `net/http`) link to the route that answers them in
  Express, Koa, Hono, Fastify, Next.js, FastAPI, Flask, net/http, chi, gin and echo. Maps draw these links
  as `requests` arrows. They are always heuristic. (#238)
- A request path built from a file's string constant reads the constant's value. `xpl draft map` leaves out
  code files that define and use nothing. (#240)
- Names that a function takes from `await import()` or `require()` resolve, so their calls are arrows.
- Rust: a root-level `mod` declaration and a `use` path inside the package (`crate::`, `self::`, `super::` or
  the crate's own name) are file imports (heuristic). `xpl health` and `xpl draft map` read them as "this
  file is used". `xpl health` no longer calls a file unused when its language's analysis does not follow
  imports: it says how many files it cannot tell about.

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
- `xpl change` finds the tests of a changed symbol through its callers too, and `xpl draft change` gives
  the changed code its "before" links. `xpl lint` flags a sequence with more than 6 lifelines
  (`many-participants`).
- The `xpl draft repo` tour has at most 7 steps, "where next" included, and leaves 2 for the main path and its
  risks. The note names the `xpl draft path` command to run. Its parts steps point at the code that other
  files call most. Without a read call, a settings file that the code names by a literal path becomes the
  settings box. A draft numbers its new tour steps after the ids the guide already uses.
- `xpl draft path` draws an `opt` over the rest of a loop body when a guard with no drawn call skips it with
  `continue` or `break`.
- The `xpl draft map` tour ends on where to start reading: the shallowest file with a `main` function, else a
  file named like main, index or app. Its first note names the files that are not code, which have no box.
- `xpl lint` flags a box on a map of summaries whose label has more than 5 words, or whose sentence is over
  130 characters or starts with an article, "This", "It" or the file's name (`map-box`).
- `xpl draft class` leaves types in test files off the map, with a note, unless the entry is in one. A Go
  entry's links read "embeds" and "embedded by".
- `-o /dev/null` no longer replaces `/dev/null` with a regular file: xpl writes to a device in place.
- The skill puts its hard rules first, starts every guide from its purpose, and gives each scope a tour shape
  and a length budget. Its writing guide follows Orwell's rules and ASD-STE100 Simplified Technical English.

Command-line messages:

- Help text wraps at 110 columns. An unknown command or option suggests the nearest name, for example
  `Did you mean: --depth?`. `xpl ready` prints each finding as the problem, then "fix:" and the fix.
  Errors use the right article ("an interface", "an enum"). The `xpl draft states` error names the command
  that lists candidates.
- Each command's `--help` is shorter: usage, a few lines, the options and a link to the docs.
- `xpl resolve` and `xpl change` take the only guide when you leave out its name.
- Messages and hints use plain words and name the command to run, for example "fix this field with
  `xpl apply`, then run `xpl validate` again".

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
- The landing page links each example by its guide's own title. The Vite and Zod overviews start with
  what the library is for, and the Cobra execution tour says where the version flag exits.
- The skill says that every arrow you store needs a summary and that a small subject may take fewer steps
  than its budget. The languages page describes the `refs:` column of `xpl index` and `--verbose`.
- SECURITY.md names the supported line (0.3.x) and says that only `xpl view` takes `--host`. The README and
  the docs list every supported language, including Rust, and give the exit codes of `xpl health`.
- The landing page names the languages xpl reads and links to the languages page. On a phone its picture
  is a phone-sized view of the same sequence, so its labels can be read.
- The skill says which 2 steps of `xpl draft path` to keep in a repository guide, and where they go. It
  tells the agent to read the coverage lines of `xpl index` for Rust, Ruby and PHP. The Vite overview
  links its "starts dev server" arrow to the `server.listen()` call.

## [0.3.0] - 2026-10-09

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

## [0.2.2] - 2026-10-07

- The website adds four self-contained examples from Vite and Zod. Readers can open them in a browser or
  save them for offline reading, with links to each source revision and license.

## [0.2.1] - 2026-10-07

- The landing page links to the public GitHub repository. The shorter README points to the docs for detailed workflows.

## [0.2.0] - 2026-10-07

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
