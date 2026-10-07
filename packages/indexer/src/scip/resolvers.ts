import { readFile } from "node:fs/promises";
import { dirname, isAbsolute, join, posix, relative, resolve } from "node:path";
import { splitLines } from "@xpl/core";
import { FileHasher } from "../hash.js";
/**
 * The precise providers: one per SCIP indexer, so a failing tool only costs its own languages their precise
 * references (`buildIndex` falls back to the heuristic ones for it, or throws in `precise: "require"` mode).
 *
 * Each provider: run the tool -> decode `index.scip` -> map to references (`mapScip`).
 */
import type { FileLanguage, FilePath } from "@xpl/core";
import type { ProviderInput, RelationshipResult, IndexProvider } from "../providers.js";
import { PRECISE_SUPPORT, relationshipOutput } from "../analysis.js";
import { mapScip } from "./map.js";
import type { ScipSource } from "./map.js";
import type { RepoView } from "../languages/types.js";
import { parseJsonc, readProjectConfiguration } from "../languages/ts-modules.js";
import {
  SCIP_GO_VERSION,
  SCIP_PYTHON_VERSION,
  SCIP_TYPESCRIPT_VERSION,
  defaultTimeoutMs,
  inSkippedDir,
  goModules,
  pythonProjectName,
  typescriptProjects,
  runCommand,
  runScipGo,
  runScipPython,
  runScipTypescript,
} from "./run.js";
import type { CommandRunner, ScipRunConfig, ScipRunOutput } from "./run.js";

export interface ScipOptions {
  /** Per-tool timeout in ms (default 10 minutes, or `XPL_SCIP_TIMEOUT_MS`). */
  timeoutMs?: number;
  /** How to run the tools (default: spawn processes). */
  run?: CommandRunner;
  /** Directory for temp directories (default: the OS temp directory). */
  tempRoot?: string;
  /** Environment of the tools (default: `process.env`). */
  env?: NodeJS.ProcessEnv;
}

/** Example files named in the "not indexed" warning. */
const UNCOVERED_EXAMPLES = 5;

/** `scip-typescript@0.4.0` from the index metadata, else the pinned default. */
function toolName(sources: readonly ScipSource[], fallback: string): string {
  const meta = sources[0]?.index.metadata;
  return meta?.toolName && meta.toolVersion ? `${meta.toolName}@${meta.toolVersion}` : fallback;
}

/** Files the tool left out: their references stay heuristic, which is worth telling the user. */
function warnUncovered(input: ProviderInput, tool: string, files: readonly FilePath[]): void {
  const uncovered = files.filter((f) => !inSkippedDir(f));
  if (uncovered.length === 0) return;
  const shown = uncovered.slice(0, UNCOVERED_EXAMPLES).join(", ");
  const more =
    uncovered.length > UNCOVERED_EXAMPLES
      ? `, and ${uncovered.length - UNCOVERED_EXAMPLES} more`
      : "";
  input.warn(
    `${tool} did not describe ${uncovered.length} file(s) (excluded by build constraints or by the tool's own configuration, or unreadable?); their references stay heuristic: ${shown}${more}`,
  );
}

async function finish(
  input: ProviderInput,
  run: ScipRunOutput,
  fallbackTool: string,
): Promise<RelationshipResult> {
  for (const warning of run.warnings) input.warn(warning);
  const result = await mapScip({
    root: input.root,
    languages: input.languages,
    files: input.files,
    lookup: input.lookup,
    readText: input.readText,
    classify: input.classify,
    warn: input.warn,
    sources: run.sources,
  });
  const tool = toolName(run.sources, fallbackTool);
  warnUncovered(input, tool, result.uncovered);
  const { outOfRange, malformed, classifyErrors } = result.stats;
  if (classifyErrors > 0) {
    input.warn(
      `${tool}: the ${input.languages.join("/")} language pack failed on ${classifyErrors} occurrence(s); they use fallback kinds`,
    );
  }
  if (outOfRange + malformed > 0 && result.misplaced.length === 0) {
    input.warn(
      `${tool}: ${outOfRange + malformed} occurrence(s) do not fit the files they describe and were ignored (did the files change while indexing?)`,
    );
  }
  // A file whose positions point outside it (`//line` directives of generated Go code: the tool reports the
  // source the code was generated from) is not described: it keeps its heuristic references.
  const misplaced = new Set(result.misplaced);
  if (misplaced.size > 0) {
    input.warn(
      `${tool}: ${misplaced.size} file(s) have positions outside their text (changed while indexing, or \`//line\` directives of generated code); they keep heuristic references: ${[...misplaced].slice(0, 5).join(", ")}${misplaced.size > 5 ? ", ..." : ""}`,
    );
  }
  return {
    resolution: "precise",
    refs:
      misplaced.size > 0
        ? result.refs.filter((r) => !misplaced.has(r.from.slice(0, r.from.indexOf("#"))))
        : result.refs,
    tool,
    describedFiles: result.described.filter((f) => !misplaced.has(f)),
    blind: result.blind,
  };
}

