#!/usr/bin/env bash
# Does a change need before/after screenshots (AGENTS.md, Pull requests)? Prints the reasons and exits 0 when it
# does, exits 1 when it does not.
#
#   scripts/needs-screenshots.sh [<base-ref>]    # default: the merge base with origin/main; includes uncommitted changes
#
# UI or UX: anything the viewer renders. Abstraction levels: what a map shows at each level (levels, grouping,
# lifted and derived edges, stubs, focus, bundle contents, drafts of repo levels) and the package boundaries.
set -euo pipefail
base="${1:-$(git merge-base HEAD origin/main 2>/dev/null || echo HEAD)}"
changed="$( { git diff --name-only "$base"; git ls-files --others --exclude-standard; } | sort -u)"
reasons=()
while IFS= read -r f; do
  case "$f" in
    packages/viewer/src/*|packages/viewer/index.html) reasons+=("UI/UX: $f") ;;
    skill/code-explainer/reference/examples/*.patch.json)
      reasons+=("worked example maps: $f") ;;
    packages/core/src/graph.ts|packages/core/src/stubs.ts|packages/core/src/levels.ts|packages/core/src/focus.ts|\
    packages/core/src/flow.ts|packages/core/src/sequence.ts|packages/core/src/bundle.ts|packages/core/src/prune.ts|\
    packages/core/src/related-files.ts|packages/core/src/model.ts|packages/core/src/constants.ts|\
    packages/cli/src/draft.ts|packages/cli/src/outside.ts|packages/cli/src/bundle-data.ts|\
    packages/cli/src/commands/draft.ts|packages/cli/src/commands/bundle.ts)
      reasons+=("abstraction levels: $f") ;;
    packages/*/package.json)
      # Only a change in which @xpl package depends on which moves a boundary.
      if git diff "$base" -- "$f" | grep -q '^[+-].*"@xpl/'; then reasons+=("package boundaries: $f"); fi ;;
  esac
done <<< "$changed"
if ((${#reasons[@]} == 0)); then
  echo "no screenshots needed (nothing the viewer renders or the levels of a map changed since $base)"
  exit 1
fi
echo "screenshots needed since $base:"
printf '  %s\n' "${reasons[@]}"
