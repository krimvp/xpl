# Zod overview authoring

The published overview is built from Zod commit
`0b216ef674e297ebe41d8bf902262e56f8755822`. Its first map has two authored
relationships. The application call is shown in `packages/zod/README.md:56` and
implemented by `packages/zod/src/v4/classic/schemas.ts:298`. The core parser
returns the successful value at `packages/zod/src/v4/core/parse.ts:34`; it throws
on issues at line 32. `safeParse` returns a result object at line 78. The Zod
index was built with `--precise off`, so its derived references are heuristic.
These two arrows are separately checked, authored relationships, not precise
static references.

To rebuild from a clean checkout of Zod, build the xpl CLI first and set `XPL`
to its absolute `packages/cli/dist/xpl.mjs` path. From the xpl checkout, save
the original published bundle and the current license header outside either
repository:

```sh
git show 9cc3b478fb104597095f6e28c18364cf66c4ff73:site/examples/zod/zod-overview.html > /tmp/zod-overview-before.html
cp site/examples/zod/LICENSE.txt /tmp/zod-overview-license.txt
git clone https://github.com/colinhacks/zod.git /tmp/xpl-zod-overview
cd /tmp/xpl-zod-overview
git checkout --detach 0b216ef674e297ebe41d8bf902262e56f8755822
node "$XPL" index --precise off
node "$XPL" new zod-overview --title "How Zod validates data with schemas" --repo zod
```

Recover the original guide as an editable patch. This removes generated anchor
caches and provenance; `xpl apply` checks the anchors against the pinned source
and writes the editable `.explainer/zod-overview.explainer.json`.

```sh
python3 - <<'PY'
import json
import re
from pathlib import Path

html = Path('/tmp/zod-overview-before.html').read_text()
bundle = json.loads(re.search(r'<script id="xpl-data" type="application/json">(.*?)</script>', html, re.S).group(1))
explainer = bundle['explainer']

def editable(value):
    if isinstance(value, list):
        return [editable(item) for item in value]
    if isinstance(value, dict):
        return {key: editable(item) for key, item in value.items() if key not in ('provenance', 'hash', 'resolved')}
    return value

patch = {key: editable(explainer[key]) for key in ('title', 'scope', 'nodes', 'edges', 'concepts', 'views', 'tours')}
Path('/tmp/zod-overview-baseline.patch.json').write_text(json.dumps(patch, indent=2) + '\n')
PY
node "$XPL" apply zod-overview /tmp/zod-overview-baseline.patch.json
```

Save the following repair patch outside the source checkout as
`/tmp/zod-overview-system.patch.json`, then run `xpl lint --patch` and `xpl
apply`. Span offsets are zero-based; `from: 31` is source line 32.

```json
{
  "edges": [
    {
      "id": "edge:application-parses-input",
      "from": "grp:app",
      "to": "grp:zod",
      "kind": "calls",
      "label": "calls schema.parse(input)",
      "summary": "The application calls parse on a Zod schema with an input value. The README shows this use, and the classic schema method passes the value to the parser.",
      "anchors": [
        { "file": "packages/zod/README.md", "find": "const data = User.parse(input);", "role": "call-site" },
        { "file": "packages/zod/src/v4/classic/schemas.ts", "find": "return parse.parse(this, data, params, { callee: _parse });", "role": "definition" }
      ]
    },
    {
      "id": "edge:parse-produces-result",
      "from": "grp:zod",
      "to": "grp:result",
      "kind": "custom",
      "label": "returns validated data",
      "summary": "For parse, the core parser returns the parsed value when there are no issues and throws an error when issues are present. safeParse instead returns a success result with data or a failure result with an error.",
      "anchors": [
        { "file": "packages/zod/src/v4/core/parse.ts", "span": { "from": 33, "to": 33 }, "role": "usage" },
        { "file": "packages/zod/src/v4/core/parse.ts", "span": { "from": 31, "to": 31 }, "role": "usage" },
        { "file": "packages/zod/README.md", "find": "const data = User.parse(input);", "role": "usage" },
        { "file": "packages/zod/src/v4/core/parse.ts", "span": { "from": 77, "to": 77 }, "role": "usage" }
      ]
    }
  ]
}
```

Finish the source checks and export:

```sh
node "$XPL" lint zod-overview --patch /tmp/zod-overview-system.patch.json
node "$XPL" apply zod-overview /tmp/zod-overview-system.patch.json
node "$XPL" validate zod-overview
node "$XPL" lint zod-overview
node "$XPL" status zod-overview
node "$XPL" ready zod-overview
python3 - <<'PY'
import json
from pathlib import Path

index = json.loads(Path('.explainer/index-0b216ef.json').read_text())
index['root'] = '.'
Path('/tmp/zod-overview-index-portable.json').write_text(json.dumps(index))
PY
node "$XPL" --index /tmp/zod-overview-index-portable.json bundle zod-overview -o /tmp/zod-overview.html
```

The portable index copy makes the bundled `index.root` equal `.`. Prefix the
bundle with the upstream license, then replace the published file from the xpl
checkout. This adds a comment before `<html>` and leaves xpl's embedded data
untouched:

```sh
cd /path/to/xpl
python3 - <<'PY'
from pathlib import Path

html = Path('/tmp/zod-overview.html').read_text()
license = Path('/tmp/zod-overview-license.txt').read_text().strip()
assert html.startswith('<!doctype html>\n<html')
published = '<!doctype html>\n<!--\n' + license + '\n-->\n' + html[len('<!doctype html>\n'):]
Path('site/examples/zod/zod-overview.html').write_text(published)
PY
npm run site
```

The published HTML must retain the full MIT header, the `xpl-data` script,
portable root and ready export status.
