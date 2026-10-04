import { resolve } from "node:path";
import { describeChange as describeChangeRange, injectBundle, suggestIds } from "@xpl/core";
import {
  BOUNDARY_MAX,
  collectBaseFiles,
  collectFiles,
  defaultIndexChoice,
  describeDrift,
  embedIndex,
  freshAnchors,
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
import { lintExplainer } from "../lint.js";
import { readViewerHtml } from "../viewer-html.js";

/** A page larger than this gets a warning: it opens slowly, and mail and chat refuse it. */
const LARGE_BUNDLE_BYTES = 20 * 1024 * 1024;

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

/**
 * `change 85c3b74..2284ff0: 2 changed files in (1 added to the selection), code before the change of 2 (14.1 KB)`.
 */
function describeChange(
  c: CollectedFiles,
  base: { files: Record<string, string>; bytes: number; missing: string[] },
  range: string,
): string {
  const changed = c.changed;
  const parts = [
    `change ${range}: ${plural(changed?.files ?? 0, "changed file")} in` +
      (changed && changed.added.length > 0
        ? ` (${changed.added.length} added to the selection: ${listText(changed.added)})`
        : ""),
    `code before the change of ${plural(Object.keys(base.files).length, "file")} (${formatBytes(base.bytes)})`,
  ];
  if (base.missing.length > 0) {
    parts.push(`base text unreadable for ${listText(base.missing)}`);
  }
  return parts.join(", ");
}

/**
 * `index 0.3 MB (1.3 MB as plain JSON, pruned from 9.4 MB)`: the size in the page (packed), then unpacked; without
 * `pruned from` when the whole index is embedded.
 */
function describeIndex(e: EmbeddedIndex): string {
  const plain = `${formatBytes(e.bytes)} as plain JSON`;
  return `index ${formatBytes(e.packedBytes)} (${e.pruned ? `${plain}, pruned from ${formatBytes(e.fullBytes)}` : plain})`;
}

export const bundleCommand: CommandSpec = {
  name: "bundle",
  usage:
    "xpl bundle <explainer> -o out.html [--mode explore|present] [--tour id] [--files referenced|boundary|all] [--boundary-max n] [--embed-index full|pruned] [--allow-drift]",
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
    "With a change recorded (`xpl change`), every changed file that exists at head is embedded whatever --files says",
    "(the summary says how many the selection had left out), and so is the code before the change of every modified,",
    "renamed or deleted file (`baseFiles`, read from git), so the reader can compare before and after.",
    "Every anchor is re-resolved against the index and the code first, so the page highlights where the code is",
    "now. A stale index is refused even with --allow-drift: run `xpl index`, then `xpl resolve --write` first.",
    "An anchor whose text moved gets its new lines. When some anchors drifted (their code changed) or are",
    "missing (their code is gone), the command refuses: the page would point at the wrong code. Run",
    "`xpl resolve <explainer> --write` and re-explain what it lists. --allow-drift writes the page anyway; it warns,",
    "and the page tells the reader which parts may be out of date.",
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
    "allow-drift": {
      type: "boolean",
      desc: "Write the page even when anchors drifted or are missing (the page says so)",
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
    const ws = await openWorkspace(ctx, {
      explainer: loaded,
      deferStaleWarning: true,
      requireFreshIndex: true,
    });
    if (ws.stale) {
      throw new CliError(
        `${ws.stale.message} Refusing to export source with an outdated index; --allow-drift only permits drift against a current index.`,
        1,
        { stale: ws.stale.head },
      );
    }
    const { explainer, drift } = freshAnchors(loaded.explainer, ws.model, ws.texts);
    const stale = describeDrift(drift);
    if (stale !== "") {
      const fix = `run \`xpl resolve ${loaded.name} --write\` and fix what it lists: re-explain the drifted elements, re-anchor or drop the missing anchors`;
      if (!args.flag("allow-drift")) {
        throw new CliError(
          `${loaded.rel} does not match the code: ${stale}, so the page would point at the wrong code. To fix it, ${fix}, then bundle again; --allow-drift writes the page anyway, with a warning on it`,
          1,
          { drift },
        );
      }
      ctx.warn(
        `${stale}: the page says so, but the reader will see code that may not match the text (to fix it, ${fix})`,
      );
    }
    const collected = collectFiles({
      root: ctx.root,
      index: ws.model,
      texts: ws.texts,
      explainer,
      ...(choice !== undefined ? { choice } : {}),
      ...(boundaryMax !== undefined ? { boundaryMax } : {}),
    });
    const embeddedIndex = embedIndex({
      index: ws.index,
      model: ws.model,
      explainer,
      files: collected.paths,
      choice: indexOption ?? defaultIndexChoice(collected.choice),
    });
    const base = collectBaseFiles(loaded.explainer, ws.texts);
    if (base && base.missing.length > 0) {
      ctx.warn(
        `the code before the change could not be read for ${listText(base.missing)} (git show failed): the reader will see no "before" for ${base.missing.length === 1 ? "it" : "them"}`,
      );
    }
    const bundle = makeBundle({
      explainer,
      index: embeddedIndex.index,
      files: collected.files,
      ...(base !== undefined ? { baseFiles: base.files } : {}),
      mode,
      ...(tour !== undefined ? { tour } : {}),
    });
    // the index packed: a fifth of its size as plain JSON (the viewer unpacks it, `parseBundle`)
    const page = injectBundle(html, bundle, { packIndex: true });
    const target = resolve(ctx.cwd, out);
    await atomicWrite(target, page);
    const bytes = Buffer.byteLength(page);
    const embedded = Object.keys(collected.files).length;
    const todos = lintExplainer(explainer).findings.filter((f) => f.rule === "todo-left").length;
    if (todos > 0) {
      ctx.warn(
        `${plural(todos, "text")} of ${loaded.rel} still ${todos === 1 ? "holds" : "hold"} a TODO placeholder, and the reader will see it: write ${todos === 1 ? "it" : "them"} first (\`xpl lint ${loaded.name}\` lists ${todos === 1 ? "it" : "them"})`,
      );
    }
    if (bytes > LARGE_BUNDLE_BYTES) {
      ctx.warn(
        `the page is ${formatBytes(bytes)}: a page this large opens slowly and is hard to send${collected.choice === "referenced" ? "" : "; --files referenced embeds only the files the explainer points at"}`,
      );
    }

    if (ctx.json) {
      ctx.emit({
        path: out,
        absolutePath: target,
        bytes,
        mode,
        ...(tour !== undefined ? { tour } : {}),
        anchors: drift,
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
        ...(base !== undefined && collected.changed !== undefined
          ? {
              change: {
                base: loaded.explainer.change!.base,
                head: loaded.explainer.change!.head,
                changedFiles: collected.changed.files,
                addedToSelection: collected.changed.added,
                baseFiles: Object.keys(base.files),
                baseBytes: base.bytes,
                ...(base.missing.length > 0 ? { baseMissing: base.missing } : {}),
              },
            }
          : {}),
        index: {
          path: ws.indexRel,
          commit: ws.index.commit,
          choice: embeddedIndex.choice,
          pruned: embeddedIndex.pruned,
          bytes: embeddedIndex.bytes,
          fullBytes: embeddedIndex.fullBytes,
          packedBytes: embeddedIndex.packedBytes,
          symbols: embeddedIndex.symbols,
          refs: embeddedIndex.refs,
        },
      });
      return 0;
    }
    const change = loaded.explainer.change;
    const changeText =
      base !== undefined && change !== undefined
        ? `, ${describeChange(collected, base, describeChangeRange(change))}`
        : "";
    ctx.out(
      `wrote ${out} (${formatBytes(bytes)}): ${loaded.rel}, ${describeFiles(collected)}${changeText}, ${describeIndex(embeddedIndex)}, mode ${mode}${tour !== undefined ? `, tour ${tour}` : ""}`,
    );
    return 0;
  },
};
