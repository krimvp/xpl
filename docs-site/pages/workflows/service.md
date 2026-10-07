# The local service and watching

`xpl service` adds source-linked questions, feedback and optional agent jobs to the local viewer. It is opt-in; plain `xpl view` and saved HTML do not start a worker.

```sh
xpl service start jobrunner --background
xpl service status --json
xpl service stop
```

By default, the service binds to loopback. `status` reports the process, address, repository root, selected guide and backend. `start` without a guide reuses the saved selection. Each canonical repository root has one service, including symlink aliases; stop it before selecting another guide. `--root` can select another repository, which has its own service.

## Questions and feedback

With `--backend claude`, readers can ask about a diagram element or selected source lines. Answers retain the head/base range and snapshot; opening an answer reference selects its source, or shows the recorded excerpt if that source changed. Questions do not edit a guide or finalize revision outcomes. Without an answer backend, questions stay pending for an explicit offline feedback pass.

The Feedback panel records requests and offers progress, retry and cancel controls. **Save for the next revision pass** records feedback without asking the worker. Browser storage is optional; refusal does not stop live answers. History survives reload and JSON import/export. Merging history rejects reused answer IDs and more than 1,000 answers per question.

## Backends and recovery

`--backend none` (the default) disables agent execution. `--backend claude` uses the installed Claude Code proposal runner. `--skill-dir <folder>` selects a managed skill installation; `--job-timeout <seconds>` sets the deadline (default 300). Both settings persist. Availability means configured, not authenticated; actual jobs report login and provider failures.

```sh
xpl service start jobrunner --backend claude --background
xpl service start jobrunner --backend none --watch
xpl service pause
xpl service resume
```

The git-ignored `.explainer/service/` directory holds local context and ownership records. If the owner exits, status reports it as interrupted. Inspect the artifacts, then use `xpl service start --recover` to archive the old instance and start again. A process whose identity cannot be verified is never signalled or replaced. Inspect a crashed artifact-writer lock before removing it; elapsed time alone does not prove the writer stopped.

With the Claude backend, jobs produce ordinary revision proposals and leave them awaiting author review. Source is read-only to the agent, and a completed job does not apply a patch. The Jobs panel lets an author inspect source and field changes, record a decision per request, review the combined candidate, then explicitly accept. Cancelled, superseded, stale or old-attempt results cannot apply. Service-owned runs refuse manual proposal or acceptance writes so those checks remain in force. Manual revision still works when the service is stopped.

## Watch source changes

Watching is opt-in each time the service starts:

```sh
xpl service start jobrunner --watch --background
xpl service pause
xpl service resume
xpl status --all --json
```

The watcher polls files and configuration, coalesces edits, and rebuilds the index. Readers see a complete snapshot; a failed or cancelled build keeps the previous index marked out of date. Moved code keeps its prose, while drifted or missing evidence blocks a ready export. Watching does not write guide text, accept revisions or discard feedback.

Watch mode defaults to heuristic references (`--precise off`). Use `--precise auto|require` for semantic tools or `--scip <artifact|manifest.json>` for supplied provider data. A watched service cannot pin `--index`. Generated exports do not dirty the watched index. Select watch options again after restart; recovery retires the previous watch pointer. Paused snapshots cannot become ready.

After stopping the service, choose **Use loaded snapshot offline** to keep reading, editing, collecting feedback and exporting HTML. That export checks only its embedded snapshot and cannot check later repository changes. Download edits before closing. **Retry connection** reconnects to the original service; **Edit → Retry save** persists offline edits. Local serving and portable HTML need no provider credentials; Claude jobs use the CLI's existing login and provider access.

Verified process cleanup currently requires Linux `/proc`; manual revision works on other platforms. See the [CLI reference](../reference/commands.md) for all service commands and options.
