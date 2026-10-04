/**
 * Running the SCIP tools (src/scip/run.ts, resolvers.ts): arguments, temp files, timeouts, failures and how
 * `buildIndex` treats them. The tools themselves are faked (no network); `runCommand` is tested on real
 * processes; scip-integration.test.ts runs the real indexers.
 */
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildIndex, indexProviders } from "../src/index.js";
import { createScipProviders } from "../src/scip/index.js";
import {
  DEFAULT_TIMEOUT_MS,
  SCIP_GO_PACKAGE,
  SCIP_GO_VERSION,
  ScipRunError,
  defaultTimeoutMs,
  extractWarnings,
  goModules,
  outputTail,
  pythonProjectName,
  pythonSourceRoots,
  runCommand,
  runScipGo,
  runScipPython,
  runScipTypescript,
  typescriptProjects,
} from "../src/scip/run.js";
import type { CommandOptions, CommandResult, CommandRunner } from "../src/scip/run.js";
import { DEF, marked, moduleDef, occs, ts } from "./scip-dsl.js";
import { encodeIndex } from "./scip-encode.js";
import type { DocumentSpec, IndexSpec } from "./scip-encode.js";
import { makeDir } from "./helpers.js";

// ─── Fakes ────────────────────────────────────────────────────────────────────────────────────────

interface Call {
  command: string;
  args: string[];
  options: CommandOptions;
  /** The value following `flag` in `args`. */
  arg(flag: string): string | undefined;
}

type Handler = (
  call: Call,
  n: number,
) => Promise<Partial<CommandResult> | void> | Partial<CommandResult> | void;

/** A command runner that records its calls and lets the test play the tool. */
function fakeRunner(handler: Handler = () => undefined): { run: CommandRunner; calls: Call[] } {
  const calls: Call[] = [];
  const run: CommandRunner = async (command, args, options) => {
    const call: Call = {
      command,
      args: [...args],
      options,
      arg: (flag) => {
        const i = args.indexOf(flag);
        return i >= 0 ? args[i + 1] : undefined;
      },
    };
    calls.push(call);
    const result = await handler(call, calls.length - 1);
    return { code: 0, stdout: "", stderr: "", timedOut: false, ...result };
  };
  return { run, calls };
}

/** Write an index to the tool's `--output`. */
function writeIndexTo(call: Call, spec: IndexSpec): void {
  writeFileSync(call.arg("--output")!, encodeIndex(spec));
}

const tempEntries = (dir: string): string[] => readdirSync(dir);

/** A private directory to create the tools' temp dirs in, so tests can see that they are removed. */
function tempRoot(): string {
  return makeDir({});
}

// ─── Processes ────────────────────────────────────────────────────────────────────────────────────

describe("runCommand", () => {
  const options = (timeoutMs = 20_000): CommandOptions => ({
    cwd: tmpdir(),
    env: process.env,
    timeoutMs,
  });

  it("captures stdout, stderr and the exit code", async () => {
    const result = await runCommand(
      process.execPath,
      ["-e", "console.log('to stdout'); console.error('to stderr'); process.exit(3)"],
      options(),
    );
    expect(result).toEqual({
      code: 3,
      stdout: "to stdout\n",
      stderr: "to stderr\n",
      timedOut: false,
    });
  });

  it("runs in the given directory with the given environment", async () => {
    const dir = makeDir({});
    const result = await runCommand(
      process.execPath,
      ["-e", "console.log(process.cwd() + '|' + process.env.XPL_PROBE)"],
      { cwd: dir, env: { ...process.env, XPL_PROBE: "yes" }, timeoutMs: 20_000 },
    );
    expect(result.stdout.trim().endsWith("|yes")).toBe(true);
    expect(result.stdout.trim().split("|")[0]).toMatch(/xpl-indexer-/);
  });

  it("kills a tool that runs past its timeout, together with what it started", async () => {
    if (process.platform === "win32") return;
    const script = `
      const { spawn } = require("node:child_process");
      const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
      console.log(child.pid);
      setInterval(() => {}, 1000);
    `;
    const started = Date.now();
    const result = await runCommand(process.execPath, ["-e", script], options(600));
    expect(result.timedOut).toBe(true);
    expect(Date.now() - started).toBeLessThan(15_000);
    const grandchild = Number(result.stdout.trim());
    expect(grandchild).toBeGreaterThan(0);
    // the group was signalled: the grandchild is gone (give the kernel a moment to reap it)
    let alive = true;
    for (let i = 0; i < 50 && alive; i++) {
      try {
        process.kill(grandchild, 0);
        if (
          process.platform === "linux" &&
          /\) Z /.test(readFileSync(`/proc/${grandchild}/stat`, "utf8"))
        ) {
          alive = false;
          break;
        }
        await new Promise((r) => setTimeout(r, 100));
      } catch {
        alive = false;
      }
    }
    expect(alive).toBe(false);
  });

  it("escalates after the parent exits when a silent descendant ignores SIGTERM", async () => {
    if (process.platform === "win32") return;
    const dir = makeDir({});
    const marker = join(dir, "alive");
    const descendant = `const fs = require('node:fs'); process.on('SIGTERM', () => {}); setInterval(() => fs.appendFileSync(${JSON.stringify(marker)}, 'x'), 30);`;
    const script = `const { spawn } = require('node:child_process'); const child = spawn(process.execPath, ['-e', ${JSON.stringify(descendant)}], {stdio: 'ignore'}); console.log(child.pid); setInterval(() => {}, 1000);`;
    const result = await runCommand(process.execPath, ["-e", script], options(600));
    const pid = Number(result.stdout.trim());
    try {
      expect(result.timedOut).toBe(true);
      expect(pid).toBeGreaterThan(0);
      expect(existsSync(marker)).toBe(true);
      const after = readFileSync(marker, "utf8");
      await new Promise((resolve) => setTimeout(resolve, 150));
      expect(readFileSync(marker, "utf8")).toBe(after);
    } finally {
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        /* already dead */
      }
    }
  });

  it("rejects when the command cannot be started", async () => {
    await expect(runCommand("xpl-no-such-command-anywhere", [], options())).rejects.toThrow(
      /ENOENT/,
    );
  });

  it("keeps only the tail of very chatty output", async () => {
    const result = await runCommand(
      process.execPath,
      ["-e", "process.stdout.write('x'.repeat(2_000_000) + 'THE END')"],
      options(),
    );
    expect(result.stdout.length).toBeLessThanOrEqual(256 * 1024);
    expect(result.stdout.endsWith("THE END")).toBe(true);
  });
});

