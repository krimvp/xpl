"""Publish a checked xpl or Cobra bundle with a portable source root and license."""

import json
import re
import sys
from pathlib import Path


source = Path(sys.argv[1])
destination = Path(sys.argv[2])
expected_commit = sys.argv[3]
assert destination.parent.name in {"xpl", "cobra"}, "expected an xpl or Cobra example"
assert destination.name in {
    "xpl-overview.html",
    "xpl-checked-edits.html",
    "cobra-overview.html",
    "cobra-command-execution.html",
}, "unexpected guide name"

html = source.read_text()
match = re.search(r'<script id="xpl-data" type="application/json">(.*?)</script>', html, re.S)
assert match, "missing embedded bundle"
data = json.loads(match.group(1))
assert data["explainer"]["index"]["commit"] == expected_commit[:7], "wrong source commit"
assert data["index"]["commit"] == expected_commit[:7], "wrong index commit"
root = data["index"]["root"]
assert root.startswith("/") and html.count(json.dumps(root, separators=(",", ":"))) == 1
html = html.replace(json.dumps(root, separators=(",", ":")), '"."', 1)

license_text = (destination.parent / "LICENSE.txt").read_text().rstrip("\n")
assert html.startswith("<!doctype html>\n"), "unexpected bundle doctype"
html = html.replace("<!doctype html>\n", f"<!doctype html>\n<!--\n{license_text}\n-->\n", 1)
assert "/Users/" not in html, "local path in bundle"
destination.write_text(html)
