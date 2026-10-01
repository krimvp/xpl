import { resolve } from "node:path";
import { injectBundle, suggestIds } from "@xpl/core";
import {
  BOUNDARY_MAX,
  collectFiles,
  defaultIndexChoice,
  embedIndex,
  makeBundle,
  type Boundary,
  type BoundaryReason,
  type CollectedFiles,
  type EmbeddedIndex,
} from "../bundle-data.js";
import type { CommandSpec } from "../command.js";
import { CliError, UsageError } from "../errors.js";
import { formatBytes, listText, plural } from "../format.js";
import { atomicWrite } from "../fsutil.js";
import { loadExplainer, openWorkspace } from "../repo.js";
import { readViewerHtml } from "../viewer-html.js";

/** The boundary files added per reason, in a fixed order. */
const REASONS: readonly { reason: BoundaryReason; name: string }[] = [
  { reason: "caller", name: "callers" },
  { reason: "callee", name: "callees" },
  { reason: "test", name: "tests" },
];

/** `boundary +8: callers 5, callees 2, tests 1`, and what the cap cut: `; 3 more cut at --boundary-max 40: a, b, c`. */
function describeBoundary(b: Boundary): string {
  const counts = REASONS.map(
    ({ reason, name }) => `${name} ${b.added.filter((e) => e.reason === reason).length}`,
  );
  const added =
    b.symbols === 0
      ? "boundary +0: no anchored symbols to draw it around"
      : `boundary +${b.added.length}: ${counts.join(", ")}`;
  if (b.cut.length === 0) return added;
  return (
    `${added}; ${b.cut.length} more cut at --boundary-max ${b.max}: ` +
    listText(
      b.cut.map((e) => e.file),
      3,
    )
  );
}

/**
 * `14 of 82 files embedded (referenced: 180 KB of source; --files all adds 68 files, 1.9 MB)`, or with a boundary
 * `20 of 143 files embedded (referenced 12, boundary +8: callers 5, callees 2, tests 1; 210 KB of source; ...)`.
 */
function describeFiles(c: CollectedFiles): string {
  const embedded = Object.keys(c.files).length;
  const size = formatBytes(c.embeddedBytes);
  if (c.choice === "all") return `${plural(embedded, "file")} embedded (all: ${size} of source)`;
  const what =
    c.choice === "boundary" && c.boundary
      ? `referenced ${c.referenced ?? 0}, ${describeBoundary(c.boundary)};`
      : "referenced:";
  if (embedded >= c.indexedFiles) {
    return `${plural(embedded, "file")} embedded (${what} all of them, ${size} of source)`;
  }
  const rest = c.indexedFiles - embedded;
  return (
    `${embedded} of ${plural(c.indexedFiles, "file")} embedded (${what} ${size} of source; ` +
    `--files all adds ${plural(rest, "file")}, ${formatBytes(Math.max(0, c.indexedBytes - c.embeddedBytes))})`
  );
}

/** `index 1.3 MB (pruned from 9.4 MB)`, or just `index 9.4 MB` when the whole index is embedded. */
function describeIndex(e: EmbeddedIndex): string {
  const size = formatBytes(e.bytes);
  return e.pruned ? `index ${size} (pruned from ${formatBytes(e.fullBytes)})` : `index ${size}`;
}

