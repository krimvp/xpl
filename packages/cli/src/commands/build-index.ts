import { readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import type { LanguageInfo } from "@xpl/core";
import { describeAnalysis } from "@xpl/core";
import { buildIndex, writeIndex } from "@xpl/indexer";
import { scipProviders } from "../index-options.js";
import type { CommandSpec } from "../command.js";
import { CliError, errorMessage } from "../errors.js";
import { plural } from "../format.js";
import { displayPath, toPosix } from "../fsutil.js";
import { EXPLAINER_DIR, EXPLAINER_SUFFIX, readExplainerFile } from "../repo.js";

const PRECISE = ["auto", "off", "require"] as const;
/** The limits `@xpl/indexer` records for heuristic and for precise relationship results (analysis.ts). */
const HEURISTIC_LIMIT = "References matched by name are hints";
const PRECISE_LIMIT =
  "A tool can miss a reference, so an empty result does not prove there is none.";

/**
 * The coverage lines of `describeAnalysis`, easier to scan: one language per line in name order, the provider only
 * when it is not the language itself (`typescript`, not `typescript (typescript)`), and the file-anchor line of
 * every file first, as `all 13 files`.
 */
export function coverageDetails(
  details: readonly string[],
  files: number,
  languages: Readonly<Record<string, LanguageInfo>>,
): string[] {
  /** A language whose every file a precise tool analyzed: its heuristic hints are not what it uses. */
  const precise = (language: string) =>
    languages[language]?.refs === "precise" && (languages[language]?.heuristicFiles ?? 0) === 0;
  const parsed = details.flatMap((line) => {
    const m = /^(\S+) \(([^)]+)\): (.*)$/.exec(line);
    if (!m) return [{ key: "~", line }];
    const [, langs, provider, rest] = m as unknown as [string, string, string, string];
    if (provider === "files") return [{ key: "", line: `all ${plural(files, "file")}: ${rest}` }];
    if (provider === langs && precise(langs) && rest.includes(HEURISTIC_LIMIT)) return [];
    // a tool that analyzed every file but does not report what it may miss: "partial" reads as broken
    const all = /^(.*) partial \((\d+)\/\2 files analyzed\)\. (.*)$/.exec(rest);
    const text =
      provider !== langs && all && all[3] === PRECISE_LIMIT
        ? `${all[1]} precise (${all[2]}/${all[2]} files analyzed). The tool does not report what it may have missed.`
        : rest;
    const head = provider === langs ? langs : `${langs} (${provider})`;
    return [{ key: langs, line: `${head}: ${text}` }];
  });
  // stable: a language's lines keep their order (symbols, then relationships)
  return parsed
    .map((p, i) => ({ ...p, i }))
    .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : a.i - b.i))
    .map((p) => p.line);
}

/** Explainers bound to another index than `commit`: they need `xpl resolve <explainer> --write`. */
function explainersNeedingResolve(root: string, commit: string): string[] {
  const dir = join(root, EXPLAINER_DIR);
  let names: string[];
  try {
    names = readdirSync(dir).filter((n) => n.endsWith(EXPLAINER_SUFFIX));
  } catch {
    return [];
  }
  const out: string[] = [];
  for (const name of names) {
    try {
      const explainer = readExplainerFile(join(dir, name));
      if (explainer.index?.commit !== commit) out.push(name.slice(0, -EXPLAINER_SUFFIX.length));
    } catch {
      // an unreadable explainer is `xpl validate`'s business
    }
  }
  return out.sort();
}

/**
 * How far the references of a language can be trusted: `none`, `heuristic`, `precise (scip-python@0.6.6)`, and
 * when the precise tool did not describe every file (build constraints, its own exclusions), how many it did:
 * `precise 64/82 (scip-python@0.6.6), 18 heuristic`. The references of those files are hints.
 */
export function describeRefs(info: LanguageInfo): string {
  if (info.refs !== "precise") return info.refs;
  const tool = info.tool ? ` (${info.tool})` : "";
  const heuristic = info.heuristicFiles ?? 0;
  if (heuristic <= 0) return `precise${tool}`;
  return `precise ${Math.max(0, info.files - heuristic)}/${info.files}${tool}, ${heuristic} heuristic`;
}

/**
 * One plain line per language whose code links are limited (`xpl index` without --verbose): references matched by
 * name, or a file with no symbols. Config languages (yaml, json, toml) have no references by design: the table says
 * `refs: none`, and nothing more is needed.
 */
