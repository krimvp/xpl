# Rebuild the Zod overview

The public overview uses Zod commit `0b216ef674e297ebe41d8bf902262e56f8755822`.
[`zod-overview.patch.json`](zod-overview.patch.json) is the complete authoring patch. It was
applied through xpl against that commit; it does not depend on an older published bundle.
The index was built with `--precise off`, so TypeScript relationships are heuristic.

From a clean checkout of the pinned Zod commit, set `XPL` to the absolute path of a current
`packages/cli/dist/xpl.mjs` and `GUIDE` to this directory. Use Node 22 or 24.

```sh
node "$XPL" index --precise off
node "$XPL" new zod-overview --title "How Zod validates data with schemas" --repo zod
node "$XPL" lint zod-overview --patch "$GUIDE/zod-overview.patch.json"
node "$XPL" apply zod-overview "$GUIDE/zod-overview.patch.json"
node "$XPL" validate zod-overview
node "$XPL" status zod-overview
node "$XPL" lint zod-overview
node "$XPL" ready zod-overview
```

`validate` is strict by default. Make a portable copy of the generated index outside the
source checkout, then export. The source index and explainer stay intact.

```sh
python3 - <<'PY'
import json
from pathlib import Path
index = json.loads(Path('.explainer/index-0b216ef.json').read_text())
index['root'] = '.'
Path('/tmp/zod-overview-index.json').write_text(json.dumps(index, separators=(',', ':')))
PY
node "$XPL" --index /tmp/zod-overview-index.json bundle zod-overview -o /tmp/zod-overview.html
```

From the xpl checkout, prefix the bundle with [`LICENSE.txt`](LICENSE.txt):

```sh
python3 - <<'PY'
from pathlib import Path
source = Path('/tmp/zod-overview.html').read_text()
license_text = Path('site/examples/zod/LICENSE.txt').read_text().strip()
assert source.startswith('<!doctype html>\n<html')
published = '<!doctype html>\n<!--\n' + license_text + '\n-->\n' + source[len('<!doctype html>\n'):]
Path('site/examples/zod/zod-overview.html').write_text(published)
PY
npm run site
```

The site check confirms the embedded index root `.`, commit `0b216ef`, and no
local absolute path.

The system map has two authored arrows. The application call is shown in
`packages/zod/README.md` and implemented by the classic schema `parse` method. The core
parser returns data on success and throws on issues; `safeParse` returns a success or failure
result instead. The arrow now says **reports parse outcome** so it covers both paths.
These arrows are reviewed source claims, not precise static call traces.
