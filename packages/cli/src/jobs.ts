/** Durable service jobs. Runners return proposals; this module never applies patches or records outcomes. */
import { randomUUID } from "node:crypto";
import { existsSync, lstatSync, readFileSync, realpathSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import {
  artifactIdentity,
  parseFeedbackRequest,
  sameFeedbackContent,
  sameFeedbackContext,
  type Job,
  type JobReviewAction,
} from "@xpl/core";
import type { Ctx } from "./context.js";
import { CliError, errorMessage } from "./errors.js";
import { atomicWrite, jsonFile, parseJson, withRepositoryLock } from "./fsutil.js";
import { loadExplainer, openWorkspace } from "./repo.js";
import { readRequests } from "./requests.js";
import { terminateJobProcess, type JobProcess } from "./job-process.js";
import { continueRevision, selectRevision, revisionStatus } from "./revision.js";

type JobState = Job["state"];
export type { Job } from "@xpl/core";
export interface JobSubmission {
  id: string;
  selectedRequestIds: string[];
  include?: string[];
}
/** Real adapters return untrusted proposals; controlled runners may return only a lifecycle receipt. */
export type JobRunner = (
  job: Job,
  signal: AbortSignal,
  progress: (message: string) => Promise<void>,
  started: (process: JobProcess) => Promise<void>,
) => Promise<{ revisionRunId: string; proposals?: unknown }>;
interface Ledger {
  schema: "xpl-jobs@1";
  root: string;
  jobs: Job[];
}

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const STATES: JobState[] = [
  "queued",
  "running",
  "completed",
  "failed",
  "cancelled",
  "superseded",
  "interrupted",
];
const UNAVAILABLE =
  "Job runner unavailable. Start the service with --backend claude to use the installed, authenticated Claude Code CLI, or use manual xpl revise.";
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new CliError("expected a job object");
  return value as Record<string, unknown>;
}
function strings(value: unknown, field: string): string[] {
  if (
    !Array.isArray(value) ||
    value.length > 1000 ||
    value.some((v) => typeof v !== "string" || !v || v.length > 500) ||
    new Set(value).size !== value.length
  )
    throw new CliError(`${field} must be a list of unique non-empty IDs`);
  return value as string[];
}
function uuid(value: unknown): string {
  if (typeof value !== "string" || !UUID.test(value))
    throw new CliError("job and owner IDs must be UUIDs");
  return value;
}
function local(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length < 4096 &&
    !value.startsWith("/") &&
    !value.includes("\\") &&
    !value.includes("\0") &&
    !value.split("/").some((p) => !p || p === "." || p === "..")
  );
}
function date(value: unknown): boolean {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}

class RepositoryJobs {
  private readonly path: string;
  private closed = false;
  private fatal: string | undefined;
  private pumping: Promise<void> | undefined;
  private wake = false;
  private active: { id: string; abort: AbortController } | undefined;

  constructor(
    private readonly ctx: Ctx,
    private readonly instanceId: string,
    private readonly runner?: JobRunner,
  ) {
    this.path = join(ctx.root, ".explainer", "service", "jobs.json");
  }

  get availability() {
    return {
      available: !!this.runner && !this.closed && !this.fatal,
      reason:
        this.fatal ??
        (this.closed ? "Service job worker stopped." : this.runner ? null : UNAVAILABLE),
    };
  }

  private checkPaths() {
    for (const path of [
      join(this.ctx.root, ".explainer"),
      dirname(this.path),
      this.path,
      join(dirname(this.path), "instance.json"),
    ]) {
      if (
        existsSync(path) &&
        (lstatSync(path).isSymbolicLink() || !realpathSync(path).startsWith(this.ctx.root + sep))
      )
        throw new CliError("job storage must stay inside its repository without symlinks");
    }
  }

  private assertOwner() {
    this.checkPaths();
    const path = join(dirname(this.path), "instance.json");
    const instance = record(parseJson(readFileSync(path, "utf8"), path));
    if (
      instance.schema !== "xpl-service-instance@1" ||
      instance.root !== this.ctx.root ||
      instance.instanceId !== this.instanceId ||
      !["starting", "running"].includes(String(instance.state))
    )
      throw new CliError("job worker no longer owns this repository service");
  }

