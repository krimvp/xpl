import { execFile } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { createServer } from "node:http";
import { delimiter, join } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { invoke, makeTempDir, writeFile } from "./helpers.js";

const hasGo =
  process.env.PATH?.split(delimiter).some((dir) => existsSync(join(dir, "go"))) ?? false;

describe("setup commands", () => {
  it.skipIf(!hasGo)(
    "doctor reports installed tools without downloading a newer Go toolchain or writing probe files",
    async () => {
      const root = makeTempDir();
      writeFile(root, "go.mod", "module example.test/diagnosis\n\ngo 1.99.0\n");
      const requests: string[] = [];
      const proxy = createServer((request, response) => {
        requests.push(request.url ?? "");
        response.writeHead(404).end("No downloads during diagnosis");
      });
      await new Promise<void>((resolve) => proxy.listen(0, "127.0.0.1", resolve));
      try {
        const address = proxy.address();
        if (!address || typeof address === "string") throw new Error("proxy did not bind TCP");
        const result = await promisify(execFile)(
          process.execPath,
          [
            "--import",
            fileURLToPath(new URL("../../../node_modules/tsx/dist/loader.mjs", import.meta.url)),
            fileURLToPath(new URL("../src/main.ts", import.meta.url)),
            "doctor",
            "--json",
            "--skill-dir",
            join(root, "skill"),
          ],
          {
            cwd: root,
            env: {
              ...process.env,
              HOME: root,
              XDG_CONFIG_HOME: join(root, "config"),
              GIT_TRACE2_EVENT: join(root, "git-trace.json"),
              GOTOOLCHAIN: "auto",
              GOPROXY: `http://127.0.0.1:${address.port}`,
              GOSUMDB: "off",
              GOPATH: join(root, "gopath"),
              GOCACHE: join(root, "gocache"),
              npm_config_cache: join(root, "npm-cache"),
            },
          },
        ).catch((error: { code: number; stdout: string }) => {
          expect(error.code).toBe(1); // Unit checks also run before the artifact is built.
          return { stdout: error.stdout };
        });
        const report = JSON.parse(result.stdout);
        expect(report.checks.find((check: { id: string }) => check.id === "go")).toMatchObject({
          required: false,
          status: "ok",
          detail: expect.stringMatching(/^go version go\d/),
        });
        expect(requests).toEqual([]);
        expect(readdirSync(root, { recursive: true }).sort()).toEqual(["go.mod"]);
      } finally {
        await new Promise<void>((resolve, reject) =>
          proxy.close((error) => (error ? reject(error) : resolve())),
        );
      }
    },
  );
  it("doctor separates a missing selected authoring agent from optional precise tools", async () => {
    const result = await invoke(
      ["doctor", "--agent", "claude", "--skill-dir", makeTempDir(), "--json"],
      { env: { PATH: "" } },
    );
    expect(result.code).toBe(1);
    const report = JSON.parse(result.out);
    expect(report.ok).toBe(false);
    expect(report.checks.find((check: { id: string }) => check.id === "agent")).toMatchObject({
      required: true,
      status: "missing",
      recovery: expect.stringContaining("Claude Code"),
    });
    expect(report.checks.find((check: { id: string }) => check.id === "npx")).toMatchObject({
      required: false,
      status: "missing",
      recovery: expect.stringContaining("--precise off"),
    });
    expect(report.checks.find((check: { id: string }) => check.id === "skill")).toMatchObject({
      required: true,
      status: "missing",
      recovery: expect.stringContaining("xpl skill install"),
    });
  });

  it("rejects an unsupported agent or skill operation with a usage error", async () => {
    const agent = await invoke(["doctor", "--agent", "unknown"]);
    expect(agent.code).toBe(2);
    expect(agent.err).toContain("--agent must be none, claude, codex, pi, droid, or devin");
    const operation = await invoke(["skill", "remove"]);
    expect(operation.code).toBe(2);
    expect(operation.err).toContain("skill operation must be install");
  });

  it.each([
    { agent: "claude", root: "home", suffix: ".claude/skills/code-explainer" },
    { agent: "codex", root: "home", suffix: ".agents/skills/code-explainer" },
    { agent: "pi", root: "home", suffix: ".agents/skills/code-explainer" },
    { agent: "droid", root: "home", suffix: ".agents/skills/code-explainer" },
    { agent: "devin", root: "project", suffix: ".agents/skills/code-explainer" },
  ] as const)(
    "doctor checks the $agent skill at its native path",
    async ({ agent, root: scope, suffix }) => {
      const root = makeTempDir();
      const home = makeTempDir();
      const result = await invoke(["--root", root, "doctor", "--agent", agent, "--json"], {
        cwd: root,
        env: { HOME: home, PATH: "" },
      });
      expect(result.code).toBe(1);
      const report = JSON.parse(result.out);
      expect(report.agent).toBe(agent);
      if (agent === "devin") {
        expect(report.checks.find((check: { id: string }) => check.id === "agent")).toMatchObject({
          required: false,
          detail: expect.stringContaining("not locally verifiable"),
        });
      } else {
        expect(report.checks.find((check: { id: string }) => check.id === "agent")).toMatchObject({
          required: true,
          status: "missing",
        });
      }
      const expectedSkill = join(scope === "project" ? root : home, suffix);
      expect(report.checks.find((check: { id: string }) => check.id === "skill")).toMatchObject({
        required: true,
        status: "missing",
        recovery: expect.stringContaining(JSON.stringify(expectedSkill)),
      });
    },
  );
});
