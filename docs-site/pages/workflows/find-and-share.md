# Search and saved versions

## Search a guide

The viewer's **Search** panel works offline. It finds symbols, embedded source, concepts and tour steps, then
opens the matching source range or step. Copied links restore the same location when the page is reopened. The
panel reports the snapshot, embedded files, pruned analysis and unavailable coverage separately from a
no-match result.

Search results are paged by category so a large number of source matches cannot hide matches in the
explanation. When a repository service is attached, the guide picker also lists guides in the repository
catalog. Other live guides open read-only; return to the library before selecting one to edit.

The CLI can search the indexed working tree too:

```sh
xpl guides
xpl search retry --code
xpl ready retry-guide
```

`xpl guides` lists local guides even without an index. `xpl search` warns when files are unavailable; `--json`
records searchable paths and analysis scope. Guide metadata describes a guide but does not prove it is ready
to share.

## Bundle a library

Include up to eight checked guide snapshots in a single offline export:

```sh
xpl bundle main-guide -o library.html \
  --include-guides retry-guide,operations-guide
```

Each guide keeps its own source and index scope. Additional guide data is limited to 20 MiB. Save or cancel
unsaved drafts and pending edits before switching guides.

## Keep fixed versions

Preview the files and readiness without writing, then stage a version and promote it as current:

```sh
xpl stage main-guide --dir /outside/versions --preview
xpl stage main-guide --dir /outside/versions
```

Staging writes the HTML of the version and a manifest, then makes it `current/index.html` in one step. A staged
version never changes. The manifest records the commit and input hashes, the readiness, the files included and
the author review state. If the code or the guide changes during staging, the previous current version stays.
Earlier versions stay in the staged folder.

For a prepared PR, pass `--pr-result <result.json>` from `xpl pr finish` and `--root <prepared-repository>`;
staging checks the result and the GitHub base and head again. This stores files on your machine; it does not
publish them. Keep the staged folder to keep the version history and its links working.

**About this guide** in the viewer lists the staged versions and the files each one includes. A link to a
step, a box or a head or base line opens the same version, also after a newer one became current. **Save as
HTML** keeps the place you are reading. Reload and the browser's Back and Forward restore the diagram, the
selection and the cursor in the code.