/** Tools read disk, so check the supplied snapshot before and after the run, including config files. */
async function checkedRun(
  input: ProviderInput,
  run: () => Promise<ScipRunOutput>,
): Promise<ScipRunOutput> {
  const check = async () => {
    for (const file of input.files) {
      let text;
      try {
        text = await readFile(join(input.root, ...file.path.split("/")), "utf8");
      } catch {
        throw new Error(`source changed while indexing: ${file.path}`);
      }
      if (new FileHasher(splitLines(text)).hashFile() !== file.hash)
        throw new Error(`source changed while indexing: ${file.path}`);
    }
  };
  await check();
  const result = await run();
  await check();
  return result;
}

function runConfig(options: ScipOptions, signal?: AbortSignal): ScipRunConfig {
  return {
    signal,
    timeoutMs: options.timeoutMs ?? defaultTimeoutMs(options.env ?? process.env),
    run: options.run ?? runCommand,
    tempRoot: options.tempRoot,
    env: options.env,
  };
}

const TYPESCRIPT_LANGUAGES: readonly FileLanguage[] = ["typescript", "tsx", "javascript"];

/** scip-typescript for TypeScript, TSX and JavaScript. */
export function scipTypescriptProvider(options: ScipOptions = {}): IndexProvider {
  const tool = `scip-typescript@${SCIP_TYPESCRIPT_VERSION}`;
  const configured = new WeakSet<RepoView>();
  return {
    id: "scip-typescript",
    capabilities: PRECISE_SUPPORT,
    languages: TYPESCRIPT_LANGUAGES,
    readConfiguration(file, repo) {
      // scip-typescript@0.4.0 src/main.ts indexSingleProject/loadConfigFile:
      // xpl passes indexed tsconfig directories before jsconfig files (typescriptProjects).
      // A directory selects tsconfig.json; a file selects itself. Local extends probes exact then
      // .json; references select <directory>/tsconfig.json or the named JSON file (ts-modules.ts).
      // The tool's synthetic leftover config is generated, not a mutable repository input.
      if (!configured.has(repo)) {
        configured.add(repo);
        const seen = new Set<string>();
        for (const project of typescriptProjects([...repo.files].map((path) => ({ path }))))
          readProjectConfiguration(
            repo,
            repo.files.has(project) ? project : posix.join(project, "tsconfig.json"),
            seen,
          );
      }
      // src/Packages.ts symbol: nearest package.json wins, even if invalid or anonymous.
      // A synthetic project outside the source tree can search past repo.root, so record ancestors.
      let dir = dirname(resolve(repo.root, file));
      for (;;) {
        const path = relative(repo.root, join(dir, "package.json")).split("\\").join("/");
        if (repo.readText(path) !== undefined || dirname(dir) === dir) break;
        dir = dirname(dir);
      }
    },
    async analyze(input) {
      return relationshipOutput(
        input,
        this,
        await finish(
          input,
          await checkedRun(input, () =>
            runScipTypescript(input.root, input.files, runConfig(options, input.signal)),
          ),
          tool,
        ),
      );
    },
  };
}

