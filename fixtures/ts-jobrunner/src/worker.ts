import type { EventBus, JobCompleted } from "./bus.ts";
import type { Job } from "./queue.ts";

/** Application code for one job type. Throwing (or rejecting) marks the attempt as failed. */
export type Handler = (job: Job) => Promise<unknown>;

export interface RunOptions {
  timeoutMs: number;
}

/** The outcome of one attempt. Failures are values here, never exceptions. */
export type RunResult =
  | { ok: true; value: unknown; durationMs: number }
  | { ok: false; error: string; durationMs: number };

export class Worker {
  readonly id: string;
  /** Id of the job being run right now, if any. */
  current: string | undefined = undefined;
  private readonly handlers: Map<string, Handler>;
  private readonly bus: EventBus;

  constructor(id: string, handlers: Map<string, Handler>, bus: EventBus) {
    this.id = id;
    this.handlers = handlers;
    this.bus = bus;
  }

  /** Runs one attempt of `job`. Never throws for job failures; success is published as "job.completed". */
  async run(job: Job, opts: RunOptions): Promise<RunResult> {
    const startedAt = Date.now();
    const handler = this.handlers.get(job.type);
    if (!handler) {
      return { ok: false, error: `no handler for job type "${job.type}"`, durationMs: 0 };
    }

    let value: unknown;
    this.current = job.id;
    try {
      // Job failures, timeouts included, are returned as results, never thrown.
      value = await withTimeout(handler(job), opts.timeoutMs);
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      return { ok: false, error, durationMs: Date.now() - startedAt };
    } finally {
      this.current = undefined;
    }

    // Success is announced on the bus; metrics (and anyone else) subscribe by topic.
    const durationMs = Date.now() - startedAt;
    this.bus.emit("job.completed", { jobId: job.id, type: job.type, durationMs } satisfies JobCompleted);
    return { ok: true, value, durationMs };
  }
}

/** A fixed set of workers that the runner leases one at a time. */
export class WorkerPool {
  private readonly idle: Worker[];
  private readonly waiting: Array<(worker: Worker) => void> = [];

  constructor(workers: Worker[]) {
    this.idle = [...workers];
  }

  /** Takes a free worker, waiting for a release when all of them are busy. */
  lease(): Promise<Worker> {
    const worker = this.idle.pop();
    if (worker) return Promise.resolve(worker);
    return new Promise((resolve) => this.waiting.push(resolve));
  }

  /** Gives a worker back, handing it straight to the longest waiter if there is one. */
  release(worker: Worker): void {
    const next = this.waiting.shift();
    if (next) next(worker);
    else this.idle.push(worker);
  }
}

/** Rejects if `work` has not settled within `ms`. */
function withTimeout<T>(work: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`timed out after ${ms}ms`)), ms);
  });
  return Promise.race([work, deadline]).finally(() => clearTimeout(timer));
}
