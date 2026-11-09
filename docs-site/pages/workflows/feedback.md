# Feedback and revision

A reader can leave a correction, a request to explain something, or a request to show more. It goes on a
selected box, arrow or step and on lines of code. In `xpl view`, feedback is saved to disk. In a saved HTML
page, it stays in browser storage until you export it as JSON. Saving feedback never starts your agent.

```sh
xpl feedback retry-guide --import /path/to/feedback.json
```

Then ask the installed skill to work through it: `/code-explainer feedback` in Claude Code or Factory Droid,
`$code-explainer feedback` in Codex, `/skill:code-explainer feedback` in Pi, or
`@skills:code-explainer feedback` in Devin. Each request has a fixed ID, so a second import of the same file
adds nothing. A request keeps the code snapshot, the lines, the outcome and the reason. When the code under a
request changed, xpl marks the request outdated, and you decide what to do with it: xpl never moves it to new
lines. Export browser feedback before you clear browser data. If browser storage is not available, export
JSON or save the page as HTML.

The next pass uses `xpl revise`. Select request IDs, read the proposed text and code-link changes, accept or
reject each one, then accept the set you reviewed. Before it saves, xpl checks the code, the snapshot and the
readiness again. It keeps the text you wrote and the previous version of the guide. An interrupted accept can
resume, and it does not apply a change or record an outcome twice. A code link whose code is gone needs your
decision: link it again or remove it. A code link whose code only moved keeps its text.

A live viewer reloads after the guide, the code or the index changes. Unsaved edits delay the reload. A saved
HTML page stays as it was when you exported it; export it again after a change. See the skill's
[revision workflow](../skill/revise.md).