// ─── Helpers ──────────────────────────────────────────────────────────────────────────────────────

describe("project detection", () => {
  const files = (...paths: string[]): { path: string }[] => paths.map((path) => ({ path }));

  it("finds the tsconfig directories (root = empty string), skipping vendored copies", () => {
    expect(
      typescriptProjects(
        files(
          "tsconfig.json",
          "packages/a/tsconfig.json",
          "packages/a/src/x.ts",
          "packages/b/tsconfig.json",
          "node_modules/dep/tsconfig.json",
          "vendor/lib/tsconfig.json",
          "tsconfig.base.json",
        ),
      ),
    ).toEqual(["", "packages/a", "packages/b"]);
  });

  it("uses a jsconfig.json only where there is no tsconfig.json", () => {
    expect(
      typescriptProjects(files("web/jsconfig.json", "app/tsconfig.json", "app/jsconfig.json")),
    ).toEqual(["app", "web/jsconfig.json"]);
    expect(typescriptProjects(files("src/a.ts"))).toEqual([]);
  });

  it("finds Go modules, skipping vendor and testdata", () => {
    expect(
      goModules(
        files(
          "go.mod",
          "services/api/go.mod",
          "vendor/github.com/x/go.mod",
          "internal/testdata/mod/go.mod",
          "docs/go.mod.md",
        ),
      ),
    ).toEqual(["", "services/api"]);
  });

  it("names the Python project after pyproject.toml, setup.cfg or the directory", () => {
    const read = (files: Record<string, string>) => (path: string) => files[path];
    expect(
      pythonProjectName(
        "/x/repo",
        read({
          "pyproject.toml":
            '[build-system]\nrequires = []\n\n[project]\nname = "py-jobrunner"\nversion = "1"\n',
        }),
      ),
    ).toBe("py-jobrunner");
    expect(
      pythonProjectName(
        "/x/repo",
        read({
          "pyproject.toml": "[tool.poetry]\nname = 'not-this'\n",
          "setup.cfg": "[metadata]\nname = from-cfg\n",
        }),
      ),
    ).toBe("from-cfg");
    expect(pythonProjectName("/x/My Repo!", read({}))).toBe("My-Repo");
    expect(pythonProjectName("/", read({}))).toBe("project");
    expect(
      pythonProjectName("/x/r", read({ "pyproject.toml": '[project]\nname = "we ird/name"\n' })),
    ).toBe("we-ird-name");
  });
});

describe("pythonSourceRoots", () => {
  const py = (...paths: string[]) => paths.map((path) => ({ path, language: "python" as const }));

  it("finds the directory above the outermost package of each chain", () => {
    expect(
      pythonSourceRoots(
        py(
          "src/flask/__init__.py",
          "src/flask/json/__init__.py",
          "src/flask/json/tag.py",
          "tests/test_basic.py",
          "examples/tutorial/flaskr/__init__.py",
          "examples/tutorial/tests/test_db.py",
        ),
      ),
    ).toEqual(["examples/tutorial", "src"]);
  });

  it("has nothing to add for a package at the root, or for scripts", () => {
    expect(
      pythonSourceRoots(py("jobrunner/__init__.py", "jobrunner/queue.py", "tests/test_x.py")),
    ).toEqual([]);
    expect(pythonSourceRoots(py("__init__.py", "a.py"))).toEqual([]);
    expect(pythonSourceRoots(py("scripts/run.py"))).toEqual([]);
  });

  it("treats src as a source root even for namespace packages, and skips vendored code", () => {
    expect(pythonSourceRoots(py("src/pkg/mod.py"))).toEqual(["src"]);
    expect(
      pythonSourceRoots(py("vendor/lib/pkg/__init__.py", "node_modules/x/__init__.py")),
    ).toEqual([]);
    expect(
      pythonSourceRoots([
        { path: "src/x.ts", language: "typescript" },
        { path: "lib/pkg/__init__.py", language: "python" },
      ]),
    ).toEqual(["lib"]);
  });

  it("handles a chain that is a package all the way up to the root", () => {
    expect(pythonSourceRoots(py("__init__.py", "a/__init__.py", "a/b/__init__.py"))).toEqual([]);
  });
});

describe("tool output", () => {
  it("quotes the tail of stderr and stdout", () => {
    const tail = outputTail({
      stdout: "one\n\ntwo\n",
      stderr: Array.from({ length: 30 }, (_, i) => `line ${i}`).join("\n"),
    });
    const lines = tail.split("\n");
    expect(lines).toHaveLength(12);
    expect(lines.slice(-2)).toEqual(["one", "two"]);
  });

  it("picks out warnings and errors, deduplicated and capped", () => {
    const output = [
      "(06:52:11) Loading pyproject.toml file at /home/error-handling/pyproject.toml",
      "Warning: Could not find package information for: ",
      "warning: Could not find package information for: ",
      "Warning: Could not find package information for: ",
      "error TS2307: Cannot find module 'x'.",
      "error: no files got indexed",
      "(06:52:12) Warning: late",
      "fatal: not a git repository",
      "panic: runtime error",
      "error: one more",
    ].join("\n");
    const found = extractWarnings("tool", output, "");
    expect(found).toHaveLength(5);
    expect(found[0]).toBe("tool: Warning: Could not find package information for:");
    expect(found).toContain("tool: error TS2307: Cannot find module 'x'.");
    expect(found.some((w) => w.includes("error-handling"))).toBe(false);
    expect(extractWarnings("tool", "Visiting Packages [3/8]\rall fine")).toEqual([]);
  });

  it("truncates very long lines", () => {
    const [w] = extractWarnings("t", `error: ${"x".repeat(1000)}`);
    expect(w!.length).toBeLessThan(400);
    expect(w!.endsWith("...")).toBe(true);
  });

  it("reads the timeout from XPL_SCIP_TIMEOUT_MS", () => {
    expect(DEFAULT_TIMEOUT_MS).toBe(600_000);
    expect(defaultTimeoutMs({})).toBe(600_000);
    expect(defaultTimeoutMs({ XPL_SCIP_TIMEOUT_MS: "2500" })).toBe(2500);
    expect(defaultTimeoutMs({ XPL_SCIP_TIMEOUT_MS: "soon" })).toBe(600_000);
    expect(defaultTimeoutMs({ XPL_SCIP_TIMEOUT_MS: "-5" })).toBe(600_000);
  });
});

