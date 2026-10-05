/** Explicit revision journals join a reviewed artifact commit to selected, retryable feedback outcomes. */
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { repositoryDirectoryIdentities } from "@xpl/indexer";
import {
  applyPatch,
  artifactIdentity,
  baseFileOf,
  basePathOf,
  checkReadiness,
  collectAnchors,
  feedbackContextReason,
  parseFeedbackRequest,
  parseId,
  referencedFiles,
  reresolveExplainer,
  sameFeedbackContent,
  sameFeedbackContext,
  type ArtifactIdentity,
  type Explainer,
  type ExplainerPatch,
  type FeedbackRequest,
  type RevisionDecision,
  type RevisionReview,
  type Issue,
  type ReadinessReport,
  type ResolveReport,
} from "@xpl/core";
import type { Ctx } from "./context.js";
import { withLockedExplainer } from "./commands/apply.js";
import { CliError } from "./errors.js";
import {
  atomicWrite,
  displayPath,
  jsonFile,
  parseJson,
  readTextFile,
  withRepositoryLock,
} from "./fsutil.js";
import { loadExplainer, openWorkspace, type LoadedExplainer, type Workspace } from "./repo.js";
import { readRequests, recordOutcomes } from "./requests.js";

interface Proposal {
  id: string;
  patch: ExplainerPatch;
}
type Decision = RevisionDecision;
interface Revision {
  schema: "code-explainer/revision@1";
  runId: string;
  explainer: string;
  state: "selected" | "proposed" | "reviewed" | "committing" | "committed" | "done";
  expected: ArtifactIdentity;
  index: string;
  previous: Explainer;
  resolved: Explainer;
  resolve: ResolveReport;
  requests: FeedbackRequest[];
  include: string[];
  proposals: Proposal[];
  proposalChanges?: RevisionReview["proposals"];
  /** Service proposals need the guarded job acceptance path, never independent manual acceptance. */
  serviceJob?: { id: string; attemptId: string };
  decisions: Decision[];
  next?: Explainer;
  nextIdentity?: ArtifactIdentity;
  sourceBefore?: { file: string; side: "head" | "base"; text: string | null }[];
  source: { file: string; side: "head" | "base"; text: string | null }[];
}

function pathFor(ctx: Ctx, runId: string): string {
  if (!/^[a-zA-Z0-9_-]{1,100}$/.test(runId)) throw new CliError("invalid revision run ID");
  return join(ctx.root, ".explainer", "revisions", runId, "run.json");
}
async function assertRevisionLocation(ctx: Ctx, runId?: string): Promise<void> {
  const sourceDirectories = await repositoryDirectoryIdentities(ctx.root);
  const directory = join(ctx.root, ".explainer");
  for (const path of [
    directory,
    join(directory, "revisions"),
    ...(runId ? [join(directory, "revisions", runId)] : []),
  ]) {
    try {
      const info = await stat(path, { bigint: true });
      const alias = sourceDirectories.get(`${info.dev}:${info.ino}`);
      if (alias !== undefined)
        throw new CliError(
          `${displayPath(ctx.root, path)} aliases repository directory ${alias}; revision journals cannot be written into source`,
        );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
  }
}
function input(ctx: Ctx, file: string): unknown {
  const path = resolve(ctx.cwd, file);
  return parseJson(readTextFile(path, "revision input"), path);
}
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new CliError("expected an object");
  return value as Record<string, unknown>;
}
function array(value: unknown): unknown[] {
  if (!Array.isArray(value)) throw new CliError("revision input must be a JSON array");
  return value;
}
function nonempty(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim() || value.length > 5000)
    throw new CliError(`${field} must be non-empty text of at most 5000 characters`);
  return value;
}
function selected(revision: Revision, id: unknown): FeedbackRequest {
  const request = revision.requests.find((r) => r.id === id);
  if (!request) throw new CliError(`unknown selected request ID ${String(id)}`);
  return request;
}
function unique(ids: string[]): void {
  if (new Set(ids).size !== ids.length) throw new CliError("duplicate selected request IDs");
}
function queue(ctx: Ctx): FeedbackRequest[] {
  const { requests, error } = readRequests(ctx.root);
  if (error) throw new CliError(error);
  return requests;
}

