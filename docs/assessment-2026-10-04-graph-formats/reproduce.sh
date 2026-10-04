#!/usr/bin/env bash
# Rebuilds the SCIP, Kythe and Joern CPG artifacts of fixtures/go-jobrunner and runs assess.mts.
#
#   docs/assessment-2026-10-04-graph-formats/reproduce.sh <work-dir> <kythe-release-dir> <joern-cli-dir>
#
# Tools: Kythe v0.0.76 (github.com/kythe/kythe/releases, unpacked), Joern v4.0.646 (joern-cli-linux-x86_64.zip,
# unpacked), Go (any; scip-go v0.2.7 downloads Go >= 1.25 through GOTOOLCHAIN=auto), Node 22 with `npm ci` done.
# Everything is written under <work-dir>; nothing in the repository changes.
set -euo pipefail
work=$(realpath -m "$1")
kythe=$(realpath "$2")
joern=$(realpath "$3")
repo=$(cd "$(dirname "$0")/../.." && pwd)
here="$repo/docs/assessment-2026-10-04-graph-formats"
mkdir -p "$work"
rm -rf "$work/go-jobrunner" "$work/go-jobrunner-stale" "$work/gopath/src/example.com/jobrunner" "$work/kz"
cp -r "$repo/fixtures/go-jobrunner" "$work/go-jobrunner"
export GOCACHE="$work/gocache" GOFLAGS=-buildvcs=false

# SCIP: scip-go on a private copy (it may rewrite go.mod/go.sum).
rm -rf "$work/scip-src" && cp -r "$work/go-jobrunner" "$work/scip-src"
(cd "$work/scip-src" && GOPATH="$work/gopath-mod" GOMODCACHE="$work/gopath-mod/pkg/mod" GOTOOLCHAIN=auto \
  GOFLAGS="-mod=mod -buildvcs=false" go run github.com/scip-code/scip-go/cmd/scip-go@v0.2.7 index \
  --output "$work/scip-go.scip" >/dev/null)

# Kythe: the Go extractor works in GOPATH mode, one compilation per package, then merged.
mkdir -p "$work/gopath/src/example.com" "$work/kz"
cp -r "$work/go-jobrunner" "$work/gopath/src/example.com/jobrunner"
for pkg in cmd/jobrunner internal/bus internal/config internal/metrics internal/queue internal/runner internal/worker; do
  (cd "$work/gopath/src/example.com/jobrunner" && GO111MODULE=off GOPATH="$work/gopath" \
    "$kythe/extractors/go_extractor" -output "$work/kz/${pkg//\//_}.kzip" -corpus jobrunner \
    -goroot "$(go env GOROOT)" -gopath "$work/gopath" "example.com/jobrunner/$pkg")
done
rm -f "$work/kythe-go.kzip"
"$kythe/tools/kzip" merge --output "$work/kythe-go.kzip" "$work"/kz/*.kzip
"$kythe/indexers/go_indexer" -anchor_scopes "$work/kythe-go.kzip" |
  "$kythe/tools/entrystream" --write_format=json >"$work/kythe-go.json"

# Joern: gosrc2cpg, then the default overlays and a JSON export of declarations and calls.
(cd "$work" && "$joern/gosrc2cpg" "$work/go-jobrunner" -o "$work/cpg-go.bin" --enable-file-content \
  >"$work/gosrc2cpg.log" 2>&1)
grep -o '`ast\.[A-Za-z]*` AST type is not handled' "$work/gosrc2cpg.log" | sort | uniq -c >"$work/gosrc2cpg-unhandled.txt" || true
(cd "$work" && "$joern/joern" --script "$here/export-cpg.sc" --param cpgFile="$work/cpg-go.bin" \
  --param outFile="$work/cpg-go.json" >/dev/null)

# A copy whose queue.go no longer matches the Kythe artifact: its facts must be rejected as stale.
cp -r "$work/go-jobrunner" "$work/go-jobrunner-stale"
sed -i '1i // stale' "$work/go-jobrunner-stale/internal/queue/queue.go"

cd "$repo" && npx tsx "$here/assess.mts" "$work/go-jobrunner" "$work" "$work/result.json" >/dev/null
echo "wrote $work/result.json"