// ─── scip-typescript ──────────────────────────────────────────────────────────────────────────────

describe("runScipTypescript", () => {
  const cfg = (
    run: CommandRunner,
    root?: string,
    env: NodeJS.ProcessEnv = { PATH: process.env.PATH },
  ) => ({
    timeoutMs: 12_345,
    run,
    tempRoot: root ?? tempRoot(),
    env,
  });
  const emptyIndex = (paths: string[] = []): IndexSpec => ({
    tool: { name: "scip-typescript", version: "0.4.0" },
    documents: paths.map((path) => ({ path })),
  });
  const ts_ = (path: string) => ({ path, language: "typescript" as const });

  it("indexes the tsconfig projects with the pinned version and reads the output back", async () => {
    const root = makeDir({ "tsconfig.json": "{}", "src/a.ts": "export const a = 1;\n" });
    const temp = tempRoot();
    const { run, calls } = fakeRunner((call) => writeIndexTo(call, emptyIndex(["src/a.ts"])));
    const out = await runScipTypescript(
      root,
      [{ path: "tsconfig.json", language: "json" }, ts_("src/a.ts")],
      cfg(run, temp),
    );

    expect(calls).toHaveLength(1);
    const call = calls[0]!;
    expect(call.command).toBe("npx");
    expect(call.args.slice(0, 3)).toEqual(["--yes", "@sourcegraph/scip-typescript@0.4.0", "index"]);
    expect(call.arg("--cwd")).toBe(root);
    expect(call.args).toContain("--no-progress-bar");
    expect(call.args[call.args.length - 1]).toBe(root); // the project: the root directory
    expect(call.arg("--output")!.startsWith(temp)).toBe(true);
    expect(call.args).not.toContain("--infer-tsconfig");
    expect(call.options).toMatchObject({ cwd: root, timeoutMs: 12_345 });
    expect(call.options.env.NODE_OPTIONS).toMatch(/--max-old-space-size=4096/);
    expect(call.options.env.NO_COLOR).toBe("1");

    expect(out.sources).toHaveLength(1);
    expect(out.sources[0]).toMatchObject({
      pathPrefix: "",
      defaultEncoding: "utf16",
      excludesBom: true,
    });
    expect(out.sources[0]!.index.metadata.toolName).toBe("scip-typescript");
    expect(tempEntries(temp)).toEqual([]); // temp dir removed
    expect(tempEntries(root).sort()).toEqual(["src", "tsconfig.json"]); // nothing added to the repository
  });

  it("gives the tool room for big repositories unless NODE_OPTIONS already says how much", async () => {
    const root = makeDir({});
    const files = [{ path: "tsconfig.json", language: "json" as const }];
    const heap = async (env: NodeJS.ProcessEnv): Promise<string | undefined> => {
      const { run, calls } = fakeRunner((call) => writeIndexTo(call, emptyIndex(["a.ts"])));
      await runScipTypescript(root, files, cfg(run, undefined, env));
      return calls[0]!.options.env.NODE_OPTIONS;
    };
    expect(await heap({ PATH: "/bin" })).toBe("--max-old-space-size=4096");
    expect(await heap({ NODE_OPTIONS: "--no-warnings" })).toBe(
      "--no-warnings --max-old-space-size=4096",
    );
    expect(await heap({ NODE_OPTIONS: "--max-old-space-size=16000" })).toBe(
      "--max-old-space-size=16000",
    );
  });

  it("passes every project of a monorepo, jsconfig-only ones as files", async () => {
    const root = makeDir({});
    const { run, calls } = fakeRunner((call) =>
      writeIndexTo(call, emptyIndex(["a/x.ts", "web/y.js", "z.ts"])),
    );
    await runScipTypescript(
      root,
      [
        { path: "a/tsconfig.json", language: "json" },
        { path: "web/jsconfig.json", language: "json" },
        { path: "tsconfig.json", language: "json" },
        ts_("a/x.ts"),
        { path: "web/y.js", language: "javascript" },
        ts_("z.ts"),
      ],
      cfg(run),
    );
    const args = calls[0]!.args;
    expect(args.slice(args.indexOf(join(root, "web", "jsconfig.json")) - 2)).toEqual([
      root,
      join(root, "a"),
      join(root, "web", "jsconfig.json"),
    ]);
  });

  it("gives files no project covers a synthetic tsconfig in the temp directory (second pass)", async () => {
    const root = makeDir({ "tsconfig.json": "{}", "src/a.ts": "", "scripts/b.js": "" });
    const temp = tempRoot();
    let synthetic: { compilerOptions: Record<string, unknown>; files: string[] } | undefined;
    let syntheticPath = "";
    const { run, calls } = fakeRunner((call, n) => {
      if (n === 0) return writeIndexTo(call, emptyIndex(["src/a.ts"]));
      syntheticPath = call.args[call.args.length - 1]!;
      synthetic = JSON.parse(readFileSync(syntheticPath, "utf8"));
      writeIndexTo(call, emptyIndex(["scripts/b.js"]));
    });
    const out = await runScipTypescript(
      root,
      [
        { path: "tsconfig.json", language: "json" },
        ts_("src/a.ts"),
        { path: "scripts/b.js", language: "javascript" },
        { path: "notes.md", language: "text" },
      ],
      cfg(run, temp),
    );
    expect(calls).toHaveLength(2);
    expect(syntheticPath.startsWith(temp)).toBe(true);
    expect(synthetic!.files).toEqual([join(root, "scripts", "b.js")]);
    expect(synthetic!.compilerOptions).toMatchObject({
      allowJs: true,
      noEmit: true,
      moduleResolution: "bundler",
    });
    expect(calls[1]!.arg("--cwd")).toBe(root);
    expect(out.sources.map((s) => s.index.documents.map((d) => d.relativePath))).toEqual([
      ["src/a.ts"],
      ["scripts/b.js"],
    ]);
    expect(tempEntries(temp)).toEqual([]);
    expect(existsSync(join(root, "tsconfig.json"))).toBe(true);
  });

  it("without any tsconfig, one synthetic project covers every TypeScript and JavaScript file", async () => {
    const root = makeDir({ "a.ts": "", "b.js": "", "c.tsx": "" });
    let files: string[] = [];
    const { run, calls } = fakeRunner((call) => {
      files = JSON.parse(readFileSync(call.args[call.args.length - 1]!, "utf8")).files;
      writeIndexTo(call, emptyIndex(["a.ts"]));
    });
    await runScipTypescript(
      root,
      [
        ts_("a.ts"),
        { path: "b.js", language: "javascript" },
        { path: "c.tsx", language: "tsx" },
        { path: "x.py", language: "python" },
      ],
      cfg(run),
    );
    expect(calls).toHaveLength(1);
    expect(files).toEqual([join(root, "a.ts"), join(root, "b.js"), join(root, "c.tsx")]);
    expect(tempEntries(root).sort()).toEqual(["a.ts", "b.js", "c.tsx"]); // no tsconfig.json left behind
  });

  it("keeps the first pass when the second fails, but fails when there is no first pass", async () => {
    const root = makeDir({});
    const files = [
      { path: "tsconfig.json", language: "json" as const },
      ts_("src/a.ts"),
      ts_("scripts/b.ts"),
    ];
    const partial = fakeRunner((call, n) =>
      n === 0
        ? writeIndexTo(call, emptyIndex(["src/a.ts"]))
        : { code: 1, stderr: "boom in b\nsecond line" },
    );
    const out = await runScipTypescript(root, files, cfg(partial.run));
    expect(out.sources).toHaveLength(1);
    expect(out.warnings).toEqual([
      "scip-typescript@0.4.0 could not index the 1 file(s) outside the tsconfig projects: scip-typescript@0.4.0 exited with code 1: boom in b",
    ]);

    const alone = fakeRunner(() => ({ code: 1, stderr: "boom" }));
    await expect(runScipTypescript(root, [ts_("a.ts")], cfg(alone.run))).rejects.toThrow(
      /exited with code 1/,
    );
  });

  it("indexes everything with default compiler options when a tsconfig cannot be loaded (its `extends` is not installed)", async () => {
    const root = makeDir({});
    const files = [
      { path: "tsconfig.json", language: "json" as const },
      ts_("src/a.ts"),
      { path: "b.js", language: "javascript" as const },
    ];
    let synthetic: string[] = [];
    const { run, calls } = fakeRunner((call, n) => {
      if (n === 0) {
        return {
          code: 1,
          stdout: "error: no files got indexed",
          stderr: "error TS6053: File '@sourcegraph/tsconfig' not found.",
        };
      }
      synthetic = JSON.parse(readFileSync(call.args[call.args.length - 1]!, "utf8")).files;
      writeIndexTo(call, emptyIndex(["src/a.ts", "b.js"]));
    });
    const out = await runScipTypescript(root, files, cfg(run));
    expect(calls).toHaveLength(2);
    expect(synthetic).toEqual([join(root, "src", "a.ts"), join(root, "b.js")]);
    expect(out.sources).toHaveLength(1);
    expect(out.warnings).toEqual([
      "scip-typescript@0.4.0: the tsconfig projects could not be indexed (scip-typescript@0.4.0 exited with code 1: error TS6053: File '@sourcegraph/tsconfig' not found.); indexing every file with default compiler options instead",
    ]);
  });

  it("does not retry when the tool could not be started or timed out, and reports both failures otherwise", async () => {
    const root = makeDir({});
    const files = [{ path: "tsconfig.json", language: "json" as const }, ts_("a.ts")];
    const timedOut = fakeRunner(() => ({ timedOut: true, code: null }));
    await expect(runScipTypescript(root, files, cfg(timedOut.run))).rejects.toThrow(/timed out/);
    expect(timedOut.calls).toHaveLength(1);

    const failing = fakeRunner((_call, n) => ({
      code: 1,
      stderr: n === 0 ? "bad tsconfig" : "still broken",
    }));
    await expect(runScipTypescript(root, files, cfg(failing.run))).rejects.toThrow(
      /exited with code 1: bad tsconfig; and with default compiler options: scip-typescript@0\.4\.0 exited with code 1: still broken/,
    );
    expect(failing.calls).toHaveLength(2);
  });

  it("fails with the tool's output when it exits non-zero (fatal errors go to stdout)", async () => {
    const root = makeDir({});
    const temp = tempRoot();
    const { run } = fakeRunner(() => ({
      code: 1,
      stdout: "error: no files got indexed",
      stderr: "- ./ (missing tsconfig.json)",
    }));
    const failure = runScipTypescript(
      root,
      [{ path: "tsconfig.json", language: "json" }],
      cfg(run, temp),
    );
    await expect(failure).rejects.toThrow(ScipRunError);
    await expect(failure).rejects.toThrow(
      /scip-typescript@0\.4\.0 exited with code 1:\n- \.\/ \(missing tsconfig\.json\)\nerror: no files got indexed/,
    );
    expect(tempEntries(temp)).toEqual([]); // cleaned up on failure too
  });

  it("reports timeouts, a missing tool, a missing output and an undecodable output", async () => {
    const root = makeDir({});
    const files = [{ path: "tsconfig.json", language: "json" as const }];
    await expect(
      runScipTypescript(root, files, cfg(fakeRunner(() => ({ timedOut: true, code: null })).run)),
    ).rejects.toThrow(/timed out after 12s.*XPL_SCIP_TIMEOUT_MS/);
    const missing: CommandRunner = async () => {
      throw Object.assign(new Error("spawn npx ENOENT"), { code: "ENOENT" });
    };
    await expect(runScipTypescript(root, files, cfg(missing))).rejects.toThrow(
      /could not be started \(is `npx` installed and on PATH\?\): spawn npx ENOENT/,
    );
    await expect(runScipTypescript(root, files, cfg(fakeRunner().run))).rejects.toThrow(
      /did not write an index/,
    );
    const garbage = fakeRunner((call) =>
      writeFileSync(call.arg("--output")!, Uint8Array.from([0x12, 0x7f, 1])),
    );
    await expect(runScipTypescript(root, files, cfg(garbage.run))).rejects.toThrow(
      /cannot be decoded/,
    );
  });

  it("hands warnings of a successful run to the caller", async () => {
    const root = makeDir({});
    const { run } = fakeRunner((call) => {
      writeIndexTo(call, emptyIndex(["a.ts"]));
      return { stderr: "Warning: something odd\nfine", stdout: "done" };
    });
    const out = await runScipTypescript(
      root,
      [{ path: "tsconfig.json", language: "json" }],
      cfg(run),
    );
    expect(out.warnings).toEqual(["scip-typescript@0.4.0: Warning: something odd"]);
  });
});

