# xpl example source

- Upstream: https://github.com/krimvp/xpl
- Commit: `7a291f9407ccbdf1a6a7e3a8bab23041f55883e1`
- License: MIT, copied in [LICENSE.txt](LICENSE.txt) and embedded in both HTML pages.
- Authoring: [`xpl-overview.patch.json`](xpl-overview.patch.json) and
  [`xpl-checked-edits.patch.json`](xpl-checked-edits.patch.json) are the replayable patches.
- Trust: TypeScript and JavaScript relationships came from `--precise off` and remain heuristic. Anchors and
  their freshness were checked against the pinned source. That does not establish that every sentence is true
  or that the guides cover every path.
- Pages: `xpl-overview.html` embeds 192 of 708 indexed files;
  `xpl-checked-edits.html` embeds 4 of 708. Both are offline HTML bundles.

## Rebuild

Build xpl with Node 22 or 24: `npm ci && npm run build`. Check out the pinned commit in a separate clean
directory. Set `XPL` to the absolute path of the built `packages/cli/dist/xpl.mjs`, and `SITE` to the
absolute path of this repository's `site/examples` directory. From the pinned xpl source checkout:

```sh
node "$XPL" index --precise off
node "$XPL" new xpl-overview --title "How xpl links guides to source" --repo xpl --url https://github.com/krimvp/xpl
node "$XPL" lint xpl-overview --patch "$SITE/xpl/xpl-overview.patch.json"
node "$XPL" apply xpl-overview "$SITE/xpl/xpl-overview.patch.json"
node "$XPL" new xpl-checked-edits --title "How xpl checks and applies guide edits" --repo xpl --url https://github.com/krimvp/xpl
node "$XPL" lint xpl-checked-edits --patch "$SITE/xpl/xpl-checked-edits.patch.json"
node "$XPL" apply xpl-checked-edits "$SITE/xpl/xpl-checked-edits.patch.json"
```

For each name, run `node "$XPL" validate NAME`, `status NAME`, `anchors NAME tour:overview` (or
`tour:apply-command`), `lint NAME`, and `ready NAME`. Validation is strict by default. Export each with
`node "$XPL" bundle NAME -o /tmp/NAME.html`. From the authoring checkout, publish it with:

```sh
python3 "$SITE/publish-xpl-cobra.py" /tmp/NAME.html "$SITE/xpl/NAME.html" 7a291f9407ccbdf1a6a7e3a8bab23041f55883e1
```

Then run `npm run site`.

The overview has a five-box reader path and a separate map of the four packages. Its authored arrows show
direct source-backed relationships. The checked-edits page focuses on `xpl apply` from patch read to
conditional save; export readiness, feedback, and review policies are outside that flow.
