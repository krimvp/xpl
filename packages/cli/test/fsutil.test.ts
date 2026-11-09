import { execFileSync, spawn } from "node:child_process";
import {
  closeSync,
  existsSync,
  lstatSync,
  openSync,
  readFileSync,
  readSync,
  symlinkSync,
} from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { atomicWrite, withFileLock } from "../src/fsutil.js";
import { makeTempDir, readJson, writeFile } from "./helpers.js";

describe("file transactions", () => {
  it("serializes read-modify-write across separate processes", async () => {
    const root = makeTempDir();
    const path = writeFile(root, "shared.json", '{"count":0}');
    const module = new URL("../src/fsutil.ts", import.meta.url).href;
    const script = `
      import { readFile } from 'node:fs/promises';
      import { atomicWrite, withFileLock } from ${JSON.stringify(module)};
      const path = ${JSON.stringify(path)};
      for (let i = 0; i < 3; i++) await withFileLock(path, async () => {
        const state = JSON.parse(await readFile(path, 'utf8'));
        await new Promise(r => setTimeout(r, 50));
        state.count++;
        await atomicWrite(path, JSON.stringify(state));
      });
    `;
    const writer = () =>
      new Promise<void>((resolve, reject) => {
        const child = spawn(
          process.execPath,
          ["--import", "tsx", "--input-type=module", "-e", script],
          { cwd: new URL("../../../", import.meta.url), stdio: ["ignore", "ignore", "pipe"] },
        );
        let error = "";
        child.stderr.on("data", (chunk: Buffer) => {
          error += chunk.toString();
        });
        child.on("error", reject);
        child.on("close", (code) =>
          code === 0 ? resolve() : reject(new Error(error || `writer exited ${code}`)),
        );
      });
    await Promise.all([writer(), writer()]);
    expect(readJson(root, "shared.json").count).toBe(6);
    expect(existsSync(path + ".lock")).toBe(false);
  });

  it("releases the lock after a failed transaction", async () => {
    const path = join(makeTempDir(), "shared.json");
    await expect(
      withFileLock(path, async () => {
        throw new Error("failed");
      }),
    ).rejects.toThrow("failed");
    expect(await withFileLock(path, async () => "next writer")).toBe("next writer");
  });
});

describe("atomic writes to a target that is not a regular file", () => {
  // `-o /dev/null` once renamed a temp file over the device and left /dev/null a regular file.
  it("writes through a FIFO (as for /dev/null) and keeps it a FIFO", async () => {
    const fifo = join(makeTempDir(), "out");
    execFileSync("mkfifo", [fifo]);
    // Read-write open of a FIFO does not block (Linux, macOS), so the old code fails at the assertion.
    const fd = openSync(fifo, "r+");
    try {
      await atomicWrite(fifo, "data\n");
      expect(lstatSync(fifo).isFIFO()).toBe(true);
      const buf = Buffer.alloc(5);
      expect(readSync(fd, buf, 0, 5, null)).toBe(5);
      expect(buf.toString()).toBe("data\n");
    } finally {
      closeSync(fd);
    }
  }, 5_000);

  it("writes through a symlink and keeps the link", async () => {
    const dir = makeTempDir();
    const target = writeFile(dir, "real.json", "old");
    symlinkSync(target, join(dir, "link.json"));
    await atomicWrite(join(dir, "link.json"), "new");
    expect(lstatSync(join(dir, "link.json")).isSymbolicLink()).toBe(true);
    expect(readFileSync(target, "utf8")).toBe("new");
  });
});
