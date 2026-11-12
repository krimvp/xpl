/**
 * `xpl live`: keep one guide in step with the working tree while someone (often an AI agent) changes the code.
 *
 * A cycle runs on start and after every settled source change (the watcher's loop, `settleBuilds`): build the index
 * from the captured snapshot and publish it, move the guide to it (`resolve --write`), record the change from the
 * base to the working tree (`xpl change <base> --worktree`), and draft the structure again (`live-draft.ts`), all in
 * one write of the guide under its lock, and only when something changed. A failing cycle keeps the last good guide
 * and waits for the next edit. With an agent (`--backend claude`), once the tree has been quiet for a while, one run
 * writes the TODO texts and `tour:live` (`reference/live.md`); xpl lints and applies its patch as actor `llm`.
 */
import { existsSync, readFileSync } from "node:fs";
import { readFile, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import {
  LIVE_TOUR_ID,
  TextCache,
  applyPatch,
  asIndexModel,
  basePathOf,
  createExplainer,
  hasBaseVersion,
  lintExplainer,
  ExplainerModel,
  reresolveExplainer,
  shortSha,
  unassignedFiles,
  type ChangeRecord,
  type FilePath,
  type Explainer,
  type ExplainerPatch,
  type IndexModel,
  type LiveStatus,
  type SymbolIndex,
} from "@xpl/core";
import { buildIndex, indexInputsChanged, writeIndex, type IndexInputs } from "@xpl/indexer";
import { orderKeys, worktreeChange } from "./commands/change.js";
import type { Ctx } from "./context.js";
import { CliError, errorMessage } from "./errors.js";
import { plural } from "./format.js";
import { atomicWrite, displayPath, jsonFile, withFileLock, withRepositoryLock } from "./fsutil.js";
import { gitShowReader, isGitWorkTree, mergeBase, resolveCommit } from "./git.js";
import { draftLiveStructure } from "./live-draft.js";
import { EXPLAINER_DIR, EXPLAINER_SUFFIX, listExplainerNames, readExplainerFile } from "./repo.js";
import { detectRepoName } from "./repo-name.js";
import { captureInputs, settleBuilds } from "./watch.js";

/** Seconds of quiet before the agent runs (`--agent-quiet`). */
export const AGENT_QUIET_SECONDS = 20;

/** How long one agent run may take before it fails (ms). */
export const AGENT_TIMEOUT_MS = 300_000;

/** Branches whose merge base with HEAD is the base of the change, the first that exists. */
const DEFAULT_BRANCHES = ["origin/HEAD", "origin/main", "origin/master", "main", "master"];

/** What one agent run gets: where things are, the code before the change, and the findings of its last try. */
export interface LiveRun {
  root: string;
  guidePath: string;
  /** The full SHA of the base, when there is one. */
  base: string | null;
  change: ChangeRecord | undefined;
  /** The code before the change of each changed file that has some, by its path at head (a deleted file: its path). */
  before: Record<string, string>;
  /** `xpl lint` findings of the patch of the first try, for the second; empty on a first try. */
  findings: string[];
  /** The source files the change added that no design box holds (`unassignedFiles`); empty without a design level. */
  unassigned: FilePath[];
}

/** The background agent: returns one patch (anything; xpl checks it). Tests pass a fake. */
export type LiveAgent = (run: LiveRun, signal: AbortSignal) => Promise<unknown>;

/** What an agent throws when its answer holds no patch: it counts as a rejected try, its message a finding. */
export class UnreadableAnswer extends CliError {}

/**
 * The task of one background run, the same for every backend: the change, the design level, the added files no
 * design box holds, and the findings of the last try. `before` says where the code before the change is.
 */
export function liveTask(run: LiveRun, before: string): string[] {
  return [
    run.change
      ? `Its \`change\` is the change from commit ${run.change.base} to the working tree. The code before the change of each changed file is ${before}.`
      : "It records no change: write the TODO texts only, and no tour.",
    ...(run.change
      ? [
          'When the change spans two or more parts, write or refresh the design level (reference/live.md, "The design level"): grp:design-<slug> boxes with members, view:design, and the steps design and design-<slug>.',
        ]
      : []),
    ...(run.unassigned.length > 0
      ? [`These added files are in no design box: ${run.unassigned.join(", ")}.`]
      : []),
    ...(run.findings.length > 0
      ? [
          "Your previous patch was not applied. Fix these findings in a new, complete patch:",
          ...run.findings.map((finding) => `- ${finding}`),
        ]
      : []),
  ];
}

export interface LiveOptions {
  /** The guide's name (`live` by default). */
  name: string;
  since?: string;
  precise: "auto" | "off" | "require";
  backend: LiveStatus["explanation"]["backend"];
  /** The agent of `backend: "claude"` or `"api"`. */
  agent?: LiveAgent;
  /** Quiet time before an agent run (ms). */
  agentQuietMs: number;
  signal: AbortSignal;
  /** Quiet time before a build, and the poll interval (ms); the watcher's 300 and 500 by default. */
  quietMs?: number;
  pollMs?: number;
}

type Base = NonNullable<LiveStatus["base"]>;

interface BaseState {
  schema: "xpl-live-state@1";
  base: string;
}

/** Adds lines to `.explainer/.gitignore` (the managed file `xpl index` writes) when they are missing. */
async function ignoreInExplainerDir(root: string, lines: readonly string[]): Promise<void> {
  const path = join(root, EXPLAINER_DIR, ".gitignore");
  await withRepositoryLock(root, path, async () => {
    const existing = existsSync(path) ? await readFile(path, "utf8") : "";
    const missing = lines.filter((line) => !existing.split(/\r?\n/).some((l) => l.trim() === line));
    if (missing.length === 0) return;
    const sep = existing !== "" && !existing.endsWith("\n") ? "\n" : "";
    await writeFile(path, `${existing}${sep}${missing.join("\n")}\n`);
  });
}

/**
 * The base of the change: `--since` (remembered), else the merge base with the default branch when HEAD is past it,
 * else the base remembered from an earlier start (while it is still an ancestor of HEAD), else HEAD now (remembered,
 * so commits made during the session stay in the change). Null outside git or before the first commit.
 */
async function chooseBase(ctx: Ctx, name: string, since: string | undefined): Promise<Base | null> {
  if (!(await isGitWorkTree(ctx.root))) {
    if (since !== undefined)
      throw new CliError(`--since needs git: ${ctx.root} is not in a git work tree`);
    return null;
  }
  const statePath = join(ctx.root, EXPLAINER_DIR, "live", `${name}.json`);
  const remember = async (sha: string) => {
    await ignoreInExplainerDir(ctx.root, ["live/"]);
    await atomicWrite(
      statePath,
      jsonFile({ schema: "xpl-live-state@1", base: sha } satisfies BaseState),
    );
  };
  if (since !== undefined) {
    const sha = await resolveCommit(ctx.root, since);
    if (!sha) {
      throw new CliError(
        `"${since}" is not a commit of this repository (\`git rev-parse ${since}\` found nothing)`,
      );
    }
    await remember(sha);
    return { rev: since, sha, how: "since" };
  }
  const head = await resolveCommit(ctx.root, "HEAD");
  if (!head) return null;
  for (const branch of DEFAULT_BRANCHES) {
    const tip = await resolveCommit(ctx.root, branch);
    if (!tip) continue;
    const from = await mergeBase(ctx.root, tip, head);
    if (from && from !== head) return { rev: branch, sha: from, how: "merge-base" };
    break;
  }
  try {
    const saved = JSON.parse(readFileSync(statePath, "utf8")) as Partial<BaseState>;
    const sha =
      typeof saved.base === "string" ? await resolveCommit(ctx.root, saved.base) : undefined;
    if (sha && (await mergeBase(ctx.root, sha, head)) === sha)
      return { rev: "HEAD", sha, how: "start" };
  } catch {
    // no state yet, or unreadable: start from HEAD
  }
  await remember(head);
  return { rev: "HEAD", sha: head, how: "start" };
}

/** Texts still to write in the guide: labels and summaries that start with `TODO`. */
function todoCount(explainer: Explainer): number {
  let n = 0;
  for (const item of [
    ...explainer.nodes,
    ...explainer.edges,
    ...explainer.views,
    ...explainer.tours,
  ]) {
    for (const text of [
      (item as { label?: unknown }).label,
      (item as { title?: unknown }).title,
      (item as { summary?: unknown }).summary,
    ]) {
      if (typeof text === "string" && text.startsWith("TODO")) n++;
    }
  }
  return n;
}

/**
 * Lint findings on what an agent's patch changed, except the ones a live tour cannot meet by design (it covers
 * the changed parts, not every box or file); `error` for a `TODO` left.
 */
function patchFindings(
  explainer: Explainer,
  model: IndexModel,
  changed: readonly string[],
): { text: string; error: boolean }[] {
  // a tour step is `<tour id>/<step id>` in both lists; a file id has slashes of its own
  const owner = (id: string) => (id.startsWith("tour:") ? id.split("/")[0]! : id);
  const touched = new Set(changed.map(owner));
  return lintExplainer(explainer, new ExplainerModel(explainer, model))
    .findings.filter(
      (f) =>
        touched.has(owner(f.elementId)) &&
        f.rule !== "tour-covers-map" &&
        f.rule !== "change-not-shown",
    )
    .map((f) => ({
      text: `${f.elementId} ${f.field} (${f.rule}): ${f.message} ${f.hint}`.trim(),
      error: f.severity === "error",
    }));
}

/**
 * `tour:live` as the cycle left it, with the commit its text was written at: moving the guide to a new index and
 * drafting the structure again can touch the tour (a gone file leaves its focus) and stamp it with the new index
 * commit, which would make an explanation of older code read as current (`LiveStatus.explanation.stale`).
 */
function keepExplainedAt(after: Explainer, before: Explainer | undefined): Explainer {
  const commit = before?.tours.find((t) => t.id === LIVE_TOUR_ID)?.provenance?.commit;
  const tour = after.tours.find((t) => t.id === LIVE_TOUR_ID);
  if (!commit || !tour?.provenance || tour.provenance.commit === commit) return after;
  return {
    ...after,
    tours: after.tours.map((t) =>
      t === tour ? { ...t, provenance: { ...tour.provenance!, commit } } : t,
    ),
  };
}

export interface Live {
  readonly guidePath: string;
  status(): LiveStatus;
  /** One cycle now, from a fresh capture (`--once`, and the first cycle). Throws when it fails. */
  cycle(): Promise<void>;
  /** One agent run now, when one is due or `force` (`--once`). */
  explain(force?: boolean): Promise<void>;
  /** The loops: cycles after settled edits, and agent runs after quiet. Returns when the signal aborts. */
  watch(): Promise<void>;
}

export async function openLive(ctx: Ctx, options: LiveOptions): Promise<Live> {
  const { name, signal } = options;
  const guidePath = join(ctx.root, EXPLAINER_DIR, `${name}${EXPLAINER_SUFFIX}`);
  const guideRel = displayPath(ctx.root, guidePath);
  const base = await chooseBase(ctx, name, options.since);

  const status: LiveStatus = {
    schema: "xpl-live@1",
    guide: name,
    state: "building",
    updatedAt: null,
    index: null,
    base,
    change: null,
    explanation: {
      backend: options.backend,
      state: options.backend === "none" ? "off" : "idle",
      explainedAt: null,
      stale: false,
      error: null,
    },
    error: null,
  };
  /** The last good state: the guide as written, and the index and texts it is on. */
  let current: { explainer: Explainer; model: IndexModel; texts: TextCache } | undefined;
  let published: string | undefined;
  let latest: string | undefined;
  let editedAt = Date.now();
  /** Index commits: the last one an agent run started on, and the last one whose explanation was applied. */
  let attempted: string | undefined;
  let explained: string | undefined;
  const ownIndexes = new Set<string>();
  let looping = false;

  /** Removes the index files this process made that no guide is bound to any more (one per edit otherwise). */
  async function pruneIndexes(keep: string): Promise<void> {
    const bound = new Set<string>();
    for (const guide of listExplainerNames(ctx.root)) {
      try {
        bound.add(
          readExplainerFile(join(ctx.root, EXPLAINER_DIR, `${guide}${EXPLAINER_SUFFIX}`)).index
            .path,
        );
      } catch {
        // an unreadable guide binds nothing we know of
      }
    }
    for (const abs of ownIndexes) {
      if (abs === keep || bound.has(displayPath(ctx.root, abs))) continue;
      await unlink(abs).catch(() => undefined);
      ownIndexes.delete(abs);
    }
  }

  /** Publish the index of `inputs`, then bring the guide to it. False when the inputs moved meanwhile. */
  async function publish(index: SymbolIndex, inputs: IndexInputs): Promise<boolean> {
    const indexPath = join(ctx.root, EXPLAINER_DIR, `index-${index.commit}.json`);
    const written = await withRepositoryLock(ctx.root, indexPath, () =>
      withRepositoryLock(ctx.root, join(ctx.root, EXPLAINER_DIR, ".gitignore"), async () => {
        if (signal.aborted || (await indexInputsChanged(inputs))) return undefined;
        // only an index this process made is its to remove later
        if (!existsSync(indexPath)) ownIndexes.add(indexPath);
        return writeIndex(ctx.root, index);
      }),
    );
    if (!written) return false;
    const model = asIndexModel(index);
    const texts = new TextCache((p) => inputs.texts.get(p), gitShowReader(ctx.root));
    const change = base ? await worktreeChange(ctx, { model, texts, index }, base.sha) : undefined;
    // git read the working tree as it is now: the record is of these inputs only when nothing moved since
    if (await indexInputsChanged(inputs)) return false;
    const commits = new Map<string, string>();
    let before: Explainer | undefined;
    const next = await withFileLock(guidePath, async () => {
      const exists = existsSync(guidePath);
      let explainer: Explainer;
      if (exists) explainer = before = readExplainerFile(guidePath);
      else {
        const repo = await detectRepoName(ctx.root);
        explainer = createExplainer({
          title: `Live view of ${repo.name}`,
          repoName: repo.name,
          index: model,
          indexPath: displayPath(ctx.root, written),
        });
        // made by `xpl live`, so generated state: never committed
        await ignoreInExplainerDir(ctx.root, [`${name}${EXPLAINER_SUFFIX}`]);
      }
      for (const node of explainer.nodes) {
        const commit = node.provenance?.commit;
        if (!commit || commits.has(commit) || !/^[0-9a-f]{7,39}$/.test(commit)) continue;
        if (!node.id.startsWith("file:") || model.hasFile(node.id.slice(5))) continue;
        const full = await resolveCommit(ctx.root, commit);
        if (full) commits.set(commit, full);
      }
      explainer = reresolveExplainer(explainer, model, texts, {
        indexPath: displayPath(ctx.root, written),
      }).explainer;
      if (change) explainer = orderKeys({ ...explainer, change });
      else delete explainer.change;
      explainer = draftLiveStructure({ explainer, model, texts, commits }).explainer;
      explainer = keepExplainedAt(explainer, before);
      const text = jsonFile(explainer);
      if (!exists || readFileSync(guidePath, "utf8") !== text) await atomicWrite(guidePath, text);
      return explainer;
    });
    current = { explainer: next, model, texts };
    published = inputs.fingerprint;
    await pruneIndexes(indexPath);
    status.state = "watching";
    status.error = null;
    status.updatedAt = new Date().toISOString();
    status.index = index.commit;
    status.change = change
      ? {
          files: change.files.length,
          added: change.files.reduce((n, f) => n + f.hunks.reduce((m, h) => m + h.newLines, 0), 0),
          removed: change.files.reduce(
            (n, f) => n + f.hunks.reduce((m, h) => m + h.oldLines, 0),
            0,
          ),
        }
      : null;
    report(before, next);
    return true;
  }

  function report(before: Explainer | undefined, after: Explainer): void {
    if (ctx.json) {
      // one JSON result per cycle of the loop; `--once` prints its own
      if (looping) ctx.emit({ live: snapshot() });
      return;
    }
    const was = new Set((before?.nodes ?? []).map((n) => n.id));
    const now = new Set(after.nodes.map((n) => n.id));
    const added = [...now].filter((id) => !was.has(id));
    const removed = [...was].filter((id) => !now.has(id));
    const change = status.change;
    ctx.out(
      [
        `live: ${guideRel} on index ${status.index}; ` +
          (!base
            ? "no base to compare with (no git commit)"
            : change
              ? `changed since ${shortSha(base.sha)} (${base.rev}): ${plural(change.files, "file")}, +${change.added} -${change.removed}`
              : `no change since ${shortSha(base.sha)} (${base.rev})`),
        ...(before && added.length > 0 ? [`  new boxes: ${added.join(", ")}`] : []),
        ...(before && removed.length > 0 ? [`  removed boxes: ${removed.join(", ")}`] : []),
      ].join("\n"),
    );
  }

  /** The commit id of the last explanation: this process's last applied run, else the guide's `tour:live`. */
  function snapshot(): LiveStatus {
    let tourCommit: string | undefined;
    try {
      tourCommit = readExplainerFile(guidePath).tours.find((t) => t.id === LIVE_TOUR_ID)?.provenance
        ?.commit;
    } catch {
      tourCommit = current?.explainer.tours.find((t) => t.id === LIVE_TOUR_ID)?.provenance?.commit;
    }
    const stale =
      status.change !== null &&
      status.index !== null &&
      explained !== status.index &&
      tourCommit !== status.index;
    return structuredClone({ ...status, explanation: { ...status.explanation, stale } });
  }

  async function failed(error: unknown): Promise<void> {
    const message = errorMessage(error);
    if (status.state !== "failed" || status.error !== message) {
      ctx.warn(`live: the guide stays as it was; the next edit tries again: ${message}`);
    }
    status.state = "failed";
    status.error = message;
  }

  /**
   * Runs the agent once on the current state and applies its patch as `llm`. A rejection or a lint finding on what
   * it changed gives a second try with the findings; that one is applied unless it is rejected or leaves a TODO.
   */
  async function explain(force = false): Promise<void> {
    const agent = options.agent;
    if (!agent || !current || status.state !== "watching") return;
    const commit = status.index!;
    const due =
      force ||
      (attempted !== commit &&
        Date.now() - editedAt >= options.agentQuietMs &&
        (snapshot().explanation.stale || todoCount(current.explainer) > 0));
    if (!due) return;
    attempted = commit;
    status.explanation.state = "running";
    status.explanation.error = null;
    try {
      const change = current.explainer.change;
      const before: Record<string, string> = {};
      for (const file of change?.files ?? []) {
        if (!hasBaseVersion(file)) continue;
        const text = current.texts.textAt(change!.base, basePathOf(file));
        if (text !== undefined) before[file.path] = text;
      }
      const unassigned = unassignedFiles(new ExplainerModel(current.explainer, current.model));
      let findings: string[] = [];
      for (let attempt = 1; ; attempt++) {
        let patch: unknown;
        try {
          patch = await agent(
            {
              root: ctx.root,
              guidePath,
              base: base?.sha ?? null,
              change,
              before,
              findings,
              unassigned,
            },
            signal,
          );
        } catch (error) {
          if (!(error instanceof UnreadableAnswer)) throw error;
          patch = error;
        }
        const result = await withFileLock(guidePath, async () => {
          if (patch instanceof UnreadableAnswer)
            return { findings: [patch.message], rejected: true, warnings: undefined };
          const { model, texts } = current!;
          const guide = readExplainerFile(guidePath);
          const applied = applyPatch(guide, patch as ExplainerPatch, model, texts, {
            actor: "llm",
          });
          if (!applied.ok) {
            const errors = applied.issues.filter((i) => i.severity === "error");
            return {
              findings: errors.slice(0, 10).map((i) => `${i.path}: ${i.message}`),
              rejected: true,
            };
          }
          const found = patchFindings(applied.explainer, model, applied.changed);
          // the first try gets every finding back; the second is applied unless a TODO is left
          if (found.some((f) => f.error) || (attempt === 1 && found.length > 0))
            return { findings: found.map((f) => f.text), rejected: false };
          if (applied.changed.length > 0) await atomicWrite(guidePath, jsonFile(applied.explainer));
          current = { ...current!, explainer: applied.explainer };
          return { findings: [], rejected: false, warnings: found.map((f) => f.text) };
        });
        if (result.findings.length === 0) {
          if (result.warnings?.length) {
            ctx.warn(
              `live: applied the agent's patch with ${plural(result.warnings.length, "lint finding")}: ${result.warnings.slice(0, 3).join("; ")}`,
            );
          }
          break;
        }
        if (attempt >= 2) {
          throw new CliError(
            `the agent's patch ${result.rejected ? "does not apply" : "leaves a TODO"}, so nothing was applied: ${result.findings.slice(0, 3).join("; ")}`,
          );
        }
        findings = result.findings;
      }
      explained = commit;
      status.explanation.state = "idle";
      status.explanation.explainedAt = new Date().toISOString();
      if (!ctx.json) ctx.out(`live: the agent explained index ${commit}`);
    } catch (error) {
      status.explanation.state = "failed";
      status.explanation.error = errorMessage(error);
      ctx.warn(`live: the agent run failed; the next edit tries again: ${errorMessage(error)}`);
    }
  }

  return {
    guidePath,
    status: snapshot,
    async cycle() {
      status.state = "building";
      try {
        const inputs = await captureInputs(ctx.root, options.precise, null);
        latest = inputs.fingerprint;
        const result = await buildIndex({
          root: ctx.root,
          precise: options.precise,
          snapshot: inputs,
        });
        for (const warning of result.warnings) ctx.warn(warning);
        if (!(await publish(result.index, inputs))) {
          throw new CliError("the code changed while the guide was being updated: run it again");
        }
      } catch (error) {
        await failed(error);
        throw error;
      }
    },
    explain,
    async watch() {
      looping = true;
      const agentLoop = (async () => {
        while (!signal.aborted) {
          await explain();
          await delay(options.pollMs ?? 500, undefined, { signal }).catch(() => undefined);
        }
      })();
      await settleBuilds(ctx, {
        precise: options.precise,
        scip: null,
        signal,
        ...(options.quietMs !== undefined ? { quietMs: options.quietMs } : {}),
        ...(options.pollMs !== undefined ? { pollMs: options.pollMs } : {}),
        async observe(inputs) {
          if (inputs.fingerprint !== latest) editedAt = Date.now();
          latest = inputs.fingerprint;
        },
        wanted: () => latest !== published,
        async building() {
          status.state = "building";
        },
        async publish(result, inputs) {
          for (const warning of result.warnings) ctx.warn(warning);
          return publish(result.index, inputs);
        },
        async superseded() {},
        failed,
      });
      await agentLoop;
    },
  };
}
