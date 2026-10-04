#!/bin/bash
# PostToolUse (Edit|Write|MultiEdit): prettier on the edited file, so format:check never fails on agent edits.
# Honours .prettierignore (fixtures/, docs/, .explainer/ are never touched). Never blocks.
input="$(cat)"
file="$(printf '%s' "$input" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{process.stdout.write(JSON.parse(s).tool_input?.file_path??"")}catch{}})')"
root="${CLAUDE_PROJECT_DIR:-$(git rev-parse --show-toplevel 2>/dev/null)}"
prettier="$root/node_modules/.bin/prettier"
[ -n "$file" ] && [ -f "$file" ] && [ -x "$prettier" ] || exit 0
case "$file" in "$root"/*) ;; *) exit 0 ;; esac
(cd "$root" && "$prettier" --write --ignore-unknown --log-level=warn "$file") >&2 || true
exit 0
