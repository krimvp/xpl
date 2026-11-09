import type { CommandSpec } from "../command.js";
import { localGuideCatalog } from "../guide-library.js";

export const guidesCommand: CommandSpec = {
  name: "guides",
  usage: "xpl guides",
  summary: "List the local guides with their title, question, reader and commits",
  details: [
    "Lists each guide in .explainer/ with its title, question, reader and the commits it was made from.",
    "It needs no index and no service. The list does not say whether a guide is ready or up to date:",
    "run `xpl ready` or `xpl status <name>` for that. A guide with bad metadata is still listed, by its",
    "file, and reported. Exit codes: 0 a list (also an empty one), 1 a file unreadable or with bad metadata.",
  ],
  options: {},
  positionals: [],
  async run(ctx) {
    const { guides, errors } = localGuideCatalog(ctx);
    if (ctx.json) ctx.emit({ ok: errors.length === 0, guides, errors });
    else {
      const lines = guides.map((g) =>
        "metadataError" in g
          ? `${g.id}\n  ${g.path}`
          : [
              `${g.title}  (scope: ${g.kind}; source ${g.commit}; index ${g.indexCommit})`,
              ...(g.audience ? [`  audience: ${g.audience}`] : []),
              ...g.questions.map((q) => `  question: ${q}`),
              `  ${g.path}`,
            ].join("\n"),
      );
      lines.push(...errors.map((e) => `${e.id}: unavailable (${e.error})`));
      ctx.out(
        lines.length
          ? lines.join("\n")
          : "no local guides; make one with `xpl start <name> --question <question> --audience <reader>`",
      );
    }
    return errors.length ? 1 : 0;
  },
};
