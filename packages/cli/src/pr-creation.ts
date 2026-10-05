/** Explicit installed-skill handoff and local PR results. No model runner or current-version publisher. */
import { createHash } from "node:crypto";
import { chmod, lstat, mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import { BUNDLE_SCRIPT_ID, artifactIdentity, parseBundle, type ReadinessReport } from "@xpl/core";
import type { Ctx } from "./context.js";
import { CliError } from "./errors.js";
import { atomicWrite, jsonFile, toPosix, withFileLock } from "./fsutil.js";
import { ownedPrDirectory, verifyPrCheckout, type PrInputManifest } from "./pr-checkout.js";
import { PR_GIT_OVERRIDES, prGitOptions, prProcess, resolvePr, type ResolvedPr } from "./pr.js";
import { defaultSkillDir, verifySkill } from "./setup.js";

interface FileIdentity {
  path: string;
  sha256: string;
}
interface SkillIdentity {
  directory: string;
  launcher: string;
  cli: string;
  cliSha256: string;
}
interface PrHandoff {
  schemaVersion: 1;
  kind: "github-pr-creation";
  inputSha256: string;
  name: string;
  skill: SkillIdentity;
  invocation: string;
  command: string[];
  commands: string[][];
}

/** #34 consumes ready results and must recheck their PR before its own current-version publication. */
export interface PrResultManifest {
  schemaVersion: 1;
  kind: "github-pr-result";
  status: "ready" | "superseded";
  input: FileIdentity;
  pr: ResolvedPr;
  checkedAt: string;
  observed: ResolvedPr;
  skill: SkillIdentity;
  readiness: ReadinessReport;
  artifacts: { explainer: FileIdentity; index: FileIdentity; html: FileIdentity };
  includedSource: { head: string[]; base: string[] };
}

const sha256 = (bytes: Uint8Array | string) => createHash("sha256").update(bytes).digest("hex");

async function regularBytes(path: string, root?: string): Promise<Buffer> {
  if (!(await lstat(path)).isFile() || (root && !(await realpath(path)).startsWith(root + "/")))
    throw new CliError(`PR artifact is not a regular owned file: ${path}`);
  return readFile(path);
}

async function skillIdentity(directory: string): Promise<SkillIdentity> {
  try {
    directory = await realpath(directory);
    const skill = verifySkill(directory);
    const cli = skill.cli!; // verifySkill requires an absolute CLI binding.
    return {
      directory,
      launcher: join(directory, "bin/xpl"),
      cli,
      cliSha256: sha256(await regularBytes(cli)),
    };
  } catch (error) {
    throw new CliError(
      `installed PR creation skill is unavailable: ${error instanceof Error ? error.message : String(error)}. Run xpl skill install --dir <folder> and retry; no agent was started.`,
    );
  }
}

/** Child commands include legacy helpers that read process.env; bind that process to the owned repository. */
async function installedCommand(
  ctx: Ctx,
  input: { repository: string; indexPath: string },
  skill: SkillIdentity,
  args: string[],
) {
  const current = await skillIdentity(skill.directory);
  if (JSON.stringify(current) !== JSON.stringify(skill))
    throw new CliError(
      "installed CLI binding changed during PR creation; explicitly recreate the handoff with the intended installation",
    );
  const env: Ctx["env"] = {
    ...prGitOptions(ctx.env).env,
    XPL_CLI: skill.cli,
    GIT_DIR: join(input.repository, ".git"),
    GIT_WORK_TREE: input.repository,
    GIT_CONFIG_COUNT: "2",
    GIT_CONFIG_KEY_0: "core.hooksPath",
    GIT_CONFIG_VALUE_0: "/dev/null",
    GIT_CONFIG_KEY_1: "core.fsmonitor",
    GIT_CONFIG_VALUE_1: "false",
  };
  delete env.GIT_CONFIG_PARAMETERS;
  return prProcess(
    process.execPath,
    [skill.launcher, ...args, "--root", input.repository, "--index", input.indexPath, "--json"],
    input.repository,
    env,
    ctx.io.signal,
  );
}

async function loadInput(ctx: Ctx, directory: string, cache: string) {
  directory = await ownedPrDirectory(ctx, directory, cache);
  const repository = join(directory, "repository");
  if (
    (await realpath(repository)) !== repository ||
    !(await lstat(join(repository, ".git"))).isDirectory()
  )
    throw new CliError("PR repository no longer belongs to its owned input");
  const bytes = await regularBytes(join(directory, "input.json"), directory);
  const manifest = JSON.parse(bytes.toString()) as PrInputManifest;
  if (
    manifest.kind !== "github-pr-input" ||
    manifest.schemaVersion !== 1 ||
    manifest.change.head !== manifest.pr.head.sha ||
    manifest.change.base !== manifest.pr.base.sha ||
    manifest.index.commit !== manifest.pr.head.sha
  )
    throw new CliError("PR input identity is invalid; prepare the PR again");
  const indexPath = resolve(directory, manifest.index.path);
  if (
    !indexPath.startsWith(repository + "/") ||
    sha256(await regularBytes(indexPath, repository)) !== manifest.index.sha256
  )
    throw new CliError("PR input index changed; prepare the PR again instead of relabeling source");
  const options = prGitOptions(ctx.env, repository);
  const head = (
    await prProcess("git", ["rev-parse", "HEAD"], repository, options.env, ctx.io.signal, options)
  ).trim();
  if (head !== manifest.pr.head.sha)
    throw new CliError("owned checkout HEAD changed; prepare the PR again");
  return { directory, repository, indexPath, manifest, inputSha256: sha256(bytes) };
}

async function immutable(path: string, bytes: string | Uint8Array) {
  await atomicWrite(path, typeof bytes === "string" ? bytes : Buffer.from(bytes).toString());
  await chmod(path, 0o444);
}

export async function createPrHandoff(
  ctx: Ctx,
  prepared: { directory: string; repository: string; manifest: PrInputManifest },
  name: string,
  audience: string,
  question: string,
  skillDir?: string,
) {
  const skill = await skillIdentity(resolve(ctx.cwd, skillDir ?? defaultSkillDir(ctx.env)));
  const input = {
    repository: prepared.repository,
    indexPath: resolve(prepared.directory, prepared.manifest.index.path),
  };
  const range = `${prepared.manifest.pr.base.sha}..${prepared.manifest.pr.head.sha}`;
  const commands = [
    [
      "new",
      name,
      "--title",
      `PR #${prepared.manifest.pr.number}: ${question}`,
      "--repo",
      prepared.manifest.pr.repository,
      "--url",
      prepared.manifest.pr.url,
    ],
    ["change", name, range],
    [
      "draft",
      "change",
      name,
      "--audience",
      audience,
      "--question",
      question,
      "-o",
      join(prepared.directory, "draft.json"),
    ],
  ];
  for (const command of commands) await installedCommand(ctx, input, skill, command);
  const command = [
    "env",
    ...[...PR_GIT_OVERRIDES, "GIT_CONFIG_PARAMETERS"].flatMap((key) => ["-u", key]),
    `GIT_DIR=${join(input.repository, ".git")}`,
    `GIT_WORK_TREE=${input.repository}`,
    `XPL_CLI=${skill.cli}`,
    "GIT_CONFIG_COUNT=2",
    "GIT_CONFIG_KEY_0=core.hooksPath",
    "GIT_CONFIG_VALUE_0=/dev/null",
    "GIT_CONFIG_KEY_1=core.fsmonitor",
    "GIT_CONFIG_VALUE_1=false",
    process.execPath,
    skill.launcher,
    "--root",
    input.repository,
    "--index",
    input.indexPath,
  ];
  const shellCommand = command.map((arg) => "'" + arg.replaceAll("'", "'\"'\"'") + "'").join(" ");
  const invocation = `/code-explainer explain change ${range}. Root: ${prepared.repository}. Audience: ${audience}. Question: ${question}. Existing guide: ${name}. Read the installed skill at ${skill.directory}/SKILL.md and reference/create.md. Run every authoring command with this owned Git prefix: ${shellCommand} <command arguments>. This calls the installed launcher ${skill.launcher} bound to ${skill.cli}; preserve the existing head index. Input evidence: ${prepared.directory}/input.json. Draft: ${prepared.directory}/draft.json. Write patches outside the repository, then lint and apply through the launcher. Finish with xpl pr finish ${prepared.directory} --cache-dir ${resolve(prepared.directory, "..")} after the accuracy pass. Source is read-only; no model or service is started by this handoff.`;
  const handoff: PrHandoff = {
    schemaVersion: 1,
    kind: "github-pr-creation",
    inputSha256: sha256(await readFile(join(prepared.directory, "input.json"))),
    name,
    skill,
    invocation,
    command,
    commands,
  };
  await immutable(join(prepared.directory, "handoff.json"), jsonFile(handoff));
  return { handoffPath: join(prepared.directory, "handoff.json"), invocation };
}

export async function finishPr(
  ctx: Ctx,
  directory: string,
  cache: string,
  note?: string,
  requireReview = false,
) {
  directory = await ownedPrDirectory(ctx, directory, cache);
  return withFileLock(join(directory, "result.json"), async () => {
    const input = await loadInput(ctx, directory, cache);
    await verifyPrCheckout(ctx, input.repository, input.manifest.pr.head.sha, true);
    const handoff = JSON.parse(
      (await regularBytes(join(directory, "handoff.json"), directory)).toString(),
    ) as PrHandoff;
    if (
      handoff.kind !== "github-pr-creation" ||
      handoff.schemaVersion !== 1 ||
      handoff.inputSha256 !== input.inputSha256 ||
      !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(handoff.name)
    )
      throw new CliError("PR creation handoff does not match its immutable input");
    const explainerPath = join(input.repository, ".explainer", `${handoff.name}.explainer.json`);
    const explainerBytes = await regularBytes(explainerPath, input.repository);
    const authored = JSON.parse(explainerBytes.toString());
    if (
      JSON.stringify(authored.change) !== JSON.stringify(input.manifest.change) ||
      authored.index?.commit !== input.manifest.index.commit ||
      resolve(input.repository, authored.index?.path ?? "") !== input.indexPath
    )
      throw new CliError(
        "guide no longer records this exact PR input change and index; restore the recorded range before finishing",
      );
    const resultDirectory = await mkdtemp(join(directory, "result-"));
    try {
      const htmlPath = join(resultDirectory, "guide.html");
      await installedCommand(ctx, input, handoff.skill, [
        "bundle",
        handoff.name,
        "-o",
        htmlPath,
        "--files",
        "boundary",
        ...(note ? ["--note", note] : []),
        ...(requireReview ? ["--require-review"] : []),
      ]);
      const html = await regularBytes(htmlPath, resultDirectory);
      const data = new RegExp(
        `<script id="${BUNDLE_SCRIPT_ID}" type="application/json">([\\s\\S]*?)</script>`,
      ).exec(html.toString());
      if (!data) throw new CliError("installed CLI export has no checked xpl bundle");
      const bundle = parseBundle(data[1]!);
      if (
        bundle.exportInfo?.status !== "ready" ||
        !bundle.exportInfo.report.ready ||
        JSON.stringify(bundle.explainer.change) !== JSON.stringify(input.manifest.change) ||
        JSON.stringify(artifactIdentity(bundle.explainer, bundle.index)) !==
          JSON.stringify(bundle.exportInfo.report.identity)
      )
        throw new CliError("installed CLI did not export this PR as a checked ready snapshot");
      // Never copy newer authored text beside an older export or promote a changed input index.
      if (
        sha256(await regularBytes(explainerPath, input.repository)) !== sha256(explainerBytes) ||
        sha256(await regularBytes(input.indexPath, input.repository)) !==
          input.manifest.index.sha256
      )
        throw new CliError(
          "guide or input index changed during export; finish again after authoring stops",
        );
      await immutable(join(resultDirectory, "guide.explainer.json"), jsonFile(bundle.explainer));
      await immutable(
        join(resultDirectory, "index.json"),
        await regularBytes(input.indexPath, input.repository),
      );
      await chmod(htmlPath, 0o444);
      await verifyPrCheckout(ctx, input.repository, input.manifest.pr.head.sha, true);
      const observed = await resolvePr(input.manifest.pr, ctx.cwd, ctx.env, ctx.io.signal);
      const status =
        observed.base.sha === input.manifest.pr.base.sha &&
        observed.head.sha === input.manifest.pr.head.sha
          ? "ready"
          : "superseded";
      const file = async (path: string): Promise<FileIdentity> => ({
        path: toPosix(relative(resultDirectory, path)),
        sha256: sha256(await regularBytes(path)),
      });
      const manifest: PrResultManifest = {
        schemaVersion: 1,
        kind: "github-pr-result",
        status,
        input: {
          path: toPosix(relative(resultDirectory, join(directory, "input.json"))),
          sha256: input.inputSha256,
        },
        pr: input.manifest.pr,
        checkedAt: new Date().toISOString(),
        observed,
        skill: handoff.skill,
        readiness: bundle.exportInfo.report,
        artifacts: {
          explainer: await file(join(resultDirectory, "guide.explainer.json")),
          index: await file(join(resultDirectory, "index.json")),
          html: await file(htmlPath),
        },
        includedSource: {
          head: Object.keys(bundle.files).sort(),
          base: Object.keys(bundle.baseFiles ?? {}).sort(),
        },
      };
      ctx.io.signal?.throwIfAborted();
      const manifestPath = join(resultDirectory, "result.json");
      await immutable(manifestPath, jsonFile(manifest));
      return { directory: resultDirectory, manifestPath, status, manifest };
    } catch (error) {
      await rm(resultDirectory, { recursive: true, force: true });
      throw new CliError(
        `PR result was not promoted: ${error instanceof Error ? error.message : String(error)}. Input and authored guide retained; repair or explicitly prepare the updated PR, then retry.`,
      );
    }
  });
}
