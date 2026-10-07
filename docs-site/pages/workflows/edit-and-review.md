# Editing and author review

## Edit in the viewer

In Explore, select a box, stored arrow or concept and choose **Edit text** in Details. Correct its label, summary or Markdown detail; concepts also let you select related elements. **Save text** marks your edit as user-owned. **Cancel** drops the draft. Live saves survive reload and reject stale inspected versions. Drafts stay available while you switch between elements. Offline edits remain unsaved until you export HTML or JSON.

Use **Edit evidence** to preview source lines in the read-only source pane. Lines are checked against a symbol or file and, for change guides, against the base. Replace, remove or add anchors, then choose **Save evidence**. Repair or remove every invalid anchor on the element; a rejected save keeps the draft. If source differs from its index, reindex and reload. Later LLM revisions preserve your edited fields.

Edit > **Undo** / **Redo** names changed fields and elements. It saves only changed fields, preserves unrelated edits, and refuses conflicts on the same field. Live history keeps up to 50 edits in browser storage, scoped to the repository and guide. Copied or renamed guides do not inherit history; offline pages keep only in-session undo.

In Explore, **Edit map** groups selected sibling boxes under a named container. Shift-click to select multiple boxes. **Ungroup in this map** shows the members while keeping the stored group for other maps, arrows and tour steps. **Hide selected items** hides boxes or arrows; restore hidden IDs from the same menu. Drag a box's move handle or use its arrow keys to pin it. Reset one or all placements to return to automatic layout. These edits persist in live views and HTML/JSON exports; pan and zoom do not change the map.

## Record an author review

Edit > **Record author review** records a self-reported name, the content and evidence inspected, and named omissions. About this explanation shows **unchecked**, **reviewed** or **out of date** separately from source checks. A narrow review covers named stored items and their anchors; unrelated source edits do not invalidate it. Repository scope covers every indexed file. Broad review evidence is included in HTML, but an offline page cannot detect later repository changes.

Review is optional. Use `xpl ready --require-review` or `xpl bundle --require-review` to require a current review of all stored content. The Save as HTML team-policy option can also require it and remains selected in that exported page. Omission notes remain the author's judgment; the recorded name and time do not verify identity, prose accuracy or complete runtime coverage.
