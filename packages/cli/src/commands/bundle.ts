import { resolve } from "node:path";
import { injectBundle, suggestIds } from "@xpl/core";
import { collectFiles, makeBundle, type CollectedFiles } from "../bundle-data.js";
import type { CommandSpec } from "../command.js";
import { CliError, UsageError } from "../errors.js";
import { formatBytes, plural } from "../format.js";
import { atomicWrite } from "../fsutil.js";
import { loadExplainer, openWorkspace } from "../repo.js";
import { readViewerHtml } from "../viewer-html.js";

/** `14 of 82 files embedded (referenced: 180 KB of source; --files all adds 68 files, 1.9 MB)`. */
function describeFiles(c: CollectedFiles): string {
  const embedded = Object.keys(c.files).length;
  const size = formatBytes(c.embeddedBytes);
  if (c.choice === "all") return `${plural(embedded, "file")} embedded (all: ${size} of source)`;
  if (embedded >= c.indexedFiles) {
    return `${plural(embedded, "file")} embedded (referenced: all of them, ${size} of source)`;
  }
  const rest = c.indexedFiles - embedded;
  return (
    `${embedded} of ${plural(c.indexedFiles, "file")} embedded (referenced: ${size} of source; ` +
    `--files all adds ${plural(rest, "file")}, ${formatBytes(Math.max(0, c.indexedBytes - c.embeddedBytes))})`
  );
}

export const bundleCommand: CommandSpec = {
  name: "bundle",
  usage:
    "xpl bundle <explainer> -o out.html [--mode explore|present] [--tour id] [--files all|referenced]",
  summary: "Write one self-contained HTML file",
  details: [
    "Writes the viewer with the explainer, the symbol index and the source files inlined, so the file works",
    "offline and can be shared. --files referenced (the default) embeds the files the explainer needs: those of",
    "every anchor, of the nodes its graph views include (a directory or group: its files), of a sequence view's",
    "participants, and the code behind the dashed stubs of a graph view (what the viewer shows when one is clicked:",
    "the sites of the references that leave the view and what they lead to; none for `stubs: {mode: none}`, and",
    "references from excludeFiles do not count). --files all embeds every indexed file.",
    "The command prints how many files and how much source went in, and what --files all would add. The",
    'viewer\'s file tree lists only the embedded files, with an "N of M files included" footer.',
    "--mode present opens in present mode; --tour <id> starts that tour (and implies --mode present).",
    "The output path is printed as given (absolute when you gave it absolute); -o is relative to the working",
    "directory.",
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
      desc: "Files to embed: referenced (default: what the explainer shows) or all",
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
        const near = suggestIds(tourOption, ids);
        throw new CliError(
          `no tour "${tourOption}" in ${loaded.rel}` +
            (near.length > 0 ? `. Did you mean: ${near.join(", ")}?` : "") +
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
        path: out,
        absolutePath: target,
        bytes,
        mode,
        ...(tour !== undefined ? { tour } : {}),
        files: {
          embedded,
          choice: collected.choice,
          embeddedBytes: collected.embeddedBytes,
          indexed: collected.indexedFiles,
          indexedBytes: collected.indexedBytes,
        },
        index: { path: ws.indexRel, commit: ws.index.commit },
      });
      return 0;
    }
    ctx.out(
      `wrote ${out} (${formatBytes(bytes)}): ${loaded.rel}, ${describeFiles(collected)}, mode ${mode}${tour !== undefined ? `, tour ${tour}` : ""}`,
    );
    return 0;
  },
};
