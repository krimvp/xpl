# rs-jobrunner

A tiny job runner: an in-memory queue, a pool of workers, retry with exponential backoff,
dead-lettering, and an event bus that feeds metrics. It is a fixture for the xpl code explainer;
the same design is implemented in `../ts-jobrunner`, `../py-jobrunner` and `../go-jobrunner`.
Rust indexing is experimental. This fixture has no explainer yet.

## Layout

| File | Role |
|---|---|
| `src/runner.rs` | `Runner::dispatch`: pop a job, lease a worker, run it, then ack, retry or dead-letter |
| `src/queue.rs` | `JobQueue` trait and `Queue` implementation: push, pop, requeue, ack, dead-letter |
| `src/worker.rs` | `Worker::run` returns a result; `WorkerPool` leases and releases workers |
| `src/bus.rs` | `EventBus` with string topics (`on` / `emit`) |
| `src/metrics.rs` | `on_job_completed` and `register_metrics`, subscribed to `job.completed` |
| `src/config.rs` | Loader for `config/default.yaml`, with a parser for its two-level YAML |
| `src/main.rs` | Wires everything together and runs a short demo |
| `tests/retry.rs` | Retry, dead-lettering, ordering, timeouts and config at their public boundaries |

## How it works

`Runner::dispatch` loops: pop the next job (highest priority first, then oldest), lease a worker,
call `Worker::run`, and release the worker. A successful job is acked. A failed one is requeued with
exponential backoff (`base_delay_ms * 2^(attempt-1)`, capped at `max_delay_ms`) until `max_retries`
requeues have been used, and is then dead-lettered.

When a job succeeds, `Worker::run` publishes `job.completed` on the event bus. The metrics module
subscribes to that topic in `register_metrics`, so the worker and the metrics never reference each other.
Handlers return `Result`; panics become failures. A listener panic cannot break the emitter.

`Runner::start` blocks until the queue drains or its stop flag is cleared. Another thread can clear
`stop_handle()` using `Ordering::SeqCst`; the active attempt finishes before dispatch stops.
The demo drains three jobs. It does not run an idle background service.
A worker runs its handler on a thread and waits on a channel with a timeout. Standard Rust cannot
cancel that thread. A timed-out handler can still finish and have side effects, like the underlying
work in the TS fixture after its timeout promise rejects.

## Running

```sh
cargo test --offline   # needs Rust >= 1.74; no external crates
cargo run --offline    # demo, about 4 seconds while the broken job walks through its backoff
cargo run --offline -- config/default.yaml
```

There are no dependencies beyond the Rust standard library. Cargo keeps this fixture outside any
parent workspace. Generated targets, lockfiles and SCIP output are ignored.

## Rust indexing cases

`JobQueue` has required method signatures and an implementation for `Queue`. Other types have
inherent impl blocks. `worker::demo::handlers` is a nested module. Its `echo` function shares a name
with `main.rs`'s `demo::echo`. The `counters!` macro in `runner.rs` defines `RunnerStats`; a syntax
parser sees the macro definition and invocation, but does not expand the generated struct.
`JOB_COMPLETED` is a const, `DEFAULT_CONFIG` is a static, and `Handler`, `Listener`, `Logger` and
`Sections` are type aliases. These cases expose gaps in an unmodified Rust tags query.

## Pinned line numbers

No acceptance anchors have been written yet. Keep these source lines stable once Rust acceptance
tests and an explainer are added. The retry mapping in `config/default.yaml` is lines 13-16, as in
the other fixtures.
