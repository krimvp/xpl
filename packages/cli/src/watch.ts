/** Poll discovery and content, wait for quiet, build from captured inputs, and fence publication. */
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { TextCache, asIndexModel } from "@xpl/core";
import {
  buildIndex,
  captureIndexInputs,
  indexInputsChanged,
  writeIndex,
  type IndexInputs,
} from "@xpl/indexer";
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
  const capture = () => captureInputs(ctx.root, options.precise, options.scip);
  await save();
  try {
    await settleBuilds(ctx, {
      ...options,
      async observe(inputs) {
        // A touch alone does not rebuild an already checked snapshot.
        if (state.fingerprint !== inputs.fingerprint || state.stale) {
          state.state = "pending";
          state.stale = true;
          state.error = null;
          await save();
        }
      },
      wanted: () => state.stale,
      async building() {
        state.state = "building";
        state.error = null;
        await save();
      },
      async superseded() {
        state.state = "pending";
        state.stale = true;
        await save();
      },
      async publish(result, inputs) {
        // Readers get one complete index. The pointer becomes current only after it exists.
        const indexPath = join(ctx.root, ".explainer", `index-${result.index.commit}.json`);
        const published = await withRepositoryLock(ctx.root, indexPath, () =>
          withRepositoryLock(ctx.root, join(ctx.root, ".explainer/.gitignore"), () =>
            withRepositoryLock(ctx.root, path, async () => {
              if (options.signal.aborted) return false;
              const final = await capture();
              if (final.revision !== inputs.revision || options.signal.aborted) return false;
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
              return true;
            }),
          ),
        );
        if (!published) return false;
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
        return true;
      },
      async failed(error) {
        const message = errorMessage(error);
        const changed = state.state !== "failed" || state.error !== message;
        state.state = "failed";
        state.stale = true;
        state.error = message;
        if (changed) {
          await save();
          ctx.warn(`watch failed; last snapshot is out of date: ${state.error}`);
        }
      },
    });
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

/** The inputs of an index build, as a watched build captures them (sources, configuration, git state). */
export function captureInputs(
  root: string,
  precise: "auto" | "off" | "require",
  scip: string | null,
): Promise<IndexInputs> {
  return captureIndexInputs({
    root,
    precise,
    inputPaths: scipInputPaths(scip),
    ...(scip ? { providers: scipProviders(scip) } : {}),
  });
}

/**
 * The loop of a watched repository (`xpl service start --watch`, `xpl live`): poll the inputs' metadata every
 * `pollMs`, and after `quietMs` without a change build an index from the captured snapshot (one attempt per
 * revision, so a failure waits for the next edit). A build whose inputs moved meanwhile is superseded, not
 * published; `publish` checks once more under its own locks. Every hook runs in the loop, one at a time; an error
 * of any of them goes to `failed`. Returns when `signal` aborts.
 */
export async function settleBuilds(
  ctx: Ctx,
  hooks: {
    precise: "auto" | "off" | "require";
    scip: string | null;
    signal: AbortSignal;
    quietMs?: number;
    pollMs?: number;
    /** The inputs moved to a new revision (or were first captured). */
    observe(inputs: IndexInputs): Promise<void>;
    /** Is a build wanted (the published snapshot is not these inputs)? */
    wanted(): boolean;
    building(inputs: IndexInputs): Promise<void>;
    /** Publish the build of `inputs`; false when they moved before it could be (the build is superseded). */
    publish(result: Awaited<ReturnType<typeof buildIndex>>, inputs: IndexInputs): Promise<boolean>;
    superseded(): Promise<void>;
    failed(error: unknown): Promise<void>;
  },
): Promise<void> {
  const { signal } = hooks;
  const quietMs = hooks.quietMs ?? 300;
  const capture = () => captureInputs(ctx.root, hooks.precise, hooks.scip);
  let polled: IndexInputs | undefined;
  let observed: string | undefined;
  let attempted: string | undefined;
  let quietAt = Date.now();
  while (!signal.aborted) {
    try {
      if (!polled || (await indexInputsChanged(polled))) polled = await capture();
      const inputs = polled;
      if (observed !== inputs.revision) {
        observed = inputs.revision;
        quietAt = Date.now();
        await hooks.observe(inputs);
      }
      if (hooks.wanted() && inputs.revision !== attempted && Date.now() - quietAt >= quietMs) {
        attempted = inputs.revision;
        await hooks.building(inputs);
        const result = await buildIndex({
          root: ctx.root,
          precise: hooks.precise,
          snapshot: inputs,
          ...(hooks.scip ? { providers: scipProviders(hooks.scip) } : {}),
        });
        const after = await capture();
        if (signal.aborted) break;
        if (after.revision !== inputs.revision || !(await hooks.publish(result, inputs))) {
          await hooks.superseded();
          continue;
        }
      }
    } catch (error) {
      await hooks.failed(error);
    }
    await delay(hooks.pollMs ?? 500, undefined, { signal }).catch(() => undefined);
  }
}
