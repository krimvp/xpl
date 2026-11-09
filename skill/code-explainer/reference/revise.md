# Revise a selected feedback batch

Readers save requests in the Feedback panel or with "Explain this". Saving a request starts no work. This page says how to answer a batch of saved requests.

Use the installed skill's `bin/xpl` launcher. The agent reads the source and writes the proposed text. The CLI checks the patches and commits them; it calls no model and starts no watcher or service. Keep the selection, proposal, decision and review files outside the source root.

## Select against current source

1. Import offline feedback first: `xpl feedback <name> --import <file>`.
2. Read the stored requests: `xpl feedback <name> --json`.
3. When the source changed, index again in the author's chosen mode.
4. Select the pending or retryable request ids by name. Never process the whole store at once.

```sh
xpl index --precise off
xpl revise myguide --select request-a,request-b -o /tmp/selection.json --json
```

`revise` always checks that the index matches the working tree, even with `XPL_SKIP_STALE_CHECK=1`.

The returned `runId` names the journal, `.explainer/revisions/<runId>/run.json`. The journal keeps:

- each selected request, unchanged, with its original context and outcome;
- the expected `artifactIdentity`, and the previous guide in `previous.json`;
- the resolution report and the source that the review showed.

Source discovery skips generated directories, and refuses directory aliases into the source (by device and inode). Keep the whole journal: it serves recovery and history.

**The guide stays unchanged until you accept.** Resolution moves anchors whose code only moved, in memory, and keeps the text, hashes and provenance. A drifted claim needs a fresh read and fresh anchors. A missing anchor stays in place. Compare the original ranges and context with the current source. Equal source hashes do not prove freshness: they name indexed snapshots, which can be stale.

**Scope.** The element that a request selects bounds its patch:

- The optional `view` records which view the reader had open. It gives no permission to edit that view or its other steps.
- A selected flow, sequence or tour step allows only that step's `stepsUpdate`, through the view or tour that holds it.
- A whole-view edit needs a request that selects the view, or `--include <view-id>` at selection.
- Add `--include <id,id>` for other existing or new ids that an expansion or repair needs.
- This operation cannot change the guide's title or audience. Read all user-owned fields before you write.

**Step ids.** A step permission covers one step in the view or tour that owns it. A raw flow or sequence id resolves to its owning view in the stored guide. A tour step with the same local id stays out of scope. Name a step with `--include view:flow/flow:1` or `--include tour:reader/step-id`; a tour step always needs this form. Inside the patch's `stepsUpdate`, keep the local step id. To send whole step arrays, edit frames or change other view or tour fields, select or include the whole view or tour. The CLI checks each `remove` id against its current owner, including moves that the run proposed earlier.

## Propose and inspect

Write an array of `{id, patch}`, one entry per selected request. Each `patch` uses the [patch format](patch-format.md), and applies as `llm`. There is no second patch language. An empty patch answers a request whose code only moved. You can decline a wrong request without a patch.

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

While you write each patch, check it with these two commands; they write nothing:

```sh
xpl apply <name> /tmp/patch.json --dry-run --index <current-index-path>
xpl lint <name> --patch /tmp/patch.json --index <current-index-path>
```

Then submit the proposal:

```sh
xpl revise myguide --run <runId> --proposal /tmp/proposal.json -o /tmp/proposal-review.json
```

The review holds `changes: [{id, before, after}]`, the source that supports them (`source: [{file, side, text}]`), the resolution report, protected-field warnings and ready findings. Plain output prints BEFORE, AFTER and SOURCE blocks, the skipped fields and the ready findings with repair hints. `--json` prints the packet. The CLI refuses an edit outside the selected scope, and a patch that changes only protected content. You can read an unfinished preview, but you cannot accept it.

## Decide the exact subset, then accept

Ask the author for a status and a reason for every selected id:

| Status       | Its patch | Afterwards             |
| ------------ | --------- | ---------------------- |
| `addressed`  | applied   | recorded as addressed  |
| `rejected`   | left out  | stored with the reason |
| `unresolved` | left out  | can be retried         |
| `outdated`   | left out  | can be retried         |

When a request's captured text or source differs from the current one, an accepted request also needs a `reconciliation` reason: what the request means now. An older request without an identity must stay `outdated`; capture a new request against the intended guide.

**Missing anchors** need one decision for each affected element: `missing: [{id: "concept:retry", action: "reanchor"}]`, or `action: "remove"`. The patch supplies the new anchors or the removal; the decision allows it. An unresolved missing anchor blocks the next ready guide, even when the text patch is valid. Keep it pending while you ask the author. Never retarget or drop it silently.

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

Call `--accept` only after the author accepts the reviewed candidate, or when their instruction already accepts it. Before it publishes, the CLI checks again:

- the guide and source identities;
- the live hashes of the discovered files, with added and deleted files;
- the original content and outcome revisions of the selected requests;
- the ready check.

A source change needs a new index and a new selection. A change to the guide needs a new run too. Warnings stay visible; they do not prove the text true or every runtime path covered.

Only accepted patches and the anchor moves enter the next guide. A batch that the author declines as a whole records the decisions, and leaves the guide as it is, even when it needs repair. The CLI records all selected outcomes after the decision is stored. New and unselected feedback stays unchanged. Use `xpl feedback <name> --export /tmp/results.json` for portable results. Do not clear the store, edit its counters or order results by time.

## Resume without duplicate changes

After an interrupted acceptance, run the same `xpl revise <name> --run <runId> --accept` again. The journal commits the intent before it publishes the guide. Recovery tells apart the original guide, the candidate it already published, and a newer conflicting guide. It never overwrites the newer one. Outcome recording uses the original expected revision, so a result recorded once is not counted again. `--run <runId>` shows the exact reviewed source of a past run, even after later edits.

A killed process can leave a lock. The lock helper times out and names the directory. Check that the writer has stopped, then remove only that lock directory and retry. Acceptance locks the journal, then the guide, then the feedback store, so a killed acceptance can leave more than one lock. Never remove a live writer's lock. Never recover by applying the proposal separately, deleting the journal, rewriting an explainer JSON file or recording the outcomes by hand. A validation or provider failure before acceptance leaves the guide and the requests unchanged: repair it and invoke the agent again.
