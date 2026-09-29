/**
 * The acceptance checks of docs/ARCHITECTURE.md section 8 against the Go fixture bundle
 * (fixtures/go-jobrunner + scripts/go-example*.patch.json), opened from file://. The checks are the
 * ones acceptance.spec.ts runs for TS (see jobrunner-acceptance.ts); the line numbers come from the
 * index and the sources at test time. Steps anchor the concrete `Queue` methods, not the `JobQueue`
 * interface the runner calls them through.
 */
import { GO_BUNDLE } from "./helpers.js";
import { defineAcceptance } from "./jobrunner-acceptance.js";

defineAcceptance({
  name: "go",
  bundle: GO_BUNDLE,
  files: {
    runner: "internal/runner/runner.go",
    queue: "internal/queue/queue.go",
    worker: "internal/worker/worker.go",
    metrics: "internal/metrics/metrics.go",
    bus: "internal/bus/bus.go",
    config: "config/default.yaml",
    test: "internal/runner/retry_test.go",
  },
  symbols: {
    dispatch: "Runner.Dispatch",
    pop: "Queue.Pop",
    requeue: "Queue.Requeue",
    run: "Worker.Run",
    handler: "Metrics.OnJobCompleted",
  },
  markers: {
    pop: "r.queue.Pop()",
    run: "w.Run(",
    requeue: "r.queue.Requeue(",
    retryStart: "// Retry policy",
    retryInner: "attempts := job.Attempts + 1",
    retryEnd: "dead-lettered %s after",
    retryClose: 1,
    idle: "sleep(ctx, r.cfg.IdleDelay)",
    emit: 'Emit("job.completed"',
  },
});
