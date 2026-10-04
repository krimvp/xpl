#!/bin/bash
# Stop: before an agent ends its turn with work in the tree, list what "done" still asks for (AGENTS.md, Done):
# the test audit (strongly recommended), the checks, docs sync, and the screenshots when the change needs them.
# It blocks the stop once per state of the change (exit 2 hands the list back to the agent) and stays quiet
# after that, so an agent that has done these, or says why not, can finish.
set -uo pipefail
input="$(cat)"
field() { printf '%s' "$input" | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{try{const v=JSON.parse(s)['$1'];process.stdout.write(v===undefined?'':String(v))}catch{}})"; }
[ "$(field stop_hook_active)" = "true" ] && exit 0
root="${CLAUDE_PROJECT_DIR:-$(git rev-parse --show-toplevel 2>/dev/null)}"
cd "$root" 2>/dev/null || exit 0

base="$(git merge-base HEAD origin/main 2>/dev/null || git rev-parse HEAD)"
changed="$( { git diff --name-only "$base"; git ls-files --others --exclude-standard; } 2>/dev/null | sort -u)"
code="$(printf '%s\n' "$changed" | grep -E '^(packages|fixtures|skill|scripts)/|^docs/ARCHITECTURE\.md$' || true)"
[ -z "$code" ] && exit 0

# Once per state of the change: the same diff does not trigger twice in a session.
state="$( { git diff "$base"; printf '%s\n' "$changed"; } 2>/dev/null | sha256sum | cut -c1-16)"
marker="${TMPDIR:-/tmp}/xpl-stop-check-$(field session_id)-$state"
[ -e "$marker" ] && exit 0
touch "$marker"

tests="$(printf '%s\n' "$code" | grep -E '(^packages/[^/]+/test/|^packages/viewer/e2e/|\.test\.tsx?$|\.spec\.ts$)' || true)"
viewer="$(printf '%s\n' "$code" | grep -E '^packages/(viewer|core)/' || true)"
{
  echo "Before you call this finished (AGENTS.md, \"Done\"), check each item, or say in your reply why it does not apply:"
  echo
  echo "1. Test audit (strongly recommended): run the test-audit skill on the tests this change adds or touches,"
  echo "   and on the tests that own the changed code. Every new test must pass its authoring gate; a regression"
  echo "   test must have failed before the fix."
  if [ -n "$tests" ]; then
    echo "   Tests changed:"
    printf '%s\n' "$tests" | sed 's/^/     /'
  else
    echo "   No test file changed: is the new behaviour covered at its owning seam (tdd skill)?"
  fi
  echo "2. Checks: npm run typecheck && npm test && npm run format:check$([ -n "$viewer" ] && echo ' && npm run test:e2e')"
  echo "3. Docs (docs-sync skill): ARCHITECTURE, --help text, the product skill and .explainer/xpl.explainer.json"
  echo "   match the code (npm test runs self-explainer.test.ts)."
  if reasons="$(scripts/needs-screenshots.sh "$base" 2>/dev/null)"; then
    echo "4. Screenshots are required for this change:"
    printf '%s\n' "$reasons" | sed 1d | sed 's/^/   /'
    echo "   Run: scripts/pr-screenshots.sh origin/main --publish   (pr-screenshots skill), and put the printed"
    echo "   Screenshots section in the PR description."
  fi
} >&2
exit 2
