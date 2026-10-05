/** Project affected-guide inventory into the managed viewer's read-only attention report. */
import { join } from "node:path";
import type { IndexModel, TextCache, WatchAttention } from "@xpl/core";
import { EXPLAINER_DIR, EXPLAINER_SUFFIX, explainerName } from "./repo.js";
import type { RepoEnv } from "./context.js";
import { guideInventory } from "./inventory.js";
import { readWatchState } from "./watch-state.js";

const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;

/** All offered guide commands share shell quoting and an absolute target, independent of cwd. */
function guideCommand(env: RepoEnv, path: string, command: "resolve" | "revise", args: string) {
  return `xpl ${command} --root ${quote(env.root)} ${quote(join(env.root, path))} ${args}`;
}

export function watchAttention(
  env: RepoEnv,
  index: IndexModel,
  texts: TextCache,
  enabled: boolean,
  instanceId: string,
  attachedGuide: string,
): WatchAttention {
  const state = readWatchState(env.root);
  const inventory = guideInventory(env, index, texts);
  const attachedName = explainerName(attachedGuide);
  if (!inventory.some((g) => g.name === attachedName))
    inventory.push({
      name: attachedName,
      attention: true,
      error: `Attached guide ${attachedGuide} is missing. Restore it or restart with another guide.`,
    });
  return {
    enabled,
    instanceId,
    watch:
      state?.instanceId === instanceId
        ? {
            state: state.state,
            stale: state.stale,
            generation: state.generation,
            index: state.index,
            error: state.error,
          }
        : null,
    guides: inventory.map((g) => ({
      name: g.name,
      path: g.path ?? null,
      title: g.title ?? g.name,
      counts: g.anchors
        ? {
            moved: g.anchors.counts.moved,
            drifted: g.anchors.counts.drifted,
            missing: g.anchors.counts.missing,
          }
        : null,
      elements: (g.anchors?.affected ?? []).flatMap((a) => {
        const status = a.resolved?.status;
        return status === "moved" || status === "drifted" || status === "missing"
          ? [{ id: a.elementId, file: a.file, status }]
          : [];
      }),
      errors: g.error ? [g.error] : (g.errors ?? []).map((e) => e.message),
      resolveCommand: guideCommand(
        env,
        g.path ?? `${EXPLAINER_DIR}/${g.name}${EXPLAINER_SUFFIX}`,
        "resolve",
        "--write",
      ),
      revisionCommand: guideCommand(
        env,
        g.path ?? `${EXPLAINER_DIR}/${g.name}${EXPLAINER_SUFFIX}`,
        "revise",
        "--select '<request-id>'",
      ),
    })),
  };
}
