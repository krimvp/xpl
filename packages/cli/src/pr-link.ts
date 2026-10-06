/**
 * One PR comment links the current staged preview at a team-configured static destination. `link`
 * points it at the current version after a fresh GitHub check; `checkLink` (run by a PR workflow) marks
 * it outdated when the PR head or base moves. Neither uploads files: the destination serves `xpl stage`'s folder.
 */
import { readFile, realpath } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";
import type { Ctx } from "./context.js";
import { CliError, UsageError, errorMessage } from "./errors.js";
import { FULL_SHA } from "./git.js";
import { prProcess, resolvePr, type PrIdentity } from "./pr.js";
import type { VersionManifest } from "./stage.js";

const MARKER = "<!-- xpl-pr-preview ";
const VERSION = /^version-[A-Za-z0-9_-]+$/;
// Only people with write access can own the link; anyone else's marker is ignored.
const TRUSTED = new Set(["OWNER", "MEMBER", "COLLABORATOR"]);

export type Visibility = "team" | "public";
interface LinkRecord {
  head: string;
  base: string;
  version: string;
  url: string;
  visibility: Visibility;
  outdated?: { head: string; base: string };
}

const gh = (ctx: Ctx, args: string[]) =>
  prProcess("gh", ["api", "--hostname", "github.com", ...args], ctx.cwd, ctx.env, ctx.io.signal);
const short = (sha: string) => sha.slice(0, 7);

function render(record: LinkRecord): string {
  // JSON in an HTML comment: escaped angle brackets cannot close it early.
  const marker = `${MARKER}${JSON.stringify(record).replace(/</g, "\\u003c").replace(/>/g, "\\u003e")} -->`;
  const version = `${record.url}/${record.version}/index.html`;
  return (
    record.outdated
      ? [
          marker,
          `**Outdated code explainer preview.** It describes head \`${short(record.head)}\` (base \`${short(record.base)}\`); the PR is now at head \`${short(record.outdated.head)}\` (base \`${short(record.outdated.base)}\`).`,
          "",
          `[The last published version](${version}) stays readable. Publish the new head with \`xpl pr create\`, \`xpl pr finish\`, \`xpl stage\` and \`xpl pr link\`.`,
        ]
      : [
          marker,
          `**Code explainer preview** for head \`${short(record.head)}\` (base \`${short(record.base)}\`).`,
          "",
          `[Open the current preview](${record.url}/current/index.html) · [This version](${version})`,
          "",
          `Readers: ${record.visibility}. Updated in place by \`xpl pr link\`.`,
        ]
  ).join("\n");
}

function parseRecord(body: string): LinkRecord | undefined {
  const line = body.split("\n", 1)[0]!;
  if (!line.startsWith(MARKER) || !line.endsWith(" -->")) return undefined;
  try {
    const record = JSON.parse(line.slice(MARKER.length, -4)) as LinkRecord;
    return FULL_SHA.test(record.head) &&
      FULL_SHA.test(record.base) &&
      VERSION.test(record.version) &&
      /^https?:\/\//.test(new URL(record.url).href) &&
      (record.visibility === "team" || record.visibility === "public")
      ? record
      : undefined;
  } catch {
    return undefined;
  }
}

async function findLink(ctx: Ctx, pr: PrIdentity) {
  const pages = JSON.parse(
    await gh(ctx, [
      "--paginate",
      "--slurp",
      `repos/${pr.repository}/issues/${pr.number}/comments?per_page=100`,
    ]),
  ) as { id: number; body?: string; author_association?: string }[][];
  for (const comment of pages.flat()) {
    const record = TRUSTED.has(comment.author_association ?? "")
      ? parseRecord(comment.body ?? "")
      : undefined;
    if (record) return { id: comment.id, record };
  }
  return undefined;
}

async function write(
  ctx: Ctx,
  pr: PrIdentity,
  record: LinkRecord,
  existing: Awaited<ReturnType<typeof findLink>>,
) {
  const body = render(record);
  if (existing && isDeepStrictEqual(existing.record, record)) return "unchanged" as const;
  const written = await gh(
    ctx,
    existing
      ? [
          "--method",
          "PATCH",
          `repos/${pr.repository}/issues/comments/${existing.id}`,
          "-f",
          `body=${body}`,
        ]
      : [
          "--method",
          "POST",
          `repos/${pr.repository}/issues/${pr.number}/comments`,
          "-f",
          `body=${body}`,
        ],
  );
  if (existing) return "updated" as const;
  // A comment from someone without write access would not count as the link next time; remove it.
  const created = JSON.parse(written) as { id: number; author_association?: string };
  if (!TRUSTED.has(created.author_association ?? "")) {
    await gh(ctx, ["--method", "DELETE", `repos/${pr.repository}/issues/comments/${created.id}`]);
    throw new CliError(
      `only an owner, member or collaborator of ${pr.repository} can keep the PR link; the comment was removed`,
    );
  }
  return "created" as const;
}

