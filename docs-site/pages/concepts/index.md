# Concepts

## Guides

A guide (the files call it an explainer) answers one question about a repository for one kind of reader.
It is a JSON file, `.explainer/<name>.explainer.json`, that you commit next to the code. The agent never
writes it directly: it sends a patch, and `xpl apply` checks the patch and merges it, all or nothing. What
you edit yourself is marked as yours, and a later patch from the agent cannot overwrite it.

A guide has three scopes. It can answer a question about part of a project, give an overview of a whole
repository, or explain a change between two commits.

## Views and tours

A guide holds views and tours:

- A **map** shows parts and how they relate: folders, files, classes and functions, or for an overview the
  system, the services inside it and what they rely on. A box can open into the level below it.
- A **flow** follows the steps and decisions of a process.
- A **sequence** shows who calls whom, in order.
- A **tour** is the story: a short summary, then steps, each with a picture and its code.

The viewer opens on the Guide, which reads the tour as a page. The Map, Flow and Code tabs show the views
and the source. Explore puts every view next to the editor. Present plays a tour one step at a time, with the
arrow keys.

## Anchors and checked claims

Every box, arrow and step can carry anchors. An anchor names a file, a symbol or a range of lines, and keeps
a hash of the code it covered when it was written. xpl resolves each anchor against the index and the
current code:

- **ok**: the code is where it was and has not changed;
- **moved**: the same code is now at other lines; xpl updates the location and keeps the text;
- **drifted**: the code changed, so the explanation may be wrong and needs a new look;
- **missing**: the file or symbol is gone.

`xpl validate` and `xpl resolve` report these states, and a ready export refuses while an anchor is drifted
or missing. A valid anchor proves the location and that the code is unchanged. It does not prove that the
prose about the code is right: the author still answers for that.

## Trust labels

`xpl index` records symbols and the references between them (calls, imports, inheritance, type uses and
reads). Every reference is labelled:

- **precise**: from a compiler-grade SCIP indexer, when its tool can run;
- **heuristic**: from xpl's own scope-aware resolver, when no precise tool ran or a tool did not describe
  the file.

The viewer draws heuristic arrows lighter, and the agent treats them as hints to confirm by reading the
code. [Languages and precision](languages.md) lists what each language gets and what precise analysis costs.

## Readiness

`xpl ready <guide>` checks a guide before it is shared: the index is current, every source link resolves,
the required text is written, and the reader checks of `xpl lint` are reported. Blockers stop a ready export
(`xpl bundle`, Save as HTML) before anything is written. Warnings invite a decision: `--note "reason"`
records an intentional omission in the report and in the HTML. `xpl bundle --draft` writes a labelled draft
for repair work.

An optional author review records who looked at which content and evidence. It is shown apart from the
source checks; see [editing and author review](../workflows/edit-and-review.md).