// ─── scip-python ──────────────────────────────────────────────────────────────────────────────────

describe("runScipPython", () => {
  it("passes a project name and version, an empty environment and no pip dependency", async () => {
    const root = makeDir({ "pyproject.toml": '[project]\nname = "py-jobrunner"\n' });
    const temp = tempRoot();
    let environment = "";
    const { run, calls } = fakeRunner((call) => {
      environment = readFileSync(call.arg("--environment")!, "utf8");
      writeIndexTo(call, {
        tool: { name: "scip-python", version: "0.6.6" },
        documents: [{ path: "a.py" }],
      });
    });
    const out = await runScipPython(
      root,
      [],
      (path) => (path === "pyproject.toml" ? '[project]\nname = "py-jobrunner"\n' : undefined),
      { timeoutMs: 1000, run, tempRoot: temp },
    );
    const call = calls[0]!;
    expect(call.command).toBe("npx");
    expect(call.args.slice(0, 3)).toEqual(["--yes", "@sourcegraph/scip-python@0.6.6", "index"]);
    expect(call.arg("--project-name")).toBe("py-jobrunner");
    expect(call.arg("--project-version")).toBe("0.0.0");
    expect(call.arg("--cwd")).toBe(root);
    expect(call.args).toContain("--quiet");
    expect(environment.trim()).toBe("[]");
    expect(call.options.cwd).toBe(root);
    expect(out.sources[0]).toMatchObject({ pathPrefix: "", defaultEncoding: "utf16" });
    expect(out.sources[0]!.excludesBom).toBeFalsy();
    expect(tempEntries(temp)).toEqual([]);
  });

  it("puts the source roots on PYTHONPATH so a src/ layout resolves (import flask in tests/)", async () => {
    const root = makeDir({});
    const files = [
      { path: "src/flask/__init__.py", language: "python" as const },
      { path: "tests/test_app.py", language: "python" as const },
    ];
    const seen = async (env: NodeJS.ProcessEnv): Promise<string | undefined> => {
      const { run, calls } = fakeRunner((call) => writeIndexTo(call, { documents: [] }));
      await runScipPython(root, files, () => undefined, { timeoutMs: 1, run, env });
      return calls[0]!.options.env.PYTHONPATH;
    };
    expect(await seen({ PATH: "/bin" })).toBe(join(root, "src"));
    expect(await seen({ PATH: "/bin", PYTHONPATH: "/opt/extra" })).toBe(
      `${join(root, "src")}${delimiter}/opt/extra`,
    );
    // nothing to add: the environment is left alone
    const { run, calls } = fakeRunner((call) => writeIndexTo(call, { documents: [] }));
    await runScipPython(root, [{ path: "pkg/__init__.py", language: "python" }], () => undefined, {
      timeoutMs: 1,
      run,
      env: { PATH: "/bin" },
    });
    expect(calls[0]!.options.env.PYTHONPATH).toBeUndefined();
  });

  it("fails like the other tools", async () => {
    const root = makeDir({});
    const { run } = fakeRunner(() => ({
      code: 1,
      stderr: "Experienced Fatal Error While Indexing",
    }));
    await expect(runScipPython(root, [], () => undefined, { timeoutMs: 1, run })).rejects.toThrow(
      /scip-python@0\.6\.6 exited with code 1:\nExperienced Fatal Error/,
    );
  });
});

