"""Entry point: `python -m jobrunner [config.yaml]` wires everything together and runs a short demo."""

from __future__ import annotations

import asyncio
import sys
from pathlib import Path

from .bus import EventBus
from .config import RunnerConfig, load_config
from .metrics import Metrics, format_metrics, register_metrics
from .queue import Job, Queue
from .runner import Runner
from .worker import Handler, Worker, WorkerPool

DEFAULT_CONFIG = Path(__file__).resolve().parent.parent / "config" / "default.yaml"


def demo_handlers() -> dict[str, Handler]:
    """Sample job kinds for the demo run: one that works, one that needs retries, one that never works."""
    attempts_seen: dict[str, int] = {}

    async def echo(job: Job) -> object:
        await asyncio.sleep(0.02)  # pretend to do some work
        return job.payload

    async def flaky(job: Job) -> object:
        attempt = attempts_seen.get(job.id, 0) + 1
        attempts_seen[job.id] = attempt
        if attempt <= 2:
            raise RuntimeError(f"flaky failure on attempt {attempt}")
        return "recovered"

    async def broken(job: Job) -> object:
        raise RuntimeError("this job always fails")

    return {"echo": echo, "flaky": flaky, "broken": broken}


async def run(config_path: Path) -> None:
    config = load_config(config_path)

    # Metrics only ever hear about completed jobs through the bus.
    bus = EventBus()
    metrics = Metrics(prefix=config.metrics.prefix)
    if config.metrics.enabled:
        register_metrics(bus, metrics)

    handlers = demo_handlers()
    workers = [Worker(f"{config.workers.name_prefix}-{n}", handlers, bus) for n in range(1, config.workers.count + 1)]
    queue = Queue(config.queue.max_pending)
    runner = Runner(queue, WorkerPool(workers), RunnerConfig.from_config(config), print)
    print(f'queue "{config.queue.name}": {len(workers)} workers, up to {config.retry.max_retries} retries')

    await queue.push("echo", {"greeting": "hello"})
    await queue.push("flaky", priority=5)
    await queue.push("broken")

    runner.start()
    while queue.size > 0:
        await asyncio.sleep(config.queue.idle_delay_ms / 1000)
    await runner.stop()

    print(f"acked={queue.acked} dead-lettered={len(queue.dead)}")
    if config.metrics.print_summary:
        print("\n".join(format_metrics(metrics)))


def main(argv: list[str] | None = None) -> None:
    args = sys.argv[1:] if argv is None else argv
    asyncio.run(run(Path(args[0]) if args else DEFAULT_CONFIG))


if __name__ == "__main__":
    main()
