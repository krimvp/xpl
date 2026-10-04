import { expect, it } from "vitest";
import { buildIndex } from "../src/index.js";
import { TypeScriptResolutionExperiment } from "../src/resolve/typescript-experiment.js";
import { makeDir, makeRepo, writeFiles } from "./helpers.js";
import { rmSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import {
  mutationScenarios,
  runMutationSequence,
} from "../../../scripts/semantic-invalidation-scenarios.js";

it.each(mutationScenarios)(
  "matches every whole clean index through $name mutations",
  async (scenario) => {
    await runMutationSequence(makeDir(), scenario);
  },
);

it("reuses unchanged TypeScript references and invalidates an unchanged caller after declaration removal", async () => {
  const root = makeDir({
    "lib/a.ts": "export function run() {}",
    "app/caller.ts": 'import { run } from "../lib/a"; export function caller() { run(); }',
    "isolated/a.ts": "export function isolated() {}",
  });
  const experiment = new TypeScriptResolutionExperiment();
  const build = () => buildIndex({ root, precise: "off", experimentalResolution: experiment });
  const first = await build();
  expect(first.index.refs.filter((r) => r.kind === "call").map((r) => r.to)).toEqual([
    "lib/a.ts#run",
  ]);
  const warm = await build();
  expect(experiment.report.reusedFiles).toEqual(["app/caller.ts", "isolated/a.ts", "lib/a.ts"]);
  expect(JSON.stringify(warm.index)).toBe(JSON.stringify(first.index));
  writeFiles(root, { "lib/a.ts": "export function removed() {}" });
  const changed = await build();
  expect(experiment.report.resolvedFiles).toEqual(["app/caller.ts", "lib/a.ts"]);
  expect(experiment.report.reusedFiles).toEqual(["isolated/a.ts"]);
  expect(changed.index.refs.filter((r) => r.kind === "call")).toEqual([]);
  const clean = await buildIndex({ root, precise: "off", cache: false });
  expect(JSON.stringify(changed.index)).toBe(JSON.stringify(clean.index));
  expect(changed.warnings).toEqual(clean.warnings);
});

it.each(["disabled", "directory alias"])(
  "uses full resolution when extraction identity is %s",
  async (mode) => {
    const root = makeRepo({
      "a.ts": "export function run() { run(); }",
      "shared/source.ts": "export const source = 1;",
    });
    const experiment = new TypeScriptResolutionExperiment();
    await buildIndex({ root, precise: "off", experimentalResolution: experiment });
    await buildIndex({ root, precise: "off", experimentalResolution: experiment });
    expect(experiment.report.resolvedFiles).toEqual([]);
    if (mode === "directory alias") {
      // Point the cache parent at a source directory. No semantic identity may survive the bypass.
      rmSync(join(root, ".explainer", "cache"), { recursive: true });
      symlinkSync(join(root, "shared"), join(root, ".explainer", "cache"), "dir");
    }
    const options = {
      root,
      precise: "off" as const,
      cache: mode !== "disabled",
      experimentalResolution: experiment,
    };
    const fresh = await buildIndex(options);
    expect(experiment.report.fallback).toBe("extraction identity unavailable");
    expect(experiment.report.reusedFiles).toEqual([]);
    const clean = await buildIndex({ root, precise: "off", cache: false });
    expect(JSON.stringify(fresh.index)).toBe(JSON.stringify(clean.index));
    expect(fresh.warnings).toEqual(clean.warnings);
  },
);
