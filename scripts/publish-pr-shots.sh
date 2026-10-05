#!/usr/bin/env bash
# Publishes the side-by-side screenshots of scripts/pr-screenshots.sh to the `pr-assets` branch and prints the
# PR description's Screenshots section (markdown) on stdout. Creates the branch on first use. CI and agents both
# use it, without asking: the branch only ever holds screenshots.
#
#   scripts/publish-pr-shots.sh <compare-dir> [<label>]     # label: the folder on pr-assets (default: the branch)
set -euo pipefail
dir="$(cd "${1:?usage: scripts/publish-pr-shots.sh <compare-dir> [<label>]}" && pwd)"
label="${2:-$(git rev-parse --abbrev-ref HEAD)}"
label="${label//\//-}"
repo="${GITHUB_REPOSITORY:-$(git remote get-url origin | sed -E 's#.*github\.com[:/]([^/]+/[^/.]+)(\.git)?/?$#\1#')}"
shopt -s nullglob
pngs=("$dir"/*.png)
if ((${#pngs[@]} == 0)); then
  echo "## Screenshots"
  echo
  echo "No visible change: every Before/After shot is byte-identical."
  [[ -f "$dir/index.md" ]] && { echo; echo '<details><summary>Shots compared</summary>'; echo; cat "$dir/index.md"; echo; echo '</details>'; }
  exit 0
fi

wt="$(mktemp -d)"
trap 'git worktree remove --force "$wt" >/dev/null 2>&1 || rm -rf "$wt"' EXIT
if git ls-remote --exit-code origin refs/heads/pr-assets >/dev/null; then
  git fetch -q origin pr-assets || { echo "fetch of existing pr-assets branch failed" >&2; exit 1; }
  git worktree add -q --detach "$wt" FETCH_HEAD
else
  status=$?
  [[ $status == 2 ]] || { echo "could not determine whether pr-assets exists" >&2; exit 1; }
  git worktree add -q --detach "$wt"
  git -C "$wt" checkout -q --orphan pr-assets-new
  git -C "$wt" rm -rfq . && git -C "$wt" clean -fdq
  printf 'Screenshots for pull requests (scripts/publish-pr-shots.sh). Never merged.\n' > "$wt/README.md"
fi
rm -rf "${wt:?}/$label" && mkdir -p "$wt/$label"
cp "${pngs[@]}" "$wt/$label/"
git -C "$wt" add -A
git -C "$wt" -c user.name="${GIT_AUTHOR_NAME:-xpl screenshots}" -c user.email="${GIT_AUTHOR_EMAIL:-screenshots@users.noreply.github.com}" \
  commit -qm "screenshots: $label" >/dev/null || true
for i in 0 1 2 3; do
  git -C "$wt" push -q origin HEAD:refs/heads/pr-assets && break
  [[ $i == 3 ]] && { echo "push to pr-assets failed" >&2; exit 1; }
  sleep $((2 ** (i + 1)))
done
sha="$(git -C "$wt" rev-parse HEAD)"

echo "## Screenshots"
echo
echo "Before left, After right; only the shots that changed (\`scripts/pr-screenshots.sh\`)."
for p in "${pngs[@]}"; do
  name="$(basename "$p" .png)"
  echo
  echo "**${name}**: <!-- what to look at -->"
  echo
  # A commit-pinned URL keeps an older PR's images when the folder is refreshed later.
  echo "![${name}](https://github.com/${repo}/blob/${sha}/${label}/${name}.png?raw=true)"
done
