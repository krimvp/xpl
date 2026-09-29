import {
  ExplainerModel,
  collectAnchors,
  describeAnchor,
  normalizeElementId,
  parseId,
  resolveWith,
  type Anchor,
  type AnchorSite,
  type AnchorStatus,
  type Explainer,
  type Range,
} from "@xpl/core";
import type { CommandSpec } from "../command.js";
import { CliError } from "../errors.js";
import { plural, rangeText } from "../format.js";
import { loadExplainer, openWorkspace, type Workspace } from "../repo.js";

/** Code lines printed per anchor before `xpl anchors` cuts it (`--full` / `--max-lines 0` print all). */
export const DEFAULT_ANCHOR_LINES = 12;
/** Longer lines are cut in the text output; `--json` keeps them whole. */
const MAX_LINE_CHARS = 200;

interface ShownLine {
  line: number;
  /** 0-based offset from the symbol's first line (file line 1 without a symbol): what a `span` uses. */
  offset: number;
  text: string;
}

interface AnchorReport {
  /** Where the anchor is stored: `views[1].steps[2].anchors[0]`. */
  path: string;
  role: Anchor["role"];
  file: string;
  symbol?: string;
  span?: { from: number; to: number };
  /** `src/runner.ts#Runner.dispatch +34..36`. */
  where: string;
  /** Resolved now, against the index and the working tree. */
  status: AnchorStatus;
  /** What the explainer file has cached, when it differs from `status` or `range`. */
  stored?: { status: AnchorStatus; range: Range };
  /** Where the code is now (for `missing`: where it was, when that is known). */
  range?: { startLine: number; endLine: number };
  /** Drifted span: the lines are only where the span used to sit. */
  approximate?: true;
  reason?: string;
  lines?: ShownLine[];
  /** Code lines cut by the cap. */
  moreLines?: number;
}

interface ElementReport {
  id: string;
  type: AnchorSite["owner"];
  /** Steps: the sequence view they belong to. */
  view?: string;
  origin?: string;
  /** Fields the user edited: `anchors` (or `steps`) means Claude cannot change these anchors. */
  userFields?: string[];
  anchors: AnchorReport[];
}

/** Anchors of one element, by element id, in the order the explainer stores them. */
function groupSites(explainer: Explainer): Map<string, AnchorSite[]> {
  const groups = new Map<string, AnchorSite[]>();
  for (const site of collectAnchors(explainer)) {
    const list = groups.get(site.elementId);
    if (list) list.push(site);
    else groups.set(site.elementId, [site]);
  }
  return groups;
}

interface Selection {
  ids: string[];
  /** Requested elements that exist but carry no stored anchors, with what they are. */
  bare: { id: string; type: string; note?: string }[];
}

/**
 * Turns what was typed into element ids that have anchors: an element id as it is (`concept:x`,
 * `dispatch:3`, `tour:intro/t2`), a view (its steps) or a tour (its steps' code), or a structural id in any
 * of the loose forms of the other commands (`src/runner.ts#Runner.dispatch`).
 */
function select(
  inputs: readonly string[],
  groups: ReadonlyMap<string, AnchorSite[]>,
  model: ExplainerModel,
  ws: Workspace,
  name: string,
): Selection {
  const ids: string[] = [];
  const bare: Selection["bare"] = [];
  const add = (id: string) => {
    if (!ids.includes(id)) ids.push(id);
  };
  for (const input of inputs) {
    if (groups.has(input)) {
      add(input);
      continue;
    }
    const parsed = parseId(input);
    if (parsed.type === "view") {
      const view = model.view(input);
      if (view?.type === "sequence") {
        const steps = (Array.isArray(view.steps) ? view.steps : []).map((s) => s.id);
        const withAnchors = steps.filter((id) => groups.has(id));
        withAnchors.forEach(add);
        if (withAnchors.length === 0) {
          bare.push({ id: input, type: "sequence view", note: "none of its steps has an anchor" });
        }
        continue;
      }
      if (view) {
        bare.push({
          id: input,
          type: "graph view",
          note: "a graph view has no anchors of its own",
        });
        continue;
      }
    }
    if (parsed.type === "tour") {
      const prefix = `${input}/`;
      const steps = [...groups.keys()].filter((id) => id.startsWith(prefix));
      if (steps.length > 0) {
        steps.forEach(add);
        continue;
      }
      if (model.tour(input)) {
        bare.push({ id: input, type: "tour", note: "none of its steps has a code override" });
        continue;
      }
    }
    const loose = normalizeElementId(input, ws.model);
    if (loose.ok && groups.has(loose.id)) {
      add(loose.id);
      continue;
    }
    const element = model.element(loose.ok ? loose.id : input);
    if (element) {
      bare.push({ id: loose.ok ? loose.id : input, type: element.type });
      continue;
    }
    const known = [
      ...groups.keys(),
      ...model.concepts.map((c) => c.id),
      ...model.storedEdges.map((e) => e.id),
    ];
    const needle = input.toLowerCase();
    const near = [...new Set(known)]
      .filter((id) => id.toLowerCase().includes(needle) || needle.includes(id.toLowerCase()))
      .slice(0, 5);
    throw new CliError(
      `no element "${input}" in ${name}` +
        (near.length > 0
          ? `. Did you mean: ${near.join(", ")}?`
          : ". `xpl anchors <explainer>` without ids lists every element with anchors."),
      1,
      near.length > 0 ? { candidates: near } : {},
    );
  }
  return { ids, bare };
}

