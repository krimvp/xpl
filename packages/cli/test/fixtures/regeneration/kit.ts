/**
 * Shared steps of the regeneration tests (`regeneration*.test.ts`): a fixture repo under real git, an
 * explainer built through the CLI, then "a second commit" of edits followed by `xpl index` and
 * `xpl resolve --write`, the way the skill runs it after the code changed.
 */
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { collectAnchors, hashRange, type Anchor, type AnchorSite } from "@xpl/core";
import { expect } from "vitest";
import {
  cloneDir,
  copyFixture,
  git,
  invoke,
  readFile,
  readJson,
  writeFile,
  xpl,
  xplJson,
  type Invocation,
  type JsonEnvelope,
} from "../../helpers.js";

export const NAME = "jobrunner";
export const EXPLAINER_PATH = `.explainer/${NAME}.explainer.json`;
const here = dirname(fileURLToPath(import.meta.url));

/** A fixture patch of this directory (`ts-user.patch.json`). */
export function patchPath(file: string): string {
  return join(here, file);
}

// ─── git ────────────────────────────────────────────────────────────────────────────────────────

/** Commits everything in `dir` and returns the short (7 character) id the indexer will use. */
export function commit(dir: string, message: string): string {
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", message);
  return git(dir, "rev-parse", "HEAD").slice(0, 7);
}

// ─── The CLI ────────────────────────────────────────────────────────────────────────────────────

/** Runs `xpl <argv>` in `dir` and fails loudly (with its output) when the exit code is not 0. */
export async function ok(dir: string, ...argv: string[]): Promise<Invocation> {
  const result = await xpl(dir, ...argv);
  if (result.code !== 0) {
    throw new Error(`xpl ${argv.join(" ")} exited ${result.code}\n${result.out}\n${result.err}`);
  }
  return result;
}

/** What `xpl apply --json` prints. */
export interface ApplyJson extends JsonEnvelope {
  applied: boolean;
  actor: string;
  changed: string[];
  /** Ids the patch touched that belong to the user (set when something was skipped as protected). */
  protectedIds?: string[];
  issues: {
    severity: "error" | "warning";
    path: string;
    elementId?: string;
    message: string;
    code?: string;
  }[];
}

/** Applies a patch object (through stdin, like Claude does) or a patch file. */
export async function applyPatch(
  dir: string,
  patch: object | string,
  actor: "llm" | "user",
): Promise<Invocation & { json: ApplyJson }> {
  const argv = ["apply", NAME, typeof patch === "string" ? patch : "-", "--actor", actor, "--json"];
  const result = await invoke(argv, {
    cwd: dir,
    ...(typeof patch === "string" ? {} : { stdin: JSON.stringify(patch) }),
  });
  return { ...result, json: JSON.parse(result.out) as ApplyJson };
}

/** Like `applyPatch`, but the patch must be accepted. */
export async function applyOk(dir: string, patch: object | string, actor: "llm" | "user") {
  const result = await applyPatch(dir, patch, actor);
  expect(result.code, `${result.out}\n${result.err}`).toBe(0);
  return result;
}

// ─── Building a repo like a person (or Claude) would ────────────────────────────────────────────

export interface Step {
  patch: object | string;
  actor: "llm" | "user";
}

/**
 * A temp copy of a fixture repo: `git init` + commit, `xpl index --precise off`, `xpl new jobrunner`,
 * the patches in order, and a commit of the explainer. Returns the directory (HEAD = the explainer commit).
 */
export async function buildRepo(fixture: string, steps: Step[]): Promise<string> {
  const dir = copyFixture(fixture);
  git(dir, "init", "-q", "-b", "main");
  const first = commit(dir, "the code");
  const indexed = await xplJson<{ commit: string }>(dir, "index", "--precise", "off");
  expect(indexed.code).toBe(0);
  expect(indexed.json.commit, "a clean tree is indexed under its short HEAD").toBe(first);
  await ok(dir, "new", NAME);
  for (const step of steps) await applyOk(dir, step.patch, step.actor);
  const valid = await xpl(dir, "validate", NAME);
  expect(valid.out).toMatch(/^ok: /);
  commit(dir, "the explainer");
  return dir;
}