export const bundleCommand: CommandSpec = {
  name: "bundle",
  usage:
    "xpl bundle <explainer> -o out.html [--mode explore|present] [--tour id] [--files referenced|boundary|all] [--boundary-max n] [--embed-index full|pruned]",
  summary: "Write one self-contained HTML file",
  details: [
    "Writes the viewer with the explainer, the symbol index and the source files inlined, so the file works",
    "offline and can be shared. --files referenced (the default) embeds the files the explainer needs: those of",
    "every anchor, of the nodes its graph views include (a directory or group: its files), of a sequence view's",
    "participants, and the code behind the dashed stubs of a graph view (what the viewer shows when one is clicked:",
    "the sites of the references that leave the view and what they lead to; none for `stubs: {mode: none}`, and",
    "references from excludeFiles do not count). --files all embeds every indexed file.",
    "--files boundary embeds the referenced files plus a safe boundary around what the explainer anchors, so a",
    "reader can check the neighbours: the files of the direct callers of every anchored symbol (a class counts with",
    "its members), the files it calls (depth 1), and the test files that reference it (a call, an import or a type",
    "use). An anchored constructor or call method (__init__, __call__, constructor) counts as called when its class",
    "is; anchors in test files draw no boundary. At most " +
      `${BOUNDARY_MAX} files are added (--boundary-max n): the`,
    "ones with the most references first, callers, tests and callees in turn; the summary says how many of each",
    "went in and names the files that were cut.",
    "The command prints how many files and how much source went in, and what --files all would add. The",
    'viewer\'s file tree lists only the embedded files, with an "N of M files included" footer.',
    "The symbol index, most of the page for a large repository, is pruned with --files referenced (and boundary) to what the viewer",
    "can draw: every file entry, the symbols of the embedded files and of what the explainer names, the references that",
    "touch an embedded file or lie on a graph view (read references: only between embedded files, or on a view) and the",
    "symbols they end in. The views, tours and code behave exactly as with the whole index; a file whose code is not",
    "embedded lists only some of its symbols when it is opened into. The summary says what that saved, and the embedded",
    "index carries `pruned` with the counts of the whole one. --embed-index full keeps the whole index (the default with",
    "--files all); --embed-index pruned prunes for whichever files are embedded (with --files all there is nothing to",
    "prune). (--index still picks the index file to read, as for every command.)",
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
      arg: "referenced|boundary|all",
      desc: "Files to embed: referenced (default: what the explainer shows), boundary (plus direct callers, callees and tests of anchored symbols) or all",
    },
    "boundary-max": {
      type: "string",
      arg: "<n>",
      desc: `With --files boundary: add at most n files (default ${BOUNDARY_MAX})`,
    },
    "embed-index": {
      type: "string",
      arg: "full|pruned",
      desc: "Index to embed: pruned (default; what the embedded files and the views can show) or full",
    },
  },
  positionals: [{ name: "explainer" }],
  async run(ctx, args) {
    const out = args.str("out");
    if (out === undefined || out === "") throw new UsageError("missing -o <out.html>");
    const modeOption = args.choice("mode", ["explore", "present"] as const);
    const choice = args.choice("files", ["referenced", "boundary", "all"] as const);
    const boundaryMax = args.int("boundary-max");
    if (boundaryMax !== undefined && choice !== "boundary") {
      throw new UsageError("--boundary-max needs --files boundary");
    }
    const indexOption = args.choice("embed-index", ["full", "pruned"] as const);
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
      ...(boundaryMax !== undefined ? { boundaryMax } : {}),
    });
    const embeddedIndex = embedIndex({
      index: ws.index,
      model: ws.model,
      explainer: loaded.explainer,
      files: collected.paths,
      choice: indexOption ?? defaultIndexChoice(collected.choice),
    });
    const bundle = makeBundle({
      explainer: loaded.explainer,
      index: embeddedIndex.index,
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
          ...(collected.referenced !== undefined ? { referenced: collected.referenced } : {}),
          ...(collected.boundary !== undefined
            ? {
                boundary: {
                  added: collected.boundary.added,
                  cut: collected.boundary.cut,
                  max: collected.boundary.max,
                  symbols: collected.boundary.symbols,
                },
              }
            : {}),
          embeddedBytes: collected.embeddedBytes,
          indexed: collected.indexedFiles,
          indexedBytes: collected.indexedBytes,
        },
        index: {
          path: ws.indexRel,
          commit: ws.index.commit,
          choice: embeddedIndex.choice,
          pruned: embeddedIndex.pruned,
          bytes: embeddedIndex.bytes,
          fullBytes: embeddedIndex.fullBytes,
          symbols: embeddedIndex.symbols,
          refs: embeddedIndex.refs,
        },
      });
      return 0;
    }
    ctx.out(
      `wrote ${out} (${formatBytes(bytes)}): ${loaded.rel}, ${describeFiles(collected)}, ${describeIndex(embeddedIndex)}, mode ${mode}${tour !== undefined ? `, tour ${tour}` : ""}`,
    );
    return 0;
  },
};
