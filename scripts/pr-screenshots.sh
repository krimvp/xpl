#!/usr/bin/env bash
# Before/after screenshots of the viewer for a pull request (.claude/skills/pr-screenshots/SKILL.md).
#
#   scripts/pr-screenshots.sh <base-ref> [out-dir] [--self] [--publish] [-- <pr-shots.ts shoot options>]
#
# Checks <base-ref> out in a temporary worktree (npm ci there), builds the viewer and its fixture bundles in
# both trees, photographs both with this tree's packages/viewer/scripts/pr-shots.ts and writes:
#   <out>/before/*.png  <out>/after/*.png  <out>/compare/*.png (side by side, changed only)  <out>/compare/index.md
# --self also bundles xpl's own explainer (.explainer/xpl.explainer.json) in both trees as the bundle `self`,
# for changes to the levels of a map: pass e.g. -- --shot self-map=self?perspective=map
# Without shoot options the standard set (scripts/ux-shots.ts) is taken.
# --publish then pushes the changed shots to the pr-assets branch (scripts/publish-pr-shots.sh) and writes the
# PR description's Screenshots section to <out>/compare/pr-section.md (and stdout).
# Default out-dir: ${TMPDIR:-/tmp}/xpl-pr-shots. Keep it outside the repo.
set -euo pipefail

base="${1:?usage: scripts/pr-screenshots.sh <base-ref> [out-dir] [--self] [--publish] [-- shoot options]}"
shift
out="${TMPDIR:-/tmp}/xpl-pr-shots"
if [[ $# -gt 0 && "$1" != --* ]]; then out="$1"; shift; fi
self=0
publish=0
while [[ "${1:-}" == "--self" || "${1:-}" == "--publish" ]]; do
  [[ "$1" == "--self" ]] && self=1
  [[ "$1" == "--publish" ]] && publish=1
  shift
done
if [[ "${1:-}" == "--" ]]; then shift; fi

head="$(git rev-parse --show-toplevel)"
out="$(mkdir -p "$out" && cd "$out" && pwd)"
case "$out/" in "$head"/*) echo "out-dir must be outside the repo: $out" >&2; exit 2 ;; esac
rm -rf "$out/before" "$out/after" "$out/compare"
wt="$out/base-src"
git -C "$head" worktree remove --force "$wt" 2>/dev/null || rm -rf "$wt"
git -C "$head" worktree add --detach "$wt" "$base" >/dev/null
trap 'git -C "$head" worktree remove --force "$wt" 2>/dev/null || true' EXIT
echo "base $(git -C "$wt" rev-parse --short HEAD) in $wt"
(cd "$wt" && npm ci --no-audit --no-fund --loglevel=error)

shots="$head/packages/viewer/scripts/pr-shots.ts"
for side in before after; do
  tree="$head"
  [[ "$side" == before ]] && tree="$wt"
  if [[ $self == 1 ]]; then
    (cd "$tree" && npm run build --silent \
      && node packages/cli/dist/xpl.mjs index --precise off >/dev/null \
      && mkdir -p packages/viewer/dist/bundles \
      && node packages/cli/dist/xpl.mjs bundle xpl -o packages/viewer/dist/bundles/self.html --allow-drift)
  fi
  (cd "$head/packages/viewer" && npx tsx "$shots" shoot "$out/$side" --viewer-dir "$tree/packages/viewer" --build "$@")
done
(cd "$head/packages/viewer" && npx tsx "$shots" compare "$out/before" "$out/after" "$out/compare")
if [[ $publish == 1 ]]; then
  "$head/scripts/publish-pr-shots.sh" "$out/compare" | tee "$out/compare/pr-section.md"
fi
