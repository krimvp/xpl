# The local service and watching

`xpl service` adds source-linked questions, feedback and optional agent jobs to the local viewer. It is
opt-in; plain `xpl view` and saved HTML do not start a worker.

```sh
xpl service start jobrunner --background
xpl service status --json
xpl service stop
```

The service always binds to 127.0.0.1. `status` reports the process, address, repository root, selected
guide and backend. `start` without a guide reuses the saved selection. Each repository has one service, also
when you reach it through a symlink; stop it before you select another guide. `--root` selects another
repository, which has its own service.

## Questions and feedback

With `--backend claude`, readers can ask about a box, an arrow, a step or selected lines of code. An answer
keeps the lines it cites and the snapshot it read. Open a cited line to select its code, or to see the saved
excerpt if that code changed. **Show on the map** selects the boxes whose code holds the lines the answer
cites. A question does not edit the guide. Without an answer backend, a question waits for the next feedback
pass (see [Feedback and revision](feedback.md)).

The Feedback panel records requests and shows progress, with retry and cancel. **Save for later** keeps a
request and starts nothing. Browser storage is optional: when the browser refuses it, live answers still work.
History survives a reload and JSON import and export. A merge of histories refuses reused answer IDs and more
than 1,000 answers per question.

## Backends and recovery

`--backend none` (the default) disables agent execution. `--backend claude` uses the installed Claude Code
proposal runner. `--skill-dir <folder>` selects a managed skill installation; `--job-timeout <seconds>` sets
the deadline (default 300). Both settings are saved. "Available" means set up, not signed in: a job reports a
failed login or provider error when it runs.

```sh
xpl service start jobrunner --backend claude --background
xpl service start jobrunner --backend none --watch
xpl service pause
xpl service resume
```

The git-ignored `.explainer/service/` directory holds local context and ownership records. If the owner exits,
status reports it as interrupted. Inspect the artifacts, then use `xpl service start --recover` to archive the
old instance and start again. A process whose identity cannot be verified is never signalled or replaced.
Inspect a crashed artifact-writer lock before removing it; elapsed time alone does not prove the writer
stopped.

With the Claude backend, a job writes an ordinary revision proposal and waits for you to review it. The agent
cannot change the code, and a finished job does not apply a patch. In the Jobs panel you read the code and
text changes, decide on each request, review the combined result, then accept it. A cancelled, replaced,
out-of-date or earlier result cannot be applied. While the service owns a run, it refuses proposals and
acceptances made by hand, so these checks always run. Revision by hand still works when the service is
stopped.

## Watch source changes

Watching is opt-in each time the service starts:

```sh
xpl service start jobrunner --watch --background
xpl service pause
xpl service resume
xpl status --all --json
```

The watcher polls files and configuration, coalesces edits, and rebuilds the index. Readers see a complete
snapshot; a failed or cancelled build keeps the previous index marked out of date. Moved code keeps its prose,
while a drifted or missing code link blocks a ready export. Watching does not write guide text, accept revisions
or discard feedback.

Watch mode uses heuristic references by default (`--precise off`). Use `--precise auto|require` to run the
SCIP tools, or `--scip <artifact|manifest.json>` to read SCIP data that you made. A watched service cannot
pin `--index`. Exports do not mark the watched index as changed. Choose the watch options again after a
restart; `--recover` drops the old watch. A paused snapshot cannot become ready.

After stopping the service, choose **Use loaded snapshot offline** to keep reading, editing, collecting
feedback and exporting HTML. That export checks only its embedded snapshot and cannot check later repository
changes. Download edits before closing. **Retry connection** reconnects to the original service; **Edit →
Retry save** persists offline edits. Local serving and portable HTML need no provider credentials; Claude jobs
use the CLI's existing login and provider access.

Verified process cleanup currently requires Linux `/proc`; manual revision works on other platforms. See the
[CLI reference](../reference/index.md) for all service commands and options.
