import {
  baseFileOf,
  basePathOf,
  describeChange,
  describeNoBase,
  hashText,
  shortSha,
} from "@xpl/core";
import type { Args } from "../args.js";
import type { CommandSpec } from "../command.js";
import type { Ctx } from "../context.js";
import { CliError, UsageError } from "../errors.js";
import { plural, rangeText } from "../format.js";
import { buildOutline, outlineJson, renderOutline } from "../outline-tree.js";
import {
  collectRefs,
  countByKind,
  groupByKind,
  needsFrom,
  refLine,
  type RefDirection,
  type RefEntry,
} from "../ref-data.js";
import { loadExplainer, listExplainerNames, openWorkspace, type Workspace } from "../repo.js";
import { detectRepoName } from "../repo-name.js";
import { resolveTarget, type Target } from "../target.js";

/** Code lines printed before `show` cuts a symbol or file (`--max-lines 0` prints everything). */
export const DEFAULT_MAX_LINES = 400;
/** Longer lines are cut in the text output (minified files); `--json` keeps them whole. */
const MAX_LINE_CHARS = 400;
/** References printed per direction by `show --refs`. */
const MAX_REF_LINES = 100;

interface ShownLine {
  line: number;
  /** 0-based offset from the symbol's first line (what spans use); null for context lines. */
  offset: number | null;
  text: string;
}

function parseLineSelection(value: string): { from: number; to: number } {
  const match = /^(\d+)(?:(?:-|\.\.)(\d+))?$/.exec(value.trim());
  const from = match ? Number(match[1]) : 0;
  const to = match ? (match[2] === undefined ? from : Number(match[2])) : 0;
  if (!match || from < 1 || to < from) {
    throw new UsageError(
      `--lines must look like 40 or 40-80 (absolute file lines), got "${value}"`,
    );
  }
  return { from, to };
}

function refsSection(
  title: string,
  direction: RefDirection,
  subject: string,
  entries: readonly RefEntry[],
  hint: string,
): string[] {
  if (entries.length === 0) return [`${title}: none`];
  const ordered = groupByKind(entries);
  const shown = ordered.slice(0, MAX_REF_LINES);
  const lines = [`${title}: ${entries.length} (${countByKind(entries)})`];
  for (const entry of shown) {
    lines.push(`  ${refLine(entry, needsFrom(entry, direction, subject))}`);
  }
  if (ordered.length > shown.length) {
    lines.push(`  ... ${ordered.length - shown.length} more; ${hint}`);
  }
  return lines;
}

async function showListing(
  ctx: Ctx,
  ws: Workspace,
  target: Extract<Target, { type: "repo" | "dir" }>,
  args: Args,
): Promise<number> {
  const tree = buildOutline(ws.model, target.id, {
    depth: 1,
    keys: false,
    repoName: (await detectRepoName(ctx.root)).name,
  });
  const refs = args.flag("refs")
    ? {
        out: groupByKind(collectRefs(ws.model, target, "out")),
        in: groupByKind(collectRefs(ws.model, target, "in")),
      }
    : undefined;
  if (ctx.json) {
    ctx.emit({
      id: target.id,
      type: target.type,
      tree: outlineJson(tree),
      ...(refs ? { refs } : {}),
    });
    return 0;
  }
  const header =
    target.type === "repo"
      ? `repo (repo) ${tree.files} files, ${tree.symbols} symbols`
      : `${target.id} (dir) ${plural(tree.files ?? 0, "file")}`;
  const children = tree.children.map((child) => `  ${renderOutline(child)[0]}`);
  const maxLines = args.int("max-lines") ?? DEFAULT_MAX_LINES;
  const shownChildren = maxLines > 0 ? children.slice(0, maxLines) : children;
  const lines = [header, ...shownChildren];
  if (children.length === 0) lines.push("  (empty)");
  if (shownChildren.length < children.length) {
    lines.push(`  ... ${children.length - shownChildren.length} more; use --max-lines 0`);
  }
  if (refs) {
    lines.push(
      "",
      ...refsSection(
        "outgoing refs",
        "out",
        target.id,
        refs.out,
        `xpl refs ${target.id} --out --limit 0`,
      ),
      "",
      ...refsSection(
        "incoming refs",
        "in",
        target.id,
        refs.in,
        `xpl refs ${target.id} --in --limit 0`,
      ),
    );
  }
  ctx.out(lines.join("\n"));
  return 0;
}

interface CodeOptions {
  selection: { from: number; to: number } | undefined;
  selectionText: string | undefined;
  maxLines: number;
  context: number;
  refs: boolean;
}