export function limitLines(languages: Readonly<Record<string, LanguageInfo>>): string[] {
  return Object.entries(languages).flatMap(([name, info]) => {
    if (info.refs === "heuristic")
      return [`${name}: references matched by name; some can be missing.`];
    if (info.refs === "precise" && (info.heuristicFiles ?? 0) > 0)
      return [
        `${name}: references of ${plural(info.heuristicFiles!, "file")} matched by name; some can be missing.`,
      ];
    if (info.symbols === 0 && info.refs === "none")
      return [`${name}: file only; no symbols or references.`];
    return [];
  });
}

export const indexCommand: CommandSpec = {
  name: "index",
  usage:
    "xpl index [--precise auto|off|require] [--commit <c>] [--no-cache] [--scip <artifact|manifest.json>] [--verbose]",
  summary: "Build and write the symbol index; print languages and excluded source candidates",
  details: [
    "Writes .explainer/index-<commit>.json: the commit is the short HEAD of a clean git tree, else wt-<hash>.",
    "Each language line ends with how far its references can be trusted.",
    "`refs: precise (tool)`: a language tool resolved them. `refs: heuristic`: matched by name; check calls.",
    "`refs: none` (Ruby, PHP, yaml, json, toml, text without an artifact provider): no references.",
    "--precise auto runs a SCIP tool when it can, else matches by name and warns; require fails instead.",
    "--scip reads a SCIP artifact you made. Facts of unchanged files come from .explainer/cache.",
    "Ctrl+C stops the build (exit 130). The old index stays until the new one is complete.",
  ],
  options: {
    "no-cache": {
      type: "boolean",
      desc: "Extract every file without reading or writing the facts cache",
    },
    scip: {
      type: "string",
      arg: "<artifact|manifest.json>",
      desc: "Read declarations and references from a SCIP artifact",
    },
    precise: {
      type: "string",
      arg: "auto|off|require",
      desc: "auto (default): SCIP when it can run; off: never; require: fail without it",
    },
    commit: { type: "string", arg: "<c>", desc: "Commit id to record instead of the computed one" },
    verbose: {
      type: "boolean",
      desc: "Also print the cache, timing and coverage lines",
    },
  },
  positionals: [],
  async run(ctx, args) {
    const precise = args.choice("precise", PRECISE) ?? "auto";
    const commit = args.str("commit");
    const scip = args.str("scip");
    if (scip && precise === "off") throw new CliError("--scip requires --precise auto or require");
    const abort = new AbortController();
    const stop = () => abort.abort();
    const signal = ctx.io.signal ? AbortSignal.any([ctx.io.signal, abort.signal]) : abort.signal;
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
    let lastPhase = "";
    let lastUpdate = 0;
    const progress = (event: import("@xpl/indexer").IndexProgress) => {
      if (ctx.json) return;
      // a SCIP tool can run for a minute: say so even when stderr is not a terminal (an agent's shell)
      const tool = event.phase === "Provider" ? event.provider : undefined;
      if (tool?.startsWith("scip-") && tool !== "scip-artifact") {
        ctx.io.err(
          `index: running ${tool} for precise references (it can take a minute; \`--precise off\` skips it)`,
        );
        return;
      }
      if (!ctx.io.isTTY) return;
      const phase = event.provider ? `${event.phase} ${event.provider}` : event.phase;
      const now = Date.now();
      if (phase === lastPhase && now - lastUpdate < 1000 && event.completed !== event.total) return;
      lastPhase = phase;
      lastUpdate = now;
      ctx.io.err(
        `index: ${phase}${event.total === undefined ? "" : ` ${event.completed}/${event.total} files`}`,
      );
    };
    let result;
    let path: string;
    try {
      const providers = scip ? scipProviders(resolve(ctx.cwd, scip)) : undefined;
      result = await buildIndex({
        root: ctx.root,
        signal,
        onProgress: progress,
        precise,
        cache: !args.flag("no-cache"),
        ...(providers ? { providers } : {}),
        ...(commit !== undefined ? { commit } : {}),
      });
      signal.throwIfAborted();
      if (!ctx.json && ctx.io.isTTY) ctx.io.err("index: Writing index");
      path = await writeIndex(ctx.root, result.index, signal);
    } catch (error) {
      if (signal.aborted)
        throw new CliError(
          "Indexing cancelled; no partial index was published. Any previous complete index is retained.",
          130,
        );
      throw new CliError(errorMessage(error));
    } finally {
      process.off("SIGINT", stop);
      process.off("SIGTERM", stop);
    }
    const { index, warnings } = result;
    const rel = toPosix(displayPath(ctx.root, path));
    for (const warning of warnings) ctx.warn(warning);
    const stale = explainersNeedingResolve(ctx.root, index.commit);

    if (ctx.json) {
      ctx.emit({
        path: rel,
        absolutePath: path,
        commit: index.commit,
        tool: index.tool,
        files: index.files.length,
        symbols: index.symbols.length,
        refs: index.refs.length,
        languages: index.languages,
        analysis: index.analysis,
        exclusions: result.exclusions,
        extraction: result.extraction,
        work: result.work,
        ...(stale.length > 0 ? { explainersToResolve: stale } : {}),
      });
      return 0;
    }
    const languages = Object.entries(index.languages);
    const width = Math.max(8, ...languages.map(([name]) => name.length));
    const lines = [
      `index written: ${rel}`,
      `commit: ${index.commit}  files: ${index.files.length}  symbols: ${index.symbols.length}  refs: ${index.refs.length}`,
      "",
      ...languages.map(
        ([name, info]) =>
          `${name.padEnd(width)}  ${plural(info.files, "file").padEnd(9)}  ${plural(info.symbols, "symbol").padEnd(12)}  refs: ${describeRefs(info)}`,
      ),
    ];
    const { extraction, work } = result;
    const verbose = args.flag("verbose");
    const coverage = describeAnalysis(index);
    if (!verbose) {
      const details = coverageDetails(coverage.details, index.files.length, index.languages);
      const failed = details.filter((line) => / failed \(/.test(line));
      // symbols found by tags (Rust, Ruby, PHP): some declarations have no symbol
      const partialSymbols = details.flatMap((line) => {
        const m = /^([\w-]+)(?: \([^)]+\))?: named symbols\b.* partial \(/.exec(line);
        return m ? [`${m[1]}: some symbols can be missing (partial extraction).`] : [];
      });
      const limits = [...partialSymbols, ...limitLines(index.languages), ...failed];
      if (limits.length > 0) lines.push("", ...limits);
    }
    if (verbose)
      lines.push(
        "",
        `Extraction (${extraction.enabled ? "cache enabled" : "cache disabled"}): ${plural(extraction.hits, "hit")}, ${plural(extraction.misses, "miss", "misses")} of the ${plural(extraction.hits + extraction.misses, "file")} with a grammar, ${extraction.wallMs.toFixed(1)} ms wall; file-local tree-sitter and tags only.`,
      );
    if (extraction.writeFailures)
      lines.push(`Cache writes failed: ${extraction.writeFailures}; fresh facts were used.`);
    if (extraction.bypassReason) lines.push(`Cache bypassed: ${extraction.bypassReason}.`);
    if (verbose) {
      lines.push(
        `Fresh work: heuristic resolution ${work.heuristicResolutionMs.toFixed(1)} ms wall; semantic providers ${work.semanticRuns} runs, ${work.semanticMs.toFixed(1)} ms wall.`,
        "",
        coverage.summary,
        ...coverageDetails(coverage.details, index.files.length, index.languages),
      );
    }
    const { exclusions } = result;
    const excluded = exclusions.reasons.map(
      ({ reason, count, examples }) =>
        `${count} ${reason} (${examples.join(", ")}${count > examples.length ? ", …" : ""})`,
    );
    lines.push(
      "",
      excluded.length
        ? `Excluded from ${exclusions.scope}: ${excluded.join("; ")}.`
        : "Excluded files: none.",
      exclusions.scope === "git candidates"
        ? "Git-ignored files are not counted."
        : exclusions.scope === "walked files"
          ? "Directories skipped by the walk are not counted."
          : "Snapshot inputs do not include discovery exclusions.",
    );
    if (stale.length > 0) {
      lines.push(
        "",
        `hint: ${plural(stale.length, "explainer")} (${stale.join(", ")}) ${stale.length === 1 ? "is" : "are"} bound to another index; run ${stale.map((name) => `\`xpl resolve ${name} --write\``).join(", ")} to move ${stale.length === 1 ? "it" : "them"} to this one.`,
      );
    }
    ctx.out(lines.join("\n"));
    return 0;
  },
};
