/** Linux group identity: boot plus kernel start ticks, never PID alone. */
import { readFile, readdir } from "node:fs/promises";
import type { ChildProcess } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { CliError } from "./errors.js";

export interface JobProcess {
  groupId: number;
  startTime: string;
}

/** A failed teardown may know the group without having verified its start time. */
export interface JobCleanup {
  groupId?: number;
  startTime?: string;
}

async function processFields(pid: number): Promise<string[] | undefined> {
  let stat: string;
  try {
    stat = await readFile("/proc/" + pid + "/stat", "utf8");
  } catch (error) {
    if (["ENOENT", "ESRCH"].includes((error as NodeJS.ErrnoException).code ?? "")) return undefined;
    throw error;
  }
  // comm can contain spaces and parentheses. Fields after it begin with state (field 3).
  return stat
    .slice(stat.lastIndexOf(")") + 2)
    .trim()
    .split(/\s+/);
}

export async function readJobProcess(groupId: number): Promise<JobProcess | undefined> {
  if (process.platform !== "linux")
    throw new CliError(
      "Verified Claude process ownership requires Linux /proc. Use manual xpl revise on this platform.",
    );
  const fields = await processFields(groupId);
  if (!fields) return undefined;
  if (["Z", "X"].includes(fields[0]!) || Number(fields[2]) !== groupId) return undefined;
  const boot = (await readFile("/proc/sys/kernel/random/boot_id", "utf8")).trim();
  if (!/^[a-f0-9-]{36}$/.test(boot) || !/^\d+$/.test(fields[19] ?? ""))
    throw new CliError(
      "Cannot verify Claude process start time; inspect Linux /proc before retrying.",
    );
  return { groupId, startTime: boot + ":" + fields[19] };
}

export async function terminateJobProcess(
  identity: JobCleanup,
  child?: ChildProcess,
): Promise<void> {
  const groupId = identity.groupId ?? child?.pid;
  const verified = !!identity.startTime;
  let stage = "identity check";
  let members: number[] | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error("two-second cleanup deadline expired")), 2000);
  });
  const wait = <T>(work: Promise<T>) => Promise.race([work, expired]);
  const exited =
    child && child.pid && child.exitCode === null && child.signalCode === null
      ? new Promise<void>((resolve) => child.once("exit", () => resolve()))
      : Promise.resolve();
  try {
    if (!groupId) {
      if (!child) throw new Error("group identity unknown; inspect before recovery");
      return; // Failed spawn: no process exists.
    }
    const current = verified ? await wait(readJobProcess(groupId)) : undefined;
    if (current && current.startTime !== identity.startTime) return;
    if (current) {
      try {
        process.kill(-groupId, "SIGKILL");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
      }
    } else if (!verified && child && child.exitCode === null && child.signalCode === null) {
      // Claude cannot start before identity registration. This handle still owns the unstarted launcher.
      child.kill("SIGKILL");
    }
    // The leader can exit first. Zombies cannot execute; only the OS can reap them.
    stage = "group drain";
    while (true) {
      const processes = (await wait(readdir("/proc"))).filter((pid) => /^\d+$/.test(pid));
      const fields = await wait(Promise.all(processes.map((pid) => processFields(Number(pid)))));
      members = processes
        .filter((_, i) => {
          const f = fields[i];
          return f && !["Z", "X"].includes(f[0]!) && Number(f[2]) === groupId;
        })
        .map(Number);
      if (!members.length) break;
      await wait(delay(20));
    }
    stage = "launcher exit";
    await wait(exited); // Stream close is unrelated: a process outside the group can hold the pipes.
  } catch (error) {
    throw new CliError(
      `JOB_PROCESS_CLEANUP: group ${groupId ?? "unknown"} (verified: ${verified}); ${stage}; ` +
        `live members: ${members?.join(",") || (members ? "none" : "unknown")}. ` +
        (error instanceof Error ? error.message : String(error)),
      1,
      { code: "JOB_PROCESS_CLEANUP", groupId, startTime: identity.startTime, verified },
    );
  } finally {
    clearTimeout(timer);
    // Destroy inherited pipes on success or deadline; they must never retain the service.
    for (const stream of child?.stdio ?? []) stream?.destroy();
    child?.unref(); // A failed cleanup stays fenced in the ledger, not in the service's event loop.
  }
}