async function freshWorkspace(
  ctx: Ctx,
  loaded: LoadedExplainer,
  index?: string,
): Promise<Workspace> {
  const ws = await openWorkspace(index ? { ...ctx, indexOption: index } : ctx, {
    explainer: loaded,
    skipExplainerIndex: true,
    deferStaleWarning: true,
    requireFreshIndex: true,
  });
  if (ws.stale)
    throw new CliError(
      `${ws.stale.message} Reindex and start a new revision selection; existing requests remain retryable.`,
    );
  return ws;
}

/** Selection does not modify the guide. The old artifact and original requests remain in the journal. */
export async function selectRevision(ctx: Ctx, name: string, ids: string[], include: string[]) {
  await assertRevisionLocation(ctx);
  unique(ids);
  if (!ids.length || ids.some((id) => !id))
    throw new CliError("select at least one immutable request ID");
  return withLockedExplainer(ctx, name, async (loaded) => {
    const ws = await freshWorkspace(ctx, loaded);
    const stored = queue(ctx);
    const requests = ids.map((id) => {
      const request = stored.find((r) => r.id === id);
      if (!request || (request.explainer !== undefined && request.explainer !== loaded.name))
        throw new CliError(`unknown selected request ID ${id} for ${loaded.name}`);
      return request;
    });
    const { explainer: resolved, report } = reresolveExplainer(
      loaded.explainer,
      ws.model,
      ws.texts,
      { indexPath: ws.indexRel },
    );
    const revision: Revision = {
      schema: "code-explainer/revision@1",
      runId: randomUUID(),
      explainer: loaded.rel,
      state: "selected",
      expected: artifactIdentity(loaded.explainer, ws.index),
      index: ws.indexRel,
      previous: loaded.explainer,
      resolved,
      resolve: report,
      requests,
      include,
      proposals: [],
      decisions: [],
      source: [],
    };
    revision.source = sourceFor(revision, resolved, ws);
    revision.sourceBefore = sourceFor(revision, revision.previous, ws);
    const path = pathFor(ctx, revision.runId);
    await atomicWrite(join(path, "..", "previous.json"), jsonFile(loaded.explainer));
    await atomicWrite(path, jsonFile(revision));
    return packet(ctx, revision, resolved);
  });
}

function readRevision(ctx: Ctx, name: string, runId: string): Revision {
  const path = pathFor(ctx, runId);
  const data = object(parseJson(readTextFile(path, "revision journal"), path));
  if (
    data.schema !== "code-explainer/revision@1" ||
    data.runId !== runId ||
    data.explainer !== loadExplainer(ctx, name).rel
  )
    throw new CliError("revision journal does not match this guide and run");
  const revision = data as unknown as Revision;
  revision.requests = array(data.requests).map(parseFeedbackRequest);
  unique(revision.requests.map((r) => r.id));
  return revision;
}

function proposals(ctx: Ctx, revision: Revision, file: string): Proposal[] {
  const result = array(input(ctx, file)).map((value) => {
    const data = object(value);
    const request = selected(revision, data.id);
    return { id: request.id, patch: object(data.patch) as ExplainerPatch };
  });
  unique(result.map((p) => p.id));
  return result;
}
function decisions(ctx: Ctx, revision: Revision, file: string): Decision[] {
  const result = array(input(ctx, file)).map((value) => {
    const data = object(value);
    const request = selected(revision, data.id);
    const status = nonempty(data.status, "status");
    if (!["addressed", "rejected", "unresolved", "outdated"].includes(status))
      throw new CliError("decision status must be addressed, rejected, unresolved or outdated");
    parseFeedbackRequest({
      ...request,
      outcome: { ...request.outcome, status, reason: data.reason },
    });
    return {
      id: request.id,
      status: status as Decision["status"],
      reason: nonempty(data.reason, "reason"),
      ...(data.reconciliation !== undefined
        ? { reconciliation: nonempty(data.reconciliation, "reconciliation") }
        : {}),
      ...(data.missing !== undefined
        ? {
            missing: array(data.missing).map(
              (value): { id: string; action: "reanchor" | "remove" } => {
                const repair = object(value);
                if (repair.action !== "reanchor" && repair.action !== "remove")
                  throw new CliError("missing anchor action must be reanchor or remove");
                return { id: nonempty(repair.id, "missing owner ID"), action: repair.action };
              },
            ),
          }
        : {}),
    };
  });
  unique(result.map((d) => d.id));
  if (result.length !== revision.requests.length)
    throw new CliError(
      "provide one decision per selected request; leave unresolved requests retryable with a reason",
    );
  return result;
}

