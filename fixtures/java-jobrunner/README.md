# java-jobrunner

A tiny job runner: an in-memory queue, a pool of workers, retry with exponential backoff,
dead-lettering, and an event bus that feeds metrics. It is a fixture for the xpl code explainer;
the same design is implemented in `../ts-jobrunner`, `../py-jobrunner` and `../go-jobrunner`.
Java indexing uses tree-sitter without a JDK. The optional [SCIP workflow](../../docs/java-scip.md) includes
a source-checked explainer and bundle example with precise type references.

## Layout

| File | Role |
|---|---|
| `src/main/java/jobrunner/Runner.java` | `Runner.dispatch`: pop a job, lease a worker, run it, then ack, retry or dead-letter |
| `src/main/java/jobrunner/Queue.java` | `Queue`: overloaded `push`, `pop`, `requeue`, `ack`, `deadLetter`; static nested `Job` |
| `src/main/java/jobrunner/Worker.java` | `Worker.run`: enforce the timeout, return a result and publish success |
| `src/main/java/jobrunner/WorkerPool.java` | `lease` / `release`, with a blocking queue of idle workers |
| `src/main/java/jobrunner/EventBus.java` | String topics with `on` / `emit` |
| `src/main/java/jobrunner/Metrics.java` | `onJobCompleted` and `registerMetrics`, which subscribes a method reference |
| `src/main/java/jobrunner/Config.java` | Loader for the two-level YAML in `config/default.yaml` |
| `src/main/java/jobrunner/Handler.java` | Callback interface implemented by `EchoHandler`, `FailingHandler` and a lambda |
| `src/main/java/jobrunner/BaseHandler.java` | Abstract base class extended by `EchoHandler` |
| `src/main/java/jobrunner/Main.java` | Wires everything together and runs a short demo |
| `src/test/java/jobrunner/RetryTest.java` | Standard-library end-to-end checks, run through its `main` |

## How it works

`Runner.dispatch` loops: pop the next job (highest priority first, then oldest), lease a worker,
call `Worker.run`, and release the worker. A successful job is acked. A failed one is requeued with
exponential backoff (`baseDelayMs * 2^(attempt-1)`, capped at `maxDelayMs`) until `retry.maxRetries`
requeues have been used, and is then dead-lettered. `Runner.Stats` is a non-static inner class.

When a job succeeds, `Worker.run` publishes `job.completed` on the event bus. `Metrics.registerMetrics`
subscribes `this::onJobCompleted`, so the worker and metrics never reference each other.
The worker runs each callback in an executor and cancels it on timeout. Cancellation relies on the
handler responding to interruption. The runner uses one dispatch thread; it does not run jobs in parallel.

## Running

Use JDK 17 or newer and Maven 3.9.11. The compiler plugin is pinned to 3.14.0.

```sh
mvn test-compile
java -cp target/classes:target/test-classes jobrunner.RetryTest
java -cp target/classes jobrunner.Main
```

`RetryTest` throws `AssertionError` on a failed check; it does not require `-ea`.
`mvn test` alone does not run these checks. Maven downloads its build plugins on the first run.
The fixture has no third-party Java dependencies. The demo takes about four seconds.

## SCIP experiment

With scip-java's v0.13.1 release launcher on `PATH`, run from this directory:

```sh
scip-java index -- --batch-mode clean test-compile
```

This generates `index.scip` for main and test sources. The artifact and `target/` are ignored.
The release launcher reports its version as `0.0.0-SNAPSHOT`; pin the release download and its checksum.
No existing fixture's line numbers are changed. The `retry` mapping remains at lines 13–16 of the config.

The xpl checkout helper `scripts/java-scip.ts ROOT FRESH_OUTPUT_DIR` captures source hashes before
generation, checks them after a successful build and writes a manifest for `xpl index --scip`. Use a
fixture copy and keep artifacts outside it. The workflow above records exact downloads, UTF-16 columns,
missing-tool/build diagnostics, partial coverage and unsupported call/implementation classification.