/** Points the PR's one link at `<url>/current` and the staged current version. */
export async function linkPr(ctx: Ctx, directory: string, url: string, visibility: Visibility) {
  let base: URL;
  try {
    base = new URL(url);
  } catch {
    throw new UsageError(`--url must be an http(s) URL: ${url}`);
  }
  if (
    (base.protocol !== "https:" && base.protocol !== "http:") ||
    base.username ||
    base.password ||
    base.search ||
    base.hash
  )
    throw new UsageError(
      `--url must be an http(s) base URL without credentials, query or fragment: ${url}`,
    );
  const current = resolve(ctx.cwd, directory, "current");
  let manifest: VersionManifest;
  let version: string;
  try {
    version = basename(await realpath(current));
    manifest = JSON.parse(await readFile(join(current, "manifest.json"), "utf8"));
  } catch (error) {
    throw new CliError(`no staged current version in ${directory}: ${errorMessage(error)}`);
  }
  const pr = manifest.prResult?.manifest.pr;
  if (
    manifest.kind !== "xpl-ready-version" ||
    manifest.version !== version ||
    !VERSION.test(version) ||
    !manifest.readiness?.ready ||
    !pr ||
    manifest.commits.head !== pr.head.sha ||
    manifest.commits.base !== pr.base.sha
  )
    throw new CliError(
      `${directory}/current is not a ready PR version; stage it with xpl stage --pr-result first`,
    );
  const observed = await resolvePr(pr, ctx.cwd, ctx.env, ctx.io.signal);
  if (observed.head.sha !== pr.head.sha || observed.base.sha !== pr.base.sha)
    throw new CliError(
      `the PR moved since this version was staged (head ${short(observed.head.sha)}); the link was not changed. Create, finish and stage the new head.`,
    );
  const repository = JSON.parse(await gh(ctx, [`repos/${pr.repository}`])) as { private?: unknown };
  if (typeof repository.private !== "boolean")
    throw new CliError(`cannot read the visibility of ${pr.repository}`);
  if (repository.private && visibility === "public")
    throw new CliError(
      `${pr.repository} is a private repository; publish its preview to a team destination (--visibility team)`,
    );
  const record: LinkRecord = {
    head: pr.head.sha,
    base: pr.base.sha,
    version,
    url: base.href.replace(/\/+$/, ""),
    visibility,
  };
  let action: Awaited<ReturnType<typeof write>>;
  try {
    action = await write(ctx, pr, record, await findLink(ctx, pr));
  } catch (error) {
    throw new CliError(
      `${errorMessage(error)}. Staged versions are kept and the previous PR link is unchanged; fix access and rerun xpl pr link.`,
    );
  }
  // A push between the check above and the write must not leave the old head shown as current.
  if ((await checkPrLink(ctx, pr)).action === "outdated")
    throw new CliError(
      "the PR moved while linking; the comment now marks this version outdated. Create, finish and stage the new head.",
    );
  return {
    action,
    pr: pr.url,
    current: `${record.url}/current/index.html`,
    version: `${record.url}/${version}/index.html`,
  };
}

/** For a PR workflow: marks the one link outdated when GitHub's base or head no longer matches it. */
export async function checkPrLink(ctx: Ctx, input: PrIdentity) {
  const pr = await resolvePr(input, ctx.cwd, ctx.env, ctx.io.signal);
  const existing = await findLink(ctx, pr);
  if (!existing) return { action: "none" as const, pr: pr.url };
  const { outdated: _outdated, ...record } = existing.record;
  const moved = record.head !== pr.head.sha || record.base !== pr.base.sha;
  const action = await write(
    ctx,
    pr,
    moved ? { ...record, outdated: { head: pr.head.sha, base: pr.base.sha } } : record,
    existing,
  );
  return { action: action === "unchanged" ? action : moved ? "outdated" : "current", pr: pr.url };
}
