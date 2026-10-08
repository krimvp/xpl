"""Prepare a Vite HMR xpl bundle for the public site."""

import re
import sys
from pathlib import Path


bundle = Path(sys.argv[1]).read_text()
site = Path(__file__).parent
license_text = (site / "LICENSE.txt").read_text().rstrip("\n")

root = re.compile(r'"root":"/[^"\\]*"')
assert len(root.findall(bundle)) == 1, "expected one index root in bundle"
bundle = root.sub('"root":"."', bundle)
assert bundle.startswith("<!doctype html>\n"), "expected xpl bundle doctype"
bundle = bundle.replace(
    "<!doctype html>\n", f"<!doctype html>\n<!--\n{license_text}\n-->\n", 1
)
(site / "vite-hmr.html").write_text(bundle)
