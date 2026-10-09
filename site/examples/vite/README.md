# Rebuild the Vite hot update guide

The published guide uses Vite commit `8a4c19cfc035f2dd203f2fa6d00ab9256a5e77c9`.
Its TypeScript relationships are heuristic. Its source anchors are checked against
that commit. The guide covers the `updateModules` decision, not every hot-update
hook or client behavior.

The original authoring patch is [`vite-hmr-baseline.patch.json`](vite-hmr-baseline.patch.json).
The correction is [`vite-hmr-repair.patch.json`](vite-hmr-repair.patch.json). To
rebuild the published page from the xpl repository root:

1. Build xpl with Node 22 or 24: `npm ci && npm run build`.
2. Check out the pinned Vite commit in a separate directory. Run the remaining
   commands there, using the absolute xpl CLI path for `xpl`.
3. Run `xpl index --precise off` and `xpl new vite-hmr --title "How Vite updates the browser after a file change"`.
4. Run `xpl apply vite-hmr /path/to/xpl/site/examples/vite/vite-hmr-baseline.patch.json`.
   This reconstructs the original explainer through xpl, without editing its
   JSON file directly.
5. Run `xpl lint vite-hmr --patch /path/to/xpl/site/examples/vite/vite-hmr-repair.patch.json`,
   then `xpl apply vite-hmr /path/to/xpl/site/examples/vite/vite-hmr-repair.patch.json`.
6. Run `xpl validate vite-hmr`, `xpl status vite-hmr`, `xpl lint vite-hmr`, and
   `xpl ready vite-hmr`. Export with `xpl bundle vite-hmr -o /tmp/vite-hmr.html`.
7. From the xpl repository root, run
   `python3 site/examples/vite/publish-vite.py /tmp/vite-hmr.html vite-hmr`. This adds the
   Vite license and normalizes the bundle's local index root before writing
   `site/examples/vite/vite-hmr.html`. Run `npm run site` to check the export.

The repair adds empty-module and circular-invalidation reload branches. It
distinguishes a dead end from an unanalyzed module, which can return without
sending an update.