function codeOptions(args: Args): CodeOptions {
  const selectionText = args.str("lines");
  return {
    selectionText,
    selection: selectionText === undefined ? undefined : parseLineSelection(selectionText),
    maxLines: args.int("max-lines") ?? DEFAULT_MAX_LINES,
    context: args.int("context") ?? 0,
    refs: args.flag("refs"),
  };
}

async function showCode(
  ctx: Ctx,
  ws: Workspace,
  target: Extract<Target, { type: "file" | "symbol" }>,
  options: CodeOptions,
): Promise<number> {
  const whole = target.type === "file";
  const file = whole ? target.path : target.symbol.file;
  const kind = whole ? target.file.language : target.symbol.kind;
  const range = whole
    ? { startLine: 1, endLine: target.file.lines }
    : { startLine: target.symbol.range.startLine, endLine: target.symbol.range.endLine };
  const indexedHash = whole ? target.file.hash : target.symbol.hash;

  const lines = ws.texts.lines(file);
  if (!lines) {
    throw new CliError(
      `cannot read ${file} from the working tree (deleted since it was indexed?). Run \`xpl index\`.`,
    );
  }
  const start = range.startLine;
  // What the index hashed: every line of the file (`IndexedFile.hash`, the trailing empty line after a final
  // newline included), or the full lines of the symbol. Compared before the display drops that empty line.
  const currentHash = whole
    ? hashText(lines.join("\n"))
    : hashText(lines.slice(start - 1, Math.min(range.endLine, lines.length)).join("\n"));
  let end = Math.min(range.endLine, lines.length);
  // A file ending in a newline has an empty last "line" that is not code.
  if (whole && end > 1 && lines[end - 1] === "") end--;
  if (start > end) {
    throw new CliError(
      `${target.id} starts at line ${start} but ${file} has only ${lines.length} lines: the index is out of date. Run \`xpl index\`.`,
    );
  }
  if (currentHash !== indexedHash) {
    ctx.warn(
      `the text of ${target.id} changed since it was indexed (indexed ${indexedHash}, now ${currentHash}); ` +
        `lines and offsets follow the index and may be off. Run \`xpl index\`.`,
    );
  }

  let shownFrom = start;
  let shownTo = end;
  const { selection, selectionText, maxLines } = options;
  if (selection !== undefined) {
    shownFrom = Math.max(start, selection.from);
    shownTo = Math.min(end, selection.to);
    if (shownFrom > shownTo) {
      throw new CliError(
        `--lines ${selectionText} is outside ${target.id}, which spans lines ${start}-${end}`,
      );
    }
  }
  let cut = false;
  if (maxLines > 0 && shownTo - shownFrom + 1 > maxLines) {
    shownTo = shownFrom + maxLines - 1;
    cut = true;
  }

  // Context lines lie outside the symbol, so they have no offset; only where the view touches its edge.
  const context = whole ? 0 : options.context;
  const beforeFrom = shownFrom === start ? Math.max(1, start - context) : shownFrom;
  const afterTo = shownTo === end ? Math.min(lines.length, end + context) : shownTo;
  const shown: ShownLine[] = [];
  for (let line = beforeFrom; line < shownFrom; line++) {
    shown.push({ line, offset: null, text: lines[line - 1]! });
  }
  for (let line = shownFrom; line <= shownTo; line++) {
    shown.push({ line, offset: line - start, text: lines[line - 1]! });
  }
  for (let line = shownTo + 1; line <= afterTo; line++) {
    shown.push({ line, offset: null, text: lines[line - 1]! });
  }
  const hasContext = shown.some((s) => s.offset === null);

  const refs = options.refs
    ? {
        out: groupByKind(collectRefs(ws.model, target, "out")),
        in: groupByKind(collectRefs(ws.model, target, "in")),
      }
    : undefined;

  if (ctx.json) {
    ctx.emit({
      id: target.id,
      type: target.type,
      kind,
      file,
      range,
      hash: indexedHash,
      lines: shown,
      ...(cut || selection !== undefined
        ? {
            shown: { startLine: shownFrom, endLine: shownTo },
            total: { startLine: start, endLine: end },
          }
        : {}),
      ...(refs ? { refs } : {}),
    });
    return 0;
  }

  const absWidth = String(Math.max(...shown.map((s) => s.line))).length;
  const offsetWidth = String(Math.max(0, ...shown.map((s) => s.offset ?? 0))).length;
  const out = [`${target.id} (${kind}) ${file}:${rangeText(range)} ${indexedHash}`];
  for (const s of shown) {
    const abs = String(s.line).padStart(absWidth);
    const off =
      s.offset === null ? " ".repeat(offsetWidth) : String(s.offset).padStart(offsetWidth);
    const text =
      s.text.length > MAX_LINE_CHARS
        ? `${s.text.slice(0, MAX_LINE_CHARS)}…[+${s.text.length - MAX_LINE_CHARS} chars]`
        : s.text;
    out.push(`${abs} ${off}${s.offset === null ? "┆" : "│"} ${text}`.trimEnd());
  }
  if (cut) {
    const next = shownTo + 1;
    out.push(
      `... ${end - shownTo} more lines (${next}-${end}); use --lines ${next}-${Math.min(end, next + maxLines - 1)}, --max-lines 0, or open a member: xpl outline --under ${target.id}`,
    );
  }
  if (hasContext) out.push("(┆ marks context lines outside the symbol; they have no offset)");
  if (refs) {
    out.push(
      "",
      ...refsSection(
        "outgoing refs",
        "out",
        target.id,
        refs.out,
        `xpl refs ${target.id} --out --limit 0`,
      ),
      "",
      ...refsSection(
        "incoming refs",
        "in",
        target.id,
        refs.in,
        `xpl refs ${target.id} --in --limit 0`,
      ),
    );
  }
  ctx.out(out.join("\n"));
  return 0;
}