// ─── scip-go ──────────────────────────────────────────────────────────────────────────────────────

describe("runScipGo", () => {
  const files = (...paths: string[]) => paths.map((path) => ({ path }));

  it("runs once per module in its directory and prefixes the documents", async () => {
    const root = makeDir({
      "go.mod": "module example.com/a\n\ngo 1.22\n",
      "svc/api/go.mod": "module example.com/api\n\ngo 1.22\n",
      "vendor/x/go.mod": "module x\n",
    });
    const temp = tempRoot();
    const { run, calls } = fakeRunner((call, n) =>
      writeIndexTo(call, {
        tool: { name: "scip-go", version: "0.2.7" },
        documents: [{ path: `m${n}.go` }],
      }),
    );
    const out = await runScipGo(root, files("go.mod", "svc/api/go.mod", "vendor/x/go.mod"), {
      timeoutMs: 99,
      run,
      tempRoot: temp,
      env: { ...process.env, GOFLAGS: "-tags=ci" },
    });
    expect(calls).toHaveLength(2);
    expect(calls[0]!.options.cwd).not.toBe(root);
    expect(calls[1]!.options.cwd).toBe(join(calls[0]!.options.cwd, "svc", "api"));
    for (const call of calls) {
      expect(call.command).toBe("go");
      expect(call.args.slice(0, 4)).toEqual([
        "run",
        `${SCIP_GO_PACKAGE}@${SCIP_GO_VERSION}`,
        "index",
        "--output",
      ]);
      expect(call.options.env.GOFLAGS).toBe("-tags=ci -mod=mod");
      expect(call.options.timeoutMs).toBe(99);
    }
    expect(SCIP_GO_PACKAGE).toBe("github.com/scip-code/scip-go/cmd/scip-go");
    expect(SCIP_GO_VERSION).toBe("v0.2.7");
    expect(out.sources.map((s) => [s.pathPrefix, s.defaultEncoding])).toEqual([
      ["", "utf8"],
      ["svc/api", "utf8"],
    ]);
    expect(tempEntries(temp)).toEqual([]);
  });

  it("isolates module writes on success and failure, preserving concurrent user edits", async () => {
    const original = "module example.com/a\n\ngo 1.22\n";
    const root = makeDir({ "go.mod": original });
    const { run } = fakeRunner((call) => {
      writeFileSync(
        join(call.options.cwd, "go.mod"),
        `${original}\nrequire example.com/dep v1.0.0\n`,
      );
      writeFileSync(join(call.options.cwd, "go.sum"), "example.com/dep v1.0.0 h1:x\n");
      writeFileSync(join(root, "go.mod"), "user edit\n");
      writeIndexTo(call, { documents: [] });
    });
    await runScipGo(root, files("go.mod"), { timeoutMs: 1, run });
    expect(readFileSync(join(root, "go.mod"), "utf8")).toBe("user edit\n");
    expect(existsSync(join(root, "go.sum"))).toBe(false);

    // A failing tool must not restore over a go.sum edit made while it was running.
    writeFileSync(join(root, "go.sum"), "kept\n");
    const failing = fakeRunner((call) => {
      writeFileSync(join(call.options.cwd, "go.sum"), "changed\n");
      writeFileSync(join(root, "go.sum"), "concurrent edit\n");
      return { code: 2, stderr: "go: broken" };
    });
    await expect(
      runScipGo(root, files("go.mod"), { timeoutMs: 1, run: failing.run }),
    ).rejects.toThrow(/exited with code 2/);
    expect(readFileSync(join(root, "go.sum"), "utf8")).toBe("concurrent edit\n");
  });

  it.each(["relative", "absolute", "block", "inline block"])(
    "keeps %s workspace members inside the private copy",
    async (style) => {
      const root = makeDir({ "svc/go.mod": "module example.com/svc\n\ngo 1.25\n" });
      const target = style === "absolute" ? JSON.stringify(join(root, "svc")) : "./svc";
      const use =
        style === "block"
          ? `use (\n // comment\n ${target}\n)\n`
          : style === "inline block"
            ? `use (${target})\n`
            : `use ${target}\n`;
      writeFileSync(join(root, "go.work"), "go 1.25\n" + use);
      const { run } = fakeRunner((call) => {
        const copy = join(call.options.cwd, "..");
        expect(readFileSync(join(copy, "go.work"), "utf8")).toContain(
          JSON.stringify(call.options.cwd),
        );
        writeFileSync(join(copy, "go.work.sum"), "tool sum");
        writeFileSync(join(root, "go.work"), "concurrent workspace edit");
        writeIndexTo(call, { documents: [] });
      });
      await runScipGo(root, files("go.work", "svc/go.mod"), { timeoutMs: 1, run });
      expect(readFileSync(join(root, "go.work"), "utf8")).toBe("concurrent workspace edit");
      expect(existsSync(join(root, "go.work.sum"))).toBe(false);
    },
  );

  it("rejects workspace members outside the root before starting the tool", async () => {
    const root = makeDir({
      "go.mod": "module example.com/a\n",
      "go.work": "go 1.25\nuse ../other\n",
    });
    const { run, calls } = fakeRunner();
    await expect(
      runScipGo(root, files("go.mod", "go.work"), { timeoutMs: 1, run }),
    ).rejects.toThrow("outside the indexed root");
    expect(calls).toEqual([]);
    await runScipGo(root, files("go.mod", "go.work"), {
      timeoutMs: 1,
      run: fakeRunner((call) => writeIndexTo(call, { documents: [] })).run,
      env: { GOWORK: "off" },
    });
  });

  it("dereferences a module metadata symlink before the tool can write through it", async () => {
    const root = makeDir({ "actual.mod": "module example.com/a\n" });
    symlinkSync(join(root, "actual.mod"), join(root, "go.mod"));
    const { run } = fakeRunner((call) => {
      writeFileSync(join(call.options.cwd, "go.mod"), "tool edit");
      writeIndexTo(call, { documents: [] });
    });
    await runScipGo(root, files("go.mod"), { timeoutMs: 1, run });
    expect(readFileSync(join(root, "actual.mod"), "utf8")).toBe("module example.com/a\n");
  });

  it("preserves local replacement paths inside and outside the root", async () => {
    const root = makeDir({ "go.mod": "module example.com/a\nreplace example.com/dep => ../dep\n" });
    const { run } = fakeRunner((call) => {
      const text = readFileSync(join(call.options.cwd, "go.mod"), "utf8");
      expect(text).toContain(JSON.stringify(join(root, "..", "dep")));
      writeIndexTo(call, { documents: [] });
    });
    await runScipGo(root, files("go.mod"), { timeoutMs: 1, run });
    expect(readFileSync(join(root, "go.mod"), "utf8")).toContain("=> ../dep");
  });

  it("keeps a Go workspace (go.work): the go command rejects -mod=mod there", async () => {
    const root = makeDir({ "go.mod": "module example.com/a\n\ngo 1.22\n" });
    const flags = async (extra: string[], env: NodeJS.ProcessEnv): Promise<string | undefined> => {
      const { run, calls } = fakeRunner((call) => writeIndexTo(call, { documents: [] }));
      await runScipGo(root, files("go.mod", ...extra), { timeoutMs: 1, run, env });
      return calls[0]!.options.env.GOFLAGS;
    };
    expect(await flags([], { PATH: "/bin" })).toBe("-mod=mod");
    expect(await flags(["go.work"], { PATH: "/bin" })).toBeUndefined();
    expect(await flags(["go.work"], { PATH: "/bin", GOFLAGS: "-tags=ci" })).toBe("-tags=ci");
    expect(await flags(["go.work"], { PATH: "/bin", GOWORK: "off" })).toBe("-mod=mod");
    expect(await flags(["vendor/x/go.work"], { PATH: "/bin" })).toBe("-mod=mod");
  });

  it("uses a vendor directory as it is instead of forcing -mod=mod (no network needed)", async () => {
    const root = makeDir({
      "go.mod": "module example.com/a\n\ngo 1.22\n",
      "vendor/modules.txt": "# example.com/dep v1.0.0\n",
      "other/go.mod": "module example.com/other\n\ngo 1.22\n",
    });
    const { run, calls } = fakeRunner((call) => writeIndexTo(call, { documents: [] }));
    await runScipGo(root, files("go.mod", "other/go.mod"), {
      timeoutMs: 1,
      run,
      env: { PATH: "/bin" },
    });
    expect(calls.map((c) => c.options.env.GOFLAGS)).toEqual([undefined, "-mod=mod"]);
  });

  it("fails without a go.mod, and names the module that failed", async () => {
    const root = makeDir({});
    await expect(
      runScipGo(root, files("main.go"), { timeoutMs: 1, run: fakeRunner().run }),
    ).rejects.toThrow(/no go\.mod found/);
    mkdirSync(join(root, "svc"), { recursive: true });
    const { run } = fakeRunner(() => ({ code: 1, stderr: "requires go >= 1.25.0" }));
    await expect(runScipGo(root, files("svc/go.mod"), { timeoutMs: 1, run })).rejects.toThrow(
      /scip-go@v0\.2\.7 \(svc\) exited with code 1:\nrequires go >= 1\.25\.0/,
    );
  });
});

