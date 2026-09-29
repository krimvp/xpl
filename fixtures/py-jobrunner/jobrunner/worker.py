"""Workers run one attempt of a job each; the pool hands them out."""

from __future__ import annotations

import asyncio
import time
from collections import deque
from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from typing import Any

from .bus import EventBus, JobCompleted
from .queue import Job

# Application code for one job kind. Raising marks the attempt as failed.
Handler = Callable[[Job], Awaitable[Any]]


@dataclass(frozen=True)
class RunOptions:
    timeout_ms: int


@dataclass(frozen=True)
class RunResult:
    """The outcome of one attempt. Failures are values here, never exceptions."""

    ok: bool
    duration_ms: float
    value: Any = None
    error: str = ""


class Worker:
    def __init__(self, id: str, handlers: dict[str, Handler], bus: EventBus) -> None:
        self.id: str = id
        self.current: str | None = None  # id of the job being run right now, if any
        self._handlers: dict[str, Handler] = handlers
        self._bus: EventBus = bus

    async def run(self, job: Job, opts: RunOptions) -> RunResult:
        """Runs one attempt of `job`. Never raises for job failures; success is published as "job.completed"."""
        started = time.monotonic()
        handler = self._handlers.get(job.kind)
        if handler is None:
            return RunResult(ok=False, duration_ms=0.0, error=f"no handler for job kind {job.kind!r}")

        self.current = job.id
        try:
            # Job failures, timeouts included, are returned as results, never raised.
            value = await asyncio.wait_for(handler(job), timeout=opts.timeout_ms / 1000)
        except asyncio.TimeoutError:
            duration_ms = (time.monotonic() - started) * 1000
            return RunResult(ok=False, duration_ms=duration_ms, error=f"timed out after {opts.timeout_ms}ms")
        except Exception as exc:
            duration_ms = (time.monotonic() - started) * 1000
            return RunResult(ok=False, duration_ms=duration_ms, error=str(exc) or type(exc).__name__)
        finally:
            self.current = None

        # Success is announced on the bus; metrics (and anyone else) subscribe by topic.
        duration_ms = (time.monotonic() - started) * 1000
        self._bus.emit("job.completed", JobCompleted(job_id=job.id, kind=job.kind, duration_ms=duration_ms))
        return RunResult(ok=True, duration_ms=duration_ms, value=value)


class WorkerPool:
    """A fixed set of workers that the runner leases one at a time."""

    def __init__(self, workers: list[Worker]) -> None:
        self._idle: deque[Worker] = deque(workers)
        self._free: asyncio.Semaphore = asyncio.Semaphore(len(workers))

    @property
    def available(self) -> int:
        """Number of workers that are free right now."""
        return len(self._idle)

    async def lease(self) -> Worker:
        """Takes a free worker, waiting for a release when all of them are busy."""
        await self._free.acquire()
        return self._idle.popleft()

    def release(self, worker: Worker) -> None:
        """Gives a worker back to the pool."""
        self._idle.append(worker)
        self._free.release()
