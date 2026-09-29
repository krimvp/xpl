# py-jobrunner

A tiny job runner: an in-memory queue, a pool of workers, retry with exponential backoff,
dead-lettering, and an event bus that feeds metrics. It is a fixture for the xpl code explainer;
the same design is implemented in `../ts-jobrunner` and `../go-jobrunner`.

## Layout

| File | Role |
|---|---|
| `jobrunner/runner.py` | `Runner.dispatch`: pop a job, lease a worker, run it, then ack, retry or dead-letter |
| `jobrunner/queue.py` | `Queue`: `push`, `pop`, `requeue(job, delay_ms)`, `ack`, `dead_letter`; the `Job` dataclass |
| `jobrunner/worker.py` | `Worker.run` (returns a result, never raises for job failures) and `WorkerPool` (`lease` / `release`) |
| `jobrunner/bus.py` | `EventBus` with string topics (`on` / `emit`) |
| `jobrunner/metrics.py` | `on_job_completed` and `register_metrics`, which subscribes it to `job.completed` |
| `jobrunner/config.py` | Loader for `config/default.yaml`, with a small parser for its two-level YAML |
| `jobrunner/__main__.py` | Wires everything together and runs a short demo |
| `tests/test_retry.py` | The retry policy, end to end |

## How it works

`Runner.dispatch` loops: pop the next job (highest priority first, then oldest), lease a worker,
call `Worker.run`, and release the worker. A successful job is acked. A failed one is requeued with
exponential backoff (`base_delay_ms * 2^(attempt-1)`, capped at `max_delay_ms`) until `retry.maxRetries`
requeues have been used, and is then dead-lettered.

When a job succeeds, `Worker.run` publishes `job.completed` on the event bus. The metrics module
subscribes to that topic in `register_metrics`, so the worker and the metrics never reference each other.

## Running

```sh
python3 -m unittest discover -s tests     # standard library only; Python >= 3.10
python3 -m jobrunner                      # demo run, about 4 seconds while the broken job walks through its backoff
```

There are no dependencies. All code is fully type-annotated (`mypy --strict` is clean).

## Pinned line numbers

Explainers anchor to line ranges, so reformatting these files shifts them. The `retry` mapping in
`config/default.yaml` is lines 13-16 in all three fixtures.
