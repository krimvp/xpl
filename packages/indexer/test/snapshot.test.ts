import { renameSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildIndex, captureIndexInputs } from "../src/index.js";
import { makeRepo, writeFiles } from "./helpers.js";

describe("captured index inputs", () => {
  it("matches a clean build after additions, deletions, renames and ignored resolver config edits", async () => {
    const root = makeRepo({
      ".gitignore": "tsconfig.json\nextra.json\n",
      "src/run.ts": "import { value } from 'chosen';\nexport const run = value;\n",
      "src/one.ts": "export const value = 1;\n",
      "src/two.ts": "export const value = 2;\n",
      "gone.ts": "export const gone = 0;\n",
    });
    writeFiles(root, {
      "tsconfig.json": '{"extends":"./extra.json"}',
      "extra.json": '{"compilerOptions":{"baseUrl":".","paths":{"chosen":["src/one.ts"]}}}',
    });
    const initial = await captureIndexInputs({ root });
    const frozen = await buildIndex({ root, precise: "off", snapshot: initial });
    expect(frozen.index.refs.filter((r) => r.kind === "import").map((r) => r.to)).toEqual([
      "src/one.ts#value",
    ]);
    writeFiles(root, {
      "extra.json": '{"compilerOptions":{"baseUrl":".","paths":{"chosen":["src/two.ts"]}}}',
      "added.ts": "export const added = 3;\n",
    });
    unlinkSync(join(root, "gone.ts"));
    renameSync(join(root, "src/one.ts"), join(root, "src/renamed.ts"));
    const current = await captureIndexInputs({ root });
    expect(current.fingerprint).not.toBe(initial.fingerprint);
    // The build reads the captured config, even when the live ignored config changes afterward.
    const old = await buildIndex({ root, precise: "off", snapshot: initial });
    expect(old.index.files).toEqual(frozen.index.files);
    expect(old.index.refs).toEqual(frozen.index.refs);
    const captured = await buildIndex({ root, precise: "off", snapshot: current });
    const clean = await buildIndex({ root, precise: "off" });
    expect(captured.index).toEqual(clean.index);
    expect(captured.index.files.map((f) => f.path)).toEqual([
      ".gitignore",
      "added.ts",
      "src/renamed.ts",
      "src/run.ts",
      "src/two.ts",
    ]);
    expect(captured.index.refs.filter((r) => r.kind === "import").map((r) => r.to)).toEqual([
      "src/two.ts#value",
    ]);
  });

  it("detects a changed-and-restored input and observes supplied provider inputs", async () => {
    const root = makeRepo({ "a.ts": "export const a = 1;\n", ".gitignore": "provider/\n" });
    writeFiles(root, { "provider/index.scip": "first" });
    const options = { root, inputPaths: [join(root, "provider/index.scip")] };
    const first = await captureIndexInputs(options);
    writeFiles(root, { "a.ts": "export const a = 2;\n" });
    writeFiles(root, { "a.ts": "export const a = 1;\n" });
    const restored = await captureIndexInputs(options);
    expect(restored.fingerprint).toBe(first.fingerprint);
    expect(restored.revision).not.toBe(first.revision);
    writeFiles(root, { "provider/index.scip": "second" });
    expect((await captureIndexInputs(options)).fingerprint).not.toBe(first.fingerprint);
  });
});
