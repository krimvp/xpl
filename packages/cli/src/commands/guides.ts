import { EXPLAINER_SCHEMA, guideCatalog, type GuideDescriptor } from "@xpl/core";
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
    "Loadable guides stay listed by ID/path when metadata is invalid. Empty titles stay recorded as empty.",
    "Read or metadata errors are reported separately (exit 1); no guides is exit 0.",
  ],
  options: {},
  positionals: [],
  async run(ctx) {
    const entries = loadRepositoryGuides(ctx);
    const guides: (
      (GuideDescriptor & { path: string }) | { id: string; path: string; metadataError: string }
    )[] = [];
    const errors: { id: string; error: string }[] = [];
    for (const entry of entries) {
      if ("error" in entry) {
        errors.push({ id: entry.name, error: entry.error });
        continue;
      }
      const { name, loaded } = entry;
      const e = loaded.explainer;
      if (
        e.schema !== EXPLAINER_SCHEMA ||
        typeof e.title !== "string" ||
        typeof e.repo?.commit !== "string" ||
        typeof e.index?.commit !== "string" ||
        (e.scope?.audience !== undefined && typeof e.scope.audience !== "string") ||
        !Array.isArray(e.views) ||
        e.views.some(
          (v) =>
            !v ||
            typeof v.scope?.root !== "string" ||
            (v.scope.question !== undefined && typeof v.scope.question !== "string"),
        ) ||
        (e.change !== undefined &&
          (typeof e.change?.base !== "string" || typeof e.change?.head !== "string"))
      ) {
        guides.push({ id: name, path: loaded.rel, metadataError: "invalid guide metadata" });
        errors.push({ id: name, error: "invalid guide metadata" });
      } else guides.push({ ...guideCatalog([{ id: name, explainer: e }])[0]!, path: loaded.rel });
    }
    if (ctx.json) ctx.emit({ ok: errors.length === 0, guides, errors });
    else {
      const lines = guides.map((g) =>
        "metadataError" in g
          ? `${g.id}\n  ${g.path}`
          : [
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
