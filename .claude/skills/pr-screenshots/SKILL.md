---
name: pr-screenshots
description: Take before/after screenshots of the xpl viewer for a pull request and put them in the PR description. Required for any change to the viewer's UI or UX, and for any change that can alter abstraction levels (what a map shows at the system, service or code level; grouping, opens/zoom, stubs, lifted or derived edges, draft repo levels, package boundaries). Use before opening or updating such a PR.
---

# PR screenshots

Reviewers judge a UI change by looking at it. Every PR that changes what a reader sees carries Before and
After images, taken by the same script on the base and on the head, so the only difference is the change.

## When it is required

- **UI or UX**: anything under `packages/viewer/src` that renders (components, CSS, layout, modes, keys,
  diagrams, the editor), and any core or CLI change that alters what the viewer shows (graph derivation,
  stubs, focus, bundle contents, lint-driven text).
- **Abstraction levels**: changes to what a reader sees at each level of a map: `role`/`opens`/zoom trails
  (`core/src/levels.ts`), grouping and lifted edges, stub policy, derived edge kinds, `xpl draft repo` levels,
  or moving responsibilities between packages (xpl's own map shows the packages). Show every level that
  changed, top-down.

If a PR in these areas truly changes nothing visible, say so in the PR's Screenshots section and attach the
`index.md` that shows zero changed shots.

## Take them

From the repo root, with the change committed or in the working tree (Chromium is preinstalled; never run
`playwright install`):

```sh
scripts/pr-screenshots.sh origin/main /tmp/xpl-shots                       # the standard set
scripts/pr-screenshots.sh origin/main /tmp/xpl-shots -- \
  --shot arch-system=py-architecture?perspective=map \
  --shot dispatch-selected=ts-jobrunner?perspective=explore\&view=view:dispatch\&focus=dispatch:3
scripts/pr-screenshots.sh origin/main /tmp/xpl-shots --self -- \
  --shot self-map=self?perspective=map                                     # xpl's own architecture map
```

The script checks the base out in a temporary worktree (`npm ci` there, a few minutes), builds the viewer and
the fixture bundles in both trees, photographs both, and writes `before/`, `after/`, and `compare/`: one
side-by-side image per changed shot plus `index.md` (changed, added, removed, unchanged). Renders are
deterministic, so an unchanged shot is byte-identical.

Bundles: `ts-jobrunner`, `py-jobrunner`, `go-jobrunner` (the fixture example), `ts-change` (a change explainer
with a diff), `py-architecture` (a system map that zooms into its parts), `self` (with `--self`), or a path
to any `.html` from `xpl bundle`. Query parameters: `perspective=guide|map|flow|code|explore`, `view=<id>`,
`focus=<element id>` (repeatable), `mode=present&tour=<id>&step=<n>`. Options: `--scheme dark`,
`--size 1280x720`. Pick shots that show the change itself: the state with the selection, the hover target,
the narrow width, the dark theme, whichever the change touches. Include dark mode when colours changed.

## Put them in the PR

Upload only what matters: the side-by-side images of the changed shots, at most about six, most important
first. Without `gh` or a browser upload, commit them to the `pr-assets` branch (never to the PR branch):

```sh
git fetch origin pr-assets || true
git worktree add /tmp/pr-assets origin/pr-assets 2>/dev/null \
  || (git worktree add --detach /tmp/pr-assets && git -C /tmp/pr-assets checkout --orphan pr-assets \
      && git -C /tmp/pr-assets rm -rf --quiet .)
mkdir -p /tmp/pr-assets/<branch> && cp /tmp/xpl-shots/compare/*.png /tmp/pr-assets/<branch>/
git -C /tmp/pr-assets add -A && git -C /tmp/pr-assets commit -m "screenshots: <branch>"
git -C /tmp/pr-assets push origin HEAD:pr-assets && git worktree remove /tmp/pr-assets
```

Ask the user before the first push of `pr-assets` if the branch does not exist yet. Reference the images in the PR
body with `https://github.com/<owner>/<repo>/blob/pr-assets/<branch>/<name>.png?raw=true`.

In the PR description's **Screenshots** section, one row per shot: what to look at, then the image.

```md
## Screenshots

**Map, system level**: the database box now shows its technology badge.
![arch-system](https://github.com/<owner>/<repo>/blob/pr-assets/<branch>/arch-system.png?raw=true)
```

Refresh the images when a later push changes the UI again.
