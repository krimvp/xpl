/**
 * The acceptance checks of docs/ARCHITECTURE.md section 8 against the Python fixture bundle
 * (fixtures/py-jobrunner + scripts/py-example*.patch.json), opened from file://. The checks are the
 * ones acceptance.spec.ts runs for TS (see jobrunner-acceptance.ts); the line numbers come from the
 * index and the sources at test time.
 */
import { PY_BUNDLE } from "./helpers.js";
import { defineAcceptance } from "./jobrunner-acceptance.js";

defineAcceptance({
  name: "python",
  bundle: PY_BUNDLE,
  files: {
    runner: "jobrunner/runner.py",
    queue: "jobrunner/queue.py",
    worker: "jobrunner/worker.py",
    metrics: "jobrunner/metrics.py",
    bus: "jobrunner/bus.py",
    config: "config/default.yaml",
    test: "tests/test_retry.py",
  },
  symbols: {
    dispatch: "Runner.dispatch",
    pop: "Queue.pop",
    requeue: "Queue.requeue",
    run: "Worker.run",
    handler: "on_job_completed",
  },
  markers: {
    pop: "self._queue.pop()",
    run: "worker.run(",
    requeue: "self._queue.requeue(",
    retryStart: "# Retry policy",
    retryInner: "attempts = job.attempts + 1",
    retryEnd: "dead-lettered {job.id} after",
    retryClose: 0,
    idle: "asyncio.sleep(",
    emit: 'emit("job.completed"',
  },
});
