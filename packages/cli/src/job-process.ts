/** Linux group identity: boot plus kernel start ticks, never PID alone. */
import { readFile, readdir } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { CliError } from "./errors.js";

export interface JobProcess {
  groupId: number;
  startTime: string;
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

export async function terminateJobProcess(identity: JobProcess): Promise<void> {
  try {
    const current = await readJobProcess(identity.groupId);
    if (current && current.startTime !== identity.startTime) return;
    if (current) {
      try {
        process.kill(-identity.groupId, "SIGKILL");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
      }
    }
    // The leader can exit first. Zombies cannot execute; only the OS can reap them.
    const deadline = Date.now() + 2000;
    while (true) {
      const processes = await readdir("/proc");
      const fields = await Promise.all(
        processes.filter((pid) => /^\d+$/.test(pid)).map((pid) => processFields(Number(pid))),
      );
      if (
        !fields.some((f) => f && !["Z", "X"].includes(f[0]!) && Number(f[2]) === identity.groupId)
      )
        return;
      if (Date.now() >= deadline)
        throw new Error("Claude group still has live members; inspect it before recovery.");
      await delay(20);
    }
  } catch (error) {
    throw new CliError(
      "Claude process-group cleanup failed: " +
        (error instanceof Error ? error.message : String(error)),
      1,
      { code: "JOB_PROCESS_CLEANUP" },
    );
  }
}
