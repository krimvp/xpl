/** Serialize watch cancellation and restart without changing service or job ownership. */
import { join } from "node:path";
import { readWatchState } from "./watch-state.js";
import { withRepositoryLock, atomicWrite, jsonFile } from "./fsutil.js";
import { CliError } from "./errors.js";
import type { Ctx } from "./context.js";
import { watchRepository } from "./watch.js";

export function watchControl(
  ctx: Ctx,
  options: Omit<Parameters<typeof watchRepository>[1], "signal" | "terminalState">,
  signal: AbortSignal,
  onFailure: () => void,
) {
  let active: { abort: AbortController; done: Promise<void> } | undefined;
  let paused = false;
  let closed = false;
  let queue: Promise<void> = Promise.resolve();
  const serial = (run: () => Promise<void>) => {
    const next = queue.then(run);
    queue = next.catch(() => undefined);
    return next;
  };
  const drain = async () => {
    active?.abort.abort();
    await active?.done;
    active = undefined;
  };
  return {
    change(action: "pause" | "resume") {
      return serial(async () => {
        if (closed || signal.aborted) throw new CliError("service is stopping");
        if (action === "pause") {
          paused = true;
          active?.abort.abort();
          const path = join(ctx.root, ".explainer/service/watch.json");
          await withRepositoryLock(ctx.root, path, async () => {
            const previous = readWatchState(ctx.root);
            if (previous?.instanceId === options.instanceId)
              await atomicWrite(path, jsonFile({ ...previous, state: "paused", stale: true }));
          });
          await drain();
        } else {
          if (active) return;
          paused = false;
          const abort = new AbortController();
          const done = watchRepository(ctx, {
            ...options,
            signal: AbortSignal.any([signal, abort.signal]),
            terminalState: () => (paused && !closed && !signal.aborted ? "paused" : "stopped"),
          });
          active = { abort, done };
          // A failed record write stops the service; shutdown still drains both subsystems.
          void done.catch(onFailure);
        }
      });
    },
    close() {
      closed = true;
      paused = false;
      active?.abort.abort();
      return serial(drain);
    },
  };
}
