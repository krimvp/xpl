/** Local artifact checks and skill installation. No downloads or agent invocation. */
import { createHash } from "node:crypto";
import { existsSync, lstatSync, readFileSync, readdirSync } from "node:fs";
import { chmod, copyFile, mkdir, mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { allWasmSources } from "@xpl/indexer";
import type { Env } from "./context.js";
import { CliError } from "./errors.js";
import { withFileLock } from "./fsutil.js";

const here = dirname(fileURLToPath(import.meta.url));
export const artifactDir =
  basename(fileURLToPath(import.meta.url)) === "xpl.mjs" ? here : resolve(here, "../dist");

export type SkillAgent = "claude" | "codex" | "pi" | "droid" | "devin";

export function defaultSkillDir(
  env: Env,
  agent: SkillAgent = "claude",
  root = process.cwd(),
): string {
  if (agent === "devin") return join(root, ".agents/skills/code-explainer");
  if (agent === "claude") return join(env.HOME ?? homedir(), ".claude/skills/code-explainer");
  return join(env.HOME ?? homedir(), ".agents/skills/code-explainer");
}

interface Inventory {
  version: string;
  files: Record<string, string>;
  cli?: string;
}

function inventory(path: string): Inventory {
  const value = JSON.parse(readFileSync(path, "utf8"));
  if (
    !value ||
    typeof value.version !== "string" ||
    !value.files ||
    typeof value.files !== "object" ||
    Array.isArray(value.files)
  ) {
    throw new Error(`invalid inventory: ${path}`);
  }
  for (const [file, hash] of Object.entries(value.files)) {
    if (
      !file ||
      file.split("/").some((part) => !part || part === "." || part === "..") ||
      file.includes("\\") ||
      isAbsolute(file) ||
      typeof hash !== "string" ||
      !/^[a-f0-9]{64}$/.test(hash)
    ) {
      throw new Error(`invalid inventory entry: ${file}`);
    }
  }
  return value;
}

function hashFile(path: string): string {
  if (!lstatSync(path).isFile()) throw new Error(`not a regular file: ${path}`);
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function entryExists(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

function verifyFiles(root: string, files: Record<string, string>): void {
  for (const [file, expected] of Object.entries(files)) {
    if (hashFile(join(root, file)) !== expected)
      throw new Error(`changed or corrupt file: ${file}`);
  }
}

/** Detect missing/corrupt bundled assets even when runtime overrides are set. */
export function verifyArtifact(): Inventory {
  const data = inventory(join(artifactDir, "integrity.json"));
  const required = [
    "xpl.mjs",
    "package.json",
    "viewer.html",
    "wasm/rust-tags.scm",
    "wasm/ruby-tags.scm",
    "skill/code-explainer/SKILL.md",
    "skill/code-explainer/bin/xpl",
    ...allWasmSources().map((source) => `wasm/${source.file}`),
  ];
  for (const path of required) {
    if (!Object.hasOwn(data.files, path)) throw new Error(`artifact inventory is missing ${path}`);
  }
  verifyFiles(artifactDir, data.files);
  return data;
}

/** A managed skill is checked before updating it, so local edits are never discarded. */
export function verifySkill(target: string): Inventory {
  if (!lstatSync(target).isDirectory()) throw new Error(`not a skill directory: ${target}`);
  const data = inventory(join(target, "xpl-install.json"));
  if (
    !data.files["SKILL.md"] ||
    !data.files["bin/xpl"] ||
    typeof data.cli !== "string" ||
    !isAbsolute(data.cli)
  ) {
    throw new Error(
      "skill installation or CLI launcher binding is missing; rerun xpl skill install",
    );
  }
  verifyFiles(target, data.files);
  return data;
}

export async function installSkill(target: string): Promise<void> {
  const data = verifyArtifact();
  const source = join(artifactDir, "skill/code-explainer");
  await mkdir(dirname(target), { recursive: true });
  await withFileLock(target, async () => {
    if (entryExists(target)) {
      try {
        const previous = verifySkill(target);
        const unexpected = readdirSync(target, { recursive: true, encoding: "utf8" }).filter(
          (path) =>
            !lstatSync(join(target, path)).isDirectory() &&
            path !== "xpl-install.json" &&
            !Object.hasOwn(previous.files, path.replaceAll("\\", "/")),
        );
        if (unexpected.length) throw new Error(`unmanaged files: ${unexpected.join(", ")}`);
      } catch (error) {
        throw new CliError(
          `Will not replace ${target}: ${error instanceof Error ? error.message : String(error)}. Move this directory aside to preserve it, then rerun xpl skill install.`,
        );
      }
    }
    const stage = await mkdtemp(join(dirname(target), ".xpl-skill-"));
    const next = join(stage, "next");
    const backup = join(stage, "previous");
    let installed = false;
    try {
      const files = Object.fromEntries(
        Object.entries(data.files)
          .filter(([file]) => file.startsWith("skill/code-explainer/"))
          .map(([file, hash]) => [file.slice("skill/code-explainer/".length), hash]),
      );
      for (const file of Object.keys(files)) {
        await mkdir(dirname(join(next, file)), { recursive: true });
        await copyFile(join(source, file), join(next, file));
      }
      await chmod(join(next, "bin/xpl"), 0o755);
      verifyFiles(next, files);
      await writeFile(
        join(next, "xpl-install.json"),
        JSON.stringify(
          { version: data.version, cli: join(artifactDir, "xpl.mjs"), files },
          null,
          2,
        ) + "\n",
      );
      if (existsSync(target)) await rename(target, backup);
      try {
        await rename(next, target);
        installed = true;
      } catch (error) {
        if (existsSync(backup)) await rename(backup, target);
        throw error;
      }
    } finally {
      // If rollback itself failed, keep the previous skill for manual recovery.
      if (installed || !existsSync(backup)) await rm(stage, { recursive: true, force: true });
    }
  });
}
