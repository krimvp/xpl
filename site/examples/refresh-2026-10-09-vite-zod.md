# Vite and Zod example refresh, 2026-10-09

This run refreshed four site bundles with xpl `0.2.2` built from xpl commit
`40c53ae34a0bd7a5b3a84cd4fb7f22b40973b29d` using Node `22.22.3`.
Vite stayed at `8a4c19cfc035f2dd203f2fa6d00ab9256a5e77c9`; Zod stayed at
`0b216ef674e297ebe41d8bf902262e56f8755822`. There was no upstream source
revision change. Fresh, detached worktrees of those commits kept the existing study
checkouts and their `.explainer/` output untouched.

| Guide | Scope | Authored change | Current xpl result |
| --- | --- | --- | --- |
| [Vite overview](vite/vite-overview.html) | Server and builder | Existing patches replayed; no prose or diagram change | 2 maps, 3 authored system arrows |
| [Vite HMR](vite/vite-hmr.html) | `updateModules` decision | Existing patches replayed; no prose or flow change | 1 flow, 9 steps |
| [Zod overview](zod/zod-overview.html) | Schema to parse outcome | Complete patch committed; one arrow relabeled to cover success and failure | 2 maps, 2 authored system arrows |
| [Zod parse outcomes](zod/zod-parse-errors.html) | Synchronous classic `parse` and `safeParse` | Existing patches replayed; no prose or flow change | 1 flow, 12 steps |

## Reproduce

Build xpl from that commit with Node 22 or 24. Set `XPL` to its absolute
`packages/cli/dist/xpl.mjs` path. For each upstream repository, check out its pinned
commit in a clean worktree, run `node "$XPL" index --precise off`, then follow the
Vite [overview](vite/vite-overview-reproduction.md) and [HMR](vite/README.md)
recipes or the Zod [overview](zod/zod-overview-authoring.md) and
[parse outcomes](zod/parse-errors/README.md) recipes. These use `xpl new`, `xpl apply`,
`xpl lint`, `xpl validate`, `xpl status`, `xpl ready`, and `xpl bundle`.
The Zod overview patch is now a file in this repository; rebuilding no longer
requires extracting its contents from an older HTML bundle.

## Source review

All four final guides passed strict validation with no errors or warnings, lint
with no findings, status with no unexplained elements or drifted or missing
anchors, and readiness with no errors or warnings. Vite indexed 2,738 files,
11,939 symbols, and 20,611 references; Zod indexed 689 files, 10,039 symbols,
and 41,943 references. The run used `--precise off`: TypeScript and JavaScript
relationships are heuristic, and authored system arrows do not become precise
because their anchors resolve.

For Vite, the CLI starts the server or builder in `packages/vite/src/node/cli.ts`;
the transform middleware handles module requests. In `server/hmr.ts`, an empty
module set, dead end, circular invalidation, or client HTML change selects a
reload. An unanalyzed module can produce no update message. The HMR guide is
limited to this decision, not all hot-update hooks or browser behavior.

For Zod, `packages/zod/src/v4/classic/schemas.ts` exposes `parse` and `safeParse`.
In `core/parse.ts`, the synchronous parser returns a value or throws, while
`safeParse` returns a success or failure object. Its failure object creates its
error on first access. Both synchronous methods throw if schema execution
returns a Promise. The overview result arrow was relabeled from “returns
validated data” to “reports parse outcome” because invalid input also has an
outcome. Anchor checks confirm the referenced code exists; this source review
supports the prose, and does not establish complete runtime coverage.

Each published HTML has the upstream license header, embedded `xpl-data`, index
root `.`, its pinned commit, and no `/Users/` path. The bundles include referenced
source and opened from `file://` in Chromium. A check of the embedded bundles
found 21, 22, 15, and 30 resolved anchors respectively, each with status `ok`
and its source file included. The Vite and Zod parse explainers are identical
to their previous exports. The Zod overview differs only in the one arrow label.

## Browser and repository checks

Matched before and after screenshots were captured in Chromium at 1440 × 900
in light mode and 390 × 844 in dark mode. All four guides were viewed at their
default entry; the two system maps were also viewed with an authored arrow
selected on desktop and phone. The focused guides were viewed with a flow step
selected on desktop. The new exports render the maps and focused walkthroughs;
selected arrows and steps show the corresponding topic and source links.
These are visual observations, separate from the source checks above.

`npm run site`, `npm run typecheck`, `npm run format:check`, and `git diff --check`
passed locally. The full local `npm test` run had 151 passing files and 10
failing files. The failures included macOS `/var` versus `/private/var` path
comparisons and a duplicate CodeMirror instance from a symlinked Java language
dependency in this small worktree. Hosted CI is the full-suite gate.
