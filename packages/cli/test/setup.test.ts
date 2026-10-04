import { describe, expect, it } from "vitest";
import { invoke, makeTempDir } from "./helpers.js";

describe("setup commands", () => {
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
    expect(agent.err).toContain("--agent must be none or claude");
    const operation = await invoke(["skill", "remove"]);
    expect(operation.code).toBe(2);
    expect(operation.err).toContain("skill operation must be install");
  });
});