  private read(): Ledger {
    this.checkPaths();
    if (!existsSync(this.path)) return { schema: "xpl-jobs@1", root: this.ctx.root, jobs: [] };
    const data = record(parseJson(readFileSync(this.path, "utf8"), this.path));
    try {
      if (data.schema !== "xpl-jobs@1" || data.root !== this.ctx.root || !Array.isArray(data.jobs))
        throw new Error("wrong schema or root");
      const jobs = data.jobs.map((value) => {
        const j = record(value);
        uuid(j.id);
        const scope = record(j.scope);
        const input = record(j.input);
        const expected = record(input.expected);
        strings(scope.include, "include");
        const ids = strings(j.selectedRequestIds, "selectedRequestIds");
        uuid(input.revisionRunId);
        if (
          scope.kind !== "revision" ||
          !local(scope.guide) ||
          !local(input.index) ||
          !ids.length ||
          typeof expected.explainerHash !== "string" ||
          typeof expected.sourceHash !== "string" ||
          !expected.explainerHash ||
          !expected.sourceHash ||
          !Array.isArray(input.requests)
        )
          throw new Error("invalid snapshot");
        const requests = input.requests.map(parseFeedbackRequest);
        if (JSON.stringify(requests.map((r) => r.id)) !== JSON.stringify(ids))
          throw new Error("selection does not match snapshot");
        if (
          !STATES.includes(j.state as JobState) ||
          !date(j.createdAt) ||
          !date(j.updatedAt) ||
          !Number.isSafeInteger(j.attempt) ||
          Number(j.attempt) < 0 ||
          !(j.error === null || (typeof j.error === "string" && j.error.length <= 5000)) ||
          !Array.isArray(j.progress) ||
          j.progress.length > 100
        )
          throw new Error("invalid lifecycle");
        for (const p of j.progress) {
          const entry = record(p);
          if (
            !date(entry.at) ||
            typeof entry.message !== "string" ||
            !entry.message.trim() ||
            entry.message.length > 2000
          )
            throw new Error("invalid progress");
        }
        if (j.owner !== null) {
          const owner = record(j.owner);
          uuid(owner.instanceId);
          uuid(owner.attemptId);
          if (owner.process !== undefined) {
            const child = record(owner.process);
            if (
              !Number.isSafeInteger(child.groupId) ||
              Number(child.groupId) <= 1 ||
              typeof child.startTime !== "string" ||
              !/^[a-f0-9-]{36}:\d+$/.test(child.startTime)
            )
              throw new Error("invalid process identity");
          }
        }
        if (j.state === "running" && (j.owner === null || j.attempt === 0))
          throw new Error("running job has no owner");
        if (
          j.result !== null &&
          (j.state !== "completed" || record(j.result).revisionRunId !== input.revisionRunId)
        )
          throw new Error("invalid proposal reference");
        if (j.state === "completed" && j.result === null)
          throw new Error("completed job has no result");
        if (j.cleanup !== undefined) {
          const cleanup = record(j.cleanup);
          if (
            j.state !== "failed" ||
            (cleanup.groupId !== undefined &&
              (!Number.isSafeInteger(cleanup.groupId) || Number(cleanup.groupId) <= 1)) ||
            (cleanup.startTime !== undefined &&
              (cleanup.groupId === undefined ||
                typeof cleanup.startTime !== "string" ||
                !/^[a-f0-9-]{36}:\d+$/.test(cleanup.startTime)))
          )
            throw new Error("invalid cleanup barrier");
        }
        return j as unknown as Job;
      });
      if (
        new Set(jobs.map((j) => j.id)).size !== jobs.length ||
        jobs.filter((j) => j.state === "running").length > 1
      )
        throw new Error("duplicate IDs or conflicting running jobs");
      return { schema: "xpl-jobs@1", root: this.ctx.root, jobs };
    } catch (error) {
      throw new CliError(
        `invalid job ledger; inspect ${this.path} before recovery: ${errorMessage(error)}`,
      );
    }
  }

  private async mutate<T>(change: (ledger: Ledger) => Promise<T> | T): Promise<T> {
    this.assertOwner();
    return withRepositoryLock(this.ctx.root, this.path, async () => {
      this.assertOwner();
      const ledger = this.read();
      const result = await change(ledger);
      this.assertOwner();
      await atomicWrite(this.path, jsonFile(ledger));
      return structuredClone(result);
    });
  }

