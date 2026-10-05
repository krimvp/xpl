/** Frozen question inputs and source evidence; answering never opens or accepts a revision. */
import { resolve } from "node:path";
import {
  artifactIdentity,
  basePathOf,
  baseVersionFiles,
  collectAnchors,
  codeFocus,
  referencedFiles,
  ExplainerModel,
  feedbackContextReason,
  hashText,
  parseAnswerSources,
  sameFeedbackContext,
  splitLines,
  type ArtifactIdentity,
  type Explainer,
  type FeedbackRequest,
  type RecordedAnswerSource,
} from "@xpl/core";
import type { Ctx } from "./context.js";
import { CliError } from "./errors.js";
import { withLockedExplainer } from "./commands/apply.js";
import { loadExplainer, openWorkspace } from "./repo.js";
import { freshAnchors } from "./bundle-data.js";
import { readRequests } from "./requests.js";

export interface AnswerInput {
  expected: ArtifactIdentity;
  index: string;
  request: FeedbackRequest;
  guide: Explainer;
  sources: RecordedAnswerSource[];
}

export async function selectAnswer(
  ctx: Ctx,
  name: string,
  requestId: string,
): Promise<AnswerInput> {
  return withLockedExplainer(ctx, name, async (loaded) => {
    const ws = await openWorkspace(ctx, {
      explainer: loaded,
      skipExplainerIndex: true,
      requireFreshIndex: true,
      deferStaleWarning: true,
    });
    if (ws.stale) throw new CliError("question source is stale; reindex before submitting");
    const stored = readRequests(ctx.root);
    if (stored.error) throw new CliError(stored.error);
    const request = stored.requests.find((r) => r.id === requestId);
    if (!request || (request.explainer !== undefined && request.explainer !== loaded.name))
      throw new CliError("unknown question request for this guide");
    // Live feedback identifies the re-resolved page, while offline CLI feedback may name the stored guide.
    const viewed = freshAnchors(loaded.explainer, ws.model, ws.texts).explainer;
    const guide = sameFeedbackContext(request.context, artifactIdentity(viewed, ws.index))
      ? viewed
      : loaded.explainer;
    const expected = artifactIdentity(guide, ws.index);
    const reason = feedbackContextReason(request, expected);
    if (reason) throw new CliError(reason);
    if (request.kind !== "explain" || !request.note?.trim())
      throw new CliError("answer jobs require an explain request with a question note");
    const model = new ExplainerModel(guide, ws.model);
    if (!request.range && !model.element(request.elementId))
      throw new CliError("question element no longer exists; select an element or source range");
    const files = new Set(referencedFiles(guide, ws.model));
    for (const focus of codeFocus([request.elementId], model)) files.add(focus.file);
    if (request.range?.side === "head") files.add(request.range.file);
    const sources: RecordedAnswerSource[] = [];
    for (const path of [...files].sort()) {
      const file = ws.model.file(path);
      if (!file) {
        if (request.range?.side === "head" && request.range.file === path)
          throw new CliError(`question source is not indexed: ${path}`);
        continue; // A base-only anchor's path is captured from the recorded commit below.
      }
      const text = ws.texts.text(file.path);
      if (text === undefined || hashText(text) !== file.hash)
        throw new CliError(`question source changed or is unavailable: ${file.path}`);
      sources.push({ file: file.path, side: "head", text, hash: file.hash });
    }
    const baseFiles = new Set<string>();
    for (const site of collectAnchors(guide))
      if (site.anchor.at === "base") baseFiles.add(site.anchor.file);
    for (const file of baseVersionFiles(guide.change)) baseFiles.add(basePathOf(file));
    if (request.range?.side === "base") baseFiles.add(request.range.file);
    for (const file of baseFiles) {
      const change = guide.change;
      if (!change) throw new CliError("base question requires a recorded change");
      const renamed = change.files.find((f) => f.path === file && f.status === "renamed");
      const path = renamed ? basePathOf(renamed) : file;
      const text = ws.texts.textAt(change.base, path);
      if (text === undefined) throw new CliError(`base question source is unavailable: ${file}`);
      sources.push({ file, side: "base", text, hash: hashText(text) });
    }
    if (request.range) {
      const range = request.range;
      const source = sources.find((s) => s.file === range.file && s.side === range.side);
      if (!source || range.toLine > splitLines(source.text).length)
        throw new CliError("question range is outside recorded source");
    }
    const input = {
      expected,
      index: ws.indexRel,
      request,
      guide,
      sources: parseAnswerSources(sources),
    };
    if (Buffer.byteLength(JSON.stringify(input)) > 5_000_000)
      throw new CliError("question snapshot exceeds 5 MB; use a smaller repository scope");
    const checked = await openWorkspace(ctx, {
      explainer: loaded,
      skipExplainerIndex: true,
      requireFreshIndex: true,
      deferStaleWarning: true,
    });
    if (checked.stale || !sameFeedbackContext(expected, artifactIdentity(guide, checked.index)))
      throw new CliError("question source changed during capture; reindex and submit again");
    return input;
  });
}

/** Re-evaluate freshness without rebinding or discarding an answer to an older snapshot. */
export async function answerContextReason(
  ctx: Ctx,
  guide: string,
  input: AnswerInput,
): Promise<string | null> {
  try {
    const loaded = loadExplainer(ctx, resolve(ctx.root, guide));
    const ws = await openWorkspace(
      { ...ctx, indexOption: undefined },
      {
        explainer: loaded,
        skipExplainerIndex: true,
        requireFreshIndex: true,
        deferStaleWarning: true,
      },
    );
    const viewed = freshAnchors(loaded.explainer, ws.model, ws.texts).explainer;
    const identities = [loaded.explainer, viewed].map((guide) => artifactIdentity(guide, ws.index));
    return identities.some((identity) => sameFeedbackContext(input.expected, identity))
      ? (ws.stale?.message ?? null)
      : (feedbackContextReason(input.request, identities[1]!) ?? ws.stale?.message ?? null);
  } catch {
    return "Current source or explanation is unavailable; answer retains its original snapshot.";
  }
}
