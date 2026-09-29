# go-jobrunner

A tiny job runner: an in-memory queue, a pool of workers, retry with exponential backoff,
dead-lettering, and an event bus that feeds metrics. It is a fixture for the xpl code explainer;
the same design is implemented in `../ts-jobrunner` and `../py-jobrunner`.

## Layout

| Path | Role |
|---|---|
| `internal/runner/runner.go` | `(*Runner).Dispatch`: pop a job, lease a worker, run it, then ack, retry or dead-letter. Depends on the small `JobQueue` and `WorkerPool` interfaces |
| `internal/queue/queue.go` | `Queue`: `Push`, `Pop`, `Requeue(job, delay)`, `Ack` |
| `internal/queue/deadletter.go` | `(*Queue).DeadLetter`, declared in its own file |
| `internal/worker/worker.go` | `(*Worker).Run` (returns a `Result`, never panics or errors for job failures) |
| `internal/worker/pool.go` | `Pool`: `Lease` / `Release` |
| `internal/bus/bus.go` | `Bus` with string topics (`On` / `Emit`) and the generic `Subscribe[T]` |
| `internal/metrics/metrics.go` | `(*Metrics).OnJobCompleted` and `Register`, which subscribes it to `job.completed` |
| `internal/config/config.go` | Loader for `config/default.yaml`, with a small parser for its two-level YAML |
| `cmd/jobrunner/main.go` | Wires everything together and runs a short demo |
| `internal/runner/retry_test.go` | The retry policy, end to end |

## How it works

`Dispatch` loops: pop the next job (highest priority first, then oldest), lease a worker, call
`Worker.Run`, and release the worker. A successful job is acked. A failed one is requeued with
exponential backoff (`BaseDelay * 2^(attempt-1)`, capped at `MaxDelay`) until `retry.maxRetries`
requeues have been used, and is then dead-lettered.

`*queue.Queue` satisfies `runner.JobQueue` and `*worker.Pool` satisfies `runner.WorkerPool` without
declaring it. When a job succeeds, `Worker.Run` publishes `job.completed` on the event bus. The metrics
package subscribes to that topic in `Register`, so the worker and the metrics never import each other.

## Running

```sh
go vet ./... && go test ./...     # standard library only; Go >= 1.22
go run ./cmd/jobrunner            # demo run, about 4 seconds while the broken job walks through its backoff
```

There are no dependencies and no `go.sum`.

## Pinned line numbers

Explainers anchor to line ranges, so reformatting these files shifts them. The `retry` mapping in
`config/default.yaml` is lines 13-16 in all three fixtures.