/** scip-python for Python. */
export function scipPythonProvider(options: ScipOptions = {}): IndexProvider {
  const tool = `scip-python@${SCIP_PYTHON_VERSION}`;
  return {
    id: "scip-python",
    capabilities: PRECISE_SUPPORT,
    languages: ["python"],
    readConfiguration(_file, repo) {
      // scip-python@0.6.6, scip-python/src/config.ts (dist/scip-python.js.map):
      // _findConfigFileHereOrUp checks scip-pyrightconfig.json before pyrightconfig.json in each
      // directory, from cwd through ancestors. Only if neither exists anywhere does it search
      // pyproject.toml, whose [tool.scip] precedes [tool.pyright]. This version does not load extends.
      // xpl's --project-name separately reads root pyproject [project], then setup.cfg [metadata].
      pythonProjectName(repo.root, (path) => repo.readText(path));
      for (const names of [["scip-pyrightconfig.json", "pyrightconfig.json"], ["pyproject.toml"]]) {
        let dir = repo.root;
        for (;;) {
          for (const name of names) {
            const path = relative(repo.root, join(dir, name)).split("\\").join("/");
            if (repo.readText(path) !== undefined) return;
          }
          if (dirname(dir) === dir) break;
          dir = dirname(dir);
        }
      }
    },
    async analyze(input) {
      return relationshipOutput(
        input,
        this,
        await finish(
          input,
          await checkedRun(input, () =>
            runScipPython(
              input.root,
              input.files,
              input.readText,
              runConfig(options, input.signal),
            ),
          ),
          tool,
        ),
      );
    },
  };
}

