"""The dispatch loop and the retry policy."""

from __future__ import annotations

import asyncio
import time
from collections.abc import Callable
from dataclasses import dataclass, field

from .config import RetryConfig, RunnerConfig
from .queue import Job, Queue
from .worker import RunOptions, WorkerPool

Logger = Callable[[str], None]


def backoff_delay(attempt: int, retry: RetryConfig) -> int:
    """Exponential backoff for the n-th failure (n starts at 1): base * 2^(n - 1), capped at max_delay_ms."""
    return min(retry.base_delay_ms << (attempt - 1), retry.max_delay_ms)


@dataclass
class RunnerStats:
    """Counters the runner keeps for itself (metrics fed by the bus live in metrics.py)."""

    processed: int = 0
    dead_lettered: int = 0
    ms_by_kind: dict[str, float] = field(default_factory=dict)

    def record(self, job: Job, elapsed_ms: float) -> None:
        self.processed += 1
        self.ms_by_kind[job.kind] = self.ms_by_kind.get(job.kind, 0.0) + elapsed_ms


class Runner:
    """Pulls jobs off the queue one at a time and runs each on a leased worker.

    The retry policy lives here: the queue only stores jobs, the worker only runs them.
    """

    def __init__(self, queue: Queue, pool: WorkerPool, config: RunnerConfig, logger: Logger) -> None:
        self.stats: RunnerStats = RunnerStats()
        self._queue: Queue = queue
        self._pool: WorkerPool = pool
        self._config: RunnerConfig = config
        self._logger: Logger = logger
        self._running: bool = False
        self._task: asyncio.Task[None] | None = None

    def start(self) -> None:
        """Starts dispatching in the background."""
        self._running = True
        self._task = asyncio.create_task(self.dispatch())

    async def stop(self) -> None:
        """Lets the job in progress finish, ends the loop, and re-raises if the loop crashed."""
        self._running = False
        if self._task is not None:
            await self._task

    async def dispatch(self) -> None:
        while self._running:
            # Take the next job; an empty queue means we wait a tick.
            # (Jobs are ordered by priority, then by enqueue time.)
            job = await self._queue.pop()
            if job is None:
                await asyncio.sleep(self._config.idle_delay_ms / 1000)
                continue

            # Lease a free worker; it goes back to the pool when we are done.
            worker = await self._pool.lease()
            started = time.monotonic()
            try:
                self._log(f"dispatching {job.id} (attempt {job.attempts + 1})")
                # A worker never raises for job failures; it reports them in the result.
                # Timeouts are enforced inside the worker.
                result = await worker.run(job, RunOptions(timeout_ms=self._config.timeout_ms))
            finally:
                self._pool.release(worker)
            self.stats.record(job, (time.monotonic() - started) * 1000)

            if result.ok:
                await self._queue.ack(job)
                continue

            # Retry policy: exponential backoff up to max_retries, then dead-letter.
            attempts = job.attempts + 1
            if attempts <= self._config.retry.max_retries:
                backoff = backoff_delay(attempts, self._config.retry)
                await self._queue.requeue(job, backoff)
            else:
                await self._queue.dead_letter(job, result.error)
                self.stats.dead_lettered += 1
                self._log(f"dead-lettered {job.id} after {attempts} attempts")

        self._log("dispatch loop stopped")

    def _log(self, message: str) -> None:
        self._logger(f"[runner] {message}")
