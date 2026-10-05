/** One installed Claude Code process writes owned output; the scheduler validates a proposal or answer. */
import type { Duplex } from "node:stream";
import { spawn } from "node:child_process";
import { lstat, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { Ctx } from "./context.js";
import { CliError, errorMessage } from "./errors.js";
import { readJobProcess, terminateJobProcess, type JobProcess } from "./job-process.js";
import type { JobRunner, AnswerRunner, AnswerJob, Job } from "./jobs.js";
import { defaultSkillDir, verifySkill } from "./setup.js";

// The launcher retains group identity and reports Claude's exit on fd 3.
// Service teardown drains the group; EOF is the service-death guard.
const launcher = [
  "const {spawn}=require('node:child_process');",
  "const {Socket}=require('node:net');",
  "const life=new Socket({fd:3});",
  "const stop=()=>{try{process.kill(-process.pid,'SIGKILL');}catch{process.exit(1);}};",
  "const ended=code=>life.write(JSON.stringify({code})+'\\n');",
  "life.on('end',stop);life.on('error',stop);",
  "life.once('data',()=>{",
  "const child=spawn('claude',process.argv.slice(1),{stdio:['inherit','inherit','inherit']});",
  "child.on('error',e=>{console.error(e.code==='ENOENT'?'Claude Code is not installed on PATH. Install/restore the chosen CLI outside xpl, then retry.':e.message);ended(1);});",
  "child.on('exit',code=>ended(code??1));",
  "});",
].join("\n");

// Claude uses gitignore patterns for Edit permissions, including the Write tool.
const literal = (path: string) => path.replace(/[\\*?\[\]]/g, "\\$&");

function failure(text: string): string {
  if (/Claude Code is not installed on PATH/.test(text))
    return "Claude Code is not installed on PATH. Install/restore the chosen CLI outside xpl, then retry.";
  if (
    /not logged in|authentication|invalid.*(?:api.?key|token)|oauth.*expired|401|login required/i.test(
      text,
    )
  )
    return "Claude authentication failed. Log in with the installed Claude Code CLI outside xpl, then explicitly retry this job.";
  if (/rate.?limit|usage limit|quota|429/i.test(text))
    return "Claude is rate limited. Wait for the provider limit to reset, then explicitly retry this job.";
  if (/EACCES|EPERM|permission denied|read-only file system/i.test(text))
    return "Claude cannot access its runtime state or proposal output. Inspect the local sandbox/permissions and retry outside that restriction; xpl does not change credentials or user configuration.";
  return `Claude failed: ${text.trim().slice(-2000) || "no diagnostic output"}. Inspect the installed CLI/provider configuration, then explicitly retry.`;
}

function runner(ctx: Ctx, options: { skillDir?: string; timeoutMs?: number } = {}) {
  const timeoutMs = options.timeoutMs ?? 300_000;
  return async (
    job: Job | AnswerJob,
    signal: AbortSignal,
    progress: Parameters<JobRunner>[2],
    started: Parameters<JobRunner>[3],
  ) => {
    signal.throwIfAborted();
    await readJobProcess(process.pid);
    let skillDir: string;
    try {
      skillDir = await realpath(options.skillDir ?? defaultSkillDir(ctx.env));
      verifySkill(skillDir);
    } catch (error) {
      throw new CliError(
        `Installed code-explainer skill unavailable: ${errorMessage(error)}. Run xpl skill install --dir <folder>, select it with service --skill-dir <folder>, and retry.`,
      );
    }
    const root = await realpath(ctx.root);
    const directory = await mkdtemp(join(tmpdir(), "xpl-claude-"));
    const answering = "request" in job.input;
    const output = join(directory, answering ? "answer.json" : "proposal.json");
    try {
      // Snapshot context is owned by xpl, not writable by the agent.
      await writeFile(
        join(directory, "input.json"),
        "request" in job.input
          ? JSON.stringify(job.input)
          : await readFile(
              resolve(root, ".explainer/revisions", job.input.revisionRunId, "run.json"),
            ),
      );
      const settings = {
        disableAllHooks: true,
        permissions: {
          allow: [`Edit(/${literal(output)})`],
          deny: [`Edit(/${literal(root)}/**)`, `Edit(/${literal(skillDir)}/**)`],
        },
      };
      const prompt = [
        `Output: ${JSON.stringify(output)}`,
        ...(answering
          ? [
              `Use the installed code-explainer skill at ${skillDir}/SKILL.md and reference/writing.md.`,
              "Read input.json: it contains the immutable question request, guide, ArtifactIdentity, and recorded head/base sources. Answer the request.note about its element and/or exact range.",
              'Write one JSON object {"text":"answer", "references":[{"file":"recorded file", "side":"head or base", "fromLine":1, "toLine":2, "quote":"exact complete source lines"}]} to Output.',
              "Use only the recorded sources in input.json for evidence, never live repository source. Every reference must contain exact full lines with inclusive 1-based line numbers. Quote at least one relevant source range; preserve base/head side.",
              "Write plain words. No patches, guide changes or author outcome decisions. An answer stays in question history and does not accept a revision.",
            ]
          : [
              `Use the installed code-explainer skill at ${skillDir}/SKILL.md, reference/patch-format.md and reference/revise.md.`,
              `Read input.json: it contains the frozen revision selection, original requests, previous/resolved guide, include IDs and source. Repository: ${root}.`,
              `Write exactly one JSON array [{"id":"selected request ID","patch":{ordinary xpl patch}}] to Output, one entry per selected request.`,
              "Produce the requested creation or revision proposal. An initialized empty/draft guide can be filled only within its explicit include IDs. Preserve user fields and unrelated content; do not change title or scope.",
              "Read the actual source to check every claim. Use existing IDs and symbol/span anchors, never invent hashes. Follow the skill's writing and accuracy rules. No TODOs in required text.",
            ]),
        "Only the output file is writable. Do not run commands, apply patches, modify source/guide/index/requests, write decisions or accept anything. xpl validates the candidate after you exit; the author reviews and accepts later.",
        "If tooling or authentication prevents completion, report that failure instead of inventing output. Keep this task small and do not delegate.",
      ].join("\n");
      await progress(
        answering
          ? "Starting configured Claude Code with frozen question source."
          : "Starting configured Claude Code; source is read-only and output awaits review.",
      );
      signal.throwIfAborted();
      const child = spawn(
        process.execPath,
        [
          "-e",
          launcher,
          "--",
          "--print",
          "--output-format",
          "json",
          "--no-session-persistence",
          "--restricted",
          "--permission-mode",
          "dontAsk",
          "--permission-prompts",
          "none",
          "--tools",
          "Read,Glob,Grep,Write",
          "--settings",
          JSON.stringify(settings),
          "--strict-mcp-config",
          "--mcp-config",
          '{"mcpServers":{}}',
          "--disallowedTools",
          "mcp__*",
          "--add-dir",
          root,
          skillDir,
        ],
        {
          cwd: directory,
          env: ctx.env,
          detached: process.platform !== "win32",
          stdio: ["pipe", "pipe", "pipe", "pipe"],
        },
      );
      let identity: JobProcess | undefined;
      let tearingDown = false;
      let timer: ReturnType<typeof setTimeout> | undefined;
      let abort = () => {};
      let stdout = "",
        stderr = "";
      const life = child.stdio[3] as Duplex;
      // All post-spawn setup and failures share this finally, including identity reads.
      try {
        const spawned = new Promise<void>((resolve, reject) => {
          child.once("spawn", resolve);
          child.once("error", reject);
        });
        const ended = new Promise<number | null>((resolve, reject) => {
          abort = () => reject(new CliError("Claude attempt cancelled; output discarded."));
          signal.addEventListener("abort", abort, { once: true });
          timer = setTimeout(
            () =>
              reject(
                new CliError(
                  `Claude timed out after ${timeoutMs} ms. Inspect provider/tool availability or increase service --job-timeout, then explicitly retry.`,
                ),
              ),
            timeoutMs,
          );
          child.stdout!.on("data", (data: Buffer) => {
            stdout += data.toString();
            if (stdout.length > 1_000_000)
              reject(new CliError("Claude diagnostic output exceeded 1 MB; output discarded."));
          });
          child.stderr!.on("data", (data: Buffer) => {
            stderr = (stderr + data.toString()).slice(-8000);
          });
          child.stdin!.on("error", () => {});
          child.on("error", (error: Error) => reject(new CliError(failure(error.message))));
          child.on("exit", resolve);
          let status = "";
          life.on("data", (data: Buffer) => {
            status += data.toString();
            if (status.includes("\n")) {
              try {
                resolve((JSON.parse(status) as { code: number }).code);
              } catch {
                reject(new CliError("Claude launcher returned invalid exit status."));
              }
            }
          });
          life.on("error", () => {});
          if (signal.aborted) abort();
        });
        // Race setup too: a stopped service never waits on a stalled identity read or lock.
        const setup = (async () => {
          await spawned;
          identity = await readJobProcess(child.pid!);
          if (tearingDown) throw new CliError("Claude startup ended; output discarded.");
          if (!identity)
            throw new CliError("Claude launcher exited before ownership was recorded.");
          await started(identity);
          signal.throwIfAborted();
          if (tearingDown) throw new CliError("Claude startup ended; output discarded.");
          life.write("start");
          child.stdin!.end(prompt);
          return ended;
        })();
        const code = await Promise.race([setup, ended]);
        if (code !== 0)
          throw new CliError(
            failure(stderr + "\n" + stdout) + ` (Claude exit code ${code ?? "unavailable"}.)`,
          );
      } finally {
        tearingDown = true;
        clearTimeout(timer);
        signal.removeEventListener("abort", abort);
        await terminateJobProcess(identity ?? {}, child);
      }
      const text = stdout;
      signal.throwIfAborted();
      let data: unknown;
      try {
        data = JSON.parse(text);
      } catch {
        throw new CliError(failure(text));
      }
      if (!data || typeof data !== "object" || Array.isArray(data))
        throw new CliError(
          "Claude returned invalid JSON diagnostics. Inspect the installed CLI and explicitly retry.",
        );
      const result = data as { is_error?: boolean; result?: string; errors?: string[] };
      if (
        (result.result !== undefined && typeof result.result !== "string") ||
        (result.errors !== undefined &&
          (!Array.isArray(result.errors) || result.errors.some((e) => typeof e !== "string")))
      )
        throw new CliError(
          "Claude returned invalid JSON diagnostics. Inspect the installed CLI and explicitly retry.",
        );
      if (result.is_error)
        throw new CliError(failure(result.result ?? result.errors?.join("\n") ?? text));
      const info = await lstat(output).catch(() => {
        throw new CliError(
          "Claude produced no proposal file. Inspect tool permission failures and retry; stdout is not a proposal.",
        );
      });
      if (
        !info.isFile() ||
        info.nlink !== 1 ||
        info.size > 5_000_000 ||
        (await realpath(output)) !== output
      )
        throw new CliError(
          "Claude proposal must be a regular owned file of at most 5 MB; output discarded.",
        );
      let proposals: unknown;
      try {
        proposals = JSON.parse(await readFile(output, "utf8"));
      } catch {
        throw new CliError(
          "Claude proposal contains invalid JSON. Explicitly retry the configured runner; no proposal was published.",
        );
      }
      if (
        !answering &&
        (!Array.isArray(proposals) ||
          proposals.length !== job.selectedRequestIds.length ||
          proposals.some(
            (p) => !p || typeof p !== "object" || !job.selectedRequestIds.includes(p.id),
          ) ||
          new Set(proposals.map((p) => p.id)).size !== proposals.length)
      )
        throw new CliError(
          "Claude must produce one proposal per selected request; output discarded.",
        );
      signal.throwIfAborted();
      await progress(
        `Claude finished: ${(result.result ?? "proposal written").slice(0, 1500)}. Validating for review.`,
      );
      return "request" in job.input
        ? proposals
        : { revisionRunId: job.input.revisionRunId, proposals };
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  };
}

export function claudeRunner(
  ctx: Ctx,
  options: { skillDir?: string; timeoutMs?: number } = {},
): JobRunner {
  const invoke = runner(ctx, options);
  return async (...args) => (await invoke(...args)) as Awaited<ReturnType<JobRunner>>;
}

export function claudeAnswerRunner(
  ctx: Ctx,
  options: { skillDir?: string; timeoutMs?: number } = {},
): AnswerRunner {
  return runner(ctx, options);
}
