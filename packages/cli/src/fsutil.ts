/** File-system helpers: atomic writes, tolerant JSON reading, the working-tree reader. */
import { randomBytes } from "node:crypto";
import { readFileSync, realpathSync } from "node:fs";
import { mkdir, rename, unlink, writeFile } from "node:fs/promises";
import { basename, dirname, join, relative, isAbsolute, sep } from "node:path";
import { CliError, errorMessage } from "./errors.js";

/** Writes `data` next to `path` and renames it into place, so readers never see a half-written file. */
export async function atomicWrite(path: string, data: string): Promise<void> {
  const dir = dirname(path);
  await mkdir(dir, { recursive: true });
  const tmp = join(dir, `.${basename(path)}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`);
  try {
    await writeFile(tmp, data);
    await rename(tmp, path);
  } catch (error) {
    await unlink(tmp).catch(() => undefined);
    throw error;
  }
}

/** Pretty JSON with a trailing newline: the format of explainers and requests on disk. */
export function jsonFile(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

export function readTextFile(path: string, what: string): string {
  try {
    return readFileSync(path, "utf8");
  } catch (error) {
    throw new CliError(`cannot read ${what} ${path}: ${errorMessage(error)}`);
  }
}

/** `JSON.parse` whose error says where the syntax error is. */
export function parseJson(text: string, what: string): unknown {
  try {
    return JSON.parse(text);
  } catch (error) {
    const message = errorMessage(error);
    const at = /position (\d+)/.exec(message);
    let where = "";
    if (at && !/line \d+/.test(message)) {
      const position = Number(at[1]);
      const before = text.slice(0, position);
      where = ` (line ${before.split("\n").length}, column ${position - before.lastIndexOf("\n")})`;
    }
    throw new CliError(`${what} is not valid JSON: ${message}${where}`);
  }
}

/**
 * Reader of working-tree files by repo-relative POSIX path. Returns undefined for anything that is not
 * a readable file inside the root: absolute paths, `..` segments, and symlinks that leave the root.
 */
export function workingTreeReader(root: string): (file: string) => string | undefined {
  let realRoot: string | undefined;
  return (file) => {
    if (
      file === "" ||
      file.includes("\0") ||
      file.includes("\\") ||
      file.startsWith("/") ||
      file.split("/").includes("..")
    ) {
      return undefined;
    }
    try {
      realRoot ??= realpathSync(root);
      const real = realpathSync(join(root, ...file.split("/")));
      if (real !== realRoot && !real.startsWith(realRoot + sep)) return undefined;
      // A leading BOM is kept, like the indexer does: columns must match the file on disk.
      return readFileSync(real).toString("utf8");
    } catch {
      return undefined;
    }
  };
}

export function toPosix(path: string): string {
  return path.split(sep).join("/");
}

/** `path` relative to `root` (POSIX) when it lies inside it, else the absolute path. */
export function displayPath(root: string, path: string): string {
  const rel = relative(root, path);
  if (rel === "") return ".";
  return rel.startsWith("..") || isAbsolute(rel) ? path : toPosix(rel);
}
