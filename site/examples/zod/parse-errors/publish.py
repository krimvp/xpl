"""Add Zod's license to the checked parse guide bundle."""

import json
import re
import sys
from pathlib import Path


bundle = Path(sys.argv[1]).read_text()
data = json.loads(re.search(r'<script id="xpl-data" type="application/json">(.*?)</script>', bundle, re.S).group(1))
assert data["index"]["root"] == ".", "bundle index must use a portable root"
assert data["index"]["commit"] == "0b216ef", "bundle source commit changed"
assert data["guideId"] == "zod-parse-errors", "wrong guide"
assert bundle.startswith("<!doctype html>\n"), "expected an xpl bundle"

site = Path(__file__).resolve().parent.parent
license_text = (site / "LICENSE.txt").read_text().rstrip("\n")
published = bundle.replace("<!doctype html>\n", f"<!doctype html>\n<!--\n{license_text}\n-->\n", 1)
(site / "zod-parse-errors.html").write_text(published)