  async start() {
    await this.mutate(async (ledger) => {
      for (const job of ledger.jobs) {
        if (job.cleanup) {
          await terminateJobProcess(job.cleanup);
          delete job.cleanup;
        } else if (job.owner?.process && job.owner.instanceId !== this.instanceId)
          await terminateJobProcess(job.owner.process);
        if (job.state === "running") {
          if (job.owner?.instanceId === this.instanceId)
            throw new CliError("this service instance already owns a running job");
          job.state = "interrupted";
          job.error =
            "Service interrupted this attempt. Inspect its progress and explicitly retry.";
          job.updatedAt = new Date().toISOString();
        }
      }
    });
    this.kick();
  }

  private guide(name: string): string {
    const loaded = loadExplainer(this.ctx, name);
    if (!local(loaded.rel) || !realpathSync(loaded.abs).startsWith(this.ctx.root + sep))
      throw new CliError("job guide must stay inside its repository");
    return loaded.rel;
  }

  async list(name: string) {
    const guide = this.guide(name);
    return this.read()
      .jobs.filter((j) => j.scope.guide === guide)
      .map((job) => {
        if (job.result && job.owner) {
          const status = revisionStatus(this.ctx, job.input.revisionRunId);
          if (
            status?.state === "done" &&
            status.serviceJob?.id === job.id &&
            status.serviceJob.attemptId === job.owner.attemptId
          )
            job.result.accepted = true;
          else delete job.result.accepted;
        }
        return job;
      });
  }

  async get(name: string, id: string): Promise<Job> {
    uuid(id);
    const job = (await this.list(name)).find((j) => j.id === id);
    if (!job) throw new CliError("unknown job for this guide", 1, { status: 404 });
    return job;
  }

  private requireRunner() {
    if (!this.availability.available)
      throw new CliError(this.availability.reason ?? UNAVAILABLE, 1, { status: 503 });
  }

  async submit(name: string, submission: JobSubmission): Promise<Job> {
    uuid(submission.id);
    const ids = strings(submission.selectedRequestIds, "selectedRequestIds");
    if (!ids.length) throw new CliError("select at least one request ID");
    const include = strings(submission.include ?? [], "include");
    const guide = this.guide(name);
    const result = await this.mutate(async (ledger) => {
      if (this.closed) throw new CliError("Service job worker stopped.");
      const existing = ledger.jobs.find((j) => j.id === submission.id);
      if (existing) {
        if (
          existing.scope.guide !== guide ||
          JSON.stringify(existing.selectedRequestIds) !== JSON.stringify(ids) ||
          JSON.stringify(existing.scope.include) !== JSON.stringify(include)
        )
          throw new CliError("job ID already used for a different selection", 1, { status: 409 });
        return existing;
      }
      this.requireRunner();
      const selected = await selectRevision(this.ctx, resolve(this.ctx.root, guide), ids, include);
      const at = new Date().toISOString();
      const job: Job = {
        id: submission.id,
        scope: { kind: "revision", guide, include },
        selectedRequestIds: ids,
        input: {
          revisionRunId: selected.runId,
          expected: selected.expected,
          index: selected.index,
          requests: selected.requests.map(parseFeedbackRequest),
        },
        state: "queued",
        createdAt: at,
        updatedAt: at,
        attempt: 0,
        owner: null,
        progress: [],
        error: null,
        result: null,
      };
      ledger.jobs.push(job);
      return job;
    });
    this.kick();
    return result;
  }

  private async fresh(job: Job) {
    const loaded = loadExplainer(this.ctx, resolve(this.ctx.root, job.scope.guide));
    const ws = await openWorkspace(
      { ...this.ctx, indexOption: resolve(this.ctx.root, job.input.index) },
      {
        explainer: loaded,
        skipExplainerIndex: true,
        requireFreshIndex: true,
        deferStaleWarning: true,
      },
    );
    if (
      ws.stale ||
      !sameFeedbackContext(artifactIdentity(loaded.explainer, ws.index), job.input.expected)
    )
      throw new CliError(
        "job source or explanation changed; submit a new selection after reindexing",
      );
    const stored = readRequests(this.ctx.root);
    if (stored.error) throw new CliError(stored.error);
    for (const request of job.input.requests) {
      const saved = stored.requests.find((r) => r.id === request.id);
      if (
        !saved ||
        !sameFeedbackContent(saved, request) ||
        saved.outcome.revision !== request.outcome.revision
      )
        throw new CliError(`selected request ${request.id} changed; submit a new selection`);
    }
  }