// ─── Resolvers and buildIndex ─────────────────────────────────────────────────────────────────────

describe("the resolvers registry", () => {
  it("registers scip-typescript, scip-python and scip-go by default", () => {
    expect(indexProviders().map((r) => [r.id, [...r.languages]])).toEqual([
      ["scip-typescript", ["typescript", "tsx", "javascript"]],
      ["scip-python", ["python"]],
      ["scip-go", ["go"]],
    ]);
  });
});

describe("buildIndex with the SCIP resolvers", () => {
  const tsSrc = marked(`export class ⟦A⟧ {
  ⟦run⟧(): void {}
}
export function ⟦use⟧(): void {
  new ⟦A⟧().⟦run⟧();
}
`);
  const tsProject = { "tsconfig.json": "{}", "a.ts": tsSrc.text };

  /** A tool that indexes `a.ts` like scip-typescript would, and says which version it is. */
  const tsTool: Handler = (call) => {
    const document: DocumentSpec = {
      path: "a.ts",
      occurrences: [
        moduleDef("a.ts"),
        ...occs(tsSrc, [
          [0, ts("a.ts", "A#"), DEF],
          [1, ts("a.ts", "A#run()."), DEF],
          [2, ts("a.ts", "use()."), DEF],
          [3, ts("a.ts", "A#")],
          [4, ts("a.ts", "A#run().")],
        ]),
      ],
    };
    writeIndexTo(call, {
      tool: { name: "scip-typescript", version: "9.9.9" },
      documents: [document],
    });
  };

  it("auto: a failing tool becomes a warning and the language keeps its heuristic references", async () => {
    const dir = makeDir(tsProject);
    const { run, calls } = fakeRunner(() => ({ code: 1, stderr: "npm ERR! network offline" }));
    const { index, warnings } = await buildIndex({
      root: dir,
      precise: "auto",
      providers: createScipProviders({ run, timeoutMs: 1000 }),
    });
    expect(calls.length).toBeGreaterThan(0);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(
      /^precise provider "scip-typescript" failed \(scip-typescript@0\.4\.0 exited with code 1:/,
    );
    expect(warnings[0]).toMatch(
      /exited with code 1: npm ERR! network offline; and with default compiler options: .*npm ERR! network offline\); using heuristic references for typescript/s,
    );
    expect(index.languages.typescript!.refs).toBe("heuristic");
    expect(index.refs.length).toBeGreaterThan(0);
    expect(index.refs.every((r) => r.resolution === "heuristic")).toBe(true);
  });

  it("require: a failing tool fails the build", async () => {
    const dir = makeDir(tsProject);
    const { run } = fakeRunner(() => ({ code: 1, stderr: "boom" }));
    await expect(
      buildIndex({ root: dir, precise: "require", providers: createScipProviders({ run }) }),
    ).rejects.toThrow(
      /precise provider "scip-typescript" failed: scip-typescript@0\.4\.0 exited with code 1/,
    );
  });

  it("off: no tool is run", async () => {
    const dir = makeDir(tsProject);
    const { run, calls } = fakeRunner();
    await buildIndex({ root: dir, precise: "off", providers: createScipProviders({ run }) });
    expect(calls).toEqual([]);
  });

  it("names the tool from the index metadata and marks the language precise", async () => {
    const dir = makeDir(tsProject);
    const { run } = fakeRunner(tsTool);
    const { index, warnings } = await buildIndex({
      root: dir,
      precise: "require",
      providers: createScipProviders({ run }),
    });
    expect(warnings).toEqual([]);
    expect(index.languages.typescript).toMatchObject({
      refs: "precise",
      tool: "scip-typescript@9.9.9",
    });
    // the references are the tool's, not the heuristic resolver's
    expect(index.refs.map((r) => `${r.kind} ${r.from} -> ${r.to} ${r.resolution}`)).toEqual([
      "call a.ts#use -> a.ts#A precise",
      "call a.ts#use -> a.ts#A.run precise",
    ]);
  });

  it("falls back to the pinned version when the index carries no tool information", async () => {
    const dir = makeDir(tsProject);
    const { run } = fakeRunner((call) => writeIndexTo(call, { documents: [{ path: "a.ts" }] }));
    const { index } = await buildIndex({
      root: dir,
      precise: "auto",
      providers: createScipProviders({ run }),
    });
    expect(index.languages.typescript!.tool).toBe("scip-typescript@0.4.0");
  });

  it("a failing tool only costs its own languages their precise references", async () => {
    const dir = makeDir({
      ...tsProject,
      "pkg/__init__.py": "",
      "pkg/m.py": "class M:\n    def go(self) -> None:\n        pass\n",
    });
    const { run, calls } = fakeRunner((call) => {
      if (call.args.some((a) => a.includes("scip-python")))
        return { code: 1, stderr: "python broke" };
      writeIndexTo(call, {
        tool: { name: "scip-typescript", version: "0.4.0" },
        documents: [{ path: "a.ts" }],
      });
    });
    const { index, warnings } = await buildIndex({
      root: dir,
      precise: "auto",
      providers: createScipProviders({ run }),
    });
    expect(index.languages.typescript!.refs).toBe("precise");
    expect(index.languages.python!.refs).toBe("heuristic");
    expect(warnings.filter((w) => w.startsWith("precise provider"))).toEqual([
      expect.stringMatching(
        /^precise provider "scip-python" failed \(scip-python@0\.6\.6 exited with code 1:\npython broke\); using heuristic references for python$/,
      ),
    ]);
    expect(calls.map((c) => c.command)).toEqual(["npx", "npx"]);
  });

  it("a file with occurrences that do not fit it (changed while indexing, `//line` directives) keeps heuristic references", async () => {
    const dir = makeDir(tsProject);
    const { run } = fakeRunner((call) =>
      writeIndexTo(call, {
        documents: [
          { path: "a.ts", occurrences: [{ range: [99, 0, 1], symbol: "x", roles: DEF }] },
        ],
      }),
    );
    const { warnings } = await buildIndex({
      root: dir,
      precise: "auto",
      providers: createScipProviders({ run }),
    });
    expect(warnings).toEqual([
      "scip-typescript@0.4.0: 1 file(s) have positions outside their text (changed while indexing, or `//line` directives of generated code); they keep heuristic references: a.ts",
      'precise provider "scip-typescript" failed (the tool described none of the 1 typescript file(s)); using heuristic references for typescript',
    ]);
  });

  it("files the tool did not describe keep their heuristic references and are counted, and named in a warning (not vendored or test data)", async () => {
    const dir = makeDir({
      ...tsProject,
      "extra.ts":
        'import { A } from "./a.ts";\nexport function extra(): void {\n  new A().run();\n}\n',
      "testdata/sample.ts": "export const y = 1;\n",
    });
    // the (fake) tool describes a.ts only, in both passes
    const { run } = fakeRunner(tsTool);
    const { index, warnings } = await buildIndex({
      root: dir,
      precise: "auto",
      providers: createScipProviders({ run }),
    });
    expect(warnings).toEqual([
      expect.stringMatching(
        /^scip-typescript@9\.9\.9 did not describe 1 file\(s\).*; their references stay heuristic: extra\.ts$/,
      ),
    ]);
    expect(index.languages.typescript).toMatchObject({
      refs: "precise",
      tool: "scip-typescript@9.9.9",
      heuristicFiles: 2, // extra.ts and testdata/sample.ts
    });
    const by = (file: string) => index.refs.filter((r) => r.from.startsWith(`${file}#`));
    expect(by("a.ts").map((r) => r.resolution)).toEqual(["precise", "precise"]);
    expect(by("extra.ts").length).toBeGreaterThan(0);
    expect(by("extra.ts").every((r) => r.resolution === "heuristic")).toBe(true);
    expect(by("extra.ts").map((r) => `${r.kind} ${r.from} -> ${r.to}`)).toContain(
      "call extra.ts#extra -> a.ts#A.run",
    );
  });

  it("real processes: tools that are not installed degrade to a warning (auto) or fail (require)", async () => {
    const dir = makeDir(tsProject);
    // an empty PATH: `npx` cannot be found, whatever the machine has installed
    const providers = createScipProviders({ env: { PATH: "" } });
    const auto = await buildIndex({ root: dir, precise: "auto", providers });
    expect(auto.warnings).toEqual([
      expect.stringMatching(
        /^precise provider "scip-typescript" failed \(scip-typescript@0\.4\.0 could not be started \(is `npx` installed and on PATH\?\).*\); using heuristic references for typescript$/,
      ),
    ]);
    expect(auto.index.languages.typescript!.refs).toBe("heuristic");
    await expect(buildIndex({ root: dir, precise: "require", providers })).rejects.toThrow(
      /precise provider "scip-typescript" failed: scip-typescript@0\.4\.0 could not be started/,
    );
  });

  it("passes the configured timeout to the tools", async () => {
    const dir = makeDir(tsProject);
    const { run, calls } = fakeRunner(tsTool);
    await buildIndex({
      root: dir,
      precise: "auto",
      providers: createScipProviders({ run, timeoutMs: 4242 }),
    });
    expect(calls.every((c) => c.options.timeoutMs === 4242)).toBe(true);
  });
});
