import assert from "node:assert/strict";
import { test } from "node:test";
import { EventBus } from "../src/bus.ts";
import { loadConfig } from "../src/config.ts";
import { createMetrics, registerMetrics } from "../src/metrics.ts";
import { Queue } from "../src/queue.ts";
import type { Job } from "../src/queue.ts";
import { backoffDelay, Runner } from "../src/runner.ts";
import { Worker, WorkerPool } from "../src/worker.ts";
import type { Handler } from "../src/worker.ts";

const retry = { maxRetries: 3, baseDelayMs: 1, maxDelayMs: 4 };

/** A queue that records what the runner does with a job and reports when the job is settled. */
class RecordingQueue extends Queue {
  readonly calls: string[] = [];
  readonly settled: PromiseWithResolvers<void> = Promise.withResolvers<void>();

  override async requeue(job: Job, delayMs: number): Promise<void> {
    this.calls.push(`requeue(${delayMs})`);
    await super.requeue(job, delayMs);
  }

  override async ack(job: Job): Promise<void> {
    await super.ack(job);
    this.calls.push("ack");
    this.settled.resolve();
  }

  override async deadLetter(job: Job, error: string): Promise<void> {
    await super.deadLetter(job, error);
    this.calls.push("deadLetter");
    this.settled.resolve();
  }
}

/** Pushes one "job" job through a real runner and waits until it is acked or dead-lettered. */
async function runOne(handler: Handler): Promise<{ queue: RecordingQueue; completed: number }> {
  const bus = new EventBus();
  const metrics = createMetrics("test");
  registerMetrics(bus, metrics);

  const queue = new RecordingQueue(10);
  const pool = new WorkerPool([new Worker("w1", new Map([["job", handler]]), bus)]);
  const runner = new Runner(queue, pool, { idleDelayMs: 1, timeoutMs: 1000, retry }, () => {});

  await queue.push("job");
  runner.start();
  await queue.settled.promise;
  await runner.stop();
  return { queue, completed: metrics.completed };
}

test("fails twice, then succeeds: acked after two requeues", { timeout: 5000 }, async () => {
  let calls = 0;
  const { queue, completed } = await runOne(async () => {
    calls += 1;
    if (calls <= 2) throw new Error(`boom #${calls}`);
    return "done";
  });

  assert.deepEqual(queue.calls, ["requeue(1)", "requeue(2)", "ack"]);
  assert.equal(queue.acked, 1);
  assert.equal(queue.dead.length, 0);
  assert.equal(completed, 1, "the worker reported success over the bus");
});

test("always fails: dead-lettered after maxRetries requeues", { timeout: 5000 }, async () => {
  const { queue, completed } = await runOne(async () => {
    throw new Error("boom");
  });

  assert.deepEqual(queue.calls, ["requeue(1)", "requeue(2)", "requeue(4)", "deadLetter"]);
  assert.equal(queue.acked, 0);
  assert.equal(queue.dead.length, 1);
  assert.equal(queue.dead[0]?.error, "boom");
  assert.equal(queue.dead[0]?.job.attempts, retry.maxRetries + 1);
  assert.equal(completed, 0);
});

test("backoff doubles with every failure and stops at maxDelayMs", () => {
  const policy = { maxRetries: 9, baseDelayMs: 100, maxDelayMs: 1000 };
  const delays = [1, 2, 3, 4, 5].map((n) => backoffDelay(n, policy));
  assert.deepEqual(delays, [100, 200, 400, 800, 1000]);
});

test("config/default.yaml carries the retry policy", () => {
  const config = loadConfig(new URL("../config/default.yaml", import.meta.url));
  assert.deepEqual(config.retry, { maxRetries: 3, baseDelayMs: 500, maxDelayMs: 30000 });
});