const patchLists = ["nodes", "edges", "concepts", "views", "tours"] as const;
type ScopeTarget = [string, string] | [string, string, string];

/** Resolve public IDs to their collection and container; never infer scope from a tour's local IDs. */
function scopeTarget(explainer: Explainer, id: string, view?: string): ScopeTarget {
  const slash = id.indexOf("/");
  if (slash !== -1 && (id.startsWith("view:") || id.startsWith("tour:")))
    return [id.startsWith("view:") ? "views" : "tours", id.slice(0, slash), id.slice(slash + 1)];
  switch (parseId(id).type) {
    case "repo":
    case "dir":
    case "file":
    case "symbol":
    case "group":
      return ["nodes", id];
    case "edge":
    case "derived-edge":
      return ["edges", id];
    case "concept":
      return ["concepts", id];
    case "view":
      return ["views", id];
    case "tour":
      return ["tours", id];
    case "step": {
      const owners = explainer.views.filter(
        (v) => (v.type === "flow" || v.type === "sequence") && v.steps.some((s) => s.id === id),
      );
      // Reading context can identify a selected step's owner, but cannot grant whole-view permission.
      const owner =
        owners.find((v) => v.id === view) ?? (owners.length === 1 ? owners[0] : undefined);
      if (!owner)
        throw new CliError(`step ${id} has no unique owner; use an explicit <view-id>/<step-id>`);
      return ["views", owner.id, id];
    }
    default:
      // Render-only or unknown selections need explicit --include IDs for patchable content.
      return ["unpatchable", id];
  }
}

function boundedPatch(revision: Revision, proposal: Proposal, current: Explainer): void {
  const request = selected(revision, proposal.id);
  const allowed = new Set([
    JSON.stringify(scopeTarget(revision.previous, request.elementId, request.view)),
    ...revision.include.map((id) => JSON.stringify(scopeTarget(revision.previous, id))),
  ]);
  const permits = (target: ScopeTarget) =>
    allowed.has(JSON.stringify(target)) ||
    (target.length === 3 && allowed.has(JSON.stringify(target.slice(0, 2))));
  const refuse = (id: string): never => {
    throw new CliError(
      `patch for ${proposal.id} changes ${id} outside its selected scope; explicitly select it with --include in a new run`,
    );
  };
  const patch = proposal.patch;
  if (patch.title !== undefined || patch.scope !== undefined)
    throw new CliError("revision patches cannot change the guide title or audience");
  for (const list of patchLists) {
    if (patch[list] === undefined) continue;
    for (const value of array(patch[list])) {
      const item = object(value);
      const id = nonempty(item.id, "patch ID");
      if (permits([list, id])) continue;
      // Every entry is checked in its actual collection, including repeated container IDs.
      const stepOnly =
        (list === "views" || list === "tours") &&
        Object.keys(item).every((k) => ["id", "type", "stepsUpdate"].includes(k)) &&
        Array.isArray(item.stepsUpdate) &&
        item.stepsUpdate.length > 0 &&
        item.stepsUpdate.every((step) => permits([list, id, nonempty(object(step).id, "step ID")]));
      if (!stepOnly) refuse(id);
    }
  }
  if (patch.remove !== undefined)
    for (const value of array(patch.remove)) {
      const id = nonempty(value, "remove ID");
      // Earlier proposals may move a step. Match the actual removal owner, not its old local ID.
      if (!permits(scopeTarget(current, id))) refuse(id);
    }
}

