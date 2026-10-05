import { renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildIndex, captureIndexInputs, indexInputsChanged } from "../src/index.js";
import {
  scipGoProvider,
  scipPythonProvider,
  scipTypescriptProvider,
} from "../src/scip/resolvers.js";
import { encodeIndex } from "./scip-encode.js";
import { makeRepo, writeFiles, git } from "./helpers.js";

describe("captured index inputs", () => {
  it.each<{
    name: string;
    files: Record<string, string>;
    configuration: Record<string, string>;
    edit: string;
    provider: typeof scipPythonProvider;
  }>([
    {
      name: "TypeScript referenced config chain",
      files: {
        "a.ts": "export const value = 1;\n",
        "tsconfig.json": '{"references":[{"path":"./project"}]}',
      },
      configuration: {
        "project/tsconfig.json": '{"extends":"../semantic.settings"}',
        "semantic.settings": '{"compilerOptions":{"strict":true}}',
      },
      edit: "semantic.settings",
      provider: scipTypescriptProvider,
    },
    {
      name: "Go module sums",
      files: { "a.go": "package demo\n", "go.mod": "module example.com/demo\ngo 1.25\n" },
      configuration: { "go.sum": "example.com/dependency v1.0.0 h1:first\n" },
      edit: "go.sum",
      provider: scipGoProvider,
    },
  ])("observes ignored $name inputs declared by the enabled provider", async (item) => {
    const root = makeRepo({
      ...item.files,
      ".gitignore": Object.keys(item.configuration).join("\n") + "\n",
    });
    writeFiles(root, item.configuration);
    let runs = 0;
    const providers = [
      item.provider({
        run: async () => {
          runs++;
          throw new Error("capture ran a semantic tool");
        },
      }),
    ];
    const options = { root, precise: "auto" as const, providers };
    const first = await captureIndexInputs(options);
    writeFiles(root, { [item.edit]: "changed\n" });
    expect(await indexInputsChanged(first)).toBe(true);
    expect((await captureIndexInputs(options)).fingerprint).not.toBe(first.fingerprint);
    expect(runs).toBe(0);
  });

  it.each(["auto", "require"] as const)(
    "captures ignored Python semantic configuration without running tools in %s mode",
    async (precise) => {
      const root = makeRepo({
        ".gitignore": "pyproject.toml\nsetup.cfg\n",
        "a.py": "def value():\n    return 1\n",
      });
      writeFiles(root, { "pyproject.toml": '[project]\nname = "correct-project"\n' });
      const names: string[] = [];
      const providers = [
        scipPythonProvider({
          async run(_command, args) {
            names.push(args[args.indexOf("--project-name") + 1]!);
            writeFileSync(
              args[args.indexOf("--output") + 1]!,
              encodeIndex({
                tool: { name: "scip-python", version: "0.6.6" },
                documents: [{ path: "a.py" }],
              }),
            );
            return { code: 0, stdout: "", stderr: "", timedOut: false };
          },
        }),
      ];
      const off = await captureIndexInputs({ root, precise: "off", providers });
      const first = await captureIndexInputs({ root, precise, providers });
      expect(names).toEqual([]);
      const clean = await buildIndex({ root, precise, providers });
      const captured = await buildIndex({ root, precise, providers, snapshot: first });
      expect(names).toEqual(["correct-project", "correct-project"]);
      expect(captured.index).toEqual(clean.index);
      writeFiles(root, { "pyproject.toml": '[project]\nname = "changed-project"\n' });
      expect(await indexInputsChanged(first)).toBe(true);
      expect(await indexInputsChanged(off)).toBe(false);
      const changed = await captureIndexInputs({ root, precise, providers });
      expect(changed.fingerprint).not.toBe(first.fingerprint);
      await buildIndex({ root, precise, providers, snapshot: changed });
      await buildIndex({ root, precise, providers, snapshot: first });
      expect(names).toEqual([
        "correct-project",
        "correct-project",
        "changed-project",
        "correct-project",
      ]);
      expect((await captureIndexInputs({ root, precise: "off", providers })).fingerprint).toBe(
        off.fingerprint,
      );
      unlinkSync(join(root, "pyproject.toml"));
      writeFiles(root, { "setup.cfg": "[metadata]\nname = fallback-project\n" });
      const fallback = await captureIndexInputs({ root, precise, providers });
      await buildIndex({ root, precise, providers, snapshot: fallback });
      expect(names.at(-1)).toBe("fallback-project");
      writeFiles(root, { "pyproject.toml": '[project]\nname = "restored-project"\n' });
      expect(await indexInputsChanged(fallback)).toBe(true);
    },
  );

  it("observes staging cleanliness when source contents and HEAD stay unchanged", async () => {
    const root = makeRepo({ "a.ts": "export const a = 1;\n" });
    writeFiles(root, { "a.ts": "export const a = 2;\n" });
    git(root, "add", "a.ts");
    writeFiles(root, { "a.ts": "export const a = 1;\n" });
    const staged = await captureIndexInputs({ root });
    const stagedIndex = (await buildIndex({ root, precise: "off", snapshot: staged })).index;
    expect(stagedIndex.commit).toMatch(/^wt-/);
    git(root, "reset", "-q", "HEAD", "--", "a.ts");
    const clean = await captureIndexInputs({ root });
    expect(clean.fingerprint).not.toBe(staged.fingerprint);
    expect((await buildIndex({ root, precise: "off", snapshot: staged })).index.commit).toBe(
      stagedIndex.commit,
    );
    expect((await buildIndex({ root, precise: "off", snapshot: clean })).index).toEqual(
      (await buildIndex({ root, precise: "off" })).index,
    );
    expect((await buildIndex({ root, precise: "off", snapshot: clean })).index.commit).toBe(
      git(root, "rev-parse", "HEAD").slice(0, 7),
    );
  });

  it.each(["base.jsonc", "base.resolver-settings"])(
    "captures resolver reads of ignored extended config %s",
    async (base) => {
      const root = makeRepo({
        ".gitignore": `tsconfig.json\n${base}\n`,
        "run.ts": "import { value } from 'chosen'; export const run = value;\n",
        "one.ts": "export const value = 1;\n",
        "two.ts": "export const value = 2;\n",
      });
      writeFiles(root, {
        "tsconfig.json": JSON.stringify({ extends: `./${base}` }),
        [base]: '{"compilerOptions":{"baseUrl":".","paths":{"chosen":["one.ts"]}}}',
      });
      const first = await captureIndexInputs({ root });
      const captured = await buildIndex({ root, precise: "off", snapshot: first });
      expect(
        (await buildIndex({ root, precise: "off" })).index.refs
          .filter((r) => r.kind === "import")
          .map((r) => r.to),
      ).toEqual(["one.ts#value"]);
      expect(captured.index.refs.filter((r) => r.kind === "import").map((r) => r.to)).toEqual([
        "one.ts#value",
      ]);
      writeFiles(root, {
        [base]: '{"compilerOptions":{"baseUrl":".","paths":{"chosen":["two.ts"]}}}',
      });
      const changed = await captureIndexInputs({ root });
      expect(changed.fingerprint).not.toBe(first.fingerprint);
      expect(
        (await buildIndex({ root, precise: "off", snapshot: changed })).index.refs
          .filter((r) => r.kind === "import")
          .map((r) => r.to),
      ).toEqual(["two.ts#value"]);
      expect(
        (await buildIndex({ root, precise: "off", snapshot: first })).index.refs
          .filter((r) => r.kind === "import")
          .map((r) => r.to),
      ).toEqual(["one.ts#value"]);
    },
  );

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
