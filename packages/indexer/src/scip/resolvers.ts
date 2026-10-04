/**
 * The precise resolvers: one per SCIP indexer, so a failing tool only costs its own languages their precise
 * references (`buildIndex` falls back to the heuristic ones for it, or throws in `precise: "require"` mode).
 *
 * Each resolver: run the tool -> decode `index.scip` -> map to references (`mapScip`).
 */
import type { FileLanguage, FilePath } from "@xpl/core";
import type { PreciseInput, PreciseOutput, PreciseResolver } from "../precise.js";
import { PRECISE_SUPPORT } from "../analysis.js";
import { mapScip } from "./map.js";
import type { ScipSource } from "./map.js";
import {
  SCIP_GO_VERSION,
  SCIP_PYTHON_VERSION,
  SCIP_TYPESCRIPT_VERSION,
  defaultTimeoutMs,
  inSkippedDir,
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
function warnUncovered(input: PreciseInput, tool: string, files: readonly FilePath[]): void {
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
  input: PreciseInput,
  run: ScipRunOutput,
  fallbackTool: string,
): Promise<PreciseOutput> {
  for (const warning of run.warnings) input.warn(warning);
  const result = await mapScip({
    root: input.root,
    languages: input.languages,
    files: input.files,
    lookup: input.lookup,
    readText: input.readText,
    withFile: input.withFile,
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
    refs:
      misplaced.size > 0
        ? result.refs.filter((r) => !misplaced.has(r.from.slice(0, r.from.indexOf("#"))))
        : result.refs,
    tool,
    describedFiles: result.described.filter((f) => !misplaced.has(f)),
    blind: result.blind,
  };
}

function runConfig(options: ScipOptions): ScipRunConfig {
  return {
    timeoutMs: options.timeoutMs ?? defaultTimeoutMs(options.env ?? process.env),
    run: options.run ?? runCommand,
    tempRoot: options.tempRoot,
    env: options.env,
  };
}

const TYPESCRIPT_LANGUAGES: readonly FileLanguage[] = ["typescript", "tsx", "javascript"];

/** scip-typescript for TypeScript, TSX and JavaScript. */
export function scipTypescriptResolver(options: ScipOptions = {}): PreciseResolver {
  const tool = `scip-typescript@${SCIP_TYPESCRIPT_VERSION}`;
  return {
    id: "scip-typescript",
    capabilities: PRECISE_SUPPORT,
    languages: TYPESCRIPT_LANGUAGES,
    async resolve(input) {
      return finish(
        input,
        await runScipTypescript(input.root, input.files, runConfig(options)),
        tool,
      );
    },
  };
}

/** scip-python for Python. */
export function scipPythonResolver(options: ScipOptions = {}): PreciseResolver {
  const tool = `scip-python@${SCIP_PYTHON_VERSION}`;
  return {
    id: "scip-python",
    capabilities: PRECISE_SUPPORT,
    languages: ["python"],
    async resolve(input) {
      return finish(
        input,
        await runScipPython(input.root, input.files, input.readText, runConfig(options)),
        tool,
      );
    },
  };
}

/** scip-go for Go (one run per go.mod). */
export function scipGoResolver(options: ScipOptions = {}): PreciseResolver {
  const tool = `scip-go@${SCIP_GO_VERSION.replace(/^v/, "")}`;
  return {
    id: "scip-go",
    capabilities: PRECISE_SUPPORT,
    languages: ["go"],
    async resolve(input) {
      return finish(input, await runScipGo(input.root, input.files, runConfig(options)), tool);
    },
  };
}

/** The three resolvers, configured with `options`. */
export function createScipResolvers(options: ScipOptions = {}): PreciseResolver[] {
  return [scipTypescriptResolver(options), scipPythonResolver(options), scipGoResolver(options)];
}