function candidate(
  revision: Revision,
  ws: Workspace,
  chosen: Proposal[],
  enforceDecisions: boolean,
) {
  let next = revision.resolved;
  const issues = [];
  for (const proposal of chosen) {
    boundedPatch(revision, proposal, next);
    const decision = revision.decisions.find((d) => d.id === proposal.id);
    if (enforceDecisions) {
      const request = selected(revision, proposal.id);
      if (feedbackContextReason(request, revision.expected) && !decision?.reconciliation)
        throw new CliError(
          `request ${request.id} has outdated context; the author must supply reconciliation in its decision`,
        );
    }
    const result = applyPatch(next, proposal.patch, ws.model, ws.texts, { actor: "llm" });
    if (!result.ok)
      throw new CliError("revision patch rejected; guide and outcomes unchanged", 1, {
        issues: result.issues,
      });
    if (result.changed.length === 0 && result.issues.some((i) => i.code === "protected"))
      throw new CliError(
        `patch for ${proposal.id} changes only protected user content; keep it unresolved`,
      );
    if (enforceDecisions) {
      const allOldSites = collectAnchors(next);
      const oldSites = allOldSites.filter((s) => s.anchor.resolved?.status === "missing");
      const newSites = collectAnchors(result.explainer);
      for (const site of oldSites) {
        const stillPresent = newSites.some(
          (s) =>
            s.elementId === site.elementId &&
            JSON.stringify(s.anchor) === JSON.stringify(site.anchor),
        );
        if (!stillPresent) {
          const beforeCount = allOldSites.filter((s) => s.elementId === site.elementId).length;
          const afterCount = newSites.filter((s) => s.elementId === site.elementId).length;
          const action = afterCount < beforeCount ? "remove" : "reanchor";
          if (!decision?.missing?.some((m) => m.id === site.elementId && m.action === action))
            throw new CliError(
              `missing anchor on ${site.elementId}: explicitly decide ${action} in decision.missing`,
            );
        }
      }
    }
    next = result.explainer;
    issues.push(...result.issues);
  }
  return { next, issues };
}

function owners(explainer: Explainer): Map<string, unknown> {
  return new Map([
    ...[
      explainer.nodes,
      explainer.edges,
      explainer.concepts,
      explainer.views,
      explainer.tours,
    ].flatMap((items) => items.map((item) => [item.id, item] as [string, unknown])),
    ["(index)", { index: explainer.index, repo: explainer.repo }],
  ]);
}
function sourceFor(revision: Revision, next: Explainer, ws: Workspace) {
  const sites = collectAnchors(next);
  const files = new Map<string, { file: string; side: "head" | "base" }>();
  for (const file of referencedFiles(next, ws.model))
    files.set(`head:${file}`, { file, side: "head" });
  for (const site of sites) {
    const side = site.anchor.at === "base" ? "base" : "head";
    files.set(`${side}:${site.anchor.file}`, { file: site.anchor.file, side });
  }
  for (const request of revision.requests)
    if (request.range) files.set(`${request.range.side}:${request.range.file}`, request.range);
  return [...files.values()].map(({ file, side }) => {
    const changedFile = next.change && baseFileOf(next.change, file);
    const basePath = changedFile ? basePathOf(changedFile) : file;
    const text =
      side === "base"
        ? next.change
          ? ws.texts.textAt(next.change.base, basePath)
          : undefined
        : ws.texts.text(file);
    return { file, side, text: text ?? null };
  });
}

function packet(
  ctx: Ctx,
  revision: Revision,
  next: Explainer,
  readiness?: ReadinessReport,
  issues: Issue[] = [],
  proposalChanges: RevisionReview["proposals"] = revision.proposalChanges ?? [],
): RevisionReview {
  const before = owners(revision.previous);
  const after = owners(next);
  const changes = [...new Set([...before.keys(), ...after.keys()])]
    .filter((id) => JSON.stringify(before.get(id)) !== JSON.stringify(after.get(id)))
    .map((id) => ({ id, before: before.get(id) ?? null, after: after.get(id) ?? null }));
  return {
    ok: true,
    runId: revision.runId,
    state: revision.state,
    expected: revision.expected,
    index: revision.index,
    previousArtifact: displayPath(
      ctx.root,
      join(pathFor(ctx, revision.runId), "..", "previous.json"),
    ),
    requests: revision.requests.map((request) => ({
      ...request,
      contextReason: feedbackContextReason(request, revision.expected) ?? null,
    })),
    include: revision.include,
    resolve: revision.resolve,
    decisions: revision.decisions,
    changes,
    proposals: proposalChanges,
    sourceBefore: revision.sourceBefore ?? revision.source,
    source: revision.source,
    issues,
    ...(readiness ? { readiness } : {}),
  };
}

