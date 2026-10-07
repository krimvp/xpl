# Search and saved versions

## Search a guide

The viewer's **Search** panel works offline. It finds symbols, embedded source, concepts and tour steps, then opens the matching source range or step. Copied links restore the same location when the page is reopened. The panel reports the snapshot, embedded files, pruned analysis and unavailable coverage separately from a no-match result.

Search results are paged by category so a large number of source matches cannot hide matches in the explanation. When a repository service is attached, the guide picker also lists guides in the repository catalog. Other live guides open read-only; return to the library before selecting one to edit.

The CLI can search the indexed working tree too:

```sh
xpl guides
xpl search retry --code
xpl ready retry-guide
```

`xpl guides` lists local guides even without an index. `xpl search` warns when files are unavailable; `--json` records searchable paths and analysis scope. Guide metadata describes a guide but does not prove it is ready to share.

## Bundle a library

Include up to eight checked guide snapshots in a single offline export:

```sh
xpl bundle main-guide -o library.html \
  --include-guides retry-guide,operations-guide
```

Each guide keeps its own source and index scope. Additional guide data is limited to 20 MiB. Save or cancel unsaved drafts and pending edits before switching guides.

## Keep immutable versions

Preview the files and readiness without writing, then stage a version and promote it as current:

```sh
xpl stage main-guide --dir /outside/versions --preview
xpl stage main-guide --dir /outside/versions
```

Staging writes immutable HTML and a manifest before atomically promoting `current/index.html`. The manifest records commit and input hashes, readiness, source scope and author review state. If source or guide changes during staging, the previous current version stays in place. Previous versions remain available in the staged tree.

For a prepared PR, pass `--pr-result <result.json>` from `xpl pr finish` and `--root <prepared-repository>`; staging verifies the result and checks the GitHub base and head again. This stores files locally; it does not publish them. Keep the staged tree to preserve version history and links.

The viewer's About panel lists captured versions and their source scope. Step, element and head/base links reopen the same immutable version after a newer one is promoted. Save as HTML preserves the current navigation. Reload and browser Back/Forward restore the selected view, focus and source cursor.
