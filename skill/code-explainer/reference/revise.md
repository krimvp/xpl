# Revise a selected feedback batch

Use the installed skill's `bin/xpl` launcher. The user's chosen agent reads source and writes proposed text. The CLI checks and commits ordinary patches; it calls no model and starts no watcher or service. Keep selection, proposal, decision and review files outside the source root.

## Select against current source

Import offline feedback first, then inspect `xpl feedback <name> --json`. Select explicit pending or retryable IDs; never process the whole store implicitly. Reindex when source changed, using the author's chosen precise-analysis mode. `revise` forces working-tree freshness checks even if `XPL_SKIP_STALE_CHECK=1` is set.

```sh
xpl index --precise off
xpl revise myguide --select request-a,request-b -o /tmp/selection.json --json
```

The returned `runId` names `.explainer/revisions/<runId>/run.json`. The journal retains immutable requests with their original context/outcome baseline, the expected `artifactIdentity`, the previous artifact in `previous.json`, the in-memory resolution report and reviewed source. Generated directories are excluded from source discovery; directory aliases into source are refused using device/inode identity. Keep the whole journal for recovery and history.

The guide stays unchanged. Resolution updates location-only moves and index metadata in memory, retaining prose, hashes and provenance. Drifted claims need reading and fresh anchors. Missing anchors remain present. Compare original ranges/context with current source; do not infer freshness from equal source hashes. The hashes identify indexed snapshots, which can be stale.

Each request's element and optional view bound its patch. A selected sequence/tour step can be updated through its enclosing view/tour with `stepsUpdate`. Add explicit `--include <id,id>` at selection for extra existing or new explanation IDs needed by an expansion or repair. Guide title/audience cannot be changed through this operation. Read all user-owned fields before writing.

## Propose and inspect

Write an array of `{id, patch}` for selected request IDs. Each `patch` uses the existing [patch format](patch-format.md); it is applied as `llm`. No second patch language exists. An empty patch handles a location-only move. Wrong feedback can be declined without proposing a patch.

```json
[
  {
    "id": "request-a",
    "patch": {
      "nodes": [
        { "id": "file:src/queue.ts", "summary": "Queue holds jobs until a worker takes them." }
      ]
    }
  },
  { "id": "request-b", "patch": {} }
]
```

For each ordinary patch, use `xpl apply <name> /tmp/patch.json --dry-run --index <current-index-path>` and `xpl lint <name> --patch /tmp/patch.json --index <current-index-path>` while authoring. Those commands write nothing. Submit the envelope with:

```sh
xpl revise myguide --run <runId> --proposal /tmp/proposal.json -o /tmp/proposal-review.json
```

Review output contains `changes: [{id, before, after}]`, supporting `source: [{file, side, text}]`, the resolution report, protected-field warnings and readiness findings. Plain output prints BEFORE/AFTER and SOURCE blocks; `--json` emits the packet. The CLI refuses edits outside the selected scope and patches that change only protected content. Unfinished previews can be inspected but cannot be accepted as ready artifacts.

## Decide the exact subset, then accept

Ask the author for a status and concrete reason for every selected ID. `addressed` includes that request's patch; `rejected`, `unresolved` and `outdated` omit it. Unresolved/outdated requests remain retryable. Rejected requests remain stored with the decline reason. For an accepted request whose captured explanation/source differs, get a `reconciliation` reason explaining what the request now means. Legacy requests lacking identity must stay outdated; capture a new request against the intended guide.

Missing evidence needs a separate explicit decision for each affected owner: `missing: [{id: "concept:retry", action: "reanchor"}]` or `action: "remove"`. The patch supplies the new anchors or removal; the declaration permits the corresponding action. A missing anchor left unresolved blocks a next ready artifact, even if the accepted text patch is valid. Keep it pending while asking the author what to do.

```json
[
  { "id": "request-a", "status": "addressed", "reason": "Checked queue ownership against source." },
  { "id": "request-b", "status": "rejected", "reason": "Keep the current scope." }
]
```

```sh
xpl revise myguide --run <runId> --decisions /tmp/decisions.json -o /tmp/decision-review.json
# Show this exact subset's text/structure diff and source to the author.
xpl revise myguide --run <runId> --accept
xpl ready myguide
xpl bundle myguide -o /tmp/myguide-next.html
```

Do not call `--accept` before the author accepts the reviewed candidate, unless the existing user instruction explicitly accepts it. Before publication the CLI rechecks artifact/source identities, live discovered file hashes (including additions/deletions), selected original content/outcome revisions, and shared readiness. Source changes require reindexing and a new selection/reconciliation; explanation changes require a new run too. Warnings remain visible and do not prove prose truth or complete runtime coverage.

Only accepted patches and location resolution enter the next artifact. A wholly declined batch records decisions without changing/rebinding the artifact, even if that artifact still needs repair. All selected outcomes are recorded after the durable decision. Newly collected/unselected feedback is merged unchanged. Use `xpl feedback <name> --export /tmp/results.json` for portable results; do not clear the store.

## Resume without duplicate changes

Retry the same `xpl revise <name> --run <runId> --accept` after interrupted acceptance. The journal commits intent before artifact publication. Recovery distinguishes the original artifact, the already-published candidate and a conflicting newer artifact. It never overwrites the latter. Outcome recording uses the original expected revision, so a previously recorded result is preserved without another increment. Historical `--run <runId>` inspection retains the exact reviewed source even after later edits.

If a killed process left a lock, the existing lock helper times out and names the directory. Verify that writer has stopped, then remove only its reported lock directory and retry. Revision acceptance locks the journal, then artifact, then feedback store; a killed acceptance may leave more than one of those locks. Never remove a live writer's lock, apply the proposal separately, delete the journal, rewrite an explainer JSON file or manually record the same outcomes to recover. Validation/provider failures before acceptance leave the original artifact and requests unchanged; repair and invoke the chosen agent again.
