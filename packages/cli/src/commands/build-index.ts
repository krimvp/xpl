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

/** Explainers bound to another index than `commit`: they need `xpl resolve --write`. */
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

export const indexCommand: CommandSpec = {
  name: "index",
  usage:
    "xpl index [--precise auto|off|require] [--commit c] [--no-cache] [--scip artifact|manifest.json]",
  summary: "Build and write the symbol index; print languages and excluded source candidates",
  details: [
    "Indexes every text file under --root (git-aware) and writes .explainer/index-<commit>.json.",
    "Interactive stderr shows phases and file counts; redirected stderr and --json omit progress.",
    "Ctrl+C cancels between files/phases and stops SCIP tools. Before publication, the previous complete",
    "index is retained (or no index is created); extraction cache entries may remain. Exit code: 130.",
    "Reuses file-local tree-sitter and Rust tags facts from .explainer/cache by default.",
    "Directory aliases into the repository (including symlinks and bind mounts) bypass cache reads and writes.",
    "--no-cache neither reads nor writes that cache. Source discovery, hashes, heuristic resolution and semantic tools",
    "still run on every build. Hits/misses and extraction wall time exclude resolution and semantic tools.",
    "The commit id is the short HEAD for a clean top-level git tree, else wt-<hash> of the files.",
    "--precise auto uses SCIP indexers when available (heuristic references otherwise, with a warning);",
    "off never runs them; syntax-only providers (Rust tags) still run. require fails instead of falling back.",
    "Each language line ends with how far its references can be trusted: `refs: precise (tool)`, `refs: heuristic`",
    "(hints: confirm each call with `xpl show`), `refs: none` (rust, yaml, json, toml, text without an artifact provider),",
    "or, when the precise tool did not",
    "describe every file, `refs: precise 64/82 (scip-python@0.6.6), 18 heuristic`: the references of those 18 files",
    "are hints.",
    "Analysis coverage lists independent source and relationship abilities, analyzed files, limits and failures.",
    "Excluded file counts and up to three paths per reason cover enumerated candidates only; git-ignored files",
    "and directories skipped by the fallback walk are not counted.",
    "Empty relationships do not prove complete coverage. Saved indexes and exported viewers retain this report.",
    "--scip imports a generated artifact with embedded source text, or a JSON manifest naming its artifact.",
    "Textless artifacts require artifactSha256 and pre-generation sourceHashes in the manifest.",
    "Unspecified positions require a verified manifest.defaultEncoding. Unknown extensions stay text.",
    "This replaces automatic SCIP tools; registered syntax providers (Rust tags) still run.",
    "--precise off cannot import an artifact. require needs precise coverage for each programming language.",
  ],
  options: {
    "no-cache": {
      type: "boolean",
      desc: "Extract every file without reading or writing the facts cache",
    },
    scip: {
      type: "string",
      arg: "<artifact|manifest.json>",
      desc: "Import source-verified SCIP declarations and supported references",
    },
    precise: {
      type: "string",
      arg: "auto|off|require",
      desc: "Reference resolution: SCIP when available (auto, default), never (off), or fail (require)",
    },
    commit: { type: "string", arg: "<c>", desc: "Commit id to record instead of the computed one" },
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
      if (ctx.json || !ctx.io.isTTY) return;
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
    lines.push(
      "",
      `Extraction (${extraction.enabled ? "cache enabled" : "cache disabled"}): ${extraction.hits} hits, ${extraction.misses} misses, ${extraction.wallMs.toFixed(1)} ms wall; file-local tree-sitter and tags only.`,
    );
    if (extraction.writeFailures)
      lines.push(`Cache writes failed: ${extraction.writeFailures}; fresh facts were used.`);
    if (extraction.bypassReason) lines.push(`Cache bypassed: ${extraction.bypassReason}.`);
    lines.push(
      `Fresh work: heuristic resolution ${work.heuristicResolutionMs.toFixed(1)} ms wall; semantic providers ${work.semanticRuns} runs, ${work.semanticMs.toFixed(1)} ms wall.`,
    );
    const coverage = describeAnalysis(index);
    lines.push("", coverage.summary, ...coverage.details);
    const { exclusions } = result;
    const excluded = exclusions.reasons.map(
      ({ reason, count, examples }) =>
        `${count} ${reason} (${examples.join(", ")}${count > examples.length ? ", …" : ""})`,
    );
    lines.push(
      "",
      `Excluded from ${exclusions.scope}: ${excluded.length ? excluded.join("; ") : "none"}.`,
      exclusions.scope === "git candidates"
        ? "Git-ignored files are not counted."
        : exclusions.scope === "walked files"
          ? "Directories skipped by the walk are not counted."
          : "Snapshot inputs do not include discovery exclusions.",
    );
    if (stale.length > 0) {
      lines.push(
        "",
        `hint: ${plural(stale.length, "explainer")} (${stale.join(", ")}) ${stale.length === 1 ? "is" : "are"} bound to another index; run \`xpl resolve <name> --write\` to move ${stale.length === 1 ? "it" : "them"} to this one.`,
      );
    }
    ctx.out(lines.join("\n"));
    return 0;
  },
};
