# Concepts

## Guides

A guide answers one question about a repository for one kind of reader. The files call it an explainer.
It is a JSON file, `.explainer/<name>.explainer.json`, that you commit next to the code. The agent never
writes it directly: it sends a patch, and `xpl apply` checks the patch and merges it, all or nothing. What
you edit yourself is marked as yours, and a later patch from the agent cannot overwrite it.

A guide has three scopes. It can answer a question about part of a project, give an overview of a whole
repository, or explain a change between two commits.

## Diagrams and tours

A guide holds diagrams and tours. A diagram is one of three kinds:

- A **map** shows parts and how they relate: folders, files, classes and functions, or for an overview the
  system, the services inside it and what they rely on. A box can open into the level below it. On a quick
  map (`xpl draft map`) each box also shows its one-sentence summary. Select a box and choose "What it leads
  to" or "What leads to it": the map lights up every box reached along its arrows.

  A map can also show as a **dependency matrix**, a table: a row and a numbered column per box, and in each
  cell the arrows from the row's box to the column's, with their count. Press **Matrix** in the toolbar of a
  map of four or more boxes (**Diagram** goes back); a guide can also open a dense map this way. The order
  puts a box before the boxes it uses, so only an arrow of a cycle has a flagged cell below the diagonal; its
  mirror cell above is the other half of the cycle. A last row and column, "Outside this map", count the
  arrows to code the map does not draw. Select a cell to select its arrow and show its code. The cells of the
  code under the cursor light up, as on the map.

- A **flow** follows the steps and decisions of a process.
- A **sequence** shows who calls whom, in order.

A **tour** is the story, in order. Its summary gives the answer in the first sentence, then up to four
reasons. Each step has a short note, a diagram and its code. A note can hold a small table that compares
options side by side.

The viewer opens on the Tour tab, which shows the tour as one page. The Map, Flow and Code tabs show the
diagrams and the source. Explore puts every diagram next to the code. Present plays a tour one step at a
time; the arrow keys move between steps.

Each diagram has "Save image" beside its zoom buttons. It downloads the whole diagram as a PNG, named after
the diagram, as it looks on screen (selection and theme included). The theme button in the header switches
between Auto (follows your device), Light and Dark, and the browser remembers the choice.

## Code links and checked claims

Every box, arrow and step can carry code links. The files call them anchors. A code link names a file, a
symbol or a range of lines, and keeps a hash of the code it covered when it was written. xpl resolves each
link against the index and the current code:

- **ok**: the code is where it was and has not changed;
- **moved**: the same code is now at other lines; xpl updates the location and keeps the text;
- **drifted**: the code changed, so the text may be wrong and needs a new look;
- **missing**: the file or symbol is gone.

`xpl validate` and `xpl resolve` report these states, and a ready export refuses while a code link is
drifted or missing. A valid code link proves the location and that the code is unchanged. It does not prove
that the text about the code is right: the author still answers for that.

## Trust labels

`xpl index` records symbols and the references between them (calls, imports, inheritance, type uses and
reads). Every reference is labelled:

- **precise** (checked by a language tool): from a SCIP indexer, when its tool can run;
- **heuristic** (matched by name): from xpl's own resolver, which matches names by scope, when no precise
  tool ran or a tool did not describe the file.

The viewer draws heuristic arrows dashed, in both themes, and the agent treats them as hints to confirm by
reading the code. [Languages and precision](languages.md) lists what each language gets and what precise
analysis costs.

## Readiness

`xpl ready <guide>` checks a guide before it is shared: the index is current, every code link resolves,
the required text is written, and the reader checks of `xpl lint` are reported. Blockers stop a ready export
(`xpl bundle`, Save as HTML) before anything is written. Warnings invite a decision: `--note "reason"`
records an intentional omission in the report and in the HTML. `xpl bundle --draft` writes a labelled draft
for repair work.

An optional author review records who checked which text and which code links. It is shown apart from the
source checks; see [editing and author review](../workflows/edit-and-review.md).
