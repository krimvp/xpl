# Feedback and revision

Readers can leave corrections, explanation requests and expansions on a selected diagram element and source range. In `xpl view`, feedback is saved to disk. In a disconnected saved page, it stays in browser storage until exported as JSON. Saving feedback never starts generation.

```sh
xpl feedback retry-guide --import /path/to/feedback.json
```

Then ask the installed skill to process it with `/code-explainer feedback`. Stable request IDs deduplicate repeated imports. The record retains the original source snapshot, range, outcome and reason. Requests tied to changed snapshots are marked outdated and need explicit reconciliation. Export browser feedback before clearing browser data. If browser storage is unavailable, export JSON or save the page as HTML.

The next pass uses `xpl revise`: select request IDs, inspect proposed text and source changes, choose which outcomes to accept or reject, then explicitly accept the reviewed subset. Acceptance rechecks the live source, snapshot and readiness; it preserves user-owned content and the previous guide. Interrupted acceptance can resume without applying changes or recording outcomes twice. Missing anchors need an explicit re-anchor or removal decision; a moved location keeps its existing prose.

A live viewer refreshes after guide, source or index changes. Unsaved edits postpone refresh. A saved HTML page stays at its exported snapshot; re-export after changes. See the skill's [revision workflow](https://github.com/krimvp/xpl/blob/main/skill/code-explainer/reference/revise.md).