  async retry(name: string, id: string, expectedAttempt: unknown): Promise<Job> {
    if (
      typeof expectedAttempt !== "number" ||
      !Number.isSafeInteger(expectedAttempt) ||
      expectedAttempt < 0
    )
      throw new CliError("retry requires a non-negative expectedAttempt from the inspected job");
    const selected = await this.get(name, id);
    const result = await this.mutate(async (ledger) => {
      const job = ledger.jobs.find((j) => j.id === selected.id)!;
      if (expectedAttempt < job.attempt) return job;
      if (expectedAttempt > job.attempt)
        throw new CliError("retry expectedAttempt is ahead of this job", 1, { status: 409 });
      if (job.state === "queued" || job.state === "running") return job;
      if (job.state !== "failed" && job.state !== "interrupted")
        throw new CliError(`cannot retry ${job.state} job; submit a new selection`, 1, {
          status: 409,
        });
      this.requireRunner();
      await this.fresh(job);
      job.state = "queued";
      job.owner = null;
      job.error = null;
      job.result = null;
      job.updatedAt = new Date().toISOString();
      return job;
    });
    this.kick();
    return result;
  }

  /** Ledger ownership and attempt fence enclose #30's journal, guide and selected-outcome locks. */
  async review(name: string, id: string, action: JobReviewAction) {
    const selected = await this.get(name, id);
    uuid(action.attemptId);
    return this.mutate(async (ledger) => {
      const job = ledger.jobs.find((j) => j.id === selected.id)!;
      if (job.state !== "completed" || !job.result || !job.owner)
        throw new CliError(`cannot review ${job.state} job`, 1, { status: 409 });
      if (job.owner.attemptId !== action.attemptId)
        throw new CliError("job attempt changed; reload its review", 1, { status: 409 });
      const decisions =
        action.decisions === undefined
          ? undefined
          : join(dirname(this.path), `decisions-${job.owner.attemptId}.json`);
      if (decisions) await atomicWrite(decisions, jsonFile(action.decisions));
      return continueRevision(
        this.ctx,
        resolve(this.ctx.root, job.scope.guide),
        job.result.revisionRunId,
        {
          ...(decisions ? { decisions } : {}),
          accept: action.accept,
          reviewToken: action.reviewToken,
          serviceJob: { id: job.id, attemptId: job.owner.attemptId },
          assertCurrent: () => this.assertOwner(),
        },
      );
    });
  }

  async fence(name: string, id: string, state: "cancelled" | "superseded"): Promise<Job> {
    const selected = await this.get(name, id);
    const result = await this.mutate(async (ledger) => {
      const job = ledger.jobs.find((j) => j.id === selected.id)!;
      if (job.state === "cancelled" || job.state === "superseded") return job;
      const revision = revisionStatus(this.ctx, job.input.revisionRunId);
      if (revision && ["committing", "committed", "done"].includes(revision.state))
        throw new CliError(
          "acceptance has started; recover acceptance before submitting new work",
          1,
          { status: 409 },
        );
      if (this.active?.id === id) this.active.abort.abort();
      if (job.cleanup) return job; // A terminal fence cannot erase an unresolved cleanup barrier.
      if (job.state === "running" && !(await this.drain(job))) return job;
      job.state = state;
      job.result = null;
      job.error = null;
      job.updatedAt = new Date().toISOString();
      return job;
    });
    if (this.active?.id === id) this.active.abort.abort();
    return result;
  }

  private kick() {
    if (!this.availability.available) return;
    this.wake = true;
    if (this.pumping) return;
    this.pumping = this.pump()
      .catch((error) => {
        this.fatal = `Job scheduler stopped: ${errorMessage(error)} Inspect service state and restart after recovery.`;
      })
      .finally(() => {
        this.pumping = undefined;
        if (this.wake) this.kick();
      });
  }

  private async drain(job: Job): Promise<boolean> {
    if (!job.owner?.process) return true;
    try {
      await terminateJobProcess(job.owner.process);
      return true;
    } catch (error) {
      this.cleanupFailed(job, error);
      return false;
    }
  }

  private cleanupFailed(job: Job, error: unknown) {
    if (!(error instanceof CliError) || error.extra.code !== "JOB_PROCESS_CLEANUP") throw error;
    const groupId = error.extra.groupId ?? job.owner?.process?.groupId;
    const startTime = error.extra.startTime ?? job.owner?.process?.startTime;
    job.cleanup = {
      ...(typeof groupId === "number" ? { groupId } : {}),
      ...(typeof startTime === "string" ? { startTime } : {}),
    };
    job.state = "failed";
    job.result = null;
    job.error = errorMessage(error).slice(0, 5000);
    job.updatedAt = new Date().toISOString();
    this.fatal = `Job scheduler stopped: ${job.error} Inspect service state and restart after recovery.`;
  }

