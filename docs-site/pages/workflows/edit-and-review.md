# Editing and author review

## Edit in the viewer

In Explore, select a box, an arrow you added or a concept, then choose **Edit text** in Details. Correct its
label, its summary or its Markdown detail. A concept also lets you pick the boxes it relates to. **Save text**
marks the text as yours. **Cancel** drops the draft. A live save survives a reload, and it is refused when the
guide changed after you opened it. A draft stays while you select other boxes. In a saved HTML page, an edit
stays unsaved until you export HTML or JSON.

**Edit code links** edits the code links. Select lines in the read-only code pane: xpl checks them against a
symbol or a file and, in a change guide, against the base. Replace, remove or add code links, then choose
**Save code links**. Fix or remove every broken code link on the box, arrow or step first; a refused save keeps
the draft. If the code differs from its index, index again and reload. A later revision by your agent keeps
the fields you edited.

Edit > **Undo** and **Redo** name the fields and boxes they change. Undo saves only the changed fields, keeps
your other edits, and refuses a conflict on the same field. A live guide keeps up to 50 edits in browser
storage, per repository and guide. A copied or renamed guide starts with no history. A saved HTML page keeps
undo only until you close it.

In Explore, **Edit map** puts the selected boxes that share a parent in a named group. Shift-click to select
several boxes. **Ungroup in this map** shows the members on this map and keeps the group for other maps,
arrows and tour steps. **Hide selected items** hides boxes or arrows; the same menu shows them again. Drag a
box by its move handle, or use its arrow keys, to pin it. Reset one or all positions to go back to the
automatic layout. These edits are kept in live guides and in HTML and JSON exports. Pan and zoom do not change
the map.

## Mark a guide as reviewed

Edit > **Mark as reviewed** records your name, what you checked (the text and the code links) and what you did
not check. **About this guide** shows the review state: **Not yet reviewed by a person**, **Reviewed by a
person** or **Changed since a person reviewed it**. It is separate from the code checks. A review of named boxes and steps covers them and their code links; a change to
other code does not make it out of date. A review of the whole repository covers every indexed file. A saved
HTML page holds the review, but it cannot see later changes to the repository.

A review is optional. `xpl ready --require-review` and `xpl bundle --require-review` refuse a guide without a
current review of all its content. The team-policy option of **Save as HTML** asks for the same, and the
exported page keeps that setting. The name and time are what the reviewer typed: xpl does not check who they
are, whether the text is right, or whether the guide covers every path the code can take.
