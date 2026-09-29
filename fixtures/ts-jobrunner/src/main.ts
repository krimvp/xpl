import { setTimeout as sleep } from "node:timers/promises";
import { EventBus } from "./bus.ts";
import { loadConfig, runnerConfig } from "./config.ts";
import { createMetrics, formatMetrics, registerMetrics } from "./metrics.ts";
import { Queue } from "./queue.ts";
import { Runner } from "./runner.ts";
import { Worker, WorkerPool } from "./worker.ts";
import type { Handler } from "./worker.ts";

/** Sample job types for the demo run: one that works, one that needs retries, one that never works. */
function demoHandlers(): Map<string, Handler> {
  const attemptsSeen = new Map<string, number>();
  return new Map<string, Handler>([
    [
      "echo",
      async (job) => {
        await sleep(20); // pretend to do some work
        return job.payload;
      },
    ],
    [
      "flaky",
      async (job) => {
        const attempt = (attemptsSeen.get(job.id) ?? 0) + 1;
        attemptsSeen.set(job.id, attempt);
        if (attempt <= 2) throw new Error(`flaky failure on attempt ${attempt}`);
        return "recovered";
      },
    ],
    [
      "broken",
      async () => {
        throw new Error("this job always fails");
      },
    ],
  ]);
}

async function main(): Promise<void> {
  const config = loadConfig(process.argv[2] ?? new URL("../config/default.yaml", import.meta.url));

  // Metrics only ever hear about completed jobs through the bus.
  const bus = new EventBus();
  const metrics = createMetrics(config.metrics.prefix);
  if (config.metrics.enabled) registerMetrics(bus, metrics);

  const handlers = demoHandlers();
  const workers = Array.from(
    { length: config.workers.count },
    (_, i) => new Worker(`${config.workers.namePrefix}-${i + 1}`, handlers, bus),
  );
  const queue = new Queue(config.queue.maxPending);
  const runner = new Runner(queue, new WorkerPool(workers), runnerConfig(config), console.log);
  console.log(
    `queue "${config.queue.name}": ${workers.length} workers, up to ${config.retry.maxRetries} retries`,
  );

  await queue.push("echo", { greeting: "hello" });
  await queue.push("flaky", {}, { priority: 5 });
  await queue.push("broken");

  runner.start();
  while (queue.size > 0) await sleep(config.queue.idleDelayMs);
  await runner.stop();

  console.log(`acked=${queue.acked} dead-lettered=${queue.dead.length}`);
  if (config.metrics.printSummary) console.log(formatMetrics(metrics).join("\n"));
}

main().catch((err: unknown) => {
  console.error(err);
  process.exitCode = 1;
});
