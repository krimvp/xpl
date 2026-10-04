/** GitHub PR input identities. GitHub access is read-only and uses the configured gh CLI. */
import { execFile } from "node:child_process";
import type { Env } from "./context.js";
import { CliError, UsageError } from "./errors.js";
import { FULL_SHA } from "./git.js";

const REPOSITORY = /^[A-Za-z0-9][A-Za-z0-9-]*\/[A-Za-z0-9_.-]+$/;

export interface PrIdentity {
  repository: string;
  number: number;
  url: string;
}

export interface ResolvedPr extends PrIdentity {
  base: { repository: string; ref: string; sha: string };
  head: { repository: string | null; ref: string; sha: string };
}

export function parsePr(input: string, number?: string): PrIdentity {
  const url = /^https:\/\/github\.com\/([^/]+\/[^/]+)\/pull\/(\d+)\/?$/.exec(input);
  const shorthand = /^([^#]+)#(\d+)$/.exec(input);
  const repository = url?.[1] ?? shorthand?.[1] ?? input;
  const raw = url?.[2] ?? shorthand?.[2] ?? number;
  const n = raw && /^[1-9]\d*$/.test(raw) ? Number(raw) : NaN;
  if (
    !REPOSITORY.test(repository) ||
    [".", ".."].includes(repository.split("/")[1]!) ||
    !Number.isSafeInteger(n) ||
    ((url || shorthand) && number !== undefined)
  ) {
    throw new UsageError(
      "give a GitHub PR URL, owner/repo#number, or owner/repo followed by a positive PR number",
    );
  }
  return { repository, number: n, url: `https://github.com/${repository}/pull/${n}` };
}

/** A real process boundary: no shell, no prompts, bounded time and output. */
export function prProcess(
  command: string,
  args: string[],
  cwd: string,
  env: Env,
  signal?: AbortSignal,
): Promise<string> {
  const operation = args.find((arg) => !arg.startsWith("--")) ?? "";
  const childEnv: Env = {
    ...env,
    GH_PROMPT_DISABLED: "1",
    GIT_TERMINAL_PROMPT: "0",
    GIT_OPTIONAL_LOCKS: "0",
    GCM_INTERACTIVE: "Never",
  };
  if (command === "git") {
    // A caller's repository overrides must never redirect owned fetches into their checkout.
    for (const name of [
      "GIT_DIR",
      "GIT_WORK_TREE",
      "GIT_INDEX_FILE",
      "GIT_COMMON_DIR",
      "GIT_OBJECT_DIRECTORY",
      "GIT_ALTERNATE_OBJECT_DIRECTORIES",
      "GIT_NAMESPACE",
      "GIT_SHALLOW_FILE",
    ])
      delete childEnv[name];
    args = ["-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false", ...args];
  }
  return new Promise((resolve, reject) => {
    execFile(
      command,
      args,
      {
        cwd,
        env: childEnv,
        encoding: "utf8",
        maxBuffer: 32 * 1024 * 1024,
        timeout: 120_000,
        ...(signal ? { signal } : {}),
      },
      (error, stdout, stderr) => {
        if (error)
          reject(
            new CliError(
              `${command} ${operation} failed: ${stderr.trim().split("\n")[0] || error.message}`,
            ),
          );
        else resolve(stdout);
      },
    );
  });
}

export async function resolvePr(
  pr: PrIdentity,
  cwd: string,
  env: Env,
  signal?: AbortSignal,
): Promise<ResolvedPr> {
  let value: unknown;
  try {
    value = JSON.parse(
      await prProcess(
        "gh",
        ["api", "--hostname", "github.com", `repos/${pr.repository}/pulls/${pr.number}`],
        cwd,
        env,
        signal,
      ),
    );
  } catch (error) {
    throw new CliError(
      `cannot resolve ${pr.url}: ${error instanceof Error ? error.message : String(error)}. Check existing gh access to the repository and PR, then retry.`,
    );
  }
  if (!value || typeof value !== "object")
    throw new CliError("GitHub PR response is not an object");
  const data = value as Record<string, unknown>;
  const endpoint = (side: "base" | "head"): ResolvedPr["head"] => {
    const raw = data[side];
    if (!raw || typeof raw !== "object") throw new CliError(`GitHub PR response has no ${side}`);
    const item = raw as Record<string, unknown>;
    const repo = item.repo;
    const repository =
      repo === null
        ? null
        : repo && typeof repo === "object" && "full_name" in repo
          ? repo.full_name
          : undefined;
    if (
      typeof item.sha !== "string" ||
      !FULL_SHA.test(item.sha) ||
      typeof item.ref !== "string" ||
      item.ref === "" ||
      (repository !== null &&
        (typeof repository !== "string" ||
          !REPOSITORY.test(repository) ||
          [".", ".."].includes(repository.split("/")[1]!)))
    ) {
      throw new CliError(`GitHub PR response has an invalid ${side} commit or repository`);
    }
    return { repository, ref: item.ref, sha: item.sha };
  };
  const base = endpoint("base");
  const head = endpoint("head");
  if (data.number !== pr.number || base.repository?.toLowerCase() !== pr.repository.toLowerCase()) {
    throw new CliError("GitHub PR response does not match the requested repository and PR number");
  }
  return {
    ...pr,
    repository: base.repository,
    url: `https://github.com/${base.repository}/pull/${pr.number}`,
    base: { ...base, repository: base.repository },
    head,
  };
}
