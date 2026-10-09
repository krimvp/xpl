# Rebuild the Zod parse outcomes guide

The published guide uses Zod commit `0b216ef674e297ebe41d8bf902262e56f8755822`.
It covers the synchronous classic `parse` and `safeParse` methods. TypeScript
relationships in the index are heuristic. Every displayed source anchor is
checked against that commit.

`baseline.patch.json` reconstructs the explainer embedded in the previous
published bundle. Its title, scope, nodes, views and tour were compared with
the embedded explainer and matched exactly. `outcomes.patch.json` replaces its
safe-only flow with branches for both methods and updates the tour.

From the xpl repository root:

1. Use Node 22 or 24 and run `npm ci && npm run build`.
2. Check out the pinned Zod commit in a separate directory. Keep its tracked
   source files unchanged; xpl writes authoring files under `.explainer/`.
   Run the commands below there, with `XPL` set to the
   absolute path of `packages/cli/dist/xpl.mjs` in this xpl repository and
   `GUIDE` set to this `parse-errors` directory.

```sh
node "$XPL" index --precise off
node "$XPL" new zod-parse-errors --title "How Zod returns parsed data or errors"
node "$XPL" apply zod-parse-errors "$GUIDE/baseline.patch.json"
node "$XPL" lint zod-parse-errors --patch "$GUIDE/outcomes.patch.json"
node "$XPL" apply zod-parse-errors "$GUIDE/outcomes.patch.json"
node "$XPL" validate zod-parse-errors
node "$XPL" status zod-parse-errors
node "$XPL" lint zod-parse-errors
node "$XPL" ready zod-parse-errors
```

3. Copy `.explainer/index-0b216ef.json` to a scratch file outside either
   repository, changing only its `root` field to `"."`. The checked index and
   authoring explainer stay untouched. Bundle with that portable index:

```sh
python3 - <<'PY'
import json
from pathlib import Path
source = Path('.explainer/index-0b216ef.json')
index = json.loads(source.read_text())
index['root'] = '.'
Path('/tmp/zod-parse-public-index.json').write_text(json.dumps(index, separators=(',', ':')))
PY
node "$XPL" --index /tmp/zod-parse-public-index.json bundle zod-parse-errors -o /tmp/zod-parse-errors.html
```

4. From the xpl repository root, run
   `python3 site/examples/zod/parse-errors/publish.py /tmp/zod-parse-errors.html`.
   It checks the guide ID, source commit and portable index root, then adds
   Zod's license before the generated HTML. Run `npm run site` to check the
   published page.

The flow and tour distinguish the two validation outcomes. Both synchronous
methods throw an async error if schema execution unexpectedly returns a Promise.
