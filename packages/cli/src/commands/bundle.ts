import { resolve } from "node:path";
import { describeChange as describeChangeRange, injectBundle, suggestIds } from "@xpl/core";
import {
  BOUNDARY_MAX,
  collectBaseFiles,
  collectFiles,
  defaultIndexChoice,
  describeDrift,
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
import { loadReadExplainer, loadRepositoryGuides } from "../repo.js";
import { describeReadiness, workspaceReadiness } from "../readiness.js";
import { guideSnapshot, LIBRARY_MAX_GUIDES, LIBRARY_MAX_BYTES } from "../guide-library.js";
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
 * `index 1.3 MB as JSON (0.3 MB packed), pruned from 9.4 MB`: the size as JSON, then packed in the page; without
 * `pruned from` when the whole index is embedded.
 */
function describeIndex(e: EmbeddedIndex): string {
  const pruned = e.pruned ? `, pruned from ${formatBytes(e.fullBytes)}` : "";
  return `index ${formatBytes(e.bytes)} as JSON (${formatBytes(e.packedBytes)} packed)${pruned}`;
}

export const bundleCommand: CommandSpec = {
  name: "bundle",
  usage:
    "xpl bundle [explainer] -o <out.html> [--mode explore|present] [--tour <id>] [--files referenced|boundary|all] [--boundary-max <n>] [--embed-index full|pruned] [--include-guides <id,id>] [--draft] [--note <reason>] [--require-review] [--allow-drift]",
  summary: "Check readiness, then write one self-contained HTML file",
  details: [
    "Runs the `xpl ready` check, then writes one HTML file with the viewer, the guide, the index and the code.",
    "The file works offline. Errors block it (exit 1, nothing written); --draft writes a labelled preview.",
    "--files referenced (the default) embeds the files the guide shows. boundary adds callers, callees and tests.",
    "--files all embeds every indexed file. A recorded change embeds its changed files and their old code.",
    "--embed-index pruned (the default) keeps only what the embedded files and the views need.",
    "A stale index or drifted code links block it: run `xpl index` and `xpl resolve <explainer> --write`.",
    "--tour <id> starts that tour in present mode. -o is relative to the working directory.",
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
      desc: "Files to embed: referenced (default), boundary (plus neighbours) or all",
    },
    "boundary-max": {
      type: "string",
      arg: "<n>",
      desc: `With --files boundary: add at most n files (default ${BOUNDARY_MAX})`,
    },
    "embed-index": {
      type: "string",
      arg: "full|pruned",
      desc: "Index to embed: pruned (default: what the page needs) or full",
    },
    "include-guides": {
      type: "string",
      arg: "<id,id>",
      desc: "Embed up to 8 other ready guides (20 MiB at most)",
    },
    draft: {
      type: "boolean",
      desc: "Write a page marked draft, even with readiness errors",
    },
    note: {
      type: "string",
      arg: "<reason>",
      desc: "Write why you keep a warning or leave something out",
    },
    "require-review": {
      type: "boolean",
      desc: "Fail unless a person reviewed the current text",
    },
    "allow-drift": {
      type: "boolean",
      desc: "Write a page marked draft when code links drifted or are missing",
    },
  },
  positionals: [{ name: "explainer", required: false }],
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
    const included = [
      ...new Set(
        (args.str("include-guides") ?? "")
          .split(",")
          .map((id) => id.trim())
          .filter(Boolean),
      ),
    ];
    if (included.length > LIBRARY_MAX_GUIDES)
      throw new UsageError(
        `--include-guides accepts at most ${LIBRARY_MAX_GUIDES} additional guides`,
      );
    const loaded = loadReadExplainer(ctx, args.positionals[0], "bundle");

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
    const { ws, explainer, drift, report } = await workspaceReadiness(
      ctx,
      loaded,
      args.str("note"),
      args.flag("require-review"),
    );
    const draft = args.flag("draft") || args.flag("allow-drift");
    if (ws.stale && !args.flag("draft")) {
      throw new CliError(
        `${ws.stale.message} Refusing to export source with an outdated index; --allow-drift only permits drift against a current index.`,
        1,
        { stale: ws.stale.head, readiness: report },
      );
    }
    const stale = describeDrift(drift);
    if (stale !== "") {
      const fix = `run \`xpl resolve ${loaded.name} --write\` and fix what it lists: re-explain the drifted elements, re-anchor or drop the missing anchors`;
      if (!draft) {
        throw new CliError(
          `${loaded.rel} does not match the code: ${stale}, so the page would point at the wrong code. To fix it, ${fix}, then bundle again; --allow-drift writes the page anyway, with a warning on it`,
          1,
          { drift, readiness: report },
        );
      }
      ctx.warn(
        `${stale}: the page says so, but the reader will see code that may not match the text (to fix it, ${fix})`,
      );
    }
    if (!report.ready && !draft) {
      throw new CliError(
        `${describeReadiness(report)}
Repair these findings, or use --draft for a labelled preview.`,
        1,
        { readiness: report },
      );
    }
    if (report.findings.length > 0) ctx.warn(describeReadiness(report));
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
    if (ws.stale) bundle.sourceWarning = ws.stale.message;
    bundle.exportInfo = { status: draft ? "draft" : "ready", report };
    bundle.guideId = loaded.name;
    if (included.length) {
      const entries = loadRepositoryGuides(ctx);
      bundle.guides = [];
      let bytes = 0;
      for (const id of included) {
        if (id === loaded.name) continue;
        const entry = entries.find((entry) => entry.name === id);
        if (!entry) throw new CliError(`no local guide "${id}"; list keys with xpl guides`);
        if ("error" in entry) throw new CliError(`${id}: ${entry.error}`);
        const snapshot = await guideSnapshot(ctx, entry.loaded, {
          draft,
          choice,
          indexChoice: indexOption,
          boundaryMax,
          note: args.str("note"),
          requireReview: args.flag("require-review"),
        });
        bytes += Buffer.byteLength(JSON.stringify(snapshot));
        if (bytes > LIBRARY_MAX_BYTES)
          throw new CliError(
            "Included guides exceed the 20 MiB library limit. Include fewer guides or fewer source files.",
          );
        bundle.guides.push(snapshot);
      }
    }
    // the index packed: a fifth of its size as plain JSON (the viewer unpacks it, `parseBundle`)
    const page = injectBundle(html, bundle, { packIndex: true });
    const target = resolve(ctx.cwd, out);
    await atomicWrite(target, page);
    const bytes = Buffer.byteLength(page);
    const embedded = Object.keys(collected.files).length;
    if (bytes > LARGE_BUNDLE_BYTES) {
      ctx.warn(
        `the page is ${formatBytes(bytes)}: a page this large opens slowly and is hard to send${collected.choice === "referenced" ? "" : "; --files referenced embeds only the files the explainer points at"}`,
      );
    }

    if (ctx.json) {
      ctx.emit({
        readiness: report,
        exportStatus: draft ? "draft" : "ready",
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
      `wrote ${out} (${formatBytes(bytes)}): ${loaded.rel}, ${describeFiles(collected)}${changeText}, ${describeIndex(embeddedIndex)}, mode ${mode}${tour !== undefined ? `, tour ${tour}` : ""}${draft ? ", draft preview" : ""}`,
    );
    return 0;
  },
};
