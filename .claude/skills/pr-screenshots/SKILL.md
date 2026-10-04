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

## Take and publish them

Do this yourself, without asking: it only builds, photographs and pushes to the screenshots-only `pr-assets`
branch. From the repo root, with the change committed or in the working tree (Chromium is preinstalled in
the sandbox; never run `playwright install` there):

```sh
scripts/needs-screenshots.sh                                               # required? prints why
scripts/pr-screenshots.sh origin/main /tmp/xpl-shots --publish             # the standard set
scripts/pr-screenshots.sh origin/main /tmp/xpl-shots --publish -- \
  --shot arch-system=py-architecture?perspective=map \
  --shot dispatch-selected=ts-jobrunner?perspective=explore\&view=view:dispatch\&focus=dispatch:3
scripts/pr-screenshots.sh origin/main /tmp/xpl-shots --self --publish -- \
  --set ux --shot self-map=self?perspective=map                            # plus xpl's own architecture map
```

The script checks the base out in a temporary worktree (`npm ci` there, a few minutes), builds the viewer and
the fixture bundles in both trees, photographs both, and writes `before/`, `after/`, and `compare/`: one
side-by-side image per changed shot plus `index.md` (changed, added, removed, unchanged). Renders are
deterministic, so an unchanged shot is byte-identical. `--publish` then pushes the changed shots to
`pr-assets/<branch>/` (`scripts/publish-pr-shots.sh`; it creates the branch on first use) and prints the PR
description's Screenshots section, also saved as `compare/pr-section.md`, with commit-pinned image URLs.

Bundles: `ts-jobrunner`, `py-jobrunner`, `go-jobrunner` (the fixture example), `ts-change` (a change explainer
with a diff), `py-architecture` (a system map that zooms into its parts), `self` (with `--self`), or a path
to any `.html` from `xpl bundle`. Query parameters: `perspective=guide|map|flow|code|explore`, `view=<id>`,
`focus=<element id>` (repeatable), `mode=present&tour=<id>&step=<n>`. Options: `--scheme dark`,
`--size 1280x720`. Pick shots that show the change itself: the state with the selection, the hover target,
the narrow width, the dark theme, whichever the change touches. Include dark mode when colours changed.

## Put them in the PR

Paste the printed section into the PR description's **Screenshots** section (create or update the PR body
with the GitHub tools you have). Keep the most important images first, at most about six, and replace each
`<!-- what to look at -->` with one or two sentences above the image. Describe the previous behaviour and
the expected behaviour after the change, and tell the reviewer where to look when the difference is subtle.
For example:

```md
**arch-system**: Before, the database box showed only its name; after, it also shows its technology badge.
Look below the box title for the new PostgreSQL label.
![arch-system](https://github.com/<owner>/<repo>/blob/<sha>/<branch>/arch-system.png?raw=true)
```

CI (`.github/workflows/ci.yml`, job `screenshots`) takes the standard set plus xpl's own map on every PR from
this repository that needs them, and posts or updates one comment with the images; it does not replace the
description's section, which names what to look at.

Refresh the images when a later push changes the UI again.
