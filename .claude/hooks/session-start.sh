#!/bin/bash
# SessionStart (cloud sessions only): dependencies and the built CLI and viewer, so tests, prettier, the
# `xpl` CLI (skills how, docs-sync) and the screenshot scripts work from the first turn. Idempotent.
set -euo pipefail
if [ "${CLAUDE_CODE_REMOTE:-}" != "true" ]; then
  exit 0
fi
cd "${CLAUDE_PROJECT_DIR:-$(git rev-parse --show-toplevel)}"
npm install --no-audit --no-fund --loglevel=error
npm run build --silent >/dev/null
# origin/main is the base of needs-screenshots.sh, the stop check and pr-screenshots.sh.
git fetch -q origin main 2>/dev/null || true
echo "xpl: dependencies installed, CLI built (node packages/cli/dist/xpl.mjs). Read AGENTS.md."