  private async pump() {
    while (this.availability.available) {
      this.wake = false;
      const job = await this.mutate((ledger) => {
        if (!this.availability.available) return undefined;
        if (ledger.jobs.some((j) => j.state === "running")) return undefined;
        const next = ledger.jobs.find((j) => j.state === "queued");
        if (!next) return undefined;
        next.state = "running";
        next.attempt++;
        next.owner = { instanceId: this.instanceId, attemptId: randomUUID() };
        next.updatedAt = new Date().toISOString();
        return next;
      });
      if (!job) return;
      const abort = new AbortController();
      this.active = { id: job.id, abort };
      const update = async (change: (current: Job) => void | Promise<void>) => {
        if (this.closed) return false;
        return this.mutate(async (ledger) => {
          const current = ledger.jobs.find((j) => j.id === job.id)!;
          if (
            current.state !== "running" ||
            current.owner?.instanceId !== this.instanceId ||
            current.owner.attemptId !== job.owner!.attemptId
          )
            return false;
          await change(current);
          current.updatedAt = new Date().toISOString();
          return true;
        });
      };
      try {
        await this.fresh(job);
        // Cancellation can win the claim before the invocation's abort controller exists.
        if (this.closed || (await this.get(job.scope.guide, job.id)).state !== "running") continue;
        const result = await this.runner!(
          structuredClone(job),
          abort.signal,
          async (message) => {
            if (typeof message !== "string" || !message.trim() || message.length > 2000)
              throw new CliError("progress must be non-empty text of at most 2000 characters");
            await update((current) => {
              current.progress.push({ at: new Date().toISOString(), message });
              current.progress = current.progress.slice(-100);
            });
          },
          async (process) => {
            abort.signal.throwIfAborted();
            if (
              !(await update((current) => {
                current.owner!.process = process;
              }))
            )
              throw new CliError("Claude attempt no longer owns this job; process discarded.");
          },
        );
        if (record(result).revisionRunId !== job.input.revisionRunId)
          throw new CliError("runner result does not match the selected revision");
        await update(async (current) => {
          if (result.proposals !== undefined) {
            const proposal = join(dirname(this.path), `proposal-${job.owner!.attemptId}.json`);
            await atomicWrite(proposal, jsonFile(result.proposals));
            const review = await continueRevision(
              this.ctx,
              resolve(this.ctx.root, job.scope.guide),
              job.input.revisionRunId,
              {
                proposal,
                serviceJob: { id: job.id, attemptId: job.owner!.attemptId },
                assertCurrent: () => {
                  this.assertOwner();
                  abort.signal.throwIfAborted();
                },
              },
            );
            if (!review.readiness?.ready)
              throw new CliError(
                "Claude proposal is not ready for review; inspect xpl revise --run and repair the reported readiness blockers.",
              );
          }
          current.state = "completed";
          current.result = { revisionRunId: job.input.revisionRunId };
        });
      } catch (error) {
        await update((current) => {
          if (error instanceof CliError && error.extra.code === "JOB_PROCESS_CLEANUP") {
            this.cleanupFailed(current, error);
            return;
          }
          current.state = "failed";
          current.error = errorMessage(error).slice(0, 5000);
        });
      } finally {
        this.active = undefined;
      }
    }
  }

  async close() {
    await this.mutate(async (ledger) => {
      this.closed = true;
      this.active?.abort.abort();
      for (const job of ledger.jobs)
        if (job.state === "running" && job.owner?.instanceId === this.instanceId) {
          if (!(await this.drain(job))) continue;
          job.state = "interrupted";
          job.error = "Service stopped during this attempt. Explicitly retry after restart.";
          job.updatedAt = new Date().toISOString();
        }
    });
    this.active?.abort.abort();
  }
}

export async function openJobs(ctx: Ctx, instanceId: string, runner?: JobRunner) {
  const root = realpathSync(ctx.root);
  // Jobs resolve repository-owned paths, rather than command-line paths relative to the caller.
  ctx = { ...ctx, root, cwd: root };
  uuid(instanceId);
  const jobs = new RepositoryJobs(ctx, instanceId, runner);
  await jobs.start();
  return jobs;
}
