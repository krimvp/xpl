import { readdirSync } from "node:fs";
import { join } from "node:path";
import { buildIndex, writeIndex } from "@xpl/indexer";
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

export const indexCommand: CommandSpec = {
  name: "index",
  usage: "xpl index [--precise auto|off|require] [--commit c]",
  summary: "Build and write the symbol index; print a per-language summary",
  details: [
    "Indexes every text file under --root (git-aware) and writes .explainer/index-<commit>.json.",
    "The commit id is the short HEAD for a clean top-level git tree, else wt-<hash> of the files.",
    "--precise auto uses SCIP indexers when available (heuristic references otherwise, with a warning);",
    "off never runs them; require fails instead of falling back.",
  ],
  options: {
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
    let result;
    try {
      result = await buildIndex({
        root: ctx.root,
        precise,
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
      ...languages.map(([name, info]) => {
        const tool = info.refs === "precise" && info.tool ? ` (${info.tool})` : "";
        return `${name.padEnd(width)}  ${plural(info.files, "file").padEnd(9)}  ${plural(info.symbols, "symbol").padEnd(12)}  refs: ${info.refs}${tool}`;
      }),
    ];
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
