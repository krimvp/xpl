# Cobra example source

- Upstream: https://github.com/spf13/cobra
- Commit: `adbc8813901bba65827259daa8e22ff94ec1f30e`
- License: Apache License 2.0, copied verbatim in [LICENSE.txt](LICENSE.txt) and embedded in each HTML page.
- Authoring: [`cobra-overview.patch.json`](cobra-overview.patch.json) and
  [`cobra-command-execution.patch.json`](cobra-command-execution.patch.json) are the replayable patches. They
  were checked against the pinned source in `command.go`, `args.go`, `flag_groups.go`, `completions.go`, and
  `doc/md_docs.go`.
- Trust: Go references are heuristic; the command selection and run path were checked directly in `command.go`. The index reported 36/36 Go files analyzed, partial declaration ranges and relationships, 789 Go symbols, and 4,676 references overall.
- Pages: `cobra-overview.html` embeds 18 of 64 indexed files; `cobra-command-execution.html` embeds 1 of 64.
  Both are self-contained offline xpl bundles generated from the pinned checkout.

## Rebuild

Build xpl with Node 22 or 24: `npm ci && npm run build`. Check out the pinned Cobra commit in a separate
directory. Set `XPL` to the absolute path of the built `packages/cli/dist/xpl.mjs`, and `SITE` to the
absolute path of this repository's `site/examples` directory. From the Cobra checkout:

```sh
node "$XPL" index --precise off
node "$XPL" new cobra-overview --title "How Cobra builds command-line programs" --repo cobra --url https://github.com/spf13/cobra
node "$XPL" lint cobra-overview --patch "$SITE/cobra/cobra-overview.patch.json"
node "$XPL" apply cobra-overview "$SITE/cobra/cobra-overview.patch.json"
node "$XPL" new cobra-command-execution --title "How Cobra selects and runs a command" --repo cobra --url https://github.com/spf13/cobra
node "$XPL" lint cobra-command-execution --patch "$SITE/cobra/cobra-command-execution.patch.json"
node "$XPL" apply cobra-command-execution "$SITE/cobra/cobra-command-execution.patch.json"
```

For each name, run `node "$XPL" validate NAME`, `status NAME`, `anchors NAME tour:overview` (or
`tour:execution`), `lint NAME`, and `ready NAME`. Validation is strict by default. Export each with
`node "$XPL" bundle NAME -o /tmp/NAME.html`. From the authoring checkout, publish it with:

```sh
python3 "$SITE/publish-xpl-cobra.py" /tmp/NAME.html "$SITE/cobra/NAME.html" adbc8813901bba65827259daa8e22ff94ec1f30e
```

Then run `npm run site`.
