/** One installed Claude Code process writes an owned proposal; the job scheduler validates and journals it. */
import { spawn } from "node:child_process";
import { lstat, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { Ctx } from "./context.js";
import { CliError, errorMessage } from "./errors.js";
import type { JobRunner } from "./jobs.js";
import { defaultSkillDir, verifySkill } from "./setup.js";

// Claude uses gitignore patterns for Edit permissions, including the Write tool.
const literal = (path: string) => path.replace(/[\\*?\[\]]/g, "\\$&");

function failure(text: string): string {
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

export function claudeRunner(
  ctx: Ctx,
  options: { skillDir?: string; timeoutMs?: number } = {},
): JobRunner {
  const timeoutMs = options.timeoutMs ?? 300_000;
  return async (job, signal, progress) => {
    signal.throwIfAborted();
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
    const output = join(directory, "proposal.json");
    try {
      const journal = resolve(root, ".explainer/revisions", job.input.revisionRunId, "run.json");
      // Snapshot context is owned by xpl, not writable by the agent.
      await writeFile(join(directory, "input.json"), await readFile(journal));
      const settings = {
        disableAllHooks: true,
        permissions: {
          allow: [`Edit(/${literal(output)})`],
          deny: [`Edit(/${literal(root)}/**)`, `Edit(/${literal(skillDir)}/**)`],
        },
      };
      const prompt = [
        `Output: ${JSON.stringify(output)}`,
        `Use the installed code-explainer skill at ${skillDir}/SKILL.md, reference/patch-format.md and reference/revise.md.`,
        `Read input.json: it contains the frozen revision selection, original requests, previous/resolved guide, include IDs and source. Repository: ${root}.`,
        `Write exactly one JSON array [{"id":"selected request ID","patch":{ordinary xpl patch}}] to Output, one entry per selected request.`,
        "Produce the requested creation or revision proposal. An initialized empty/draft guide can be filled only within its explicit include IDs. Preserve user fields and unrelated content; do not change title or scope.",
        "Read the actual source to check every claim. Use existing IDs and symbol/span anchors, never invent hashes. Follow the skill's writing and accuracy rules. No TODOs in required text.",
        "Only the proposal file is writable. Do not run commands, apply patches, modify source/guide/index/requests, write decisions or accept anything. xpl validates the candidate after you exit; the author reviews and accepts later.",
        "If tooling or authentication prevents completion, report that failure instead of inventing output. Keep this task small and do not delegate.",
      ].join("\n");
      await progress(
        "Starting configured Claude Code; source is read-only and output awaits review.",
      );
      signal.throwIfAborted();
      const text = await new Promise<string>((yes, no) => {
        const child = spawn(
          "claude",
          [
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
            stdio: ["pipe", "pipe", "pipe"],
          },
        );
        let stdout = "",
          stderr = "";
        let stopped: Error | undefined;
        const kill = (error: Error) => {
          stopped ??= error;
          try {
            if (child.pid && process.platform !== "win32") process.kill(-child.pid, "SIGKILL");
            else child.kill("SIGKILL");
          } catch {
            child.kill("SIGKILL");
          }
        };
        const abort = () => kill(new CliError("Claude attempt cancelled; output discarded."));
        const timer = setTimeout(
          () =>
            kill(
              new CliError(
                `Claude timed out after ${timeoutMs} ms. Inspect provider/tool availability or increase service --job-timeout, then explicitly retry.`,
              ),
            ),
          timeoutMs,
        );
        signal.addEventListener("abort", abort, { once: true });
        child.stdout.on("data", (data: Buffer) => {
          stdout += data.toString();
          if (stdout.length > 1_000_000)
            kill(new CliError("Claude diagnostic output exceeded 1 MB; output discarded."));
        });
        child.stderr.on("data", (data: Buffer) => {
          stderr = (stderr + data.toString()).slice(-8000);
        });
        child.stdin.on("error", () => {}); // A failed spawn or early provider exit can close stdin first.
        child.on("error", (error: NodeJS.ErrnoException) => {
          stopped = new CliError(
            error.code === "ENOENT"
              ? "Claude Code is not installed on PATH. Install/restore the chosen CLI outside xpl, then retry."
              : failure(error.message),
          );
        });
        child.on("close", (code) => {
          clearTimeout(timer);
          signal.removeEventListener("abort", abort);
          if (stopped) no(stopped);
          else if (code !== 0) no(new CliError(failure(stderr + "\n" + stdout)));
          else yes(stdout);
        });
        if (signal.aborted) abort();
        child.stdin.end(prompt);
      });
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
        !Array.isArray(proposals) ||
        proposals.length !== job.selectedRequestIds.length ||
        proposals.some(
          (p) => !p || typeof p !== "object" || !job.selectedRequestIds.includes(p.id),
        ) ||
        new Set(proposals.map((p) => p.id)).size !== proposals.length
      )
        throw new CliError(
          "Claude must produce one proposal per selected request; output discarded.",
        );
      signal.throwIfAborted();
      await progress(
        `Claude finished: ${(result.result ?? "proposal written").slice(0, 1500)}. Validating for review.`,
      );
      return { revisionRunId: job.input.revisionRunId, proposals };
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  };
}