function describeOne(site: AnchorSite, ws: Workspace, cap: number): AnchorReport {
  const { anchor } = site;
  const resolved = resolveWith(anchor, ws.model, ws.texts);
  // a moved span has new offsets: show those (`xpl resolve --write` stores them)
  const shownSpan = resolved.span ?? anchor.span;
  const report: AnchorReport = {
    path: site.path,
    role: anchor.role,
    file: anchor.file,
    ...(anchor.symbol !== undefined ? { symbol: anchor.symbol } : {}),
    ...(shownSpan !== undefined ? { span: { ...shownSpan } } : {}),
    where: describeAnchor({
      file: anchor.file,
      ...(anchor.symbol !== undefined ? { symbol: anchor.symbol } : {}),
      ...(shownSpan !== undefined ? { span: shownSpan } : {}),
    }),
    status: resolved.status,
  };
  const stored = anchor.resolved;
  if (resolved.status === "missing") {
    if (stored && stored.range.startLine > 0) report.range = { ...stored.range };
    report.reason = resolved.reason ?? "missing";
    return report;
  }
  report.range = { startLine: resolved.range.startLine, endLine: resolved.range.endLine };
  if (resolved.status === "drifted" && anchor.span) report.approximate = true;
  if (resolved.reason && resolved.status === "drifted") report.reason = resolved.reason;
  // `ok` and `moved` are the same news (the code is where it is): only a change of lines or of health counts
  const health = (status: AnchorStatus) =>
    status === "ok" || status === "moved" ? 0 : status === "drifted" ? 1 : 2;
  if (
    stored &&
    (health(stored.status) !== health(resolved.status) ||
      stored.range.startLine !== resolved.range.startLine ||
      stored.range.endLine !== resolved.range.endLine)
  ) {
    report.stored = { status: stored.status, range: { ...stored.range } };
  }

  const lines = ws.texts.lines(anchor.file);
  if (!lines) {
    report.reason = `cannot read ${anchor.file} from the working tree`;
    return report;
  }
  const base =
    (anchor.symbol ? ws.model.symbolAt(anchor.file, anchor.symbol)?.range.startLine : 1) ?? 1;
  const first = Math.max(1, resolved.range.startLine);
  const last = Math.min(lines.length, resolved.range.endLine);
  const wanted = Math.max(0, last - first + 1);
  const shown = cap > 0 ? Math.min(wanted, cap) : wanted;
  report.lines = [];
  for (let line = first; line < first + shown; line++) {
    report.lines.push({ line, offset: line - base, text: lines[line - 1]! });
  }
  if (shown < wanted) report.moreLines = wanted - shown;
  return report;
}

function renderCode(lines: readonly ShownLine[]): string[] {
  const absWidth = String(Math.max(...lines.map((l) => l.line))).length;
  const offWidth = String(Math.max(0, ...lines.map((l) => l.offset))).length;
  return lines.map((l) => {
    const text =
      l.text.length > MAX_LINE_CHARS
        ? `${l.text.slice(0, MAX_LINE_CHARS)}…[+${l.text.length - MAX_LINE_CHARS} chars]`
        : l.text;
    return `${String(l.line).padStart(absWidth)} ${String(l.offset).padStart(offWidth)}│ ${text}`.trimEnd();
  });
}

function renderAnchor(a: AnchorReport, n: number, name: string): string[] {
  const parts = [`${n}. ${a.role}`, a.where, a.status];
  if (a.range) {
    const label = a.status === "missing" ? "last known lines" : "lines";
    parts.push(`${label} ${rangeText(a.range)}`);
  }
  const out = [`  ${parts.join("  ")}`];
  if (a.approximate) {
    out.push(
      "     (approximate: the text changed, so these are only the lines where the span used to sit; re-read the code)",
    );
  }
  if (a.stored) {
    out.push(
      `     (the explainer file still says ${a.stored.status}, lines ${rangeText(a.stored.range)}: run \`xpl resolve ${name} --write\`)`,
    );
  }
  if (a.reason) out.push(`     ${a.reason}`);
  if (a.lines && a.lines.length > 0) {
    out.push(...renderCode(a.lines).map((line) => `     ${line}`));
    if (a.moreLines) {
      const to = a.range!.endLine;
      out.push(
        `     ... ${a.moreLines} more lines (${a.range!.startLine + a.lines.length}-${to}); --full shows all, or \`xpl show ${a.file}${a.symbol ? `#${a.symbol}` : ""} --lines ${a.range!.startLine + a.lines.length}-${to}\``,
      );
    }
  }
  return out;
}