/** Read-only recovery/fence receipt; no proposal engine lives in the job ledger. */
export function revisionStatus(
  ctx: Ctx,
  runId: string,
): Pick<Revision, "state" | "serviceJob"> | undefined {
  try {
    return object(
      parseJson(readTextFile(pathFor(ctx, runId), "revision journal"), "revision journal"),
    ) as unknown as Revision;
  } catch (error) {
    if (!existsSync(pathFor(ctx, runId))) return undefined;
    throw error;
  }
}

/** Proposals and decisions are reviews only. Acceptance publishes the exact reviewed candidate. */
export async function continueRevision(
  ctx: Ctx,
  name: string,
  runId: string,
  action: {
    proposal?: string;
    decisions?: string;
    accept?: boolean;
    assertCurrent?: () => void;
    serviceJob?: { id: string; attemptId: string };
  },
) {
  await assertRevisionLocation(ctx, runId);
  const path = pathFor(ctx, runId);
  return withRepositoryLock(ctx.root, path, async () => {
    const revision = readRevision(ctx, name, runId);
    action.assertCurrent?.();
    const matchingJob =
      revision.serviceJob &&
      action.serviceJob?.id === revision.serviceJob.id &&
      action.serviceJob.attemptId === revision.serviceJob.attemptId;
    const replacement = action.proposal && action.serviceJob?.id === revision.serviceJob?.id;
    if (
      revision.serviceJob &&
      (!matchingJob || !action.assertCurrent) &&
      !(!action.proposal && !action.decisions && !action.accept)
    ) {
      if (!(replacement && action.assertCurrent))
        throw new CliError(
          "Service job proposals require guarded job review; manual --accept cannot bypass cancellation or supersession.",
        );
    }
    if (action.serviceJob && !action.assertCurrent)
      throw new CliError("service job requires a current ownership guard");
    if (action.accept) return accept(ctx, name, revision, action.assertCurrent);
    if (
      ["committing", "committed", "done"].includes(revision.state) &&
      (action.proposal || action.decisions)
    )
      throw new CliError(
        "a committed decision cannot be edited; retry --accept or select a new run",
      );
    const loaded = loadExplainer(ctx, name);
    if (["committing", "committed", "done"].includes(revision.state)) {
      return packet(ctx, revision, revision.next ?? revision.resolved);
    }
    const ws = await freshWorkspace(ctx, loaded, revision.index);
    if (!sameFeedbackContext(artifactIdentity(loaded.explainer, ws.index), revision.expected))
      throw new CliError("explanation changed since selection; start a new revision run");
    if (action.proposal) {
      revision.proposals = proposals(ctx, revision, action.proposal);
      if (action.serviceJob) revision.serviceJob = action.serviceJob;
      revision.decisions = [];
      delete revision.next;
      delete revision.nextIdentity;
      revision.state = "proposed";
    }
    if (action.decisions) {
      revision.decisions = decisions(ctx, revision, action.decisions);
      revision.state = "reviewed";
    }
    const accepted = revision.decisions.filter((d) => d.status === "addressed");
    for (const decision of accepted)
      if (!revision.proposals.some((p) => p.id === decision.id))
        throw new CliError(
          `addressed request ${decision.id} needs a reviewed proposal (an empty patch allows location-only resolution)`,
        );
    const chosen = revision.decisions.length
      ? revision.proposals.filter((p) => accepted.some((d) => d.id === p.id))
      : revision.proposals;
    const { next: proposed, issues } = candidate(
      revision,
      ws,
      chosen,
      revision.decisions.length > 0,
    );
    // A declined batch records decisions without rebinding or changing an unfinished guide.
    const next = revision.decisions.length && !accepted.length ? revision.previous : proposed;
    const readiness = checkReadiness(next, ws.index, ws.texts, { scope: "workspace" });
    if (action.decisions) {
      revision.next = next;
      revision.nextIdentity = artifactIdentity(next, ws.index);
    }
    const perProposal = revision.proposals.map((proposal) => {
      const { next: one } = candidate(revision, ws, [proposal], false);
      return { id: proposal.id, changes: packet(ctx, revision, one).changes };
    });
    if (action.proposal || action.decisions) {
      revision.proposalChanges = perProposal;
      revision.source = sourceFor(revision, next, ws);
      action.assertCurrent?.();
      await atomicWrite(path, jsonFile(revision));
    }
    return packet(ctx, revision, next, readiness, issues, perProposal);
  });
}

