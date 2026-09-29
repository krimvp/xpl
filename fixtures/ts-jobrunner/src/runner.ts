import { setTimeout as sleep } from "node:timers/promises";
import type { RetryConfig, RunnerConfig } from "./config.ts";
import type { Job, Queue } from "./queue.ts";
import type { RunResult, WorkerPool } from "./worker.ts";

export type Logger = (message: string) => void;

/**
 * Pulls jobs off the queue one at a time and runs each on a leased worker.
 * The retry policy lives here: the queue only stores jobs, the worker only runs them.
 */
export class Runner {
  readonly stats: RunnerStats = new RunnerStats();
  private readonly queue: Queue;
  private readonly pool: WorkerPool;
  private readonly config: RunnerConfig;
  private readonly logger: Logger;
  private running: boolean = false;
  // Settles when the dispatch loop has exited (it rejects if the loop crashed).
  private readonly stopped: PromiseWithResolvers<void> = Promise.withResolvers<void>();

  constructor(queue: Queue, pool: WorkerPool, config: RunnerConfig, logger: Logger) {
    this.queue = queue;
    this.pool = pool;
    this.config = config;
    this.logger = logger;
  }

  /** Starts dispatching in the background; the promise settles once the loop has exited. */
  start(): Promise<void> {
    this.running = true;
    this.dispatch().catch((err: unknown) => this.stopped.reject(err));
    return this.stopped.promise;
  }

  /** Lets the job in progress finish, then ends the loop. */
  stop(): Promise<void> {
    this.running = false;
    return this.stopped.promise;
  }

  async dispatch(): Promise<void> {
    while (this.running) {
      // Take the next job; an empty queue means we wait a tick.
      // (Jobs are ordered by priority, then by enqueue time.)
      const job = await this.queue.pop();
      if (!job) {
        await sleep(this.config.idleDelayMs);
        continue;
      }

      // Lease a free worker; it goes back to the pool when we are done.
      const worker = await this.pool.lease();
      const startedAt = Date.now();
      let result: RunResult;
      try {
        this.log(`dispatching ${job.id} (attempt ${job.attempts + 1})`);
        // A worker never throws for job failures; it reports them in the result.
        // Timeouts are enforced inside the worker.
        result = await worker.run(
          job, { timeoutMs: this.config.timeoutMs });
      } finally {
        this.pool.release(worker);
      }
      this.stats.record(job, Date.now() - startedAt);

      if (result.ok) {
        await this.queue.ack(job);
        continue;
      }

      // Retry policy: exponential backoff up to maxRetries, then dead-letter.
      const attempts = job.attempts + 1;
      if (attempts <= this.config.retry.maxRetries) {
        const backoff = backoffDelay(attempts, this.config.retry);
        await this.queue.requeue(
          job,
          backoff);
      } else {
        await this.queue.deadLetter(job, result.error);
        this.stats.deadLettered += 1;
        this.log(`dead-lettered ${job.id} after ${attempts} attempts`);
      }
    }

    this.log("dispatch loop stopped");
    this.stopped.resolve();
  }

  private log(message: string): void {
    this.logger(`[runner] ${message}`);
  }
}

/** Counters the runner keeps for itself (metrics fed by the bus live in metrics.ts). */
export class RunnerStats {
  processed: number = 0;
  deadLettered: number = 0;
  readonly msByType: Map<string, number> = new Map();

  record(job: Job, elapsedMs: number): void {
    this.processed += 1;
    this.msByType.set(job.type, (this.msByType.get(job.type) ?? 0) + elapsedMs);
  }
}

/** Exponential backoff for the n-th failure (n starts at 1): base * 2^(n - 1), capped at maxDelayMs. */
export function backoffDelay(attempt: number, retry: RetryConfig): number {
  return Math.min(retry.baseDelayMs * 2 ** (attempt - 1), retry.maxDelayMs);
}
