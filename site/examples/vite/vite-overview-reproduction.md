# Rebuild the Vite overview

The public overview is pinned to Vite commit
`8a4c19cfc035f2dd203f2fa6d00ab9256a5e77c9`. Its TypeScript relationships
are heuristic. Source anchors are checked against that commit.

The original authoring patch is
[`vite-overview-baseline.patch.json`](vite-overview-baseline.patch.json). The
three system-map arrows are in
[`vite-overview-edges.patch.json`](vite-overview-edges.patch.json). To reproduce
the public HTML:

1. Build xpl with Node 22 or 24: `npm ci && npm run build`.
2. Check out the pinned Vite commit in a separate directory. Run the remaining
   xpl commands there with the absolute path to the built xpl CLI.
3. Run `xpl index --precise off` and
   `xpl new vite-overview --title "How Vite serves and builds a web app"`.
4. Apply the baseline with
   `xpl apply vite-overview /path/to/xpl/site/examples/vite/vite-overview-baseline.patch.json`.
5. Run
   `xpl lint vite-overview --patch /path/to/xpl/site/examples/vite/vite-overview-edges.patch.json`
   and
   `xpl apply vite-overview /path/to/xpl/site/examples/vite/vite-overview-edges.patch.json`.
6. Run `xpl validate vite-overview`, `xpl status vite-overview`,
   `xpl lint vite-overview`, and `xpl ready vite-overview`. Export with
   `xpl bundle vite-overview -o /tmp/vite-overview.html`.
7. From the xpl repository root, run
   `python3 site/examples/vite/publish-vite.py /tmp/vite-overview.html vite-overview`.
   The script adds Vite's license and normalizes the local index root before
   writing `site/examples/vite/vite-overview.html`. Run `npm run site` to check it.

The system map links the developer to Vite's dev server and production builder,
and the browser's module requests to the dev server. Each authored edge is
anchored at the pinned source; it does not claim a precise cross-system call
trace.
