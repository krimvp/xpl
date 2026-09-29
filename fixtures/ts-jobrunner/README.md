# ts-jobrunner

A tiny job runner: an in-memory queue, a pool of workers, retry with exponential backoff,
dead-lettering, and an event bus that feeds metrics. It is a fixture for the xpl code explainer;
the same design is implemented in `../py-jobrunner` and `../go-jobrunner`.

## Layout

| File | Role |
|---|---|
| `src/runner.ts` | `Runner.dispatch`: pop a job, lease a worker, run it, then ack, retry or dead-letter |
| `src/queue.ts` | `Queue`: `push`, `pop`, `requeue(job, delayMs)`, `ack`, `deadLetter` |
| `src/worker.ts` | `Worker.run` (returns a result, never throws for job failures) and `WorkerPool` (`lease` / `release`) |
| `src/bus.ts` | `EventBus` with string topics (`on` / `emit`) |
| `src/metrics.ts` | `onJobCompleted` and `registerMetrics`, which subscribes it to `job.completed` |
| `src/config.ts` | Loader for `config/default.yaml`, with a small parser for its two-level YAML |
| `src/main.ts` | Wires everything together and runs a short demo |
| `test/retry.test.ts` | The retry policy, end to end |

## How it works

`Runner.dispatch` loops: pop the next job (highest priority first, then oldest), lease a worker,
call `Worker.run`, and release the worker. A successful job is acked. A failed one is requeued with
exponential backoff (`baseDelayMs * 2^(attempt-1)`, capped at `maxDelayMs`) until `retry.maxRetries`
requeues have been used, and is then dead-lettered.

When a job succeeds, `Worker.run` publishes `job.completed` on the event bus. The metrics module
subscribes to that topic in `registerMetrics`, so the worker and the metrics never reference each other.

## Running

```sh
npm test             # node --test; needs Node >= 22.18 (type stripping is on by default)
npm start            # demo run, about 4 seconds while the broken job walks through its backoff
npm run typecheck    # tsc -p .; needs TypeScript >= 5.8 and @types/node from the workspace root
```

There are no dependencies: Node runs the `.ts` files directly, and relative imports carry their
`.ts` extension. The tsconfig uses `erasableSyntaxOnly`, so no enums or parameter properties.

## Pinned line numbers

xpl's acceptance tests anchor to exact lines, so reformatting these files breaks them:
`Runner.dispatch` is lines 42-88 of `src/runner.ts`, the `job.completed` emit is offset 21 of
`Worker.run`, and the `retry` mapping in `config/default.yaml` is lines 13-16.
