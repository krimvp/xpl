import { mkdirSync, renameSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { SourceRepoView } from "../src/repo.js";
import { runCommand } from "../src/scip/run.js";
import { describe, expect, it } from "vitest";
import { buildIndex, captureIndexInputs, indexInputsChanged } from "../src/index.js";
import {
  scipGoProvider,
  scipPythonProvider,
  scipTypescriptProvider,
} from "../src/scip/resolvers.js";
import { encodeIndex } from "./scip-encode.js";
import { makeDir, makeRepo, writeFiles, git } from "./helpers.js";

describe("captured index inputs", () => {
  it("reuses file-local extraction during capture and keeps the edited index identical to a clean build", async () => {
    const root = makeRepo({
      "a.ts": 'import { target } from "./b"; export function call() { target(); }\n',
      "b.ts": "export function target() { return 1; }\n",
    });
    const first = await captureIndexInputs({ root });
    const initial = await buildIndex({ root, snapshot: first, precise: "off" });
    expect(initial.extraction).toMatchObject({ enabled: true, hits: 2, misses: 0 });

    writeFiles(root, { "b.ts": "export function target() { return 2; }\n" });
    const edited = await captureIndexInputs({ root });
    const reused = await buildIndex({ root, snapshot: edited, precise: "off" });
    const clean = await buildIndex({ root, precise: "off", cache: false });
    expect(reused.extraction).toMatchObject({ enabled: true, hits: 2, misses: 0 });
    expect(JSON.stringify(reused.index)).toBe(JSON.stringify(clean.index));
    expect(reused.warnings).toEqual(clean.warnings);
    expect(reused.index.commit).not.toBe(initial.index.commit);
  });

  it("declares Python config priority and records a missing higher-priority choice", () => {
    const reads: string[] = [];
    const configuration = new Map([
      ["pyproject.toml", '[project]\nname = "demo"\n'],
      ["scip-pyrightconfig.json", '{"include":["one"]}'],
      ["pyrightconfig.json", '{"include":["two"]}'],
    ]);
    const provider = scipPythonProvider();
    const declare = () => {
      reads.length = 0;
      provider.readConfiguration!(
        "a.py",
        new SourceRepoView("/repo", ["a.py"], (path) => {
          reads.push(path);
          return configuration.get(path);
        }),
      );
      return [...reads];
    };
    expect(declare()).toEqual(["pyproject.toml", "scip-pyrightconfig.json"]);
    configuration.delete("scip-pyrightconfig.json");
    expect(declare()).toEqual(["pyproject.toml", "scip-pyrightconfig.json", "pyrightconfig.json"]);
  });

  it("declares TS exact-file extends before .json and directory references without a .json sibling", () => {
    const configuration = new Map([
      ["tsconfig.json", '{"extends":"./base","references":[{"path":"./child"}]}'],
      ["base.json", '{"compilerOptions":{"strict":true}}'],
      ["child.json", '{"extends":"./wrong"}'],
      ["child/tsconfig.json", "{}"],
      ["package.json", '{"name":"demo"}'],
    ]);
    const reads: string[] = [];
    scipTypescriptProvider().readConfiguration!(
      "child/a.ts",
      new SourceRepoView("/repo", ["tsconfig.json", "child/a.ts"], (path) => {
        reads.push(path);
        return configuration.get(path);
      }),
    );
    expect(reads).toEqual([
      "tsconfig.json",
      "base",
      "base.json",
      "child/tsconfig.json",
      "child/package.json",
      "package.json",
    ]);
  });

  it("declares Go workspace priority, workspace vendor metadata and ignored member modules", () => {
    const reads: string[] = [];
    const configuration = new Map([
      ["app/go.mod", "module example.com/app\ngo 1.25\n"],
      ["go.work", "go 1.25\nuse (\n ./app\n ./ignored\n)\n"],
      ["vendor/modules.txt", "## workspace\n"],
      ["ignored/go.mod", "module example.com/ignored\ngo 1.25\n"],
    ]);
    const provider = scipGoProvider({ env: {} });
    provider.readConfiguration!(
      "app/a.go",
      new SourceRepoView("/repo", ["app/a.go", "app/go.mod"], (path) => {
        reads.push(path);
        return configuration.get(path);
      }),
    );
    expect(reads).toEqual([
      "app/go.mod",
      "app/go.work",
      "go.work",
      "go.work.sum",
      "vendor/modules.txt",
      "app/go.sum",
      "ignored/go.mod",
      "ignored/go.sum",
    ]);
  });

  it("declares Go persisted flags below process overrides, alternate sums and overlay backing files", () => {
    const configuration = new Map([
      [
        "config/go.env",
        "GOWORK=ignored/go.work\nGOFLAGS='-modfile=local config.mod' -overlay=overlay.json\n",
      ],
      [
        "app/go.mod",
        'module example.com/app\ngo 1.25\nreplace example.com/local => ../local\nreplace example.com/root => ".."\n',
      ],
      ["app/local config.mod", "module example.com/alternate\ngo 1.25\n"],
      ["app/overlay.json", '{"Replace":{"a.go":"../backing/a.go"}}'],
    ]);
    const reads: string[] = [];
    scipGoProvider({ env: { GOENV: "/repo/config/go.env", GOWORK: "off" } }).readConfiguration!(
      "app/a.go",
      new SourceRepoView("/repo", ["app/a.go", "app/go.mod"], (path) => {
        reads.push(path);
        return configuration.get(path);
      }),
    );
    expect(reads).toEqual([
      "config/go.env",
      "app/go.mod",
      "app/go.sum",
      "local/go.mod",
      "local/go.sum",
      "go.mod",
      "go.sum",
      "app/vendor/modules.txt",
      "app/local config.mod",
      "app/local config.sum",
      "app/overlay.json",
      "backing/a.go",
    ]);
  });

  it("observes creation of ancestor Python JSON config ahead of root TOML", async () => {
    const parent = makeDir({
      "nested/a.py": "def value():\n    return 1\n",
      "nested/pyproject.toml": '[project]\nname = "demo"\n[tool.scip]\ninclude = ["."]\n',
    });
    const root = join(parent, "nested");
    git(root, "init", "-q", "-b", "main");
    git(root, "add", ".");
    git(root, "commit", "-qm", "initial");
    const options = { root, precise: "auto" as const, providers: [scipPythonProvider()] };
    const first = await captureIndexInputs(options);
    writeFiles(parent, { "scip-pyrightconfig.json": '{"include":["nested"]}\n' });
    expect(await indexInputsChanged(first)).toBe(true);
    const changed = await captureIndexInputs(options);
    expect(changed.fingerprint).not.toBe(first.fingerprint);
    expect(changed.texts.get("../scip-pyrightconfig.json")).toBe('{"include":["nested"]}\n');
  });

  it("observes a directory replaced by a higher-priority exact TS config file", async () => {
    const root = makeRepo({
      ".gitignore": "base\nbase.json\n",
      "a.ts": "export const value = 1;\n",
      "tsconfig.json": '{"extends":"./base"}',
    });
    writeFiles(root, { "base.json": '{"compilerOptions":{"strict":true}}' });
    const options = { root, precise: "auto" as const, providers: [scipTypescriptProvider()] };
    const missing = await captureIndexInputs(options);
    mkdirSync(join(root, "base"));
    const first = await captureIndexInputs(options);
    expect(await indexInputsChanged(missing)).toBe(true);
    expect(first.fingerprint).not.toBe(missing.fingerprint);
    rmSync(join(root, "base"), { recursive: true });
    writeFiles(root, { base: '{"compilerOptions":{"strict":false}}' });
    expect(await indexInputsChanged(first)).toBe(true);
    expect((await captureIndexInputs(options)).fingerprint).not.toBe(first.fingerprint);
  });

  it.skipIf(!process.env.XPL_TEST_SCIP_PYTHON)(
    "observes ignored scip-pyrightconfig priority with the real pinned Python tool",
    async () => {
      const executable = process.env.XPL_TEST_SCIP_PYTHON!;
      const version = await runCommand(executable, ["--version"], {
        cwd: process.cwd(),
        env: process.env,
        timeoutMs: 30_000,
      });
      expect(version.code).toBe(0);
      expect(version.stdout.trim()).toBe("0.6.6");
      const root = makeRepo({
        ".gitignore": "scip-pyrightconfig.json\npyrightconfig.json\n",
        "pyproject.toml": '[project]\nname = "demo"\n',
        "one/dep.py": "def helper():\n    return 1\n\nhelper()\n",
        "two/dep.py": "def helper():\n    return 2\n\nhelper()\n",
      });
      writeFiles(root, {
        "scip-pyrightconfig.json": '{"include":["one"]}\n',
        "pyrightconfig.json": '{"include":["two"]}\n',
      });
      const providers = [
        scipPythonProvider({
          run: (_command, args, options) => runCommand(executable, args.slice(2), options),
        }),
      ];
      const options = { root, precise: "require" as const, providers };
      const calls = (index: Awaited<ReturnType<typeof buildIndex>>["index"]) =>
        index.refs.filter((r) => r.kind === "call").map((r) => [r.to, r.resolution]);
      const first = await captureIndexInputs(options);
      const initial = await buildIndex(options);
      expect(calls(initial.index)).toEqual([
        ["one/dep.py#helper", "precise"],
        ["two/dep.py#helper", "heuristic"],
      ]);
      writeFiles(root, { "scip-pyrightconfig.json": '{"include":["two"]}\n' });
      const clean = await buildIndex(options);
      expect(calls(clean.index)).toEqual([
        ["one/dep.py#helper", "heuristic"],
        ["two/dep.py#helper", "precise"],
      ]);
      expect(await indexInputsChanged(first)).toBe(true);
      const changed = await captureIndexInputs(options);
      expect(changed.fingerprint).not.toBe(first.fingerprint);
      expect((await buildIndex({ ...options, snapshot: changed })).index).toEqual(clean.index);
      unlinkSync(join(root, "scip-pyrightconfig.json"));
      const fallback = await captureIndexInputs(options);
      writeFiles(root, { "scip-pyrightconfig.json": '{"include":["one"]}\n' });
      expect(await indexInputsChanged(fallback)).toBe(true);
    },
    270_000,
  );

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
