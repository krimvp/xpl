import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { withFileLock } from "../src/fsutil.js";
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
