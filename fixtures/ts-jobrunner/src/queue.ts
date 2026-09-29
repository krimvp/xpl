export interface Job {
  id: string;
  type: string;
  payload: Record<string, unknown>;
  /** Higher runs first. */
  priority: number;
  /** Failed attempts recorded so far. */
  attempts: number;
  enqueuedAt: number;
  /** Not eligible to run before this time (ms since epoch); used for retry backoff. */
  availableAt: number;
}

export interface DeadJob {
  job: Job;
  error: string;
  deadAt: number;
}

export interface PushOptions {
  priority?: number;
}

/**
 * In-memory job queue. Every method is async so a networked queue can replace it
 * without changing the runner.
 */
export class Queue {
  readonly dead: DeadJob[] = [];
  acked: number = 0;
  private readonly ready: Job[] = [];
  private readonly inflight: Map<string, Job> = new Map();
  private readonly maxPending: number;
  private nextId: number = 1;

  constructor(maxPending: number) {
    this.maxPending = maxPending;
  }

  /** Jobs that are waiting or running. */
  get size(): number {
    return this.ready.length + this.inflight.size;
  }

  /** Adds a job to the queue. Throws when `maxPending` jobs are already waiting. */
  async push(
    type: string,
    payload: Record<string, unknown> = {},
    opts: PushOptions = {},
  ): Promise<Job> {
    if (this.ready.length >= this.maxPending) {
      throw new Error(`queue is full (${this.maxPending} pending)`);
    }
    const now = Date.now();
    const job: Job = {
      id: `job-${this.nextId++}`,
      type,
      payload,
      priority: opts.priority ?? 0,
      attempts: 0,
      enqueuedAt: now,
      availableAt: now,
    };
    this.ready.push(job);
    return job;
  }

  /**
   * Hands out the next job: highest priority first, then oldest enqueue time.
   * Jobs that are still backing off are skipped. Returns undefined when nothing is due.
   */
  async pop(): Promise<Job | undefined> {
    const now = Date.now();
    const due = this.ready.filter((job) => job.availableAt <= now);
    due.sort((a, b) => b.priority - a.priority || a.enqueuedAt - b.enqueuedAt);
    const job: Job | undefined = due[0];
    if (!job) return undefined;
    this.ready.splice(this.ready.indexOf(job), 1);
    this.inflight.set(job.id, job);
    return job;
  }

  /**
   * Puts a failed job back to try again after `delayMs`. Records the failed attempt.
   * The job keeps its original enqueue time, so it goes ahead of newer jobs once it is due.
   */
  async requeue(job: Job, delayMs: number): Promise<void> {
    this.inflight.delete(job.id);
    this.ready.push({ ...job, attempts: job.attempts + 1, availableAt: Date.now() + delayMs });
  }

  /** Marks a job as done for good. */
  async ack(job: Job): Promise<void> {
    this.inflight.delete(job.id);
    this.acked += 1;
  }

  /** Parks a job that ran out of retries, together with the error of its last attempt. */
  async deadLetter(job: Job, error: string): Promise<void> {
    this.inflight.delete(job.id);
    this.dead.push({ job: { ...job, attempts: job.attempts + 1 }, error, deadAt: Date.now() });
  }
}