export interface Regenerated {
  dir: string;
  /** Short id of the edit commit = the id of the new index. */
  commit: string;
  index: { path: string; commit: string; explainersToResolve?: string[] };
  /** `xpl resolve --write --json`. */
  resolve: any;
  /** The explainer file after the write. */
  explainer: any;
}

/**
 * The regeneration flow on a copy of `base`: apply `edits` to the working tree, make a second commit,
 * then `xpl index` and `xpl resolve <name> --write`.
 */
export async function regenerate(
  base: string,
  edits: ((dir: string) => void)[],
  message = "edits",
): Promise<Regenerated> {
  const dir = cloneDir(base);
  for (const edit of edits) edit(dir);
  const head = commit(dir, message);
  const indexed = await xplJson<Regenerated["index"]>(dir, "index", "--precise", "off");
  expect(indexed.code).toBe(0);
  expect(indexed.json.commit).toBe(head);
  const before = readFile(dir, EXPLAINER_PATH);
  const resolved = await xplJson<any>(dir, "resolve", NAME, "--write");
  expect(resolved.code, resolved.out).toBe(0);
  expect(readFile(dir, EXPLAINER_PATH), "resolve --write saves the explainer").not.toBe(before);
  return {
    dir,
    commit: head,
    index: indexed.json,
    resolve: resolved.json,
    explainer: readJson(dir, EXPLAINER_PATH),
  };
}

// ─── Editing the working tree ───────────────────────────────────────────────────────────────────

/** Replaces `from` by `to` in a file; `from` must occur exactly once (an edit that misses is a bug in the test). */
export function replaceOnce(dir: string, file: string, from: string, to: string): void {
  const text = readFile(dir, file);
  const count = text.split(from).length - 1;
  if (count !== 1)
    throw new Error(`${file}: expected exactly one occurrence, found ${count}: ${from}`);
  writeFile(
    dir,
    file,
    text.replace(from, () => to),
  );
}

// ─── Reading the explainer ──────────────────────────────────────────────────────────────────────

/** Every anchor owned by element / step `id`, in file order. */
export function anchorsOf(explainer: unknown, id: string): Anchor[] {
  return collectAnchors(explainer as never)
    .filter((site: AnchorSite) => site.elementId === id)
    .map((site) => site.anchor);
}

/** `["ok", "moved"]`: the resolved status of each anchor of `id`. */
export function statusesOf(explainer: unknown, id: string): string[] {
  return anchorsOf(explainer, id).map((anchor) => anchor.resolved?.status ?? "none");
}

/** Every id that owns anchors, with the number of anchors: the "nothing is dropped" fingerprint. */
export function anchorInventory(explainer: unknown): Record<string, number> {
  const out: Record<string, number> = {};
  for (const site of collectAnchors(explainer as never)) {
    out[site.elementId] = (out[site.elementId] ?? 0) + 1;
  }
  return out;
}

/** `{ ok: 9, moved: 7, ... }` over the anchors written to the explainer. */
export function statusCounts(explainer: unknown): Record<string, number> {
  const counts: Record<string, number> = { ok: 0, moved: 0, drifted: 0, missing: 0 };
  for (const site of collectAnchors(explainer as never)) {
    const status = site.anchor.resolved?.status ?? "none";
    counts[status] = (counts[status] ?? 0) + 1;
  }
  return counts;
}

/**
 * What every written `resolved` cache must satisfy, whatever the edit: the text at the range of an `ok` or
 * `moved` anchor hashes to the anchor's `hash` (so `moved` really is "same text, new place"), and the range of
 * a `moved` span anchor is where its (updated) span says. Drifted anchors point at text that no longer hashes
 * to their `hash`.
 */
export function checkResolvedCache(dir: string, explainer: any): void {
  for (const site of collectAnchors(explainer)) {
    const { anchor } = site;
    const resolved = anchor.resolved;
    expect(resolved, site.path).toBeDefined();
    if (resolved!.status === "missing") continue;
    const actual = hashRange(readFile(dir, anchor.file), resolved!.range);
    if (resolved!.status === "drifted") {
      expect(actual, `${site.elementId} ${site.path} is drifted`).not.toBe(anchor.hash);
    } else {
      expect(actual, `${site.elementId} ${site.path} is ${resolved!.status}`).toBe(anchor.hash);
    }
  }
}
