/** Linux group identity: boot plus kernel start ticks, never PID alone. */
import { readFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { CliError } from "./errors.js";

export interface JobProcess {
  groupId: number;
  startTime: string;
}

export async function readJobProcess(groupId: number): Promise<JobProcess | undefined> {
  if (process.platform !== "linux")
    throw new CliError(
      "Verified Claude process ownership requires Linux /proc. Use manual xpl revise on this platform.",
    );
  let stat: string;
  try {
    stat = await readFile("/proc/" + groupId + "/stat", "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
  // comm can contain spaces and parentheses. Fields after it begin with state (field 3).
  const fields = stat
    .slice(stat.lastIndexOf(")") + 2)
    .trim()
    .split(/\s+/);
  if (["Z", "X"].includes(fields[0]!) || Number(fields[2]) !== groupId) return undefined;
  const boot = (await readFile("/proc/sys/kernel/random/boot_id", "utf8")).trim();
  if (!/^[a-f0-9-]{36}$/.test(boot) || !/^\d+$/.test(fields[19] ?? ""))
    throw new CliError(
      "Cannot verify Claude process start time; inspect Linux /proc before retrying.",
    );
  return { groupId, startTime: boot + ":" + fields[19] };
}

export async function terminateJobProcess(identity: JobProcess): Promise<void> {
  if ((await readJobProcess(identity.groupId))?.startTime !== identity.startTime) return;
  try {
    process.kill(-identity.groupId, "SIGKILL");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
  }
  const deadline = Date.now() + 2000;
  while ((await readJobProcess(identity.groupId))?.startTime === identity.startTime) {
    if (Date.now() >= deadline)
      throw new CliError("Previous Claude group is still stopping; inspect it before retrying.");
    await delay(20);
  }
}