async function accept(ctx: Ctx, name: string, revision: Revision, assertCurrent?: () => void) {
  if (revision.serviceJob && !assertCurrent)
    throw new CliError(
      "Service job proposals require guarded job acceptance; manual --accept cannot bypass cancellation or supersession. Inspect the review and wait for the job acceptance flow, or start a separate manual revision selection.",
    );
  const path = pathFor(ctx, revision.runId);
  if (
    !revision.next ||
    !revision.nextIdentity ||
    !["reviewed", "committing", "committed", "done"].includes(revision.state)
  )
    throw new CliError("review author decisions with --decisions before --accept");
  if (revision.state === "done") return packet(ctx, revision, revision.next);
  const reviewedNext = revision.next;
  const reviewedIdentity = revision.nextIdentity;
  return withLockedExplainer(ctx, name, async (loaded, save) => {
    assertCurrent?.();
    // A new workspace is mandatory: WorkingTree caches both text and discovered hashes.
    const ws = await openWorkspace(
      { ...ctx, indexOption: revision.index },
      {
        explainer: loaded,
        deferStaleWarning: true,
        requireFreshIndex: true,
        skipExplainerIndex: true,
      },
    );
    const current = artifactIdentity(loaded.explainer, ws.index);
    const alreadyWritten = sameFeedbackContext(current, reviewedIdentity);
    if (!sameFeedbackContext(artifactIdentity(reviewedNext, ws.index), reviewedIdentity))
      throw new CliError("reviewed candidate does not match its journal identity");
    const accepted = revision.decisions.filter((d) => d.status === "addressed");
    const changed = !sameFeedbackContext(revision.expected, reviewedIdentity);
    let publish = false;
    if (revision.state === "reviewed" || (revision.state === "committing" && !alreadyWritten)) {
      if (!sameFeedbackContext(current, revision.expected))
        throw new CliError(
          "explanation or indexed source changed since review; select a new revision run",
        );
      if (ws.stale)
        throw new CliError(
          `${ws.stale.message} Reconcile in a new revision run before acceptance.`,
        );
      const latest = queue(ctx);
      for (const request of revision.requests) {
        const saved = latest.find((r) => r.id === request.id);
        if (
          !saved ||
          !sameFeedbackContent(saved, request) ||
          saved.outcome.revision !== request.outcome.revision
        )
          throw new CliError(
            `selected request ${request.id} changed since review; select a new revision run`,
          );
      }
      const { next } = candidate(
        revision,
        ws,
        revision.proposals.filter((p) => accepted.some((d) => d.id === p.id)),
        true,
      );
      if (
        accepted.length &&
        !sameFeedbackContext(artifactIdentity(next, ws.index), reviewedIdentity)
      )
        throw new CliError("candidate changed since review; inspect a new revision run");
      const readiness = checkReadiness(reviewedNext, ws.index, ws.texts, { scope: "workspace" });
      if ((accepted.length || changed) && !readiness.ready)
        throw new CliError("next revision is not ready; requests remain retryable", 1, {
          readiness,
        });
      publish = true;
    } else if (changed && !alreadyWritten) {
      throw new CliError(
        "artifact changed after the committed revision; refusing to overwrite it during recovery",
      );
    }
    await recordOutcomes(
      ctx.root,
      revision.decisions.map((decision) => {
        const request = selected(revision, decision.id);
        return {
          id: request.id,
          context: request.context,
          status: decision.status,
          reason: decision.reason,
          expectedRevision: request.outcome.revision,
        };
      }),
      async () => {
        assertCurrent?.();
        if (publish) {
          revision.state = "committing";
          await atomicWrite(path, jsonFile(revision));
          assertCurrent?.();
          if (changed) await save(reviewedNext);
        }
        revision.state = "committed";
        await atomicWrite(path, jsonFile(revision));
      },
    );
    assertCurrent?.();
    revision.state = "done";
    await atomicWrite(path, jsonFile(revision));
    return packet(
      ctx,
      revision,
      reviewedNext,
      checkReadiness(reviewedNext, ws.index, ws.texts, {
        scope: "workspace",
        ...(ws.stale ? { sourceWarning: ws.stale.message } : {}),
      }),
    );
  });
}
