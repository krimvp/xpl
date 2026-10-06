/** Local ready versions. Readers follow one atomic symlink; failures retain the previous current version. */
import { createHash, randomUUID } from "node:crypto";
import {
  chmod,
  lstat,
  mkdtemp,
  readFile,
  realpath,
  readdir,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { basename, dirname, join, resolve, sep } from "node:path";
import { isDeepStrictEqual } from "node:util";
import {
  BUNDLE_SCRIPT_ID,
  artifactIdentity,
  checkReadiness,
  injectBundle,
  parseBundle,
  TextCache,
  baseFileOf,
  basePathOf,
  type ReadinessReport,
  type ViewerBundle,
  type PublishedVersion,
} from "@xpl/core";
import {
  collectBaseFiles,
  collectFiles,
  defaultIndexChoice,
  embedIndex,
  makeBundle,
  type FilesChoice,
} from "./bundle-data.js";
import type { Ctx } from "./context.js";
import { CliError, errorMessage } from "./errors.js";
import { jsonFile, withFileLock } from "./fsutil.js";
import { outsideSourceDirectory, verifyPrCheckout, type PrInputManifest } from "./pr-checkout.js";
import type { PrResultManifest } from "./pr-creation.js";
import { parsePr, prGitOptions, prProcess, resolvePr } from "./pr.js";
import { describeReadiness, workspaceReadiness } from "./readiness.js";
import { loadExplainer } from "./repo.js";
import { readViewerHtml } from "./viewer-html.js";

interface StageOptions {
  files?: FilesChoice;
  note?: string;
  requireReview: boolean;
  prResult?: string;
}

export interface VersionManifest extends PublishedVersion {
  schemaVersion: 1;
  kind: "xpl-ready-version";
  /** A directory locator, not a replacement for artifactIdentity. */
  inputs: { explainerSha256: string; indexSha256: string };
  artifacts: { html: { path: "index.html"; sha256: string } };
  readiness: ReadinessReport;
  prResult?: { sha256: string; manifest: PrResultManifest };
}

const sha256 = (bytes: string | Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const includedSource = (bundle: ViewerBundle) => ({
  head: Object.keys(bundle.files).sort(),
  base: Object.keys(bundle.baseFiles ?? {}).sort(),
});

async function regularBytes(path: string, root?: string): Promise<Buffer> {
  if (!(await lstat(path)).isFile() || (root && !(await realpath(path)).startsWith(root + sep)))
    throw new CliError(
      `staging input is not a regular file within its recorded directory: ${path}`,
    );
  return readFile(path);
}

async function checkedPrResult(ctx: Ctx, path: string, options: StageOptions) {
  path = resolve(ctx.cwd, path);
  const bytes = await regularBytes(path);
  const manifest = JSON.parse(bytes.toString()) as PrResultManifest;
  if (
    !manifest ||
    manifest.schemaVersion !== 1 ||
    manifest.kind !== "github-pr-result" ||
    manifest.status !== "ready" ||
    !manifest.readiness?.ready
  )
    throw new CliError(
      "PR staging requires a ready #33 result manifest; prepared or superseded results cannot become current",
    );
  let pr: ReturnType<typeof parsePr>;
  try {
    pr = parsePr(manifest.pr.url);
  } catch (error) {
    throw new CliError(`PR result has an invalid identity: ${errorMessage(error)}`);
  }
  if (
    pr.repository !== manifest.pr.repository ||
    pr.number !== manifest.pr.number ||
    !isDeepStrictEqual(manifest.observed, manifest.pr)
  )
    throw new CliError("PR result identity does not match its ready observation");
  const directory = await realpath(dirname(path));
  const file = async (entry: { path: string; sha256: string }, root: string) => {
    if (!entry || typeof entry.path !== "string" || !/^[a-f0-9]{64}$/.test(entry.sha256))
      throw new CliError("PR result has an invalid file identity");
    const content = await regularBytes(resolve(directory, entry.path), root);
    if (sha256(content) !== entry.sha256)
      throw new CliError(`PR result hash changed: ${entry.path}`);
    return content;
  };
  const input = JSON.parse(
    (await file(manifest.input, await realpath(dirname(directory)))).toString(),
  ) as PrInputManifest;
  const html = (await file(manifest.artifacts.html, directory)).toString();
  const explainerBytes = await file(manifest.artifacts.explainer, directory);
  const indexBytes = await file(manifest.artifacts.index, directory);
  const data = new RegExp(
    `<script id="${BUNDLE_SCRIPT_ID}" type="application/json">([\\s\\S]*?)</script>`,
  ).exec(html);
  if (!data) throw new CliError("PR result HTML has no checked xpl bundle");
  const bundle = parseBundle(data[1]!);
  const index = JSON.parse(indexBytes.toString());
  if (
    input.schemaVersion !== 1 ||
    input.kind !== "github-pr-input" ||
    !isDeepStrictEqual(input.pr, manifest.pr) ||
    input.index?.sha256 !== sha256(indexBytes) ||
    input.index.commit !== manifest.pr.head.sha ||
    index.commit !== manifest.pr.head.sha ||
    !isDeepStrictEqual(input.change, bundle.explainer.change) ||
    bundle.explainer.change?.head !== manifest.pr.head.sha ||
    bundle.explainer.change.base !== manifest.pr.base.sha ||
    !isDeepStrictEqual(JSON.parse(explainerBytes.toString()), bundle.explainer) ||
    !isDeepStrictEqual(artifactIdentity(bundle.explainer, index), manifest.readiness.identity) ||
    !isDeepStrictEqual(
      artifactIdentity(bundle.explainer, bundle.index),
      manifest.readiness.identity,
    ) ||
    !isDeepStrictEqual(bundle.exportInfo?.report, manifest.readiness) ||
    bundle.exportInfo?.status !== "ready" ||
    bundle.server ||
    bundle.sourceWarning ||
    !isDeepStrictEqual(includedSource(bundle), manifest.includedSource)
  )
    throw new CliError("PR result artifacts do not describe the recorded ready snapshot");
  const texts = new TextCache(
    (file) => bundle.files[file],
    (commit, file) => {
      const changed = bundle.explainer.change && baseFileOf(bundle.explainer.change, file);
      return commit === bundle.explainer.change?.base && changed && basePathOf(changed) === file
        ? bundle.baseFiles?.[changed.path]
        : undefined;
    },
  );
  const report = checkReadiness(bundle.explainer, bundle.index, texts, {
    scope: "embedded-snapshot",
    requireReview: options.requireReview || manifest.readiness.review?.required === true,
  });
  if (!report.ready) throw new CliError(describeReadiness(report), 1, { readiness: report });
  // A result stays tied to its prepared source tree; it cannot relabel a different working checkout.
  const repository = await realpath(join(dirname(directory), "repository"));
  if ((await realpath(ctx.root)) !== repository)
    throw new CliError(
      `stage this PR guide with --root ${repository}; keep its prepared checkout for freshness checks`,
    );
  const gitOptions = prGitOptions(ctx.env, repository);
  const head = (
    await prProcess(
      "git",
      ["rev-parse", "HEAD"],
      repository,
      gitOptions.env,
      ctx.io.signal,
      gitOptions,
    )
  ).trim();
  if (head !== manifest.pr.head.sha)
    throw new CliError("prepared PR checkout HEAD changed; prepare the PR again");
  await verifyPrCheckout(ctx, repository, manifest.pr.head.sha, true);
  return { html, bundle, manifest, sha256: sha256(bytes) };
}

export async function stagePreview(ctx: Ctx, name: string, options: StageOptions) {
  const loaded = loadExplainer(ctx, name);
  const pr = options.prResult ? await checkedPrResult(ctx, options.prResult, options) : undefined;
  if (
    !pr &&
    (/^https:\/\/github\.com\/[^/]+\/[^/]+\/pull\/[1-9]\d*\/?$/.test(
      loaded.explainer.repo.url ?? "",
    ) ||
      (await lstat(join(dirname(await realpath(ctx.root)), ".xpl-pr-owned.json")).then(
        () => true,
        () => false,
      )))
  )
    throw new CliError(
      "PR guides require --pr-result <ready-result.json> from xpl pr finish before staging",
    );
  const { ws, explainer, report } = await workspaceReadiness(
    ctx,
    loaded,
    options.note ?? pr?.manifest.readiness.decisionNote,
    options.requireReview || pr?.manifest.readiness.review?.required === true,
  );
  if (!report.ready) throw new CliError(describeReadiness(report), 1, { readiness: report });
  const inputs = {
    explainerSha256: sha256(await regularBytes(loaded.abs)),
    indexSha256: sha256(await regularBytes(ws.indexFile)),
  };
  let bundle: ViewerBundle;
  if (pr) {
    if (
      !isDeepStrictEqual(report.identity, pr.manifest.readiness.identity) ||
      inputs.indexSha256 !== pr.manifest.artifacts.index.sha256
    )
      throw new CliError(
        "PR guide or index differs from its ready result; run xpl pr finish again",
      );
    bundle = pr.bundle;
  } else {
    const files = collectFiles({
      root: ctx.root,
      index: ws.model,
      texts: ws.texts,
      explainer,
      choice: options.files ?? "referenced",
    });
    const index = embedIndex({
      index: ws.index,
      model: ws.model,
      explainer,
      files: files.paths,
      choice: defaultIndexChoice(files.choice),
    }).index;
    const base = collectBaseFiles(explainer, ws.texts);
    bundle = makeBundle({
      explainer,
      index,
      files: files.files,
      ...(base ? { baseFiles: base.files } : {}),
    });
    bundle.exportInfo = { status: "ready", report };
  }
  return { bundle, report, inputs, includedSource: includedSource(bundle), pr };
}

export async function stageVersion(
  ctx: Ctx,
  name: string,
  destination: string,
  options: StageOptions,
  preview: Awaited<ReturnType<typeof stagePreview>>,
) {
  destination = await outsideSourceDirectory(ctx, destination);
  const current = join(destination, "current");
  let promoted:
    { directory: string; current: string; version: string; manifest: VersionManifest } | undefined;
  return withFileLock(current, async () => {
    // Recheck canonical storage after waiting for a writer; source aliases must never become output.
    if ((await outsideSourceDirectory(ctx, destination)) !== destination)
      throw new CliError("staging directory changed while waiting for its lock");
    const directory = await mkdtemp(join(destination, "version-"));
    const pointer = join(destination, `.current-${randomUUID()}`);
    try {
      const currentVersion: PublishedVersion = {
        version: basename(directory),
        createdAt: new Date().toISOString(),
        commits: {
          index: preview.bundle.index.commit,
          ...(preview.bundle.explainer.change
            ? {
                base: preview.bundle.explainer.change.base,
                head: preview.bundle.explainer.change.head,
              }
            : {}),
        },
        identity: preview.report.identity,
        includedSource: preview.includedSource,
        review: preview.report.review,
      };
      const previous: PublishedVersion[] = [];
      for (const entry of (await readdir(destination)).sort()) {
        if (!/^version-[A-Za-z0-9_-]+$/.test(entry) || entry === currentVersion.version) continue;
        const old = JSON.parse(
          (await regularBytes(join(destination, entry, "manifest.json"), destination)).toString(),
        ) as VersionManifest;
        if (old.kind !== "xpl-ready-version" || old.version !== entry || !old.readiness.ready)
          throw new CliError(`invalid retained version manifest: ${entry}`);
        const { version, createdAt, commits, identity, includedSource, review } = old;
        previous.push({ version, createdAt, commits, identity, includedSource, review });
      }
      previous.sort(
        (a, b) => b.createdAt.localeCompare(a.createdAt) || a.version.localeCompare(b.version),
      );
      const html = injectBundle(
        preview.pr?.html ?? readViewerHtml(ctx.env),
        {
          ...preview.bundle,
          publication: { current: currentVersion, previous },
        },
        { packIndex: true },
      );
      const manifest: VersionManifest = {
        ...currentVersion,
        schemaVersion: 1,
        kind: "xpl-ready-version",
        inputs: preview.inputs,
        artifacts: { html: { path: "index.html", sha256: sha256(html) } },
        readiness: preview.report,
        ...(preview.pr
          ? { prResult: { sha256: preview.pr.sha256, manifest: preview.pr.manifest } }
          : {}),
      };
      // Check retained metadata with the same reader contract before it can become current.
      parseBundle(
        new RegExp(
          `<script id="${BUNDLE_SCRIPT_ID}" type="application/json">([\\s\\S]*?)</script>`,
        ).exec(html)![1]!,
      );
      await writeFile(join(directory, "index.html"), html, { flag: "wx", mode: 0o444 });
      await writeFile(join(directory, "manifest.json"), jsonFile(manifest), {
        flag: "wx",
        mode: 0o444,
      });
      await chmod(directory, 0o555);
      await symlink(basename(directory), pointer, "dir");
      if (!ctx.json)
        ctx.out(`Staged ${basename(directory)}; rechecking readiness before promotion.`);
      if (preview.pr) {
        const observed = await resolvePr(preview.pr.manifest.pr, ctx.cwd, ctx.env, ctx.io.signal);
        if (
          observed.base.sha !== preview.pr.manifest.pr.base.sha ||
          observed.head.sha !== preview.pr.manifest.pr.head.sha
        )
          throw new CliError(
            "PR result is superseded: GitHub base or head changed; prepare and finish the new input before staging",
          );
      }
      const fresh = await stagePreview(ctx, name, options);
      if (
        !isDeepStrictEqual(fresh.inputs, preview.inputs) ||
        !isDeepStrictEqual(fresh.report.identity, preview.report.identity) ||
        !isDeepStrictEqual(fresh.bundle, preview.bundle) ||
        fresh.pr?.sha256 !== preview.pr?.sha256
      )
        throw new CliError(
          "guide, index or included source changed during staging; retry with a fresh preview",
        );
      ctx.io.signal?.throwIfAborted();
      await rename(pointer, current);
      promoted = {
        directory,
        current: join(current, "index.html"),
        version: basename(directory),
        manifest,
      };
      return promoted;
    } catch (error) {
      await rm(pointer, { force: true });
      await chmod(directory, 0o700);
      await rm(directory, { recursive: true, force: true });
      throw new CliError(
        `staging failed; previous current version retained: ${errorMessage(error)}`,
        1,
        error instanceof CliError ? error.extra : undefined,
      );
    }
  }).catch((error) => {
    if (!promoted) throw error;
    // The atomic rename committed the version. Lock cleanup cannot turn it into a failed promotion.
    ctx.warn(
      `version promoted, but could not release ${current}.lock: ${errorMessage(error)}. Verify the writer stopped, remove the lock directory and retry future staging.`,
    );
    return promoted;
  });
}