/** scip-go for Go (one run per go.mod). */
export function scipGoProvider(options: ScipOptions = {}): IndexProvider {
  const tool = `scip-go@${SCIP_GO_VERSION.replace(/^v/, "")}`;
  const configured = new WeakSet<RepoView>();
  return {
    id: "scip-go",
    capabilities: PRECISE_SUPPORT,
    languages: ["go"],
    readConfiguration(_file, repo) {
      // scip-go@v0.2.7 internal/modules/modules.go ModuleName reads module go.mod first.
      // internal/loader/loader.go LoadPackages delegates to x/tools@v0.45.0 go/packages/golist.go
      // and cmd/go/internal/modload/init.go (checked against Go 1.25.0): GOWORK=off disables work;
      // explicit GOWORK wins, else nearest go.work wins. Workspace sums and vendor/modules.txt
      // belong beside that workfile; without work, sums/vendor belong beside the module.
      // Workspace use members and local replace modules also supply go.mod/go.sum. GOFLAGS
      // -modfile selects an alternate .mod/.sum; -overlay reads its JSON and backing files.
      // xpl runs in a private root copy, so implicit workspace lookup stops at the copied root.
      if (configured.has(repo)) return;
      configured.add(repo);
      const processEnv = options.env ?? process.env;
      const defaults: Record<string, string> = {};
      // cmd/go/internal/cfg/cfg.go EnvFile/readEnvFile: process > user go/env > GOROOT/go.env.
      // Default GOROOT/tool installations are external dependencies; an explicit GOROOT is observable.
      const readEnv = (path: string) => {
        const text = repo.readText(
          relative(repo.root, resolve(repo.root, path)).split("\\").join("/"),
        );
        for (const line of (text ?? "").split("\n")) {
          const match = /^([A-Z][^=]*)=(.*)$/.exec(line);
          if (match) defaults[match[1]!] = match[2]!;
        }
      };
      const configDir =
        process.platform === "win32"
          ? processEnv.APPDATA
          : process.platform === "darwin"
            ? processEnv.HOME && join(processEnv.HOME, "Library/Application Support")
            : processEnv.XDG_CONFIG_HOME || (processEnv.HOME && join(processEnv.HOME, ".config"));
      const envFile = processEnv.GOENV || (configDir && join(configDir, "go/env"));
      if (envFile && envFile !== "off") readEnv(envFile);
      const goroot = processEnv.GOROOT || defaults.GOROOT;
      if (goroot) {
        const user = { ...defaults };
        readEnv(join(goroot, "go.env"));
        Object.assign(defaults, user);
      }
      const env = {
        ...defaults,
        ...Object.fromEntries(Object.entries(processEnv).filter(([, v]) => v)),
      };
      const modules = goModules([...repo.files].map((path) => ({ path })));
      const seen = new Set<string>();
      const localModules = (text: string, dir: string, workspace = false): void => {
        const tokens = [...text.matchAll(/"(?:[^"\\]|\\.)*"|`[^`]*`|\/\/[^\n]*|[()]|[^\s()]+/g)]
          .map((m) => m[0])
          .filter((t) => !t.startsWith("//"));
        const unquote = (token: string): string =>
          token.startsWith('"') ? JSON.parse(token) : token.replace(/^`|`$/g, "");
        const read = (token: string) => {
          const path = unquote(token);
          readModule(
            relative(repo.root, resolve(repo.root, dir, path))
              .split("\\")
              .join("/"),
          );
        };
        for (let i = 0; i < tokens.length; i++) {
          if (workspace && tokens[i] === "use") {
            if (tokens[i + 1] === "(") {
              for (i += 2; i < tokens.length && tokens[i] !== ")"; i++) read(tokens[i]!);
            } else if (tokens[i + 1]) read(tokens[++i]!);
          } else if (tokens[i] === "=>" && tokens[i + 1]) {
            const token = tokens[++i]!;
            const path = unquote(token);
            if (isAbsolute(path) || /^\.{1,2}(?:\/|$)/.test(path)) read(token);
          }
        }
      };
      const readModule = (dir: string): void => {
        if (seen.has(dir)) return;
        seen.add(dir);
        const text = repo.readText(posix.join(dir, "go.mod"));
        repo.readText(posix.join(dir, "go.sum"));
        if (text !== undefined) localModules(text, dir);
      };
      // cmd/go/internal/base/goflags.go uses quoted.Split: only whole fields are quoted, no escapes.
      const flags = (env.GOFLAGS ?? "").match(/"[^"]*"|'[^']*'|[^ \t\r\n]+/g) ?? [];
      for (const dir of modules) {
        repo.readText(posix.join(dir, "go.mod"));
        let work: string | undefined;
        if (env.GOWORK && env.GOWORK !== "off" && env.GOWORK !== "auto") {
          work = relative(repo.root, resolve(repo.root, env.GOWORK)).split("\\").join("/");
        } else if (env.GOWORK !== "off") {
          let parent = dir;
          for (;;) {
            const path = posix.join(parent, "go.work");
            if (repo.readText(path) !== undefined) {
              work = path;
              break;
            }
            if (!parent) break;
            parent = posix.dirname(parent) === "." ? "" : posix.dirname(parent);
          }
        }
        if (work !== undefined) {
          const text = repo.readText(work);
          repo.readText(`${work}.sum`);
          repo.readText(posix.join(posix.dirname(work), "vendor/modules.txt"));
          if (text !== undefined) localModules(text, posix.dirname(work), true);
        } else {
          readModule(dir);
          repo.readText(posix.join(dir, "vendor/modules.txt"));
        }
        for (const flag of flags) {
          const match = /^--?(modfile|overlay)=(.*)$/.exec(flag.replace(/^['"]|['"]$/g, ""));
          if (!match) continue;
          const path = relative(repo.root, resolve(repo.root, dir, match[2]!))
            .split("\\")
            .join("/");
          const text = repo.readText(path);
          if (match[1] === "modfile") {
            repo.readText(path.replace(/\.mod$/, ".sum"));
            if (text !== undefined) localModules(text, posix.dirname(path));
          } else if (text !== undefined) {
            const overlay = parseJsonc(text) as { Replace?: Record<string, unknown> } | undefined;
            for (const backing of Object.values(overlay?.Replace ?? {}))
              if (typeof backing === "string" && backing !== "")
                repo.readText(
                  relative(repo.root, resolve(repo.root, dir, backing))
                    .split("\\")
                    .join("/"),
                );
          }
        }
      }
    },
    async analyze(input) {
      return relationshipOutput(
        input,
        this,
        await finish(
          input,
          await checkedRun(input, () =>
            runScipGo(input.root, input.files, runConfig(options, input.signal)),
          ),
          tool,
        ),
      );
    },
  };
}

/** The three providers, configured with `options`. */
export function createScipProviders(options: ScipOptions = {}): IndexProvider[] {
  return [scipTypescriptProvider(options), scipPythonProvider(options), scipGoProvider(options)];
}