function headerOf(e: ElementReport): string {
  const kind = e.type === "step" && e.view ? `step in ${e.view}` : e.type;
  const owner = e.origin ? `, ${e.origin}` : "";
  const locked =
    e.userFields?.includes(e.type === "step" ? "steps" : "anchors") === true
      ? ", anchors owned by the user"
      : "";
  return `${e.id}  (${kind}${owner}${locked})  ${plural(e.anchors.length, "anchor")}`;
}

export const anchorsCommand: CommandSpec = {
  name: "anchors",
  usage: "xpl anchors <explainer> [id...] [--full] [--max-lines n]",
  summary: "Each anchor of an element with its resolved lines and code",
  details: [
    "Verifies what an explainer points at. For every element with stored anchors (node overlays, edges, concepts,",
    "sequence steps, tour steps' code overrides) it prints each anchor",
    "  <n>. <role>  <file>#<symbol> +<from>..<to>  <status>  lines <a>-<b>",
    "resolved now against the index and the working tree (status ok, moved, drifted or missing), then the code at",
    "those lines as `<line> <offset>│ code` (the offsets are the ones `xpl show` prints and a span uses). Use it",
    "after `xpl apply` to confirm every span landed on the code you meant, and to re-read what drifted.",
    "Ids: element ids as they are (concept:x, dispatch:3, edge:x, sym:src/a.ts#A.b, tour:intro/t2), a view (its",
    "steps), a tour (its steps), or the loose forms of the other commands. Without ids: every element with anchors.",
    `Each anchor's code is cut after ${DEFAULT_ANCHOR_LINES} lines; --full (or --max-lines 0) prints all of it.`,
  ],
  options: {
    full: { type: "boolean", desc: "Print every line of every anchor (no cap)" },
    "max-lines": {
      type: "string",
      arg: "<n>",
      desc: `Cut each anchor's code after n lines (default ${DEFAULT_ANCHOR_LINES}, 0 = no limit)`,
    },
  },
  positionals: [{ name: "explainer" }, { name: "id", required: false, rest: true }],
  async run(ctx, args) {
    const cap = args.flag("full") ? 0 : (args.int("max-lines") ?? DEFAULT_ANCHOR_LINES);
    const loaded = loadExplainer(ctx, args.positionals[0]!);
    const ws = await openWorkspace(ctx, { explainer: loaded });
    const model = new ExplainerModel(loaded.explainer, ws.model);
    const groups = groupSites(loaded.explainer);
    const requested = args.positionals.slice(1);
    const selection =
      requested.length > 0
        ? select(requested, groups, model, ws, loaded.name)
        : { ids: [...groups.keys()], bare: [] };

    const elements: ElementReport[] = selection.ids.map((id) => {
      const sites = groups.get(id)!;
      const first = sites[0]!;
      return {
        id,
        type: first.owner,
        ...(first.viewId !== undefined ? { view: first.viewId } : {}),
        ...(first.origin !== undefined ? { origin: first.origin } : {}),
        ...(first.userFields.length > 0 ? { userFields: first.userFields } : {}),
        anchors: sites.map((site) => describeOne(site, ws, cap)),
      };
    });
    const counts: Record<AnchorStatus, number> = { ok: 0, moved: 0, drifted: 0, missing: 0 };
    for (const element of elements) for (const a of element.anchors) counts[a.status]++;
    const total = elements.reduce((sum, e) => sum + e.anchors.length, 0);

    if (ctx.json) {
      ctx.emit({
        path: loaded.rel,
        index: { path: ws.indexRel, commit: ws.index.commit },
        maxLines: cap,
        anchors: { total, counts },
        elements,
        ...(selection.bare.length > 0 ? { withoutAnchors: selection.bare } : {}),
      });
      return 0;
    }

    const lines: string[] = [];
    for (const element of elements) {
      if (lines.length > 0) lines.push("");
      lines.push(headerOf(element));
      element.anchors.forEach((a, i) => lines.push(...renderAnchor(a, i + 1, loaded.name)));
    }
    for (const b of selection.bare) {
      if (lines.length > 0) lines.push("");
      lines.push(`${b.id}  (${b.type})  no stored anchors${b.note ? `: ${b.note}` : ""}`);
    }
    if (elements.length === 0 && selection.bare.length === 0) {
      lines.push(`${loaded.rel} has no anchors yet`);
    }
    if (total > 0) {
      lines.push(
        "",
        `${plural(total, "anchor")} of ${plural(elements.length, "element")}: ok ${counts.ok}, moved ${counts.moved}, drifted ${counts.drifted}, missing ${counts.missing}`,
      );
    }
    ctx.out(lines.join("\n"));
    return 0;
  },
};
