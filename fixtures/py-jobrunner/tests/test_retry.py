"""The retry policy, end to end: real queue, real worker, real runner."""

from __future__ import annotations

import asyncio
import unittest
from pathlib import Path

from jobrunner.bus import EventBus
from jobrunner.config import RetryConfig, RunnerConfig, load_config
from jobrunner.metrics import Metrics, register_metrics
from jobrunner.queue import Job, Queue
from jobrunner.runner import Runner, backoff_delay
from jobrunner.worker import Handler, Worker, WorkerPool

RETRY = RetryConfig(max_retries=3, base_delay_ms=1, max_delay_ms=4)
DEFAULT_CONFIG = Path(__file__).resolve().parent.parent / "config" / "default.yaml"


class RecordingQueue(Queue):
    """A queue that records what the runner does with a job and says when the job is settled."""

    def __init__(self, max_pending: int) -> None:
        super().__init__(max_pending)
        self.calls: list[str] = []
        self.settled: asyncio.Event = asyncio.Event()

    async def requeue(self, job: Job, delay_ms: int) -> None:
        self.calls.append(f"requeue({delay_ms})")
        await super().requeue(job, delay_ms)

    async def ack(self, job: Job) -> None:
        await super().ack(job)
        self.calls.append("ack")
        self.settled.set()

    async def dead_letter(self, job: Job, error: str) -> None:
        await super().dead_letter(job, error)
        self.calls.append("dead_letter")
        self.settled.set()


class RetryPolicyTest(unittest.IsolatedAsyncioTestCase):
    async def run_one(self, handler: Handler) -> tuple[RecordingQueue, Metrics]:
        """Pushes one "job" job through a real runner and waits until it is acked or dead-lettered."""
        bus = EventBus()
        metrics = Metrics(prefix="test")
        register_metrics(bus, metrics)

        queue = RecordingQueue(max_pending=10)
        pool = WorkerPool([Worker("w1", {"job": handler}, bus)])
        config = RunnerConfig(idle_delay_ms=1, timeout_ms=1000, retry=RETRY)
        runner = Runner(queue, pool, config, lambda message: None)

        await queue.push("job")
        runner.start()
        await asyncio.wait_for(queue.settled.wait(), timeout=5)
        await runner.stop()
        return queue, metrics

    async def test_fails_twice_then_succeeds_is_acked_after_two_requeues(self) -> None:
        calls = 0

        async def flaky(job: Job) -> str:
            nonlocal calls
            calls += 1
            if calls <= 2:
                raise RuntimeError(f"boom #{calls}")
            return "done"

        queue, metrics = await self.run_one(flaky)

        self.assertEqual(queue.calls, ["requeue(1)", "requeue(2)", "ack"])
        self.assertEqual(queue.acked, 1)
        self.assertEqual(queue.dead, [])
        self.assertEqual(metrics.completed, 1, "the worker reported success over the bus")

    async def test_always_failing_job_is_dead_lettered_after_max_retries(self) -> None:
        async def broken(job: Job) -> str:
            raise RuntimeError("boom")

        queue, metrics = await self.run_one(broken)

        self.assertEqual(queue.calls, ["requeue(1)", "requeue(2)", "requeue(4)", "dead_letter"])
        self.assertEqual(queue.acked, 0)
        self.assertEqual(len(queue.dead), 1)
        self.assertEqual(queue.dead[0].error, "boom")
        self.assertEqual(queue.dead[0].job.attempts, RETRY.max_retries + 1)
        self.assertEqual(metrics.completed, 0)


class BackoffTest(unittest.TestCase):
    def test_doubles_with_every_failure_and_stops_at_max_delay(self) -> None:
        policy = RetryConfig(max_retries=9, base_delay_ms=100, max_delay_ms=1000)
        self.assertEqual([backoff_delay(n, policy) for n in range(1, 6)], [100, 200, 400, 800, 1000])


class ConfigTest(unittest.TestCase):
    def test_default_yaml_carries_the_retry_policy(self) -> None:
        config = load_config(DEFAULT_CONFIG)
        self.assertEqual(config.retry, RetryConfig(max_retries=3, base_delay_ms=500, max_delay_ms=30000))


if __name__ == "__main__":
    unittest.main()
