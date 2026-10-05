import type { CommandSpec } from "../command.js";
import { loadRepositoryGuides } from "../repo.js";

export const guidesCommand: CommandSpec = {
  name: "guides",
  usage: "xpl guides",
  summary: "List local guides by title, question, audience and snapshot",
  details: [
    "Reads .explainer/*.explainer.json without a service or symbol index. Shows recorded titles,",
    "view questions, audience, scope roots and source/index commits; filenames are only stable keys.",
    "Metadata is not a readiness or freshness check; use xpl ready or xpl status <name> for evidence.",
    "Unreadable, invalid or out-of-repository guides are reported separately (exit 1); no guides is exit 0.",
  ],
  options: {},
  positionals: [],
  async run(ctx) {
    const entries = loadRepositoryGuides(ctx);
    const guides = entries.flatMap((entry) =>
      "loaded" in entry ? [{ ...entry.descriptor, path: entry.loaded.rel }] : [],
    );
    const errors = entries.flatMap((entry) =>
      "error" in entry ? [{ id: entry.name, error: entry.error }] : [],
    );
    if (ctx.json) ctx.emit({ ok: errors.length === 0, guides, errors });
    else {
      const lines = guides.map((g) =>
        [
          `${g.title}  (${g.kind}; source ${g.commit}; index ${g.indexCommit})`,
          ...(g.audience ? [`  audience: ${g.audience}`] : []),
          ...g.questions.map((q) => `  question: ${q}`),
          `  ${g.path}`,
        ].join("\n"),
      );
      lines.push(...errors.map((e) => `${e.id}: unavailable (${e.error})`));
      ctx.out(lines.length ? lines.join("\n") : "no local guides; create one with xpl new");
    }
    return errors.length ? 1 : 0;
  },
};
