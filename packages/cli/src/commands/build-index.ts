import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import type { LanguageInfo } from "@xpl/core";
import { describeAnalysis } from "@xpl/core";
import { buildIndex, scipArtifactProvider, writeIndex } from "@xpl/indexer";
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
  usage: "xpl index [--precise auto|off|require] [--commit c] [--scip artifact|manifest.json]",
  summary: "Build and write the symbol index; print a per-language summary",
  details: [
    "Indexes every text file under --root (git-aware) and writes .explainer/index-<commit>.json.",
    "The commit id is the short HEAD for a clean top-level git tree, else wt-<hash> of the files.",
    "--precise auto uses SCIP indexers when available (heuristic references otherwise, with a warning);",
    "off never runs them; require fails instead of falling back.",
    "Each language line ends with how far its references can be trusted: `refs: precise (tool)`, `refs: heuristic`",
    "(hints: confirm each call with `xpl show`), `refs: none` (yaml, json, toml, text without an artifact provider),",
    "or, when the precise tool did not",
    "describe every file, `refs: precise 64/82 (scip-python@0.6.6), 18 heuristic`: the references of those 18 files",
    "are hints.",
    "Analysis coverage lists independent source and relationship abilities, analyzed files, limits and failures.",
    "Empty relationships do not prove complete coverage. Saved indexes and exported viewers retain this report.",
    "--scip imports a generated artifact with embedded source text, or a JSON manifest naming its artifact.",
    "Textless artifacts require artifactSha256 and pre-generation sourceHashes in the manifest.",
    "Unspecified positions require a verified manifest.defaultEncoding. Unknown extensions stay text.",
    "This replaces automatic SCIP tool selection for the run. --precise off cannot import an artifact.",
  ],
  options: {
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
    let result;
    try {
      let providers;
      if (scip) {
        const path = resolve(ctx.cwd, scip);
        if (path.endsWith(".json")) {
          const manifest: unknown = JSON.parse(readFileSync(path, "utf8"));
          if (
            !manifest ||
            typeof manifest !== "object" ||
            !("artifact" in manifest) ||
            typeof manifest.artifact !== "string" ||
            !manifest.artifact
          )
            throw new Error("SCIP manifest requires an artifact path relative to the manifest");
          providers = [
            scipArtifactProvider({
              artifact: readFileSync(resolve(dirname(path), manifest.artifact)),
              manifest,
            }),
          ];
        } else providers = [scipArtifactProvider({ artifact: readFileSync(path) })];
      }
      result = await buildIndex({
        root: ctx.root,
        precise,
        ...(providers ? { providers } : {}),
        ...(commit !== undefined ? { commit } : {}),
      });
    } catch (error) {
      throw new CliError(errorMessage(error));
    }
    const { index, warnings } = result;
    const path = await writeIndex(ctx.root, index);
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
    const coverage = describeAnalysis(index);
    lines.push("", coverage.summary, ...coverage.details);
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
