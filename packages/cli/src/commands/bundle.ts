import { resolve } from "node:path";
import { injectBundle } from "@xpl/core";
import { collectFiles, makeBundle } from "../bundle-data.js";
import type { CommandSpec } from "../command.js";
import { CliError, UsageError } from "../errors.js";
import { formatBytes, plural } from "../format.js";
import { atomicWrite, displayPath } from "../fsutil.js";
import { loadExplainer, openWorkspace } from "../repo.js";
import { readViewerHtml } from "../viewer-html.js";

export const bundleCommand: CommandSpec = {
  name: "bundle",
  usage:
    "xpl bundle <explainer> -o out.html [--mode explore|present] [--tour id] [--files all|referenced]",
  summary: "Write one self-contained HTML file",
  details: [
    "Writes the viewer with the explainer, the symbol index and the source files inlined, so the file works",
    "offline and can be shared. --files all (the default when the indexed files total under 20 MB) embeds",
    "every indexed file; referenced embeds only the files the explainer points at.",
    "--mode present opens in present mode; --tour <id> starts that tour (and implies --mode present).",
  ],
  options: {
    out: { type: "string", short: "o", arg: "<out.html>", desc: "Output file (required)" },
    mode: { type: "string", arg: "explore|present", desc: "Initial mode (default explore)" },
    tour: {
      type: "string",
      arg: "<id>",
      desc: "Initial tour for present mode (tour:intro or intro)",
    },
    files: {
      type: "string",
      arg: "all|referenced",
      desc: "Files to embed (default: all when they total < 20 MB, else referenced)",
    },
  },
  positionals: [{ name: "explainer" }],
  async run(ctx, args) {
    const out = args.str("out");
    if (out === undefined || out === "") throw new UsageError("missing -o <out.html>");
    const modeOption = args.choice("mode", ["explore", "present"] as const);
    const choice = args.choice("files", ["all", "referenced"] as const);
    const loaded = loadExplainer(ctx, args.positionals[0]!);

    let tour: string | undefined;
    const tourOption = args.str("tour");
    if (tourOption !== undefined) {
      const ids = (Array.isArray(loaded.explainer.tours) ? loaded.explainer.tours : []).map(
        (t) => t.id,
      );
      tour = [tourOption, `tour:${tourOption}`].find((id) => ids.includes(id));
      if (tour === undefined) {
        throw new CliError(
          `no tour "${tourOption}" in ${loaded.rel}` +
            (ids.length > 0 ? ` (tours: ${ids.join(", ")})` : " (it has no tours yet)"),
        );
      }
    }
    const mode = modeOption ?? (tour !== undefined ? "present" : "explore");

    const html = readViewerHtml(ctx.env);
    const ws = await openWorkspace(ctx, { explainer: loaded });
    const collected = collectFiles({
      root: ctx.root,
      index: ws.model,
      texts: ws.texts,
      explainer: loaded.explainer,
      ...(choice !== undefined ? { choice } : {}),
    });
    const bundle = makeBundle({
      explainer: loaded.explainer,
      index: ws.index,
      files: collected.files,
      mode,
      ...(tour !== undefined ? { tour } : {}),
    });
    const page = injectBundle(html, bundle);
    const target = resolve(ctx.cwd, out);
    await atomicWrite(target, page);
    const bytes = Buffer.byteLength(page);
    const embedded = Object.keys(collected.files).length;

    if (ctx.json) {
      ctx.emit({
        path: displayPath(ctx.cwd, target),
        absolutePath: target,
        bytes,
        mode,
        ...(tour !== undefined ? { tour } : {}),
        files: {
          embedded,
          choice: collected.choice,
          ...(collected.totalBytes !== undefined ? { indexedBytes: collected.totalBytes } : {}),
        },
        index: { path: ws.indexRel, commit: ws.index.commit },
      });
      return 0;
    }
    ctx.out(
      `wrote ${displayPath(ctx.cwd, target)} (${formatBytes(bytes)}): ${loaded.rel}, ${plural(embedded, "file")} embedded (${collected.choice}), mode ${mode}${tour !== undefined ? `, tour ${tour}` : ""}`,
    );
    return 0;
  },
};