/**
 * `xpl show --at base <path>`: the code of a changed file before the change (its base version, read with
 * `git show <base>:<path>`), with the offsets a base anchor's `span` uses (0-based from line 1). Which change: the
 * explainer's record (`--explainer`, else the only explainer that has one).
 */
async function showBase(ctx: Ctx, args: Args, options: CodeOptions): Promise<number> {
  const input = args.positionals[0]!;
  const explainerName = args.str("explainer");
  let loaded;
  if (explainerName !== undefined) loaded = loadExplainer(ctx, explainerName);
  else {
    const withChange = listExplainerNames(ctx.root)
      .map((name) => loadExplainer(ctx, name))
      .filter((candidate) => candidate.explainer.change !== undefined);
    if (withChange.length === 0) {
      throw new CliError(
        "no explainer here records a change, so there is no code before it: run `xpl change <name> <base>..<head>` first",
      );
    }
    if (withChange.length > 1) {
      throw new UsageError(
        `several explainers record a change (${withChange.map((c) => c.name).join(", ")}): pick one with --explainer <name>`,
      );
    }
    loaded = withChange[0]!;
  }
  const change = loaded.explainer.change;
  if (!change) {
    throw new CliError(
      `${loaded.rel} records no change, so there is no code before it: run \`xpl change ${loaded.name} <base>..<head>\` first`,
    );
  }
  // `file:src/a.py`, `src/a.py`, `./src/a.py` all name the file; a symbol is not available in the base
  let path = input.replace(/^file:/, "").replace(/^\.\//, "");
  if (path.includes("#")) {
    throw new UsageError(
      `--at base shows whole files (there is no index of the base commit): give the path, e.g. xpl show --at base ${path.slice(0, path.indexOf("#"))} --lines 40-80`,
    );
  }
  const changed = baseFileOf(change, path);
  if (!changed) throw new CliError(describeNoBase(change, path));
  path = changed.path;
  const basePath = basePathOf(changed);
  const ws = await openWorkspace(ctx, { explainer: loaded, skipFreshnessCheck: true });
  const lines = ws.texts.linesAt(change.base, basePath);
  if (!lines) {
    throw new CliError(
      `cannot read ${basePath} at the base commit ${shortSha(change.base)} (\`git show ${shortSha(change.base)}:${basePath}\` failed)`,
    );
  }
  let end = lines.length;
  if (end > 1 && lines[end - 1] === "") end--;
  let shownFrom = 1;
  let shownTo = end;
  const { selection, selectionText, maxLines } = options;
  if (selection !== undefined) {
    shownFrom = Math.max(1, selection.from);
    shownTo = Math.min(end, selection.to);
    if (shownFrom > shownTo) {
      throw new CliError(
        `--lines ${selectionText} is outside ${basePath} at base, which has lines 1-${end}`,
      );
    }
  }
  let cut = false;
  if (maxLines > 0 && shownTo - shownFrom + 1 > maxLines) {
    shownTo = shownFrom + maxLines - 1;
    cut = true;
  }
  const shown: ShownLine[] = [];
  for (let line = shownFrom; line <= shownTo; line++) {
    shown.push({ line, offset: line - 1, text: lines[line - 1]! });
  }
  const hunks = changed.hunks.map((h) => ({ ...h }));
  if (ctx.json) {
    ctx.emit({
      at: "base",
      file: path,
      ...(basePath !== path ? { basePath } : {}),
      status: changed.status,
      commit: change.base,
      explainer: loaded.rel,
      range: { startLine: 1, endLine: end },
      lines: shown,
      hunks,
      ...(cut || selection !== undefined
        ? {
            shown: { startLine: shownFrom, endLine: shownTo },
            total: { startLine: 1, endLine: end },
          }
        : {}),
    });
    return 0;
  }
  // lines the change removes or replaces are marked `-` (the hunks' old side)
  const removed = new Set<number>();
  for (const h of hunks) for (let l = h.oldStart; l < h.oldStart + h.oldLines; l++) removed.add(l);
  const absWidth = String(Math.max(1, ...shown.map((s) => s.line))).length;
  const offsetWidth = String(Math.max(0, ...shown.map((s) => s.offset ?? 0))).length;
  const out = [
    `${path}${basePath !== path ? ` (was ${basePath})` : ""} before the change ${describeChange(change)} ` +
      `(${changed.status}, base ${shortSha(change.base)}): lines 1-${end}; spans count from line 1`,
  ];
  for (const s of shown) {
    const text =
      s.text.length > MAX_LINE_CHARS
        ? `${s.text.slice(0, MAX_LINE_CHARS)}…[+${s.text.length - MAX_LINE_CHARS} chars]`
        : s.text;
    const mark = removed.has(s.line) ? "-" : " ";
    out.push(
      `${String(s.line).padStart(absWidth)} ${String(s.offset).padStart(offsetWidth)}│${mark}${text}`.trimEnd(),
    );
  }
  if (cut) {
    const next = shownTo + 1;
    out.push(
      `... ${end - shownTo} more lines (${next}-${end}); use --lines ${next}-${Math.min(end, next + maxLines - 1)} or --max-lines 0`,
    );
  }
  if (removed.size > 0) out.push("(- marks lines the change removes or rewrites)");
  ctx.out(out.join("\n"));
  return 0;
}

export const showCommand: CommandSpec = {
  name: "show",
  usage: "xpl show <id> [--refs] [--context n] | xpl show --at base <path> [--lines a-b]",
  summary: "Code with 0-based offsets relative to the symbol (what spans use), plus refs",
  details: [
    "Header: <id> (<kind>) <file>:<first>-<last> <hash>. Then one line per code line:",
    "  <absolute line> <offset>│ <code>",
    "The offset is 0-based from the symbol's first line (for a file: line - 1). It is exactly what an",
    "anchor's span {from, to} uses, e.g. offsets 34..36 for the requeue call in Runner.dispatch.",
    "Directories and the repo list their children instead. Ids: sym:src/a.ts#A.b, file:src/a.ts, dir:src,",
    "src/a.ts#A.b, src/a.ts.",
    `--refs appends the references leaving and entering the element, grouped by kind: each line is`,
    "  <kind>  <other id>  (<file>:<line>, <precise|heuristic>)  +<offset>",
    "where +<offset> counts lines from the start of the referencing symbol: a call-site anchor's span.",
    `Long symbols are cut after ${DEFAULT_MAX_LINES} lines (--max-lines 0 prints all; --lines 401-800 selects a part).`,
    "--at base <path> prints a changed file as it was before the change the explainer records (`xpl change`): the",
    "  offsets are those a base anchor's span uses (0-based from line 1 of the base file), and `-` marks the lines",
    "  the change removes or rewrites. Paths only (the base commit is not indexed); --explainer picks the explainer",
    "  when more than one records a change.",
  ],
  options: {
    refs: { type: "boolean", desc: "Append outgoing and incoming references grouped by kind" },
    context: {
      type: "string",
      arg: "<n>",
      desc: "Also print n lines before and after a symbol (marked ┆, no offsets)",
    },
    lines: {
      type: "string",
      arg: "<a-b>",
      desc: "Only these absolute file lines (within the element)",
    },
    "max-lines": {
      type: "string",
      arg: "<n>",
      desc: `Cut after n code lines (default ${DEFAULT_MAX_LINES}, 0 = no limit)`,
    },
    at: {
      type: "string",
      arg: "base",
      desc: "base: the file before the change the explainer records (see xpl change)",
    },
    explainer: {
      type: "string",
      arg: "<name>",
      desc: "With --at base: the explainer whose change to use (default: the only one with a change)",
    },
  },
  positionals: [{ name: "id" }],
  async run(ctx, args) {
    const options = codeOptions(args); // usage errors before any work
    const at = args.choice("at", ["base"] as const);
    if (at === "base") {
      if (options.refs)
        throw new UsageError("--refs needs the index; the base commit is not indexed");
      return showBase(ctx, args, options);
    }
    if (args.str("explainer") !== undefined)
      throw new UsageError("--explainer goes with --at base");
    const ws = await openWorkspace(ctx);
    const target = resolveTarget(ws.model, args.positionals[0]!);
    if (target.type === "repo" || target.type === "dir") return showListing(ctx, ws, target, args);
    return showCode(ctx, ws, target, options);
  },
};
