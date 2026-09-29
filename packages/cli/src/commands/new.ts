import { existsSync } from "node:fs";
import { join } from "node:path";
import { createExplainer } from "@xpl/core";
import type { CommandSpec } from "../command.js";
import { CliError, UsageError } from "../errors.js";
import { atomicWrite, displayPath, jsonFile } from "../fsutil.js";
import { EXPLAINER_DIR, EXPLAINER_SUFFIX, openWorkspace } from "../repo.js";
import { detectRepoName } from "../repo-name.js";

/** `job-runner` -> `Job runner`. */
function humanize(name: string): string {
  const words = name.replace(/[._-]+/g, " ").trim();
  return words === "" ? name : words[0]!.toUpperCase() + words.slice(1);
}

export const newCommand: CommandSpec = {
  name: "new",
  usage: "xpl new <name> [--title t] [--repo r] [--url u]",
  summary: "Create .explainer/<name>.explainer.json bound to the index",
  details: [
    "Creates an empty explainer (no nodes, edges, concepts, views or tours) bound to the selected index.",
    "Refuses to overwrite an existing file. Fill it with `xpl apply <name> patch.json`.",
    "The repository name (the label of the repo node) is --repo, else detected: package.json `name`, the last",
    "element of the go.mod module, pyproject.toml `[project] name`, the git remote's base name, the directory",
    "name. --url records where the repository lives (never taken from the git remote: it may hold credentials).",
  ],
  options: {
    title: { type: "string", arg: "<t>", desc: "Explainer title (default: the name, humanized)" },
    repo: {
      type: "string",
      arg: "<name>",
      desc: "Repository name (default: package.json / go.mod / pyproject.toml / git remote / directory)",
    },
    url: { type: "string", arg: "<url>", desc: "Repository URL to record (default: none)" },
  },
  positionals: [{ name: "name" }],
  async run(ctx, args) {
    const given = args.positionals[0]!;
    const name = given.endsWith(EXPLAINER_SUFFIX)
      ? given.slice(0, -EXPLAINER_SUFFIX.length)
      : given;
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name)) {
      throw new UsageError(
        `invalid explainer name "${given}": use letters, digits, ".", "_" and "-", starting with a letter or digit`,
      );
    }
    const path = join(ctx.root, EXPLAINER_DIR, `${name}${EXPLAINER_SUFFIX}`);
    const rel = displayPath(ctx.root, path);
    if (existsSync(path)) {
      throw new CliError(
        `${rel} already exists; not overwriting it. Pick another name, or change it with \`xpl apply ${name} patch.json\`.`,
      );
    }
    const repoOption = args.str("repo");
    if (repoOption !== undefined && repoOption.trim() === "") {
      throw new UsageError("--repo must not be empty");
    }
    const url = args.str("url")?.trim();
    if (args.str("url") !== undefined && url === "")
      throw new UsageError("--url must not be empty");
    const ws = await openWorkspace(ctx);
    const title = args.str("title") ?? humanize(name);
    const repo =
      repoOption !== undefined
        ? { name: repoOption.trim(), source: "--repo" }
        : await detectRepoName(ctx.root);
    const explainer = createExplainer({
      title,
      repoName: repo.name,
      ...(url !== undefined ? { repoUrl: url } : {}),
      index: ws.model,
      indexPath: ws.indexRel,
    });
    await atomicWrite(path, jsonFile(explainer));
    if (ctx.json) {
      ctx.emit({
        path: rel,
        name,
        title,
        repo: { name: repo.name, source: repo.source, ...(url !== undefined ? { url } : {}) },
        index: { path: ws.indexRel, commit: ws.index.commit },
      });
      return 0;
    }
    ctx.out(
      [
        `created ${rel} (title "${title}", index ${ws.indexRel}, commit ${ws.index.commit})`,
        `repo: ${repo.name} (${repo.source})${url !== undefined ? `, ${url}` : ""}`,
        `next: write a patch and run \`xpl apply ${name} patch.json\``,
      ].join("\n"),
    );
    return 0;
  },
};
