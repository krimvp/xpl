/** Poll discovery and content, wait for quiet, build from captured inputs, and fence publication. */
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { TextCache, asIndexModel } from "@xpl/core";
import { buildIndex, captureIndexInputs, indexInputsChanged, writeIndex } from "@xpl/indexer";
import type { Ctx } from "./context.js";
import { errorMessage } from "./errors.js";
import { atomicWrite, displayPath, jsonFile, withRepositoryLock } from "./fsutil.js";
import { gitShowReader } from "./git.js";
import { guideInventory } from "./inventory.js";
import { scipInputPaths, scipProviders } from "./index-options.js";
import { readWatchState, indexDigest, type WatchState } from "./watch-state.js";
import { openWorkspace } from "./repo.js";

export async function watchRepository(
  ctx: Ctx,
  options: {
    instanceId: string;
    precise: "auto" | "off" | "require";
    scip: string | null;
    signal: AbortSignal;
    terminalState?: () => "paused" | "stopped";
  },
): Promise<void> {
  const path = join(ctx.root, ".explainer/service/watch.json");
  const previous = readWatchState(ctx.root);
  const initial = await openWorkspace(ctx, { skipExplainerIndex: true, skipFreshnessCheck: true });
  const state: WatchState = {
    schema: "xpl-watch@1",
    root: ctx.root,
    instanceId: options.instanceId,
    state: "pending",
    stale: true,
    generation: previous?.generation ?? 0,
    index: { path: initial.indexRel, commit: initial.index.commit },
    indexDigest: indexDigest(initial.index),
    fingerprint: null,
    scip: options.scip,
    precise: options.precise,
    error: null,
  };
  const save = () => withRepositoryLock(ctx.root, path, () => atomicWrite(path, jsonFile(state)));
  const capture = () =>
    captureIndexInputs({
      root: ctx.root,
      precise: options.precise,
      inputPaths: scipInputPaths(options.scip),
      ...(options.scip ? { providers: scipProviders(options.scip) } : {}),
    });
  let polled: Awaited<ReturnType<typeof captureIndexInputs>> | undefined;
  let observed: string | undefined;
  let attempted: string | undefined;
  let quietAt = Date.now();
  await save();
  try {
    while (!options.signal.aborted) {
      try {
        if (!polled || (await indexInputsChanged(polled))) polled = await capture();
        const inputs = polled;
        if (observed !== inputs.revision) {
          observed = inputs.revision;
          quietAt = Date.now();
          // A touch alone does not rebuild an already checked snapshot.
          if (state.fingerprint !== inputs.fingerprint || state.stale) {
            state.state = "pending";
            state.stale = true;
            state.error = null;
            await save();
          }
        }
        if (state.stale && inputs.revision !== attempted && Date.now() - quietAt >= 300) {
          attempted = inputs.revision;
          state.state = "building";
          state.error = null;
          await save();
          const result = await buildIndex({
            root: ctx.root,
            precise: options.precise,
            snapshot: inputs,
            ...(options.scip ? { providers: scipProviders(options.scip) } : {}),
          });
          const after = await capture();
          if (options.signal.aborted) break;
          if (after.revision !== inputs.revision) {
            state.state = "pending";
            state.stale = true;
            await save();
            continue;
          }
          // Readers get one complete index. The pointer becomes current only after it exists.
          const indexPath = join(ctx.root, ".explainer", `index-${result.index.commit}.json`);
          const published = await withRepositoryLock(ctx.root, indexPath, async () => {
            const published = await withRepositoryLock(
              ctx.root,
              join(ctx.root, ".explainer/.gitignore"),
              () =>
                withRepositoryLock(ctx.root, path, async () => {
                  if (options.signal.aborted) return undefined;
                  const final = await capture();
                  if (final.revision !== inputs.revision || options.signal.aborted)
                    return undefined;
                  const published = await writeIndex(ctx.root, result.index);
                  state.index = {
                    path: displayPath(ctx.root, published),
                    commit: result.index.commit,
                  };
                  state.indexDigest = indexDigest(result.index);
                  state.fingerprint = inputs.fingerprint;
                  state.generation++;
                  state.state = "current";
                  state.stale = false;
                  state.error = null;
                  await atomicWrite(path, jsonFile(state));
                  return published;
                }),
            );
            return published;
          });
          if (!published) {
            state.state = "pending";
            state.stale = true;
            await save();
            continue;
          }
          for (const warning of result.warnings) ctx.warn(warning);
          const guides = guideInventory(
            ctx,
            asIndexModel(result.index),
            new TextCache((p) => inputs.texts.get(p), gitShowReader(ctx.root)),
          );
          if (ctx.json) ctx.emit({ watch: state, guides });
          else
            ctx.out(
              [
                `watch ${state.state}: index ${state.index?.commit ?? "none"}; ${guides.filter((g) => g.attention).length} guides need attention (xpl status --all)`,
                ...guides.map((g) =>
                  g.error
                    ? `${g.name}: ${g.error}`
                    : `${g.name}: ${g.anchors!.counts.moved} moved, ${g.anchors!.counts.drifted} drifted, ${g.anchors!.counts.missing} missing`,
                ),
              ].join("\n"),
            );
        }
      } catch (error) {
        const message = errorMessage(error);
        const changed = state.state !== "failed" || state.error !== message;
        state.state = "failed";
        state.stale = true;
        state.error = message;
        if (changed) {
          await save();
          ctx.warn(`watch failed; last snapshot is out of date: ${state.error}`);
        }
      }
      await delay(500, undefined, { signal: options.signal }).catch(() => undefined);
    }
  } finally {
    if (!state.stale) {
      try {
        state.stale = (await capture()).fingerprint !== state.fingerprint;
      } catch (error) {
        state.stale = true;
        state.error = errorMessage(error);
      }
    }
    state.state = options.terminalState?.() ?? "stopped";
    if (state.state === "paused") state.stale = true;
    // Stopping during a pending/failed build retains its stale mark and last pointer.
    await save();
  }
}
