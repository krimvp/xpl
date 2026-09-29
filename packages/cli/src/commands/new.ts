import { existsSync } from "node:fs";
import { basename, join } from "node:path";
import { createExplainer } from "@xpl/core";
import type { CommandSpec } from "../command.js";
import { CliError, UsageError } from "../errors.js";
import { atomicWrite, displayPath, jsonFile } from "../fsutil.js";
import { EXPLAINER_DIR, EXPLAINER_SUFFIX, openWorkspace } from "../repo.js";

/** `job-runner` -> `Job runner`. */
function humanize(name: string): string {
  const words = name.replace(/[._-]+/g, " ").trim();
  return words === "" ? name : words[0]!.toUpperCase() + words.slice(1);
}

export const newCommand: CommandSpec = {
  name: "new",
  usage: "xpl new <name> [--title t]",
  summary: "Create .explainer/<name>.explainer.json bound to the index",
  details: [
    "Creates an empty explainer (no nodes, edges, concepts, views or tours) bound to the selected index.",
    "Refuses to overwrite an existing file. Fill it with `xpl apply <name> patch.json`.",
  ],
  options: {
    title: { type: "string", arg: "<t>", desc: "Explainer title (default: the name, humanized)" },
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
    const ws = await openWorkspace(ctx);
    const title = args.str("title") ?? humanize(name);
    const explainer = createExplainer({
      title,
      repoName: basename(ctx.root) || "repo",
      index: ws.model,
      indexPath: ws.indexRel,
    });
    await atomicWrite(path, jsonFile(explainer));
    if (ctx.json) {
      ctx.emit({
        path: rel,
        name,
        title,
        index: { path: ws.indexRel, commit: ws.index.commit },
      });
      return 0;
    }
    ctx.out(
      [
        `created ${rel} (title "${title}", index ${ws.indexRel}, commit ${ws.index.commit})`,
        `next: write a patch and run \`xpl apply ${name} patch.json\``,
      ].join("\n"),
    );
    return 0;
  },
};
