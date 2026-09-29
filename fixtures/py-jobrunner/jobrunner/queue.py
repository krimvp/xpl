"""In-memory job queue with priorities, delayed retries and a dead-letter list."""

from __future__ import annotations

import time
from dataclasses import dataclass, field, replace
from typing import Any


@dataclass
class Job:
    """One unit of work."""

    id: str
    kind: str
    payload: dict[str, Any] = field(default_factory=dict)
    priority: int = 0  # higher runs first
    attempts: int = 0  # failed attempts recorded so far
    enqueued_at: float = field(default_factory=time.monotonic)
    available_at: float = 0.0  # not eligible before this time; used for retry backoff


@dataclass(frozen=True)
class DeadJob:
    """A job that ran out of retries, with the error of its last attempt."""

    job: Job
    error: str
    dead_at: float


class Queue:
    """In-memory job queue. Every method is async so a networked queue can replace it
    without changing the runner."""

    def __init__(self, max_pending: int) -> None:
        self.dead: list[DeadJob] = []
        self.acked: int = 0
        self._ready: list[Job] = []
        self._inflight: dict[str, Job] = {}
        self._max_pending: int = max_pending
        self._next_id: int = 1

    @property
    def size(self) -> int:
        """Jobs that are waiting or running."""
        return len(self._ready) + len(self._inflight)

    async def push(self, kind: str, payload: dict[str, Any] | None = None, priority: int = 0) -> Job:
        """Adds a job to the queue. Raises when `max_pending` jobs are already waiting."""
        if len(self._ready) >= self._max_pending:
            raise OverflowError(f"queue is full ({self._max_pending} pending)")
        job = Job(id=f"job-{self._next_id}", kind=kind, payload=payload or {}, priority=priority)
        self._next_id += 1
        self._ready.append(job)
        return job

    async def pop(self) -> Job | None:
        """Hands out the next job: highest priority first, then oldest enqueue time.

        Jobs that are still backing off are skipped. Returns None when nothing is due.
        """
        now = time.monotonic()
        due = [job for job in self._ready if job.available_at <= now]
        if not due:
            return None
        job = min(due, key=lambda candidate: (-candidate.priority, candidate.enqueued_at))
        self._ready.remove(job)
        self._inflight[job.id] = job
        return job

    async def requeue(self, job: Job, delay_ms: int) -> None:
        """Puts a failed job back to try again after `delay_ms`. Records the failed attempt.

        The job keeps its original enqueue time, so it goes ahead of newer jobs once it is due.
        """
        self._inflight.pop(job.id, None)
        retry = replace(job, attempts=job.attempts + 1, available_at=time.monotonic() + delay_ms / 1000)
        self._ready.append(retry)

    async def ack(self, job: Job) -> None:
        """Marks a job as done for good."""
        self._inflight.pop(job.id, None)
        self.acked += 1

    async def dead_letter(self, job: Job, error: str) -> None:
        """Parks a job that ran out of retries, together with the error of its last attempt."""
        self._inflight.pop(job.id, None)
        failed = replace(job, attempts=job.attempts + 1)
        self.dead.append(DeadJob(job=failed, error=error, dead_at=time.monotonic()))
