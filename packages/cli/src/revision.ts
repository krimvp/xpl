/** Explicit revision journals join a reviewed artifact commit to selected, retryable feedback outcomes. */
import { randomUUID } from "node:crypto";
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
  referencedFiles,
  reresolveExplainer,
  sameFeedbackContent,
  sameFeedbackContext,
  type ArtifactIdentity,
  type Explainer,
  type ExplainerPatch,
  type FeedbackRequest,
  type FeedbackStatus,
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
  withFileLock,
} from "./fsutil.js";
import { loadExplainer, openWorkspace, type LoadedExplainer, type Workspace } from "./repo.js";
import { readRequests, recordOutcomes } from "./requests.js";

interface Proposal {
  id: string;
  patch: ExplainerPatch;
}
interface Decision {
  id: string;
  status: Exclude<FeedbackStatus, "pending">;
  reason: string;
  /** Required when accepting a request whose original snapshot differs. */
  reconciliation?: string;
  /** Explicit author permission for these missing-anchor owners to be repaired or removed. */
  missing?: { id: string; action: "reanchor" | "remove" }[];
}
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
  decisions: Decision[];
  next?: Explainer;
  nextIdentity?: ArtifactIdentity;
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

function boundedPatch(revision: Revision, proposal: Proposal): void {
  const request = selected(revision, proposal.id);
  const allowed = new Set([request.elementId, ...revision.include]);
  const patch = proposal.patch;
  if (patch.title !== undefined || patch.scope !== undefined)
    throw new CliError("revision patches cannot change the guide title or audience");
  const ids = [
    ...[patch.nodes, patch.edges, patch.concepts, patch.views, patch.tours].flatMap((items) =>
      items === undefined ? [] : array(items).map((item) => nonempty(object(item).id, "patch ID")),
    ),
    ...(patch.remove === undefined
      ? []
      : array(patch.remove).map((id) => nonempty(id, "remove ID"))),
  ];
  for (const id of ids) {
    // A selected step may be updated through its enclosing view/tour, but only that step.
    const view = patch.views?.find((v) => v.id === id);
    const tour = patch.tours?.find((t) => t.id === id);
    const updates = view && "stepsUpdate" in view ? view.stepsUpdate : tour?.stepsUpdate;
    const stepOnly =
      updates?.length &&
      Object.keys(view ?? tour!).every((k) => ["id", "type", "stepsUpdate"].includes(k)) &&
      updates.every((step) => allowed.has(step.id) || allowed.has(`${id}/${step.id}`));
    if (!allowed.has(id) && !stepOnly)
      throw new CliError(
        `patch for ${proposal.id} changes ${id} outside its selected scope; explicitly select it with --include in a new run`,
      );
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
    boundedPatch(revision, proposal);
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
) {
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
    source: revision.source,
    issues,
    ...(readiness ? { readiness } : {}),
  };
}

/** Proposals and decisions are reviews only. Acceptance publishes the exact reviewed candidate. */
export async function continueRevision(
  ctx: Ctx,
  name: string,
  runId: string,
  action: { proposal?: string; decisions?: string; accept?: boolean },
) {
  await assertRevisionLocation(ctx, runId);
  const path = pathFor(ctx, runId);
  return withFileLock(path, async () => {
    const revision = readRevision(ctx, name, runId);
    if (action.accept) return accept(ctx, name, revision);
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
    if (action.proposal || action.decisions) {
      revision.source = sourceFor(revision, next, ws);
      await atomicWrite(path, jsonFile(revision));
    }
    return packet(ctx, revision, next, readiness, issues);
  });
}

async function accept(ctx: Ctx, name: string, revision: Revision) {
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
        if (publish) {
          revision.state = "committing";
          await atomicWrite(path, jsonFile(revision));
          if (changed) await save(reviewedNext);
        }
        revision.state = "committed";
        await atomicWrite(path, jsonFile(revision));
      },
    );
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
