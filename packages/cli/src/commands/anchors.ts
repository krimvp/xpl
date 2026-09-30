import {
  ExplainerModel,
  codeFocus,
  collectAnchors,
  deriveGraph,
  derivedEdgeMap,
  describeAnchor,
  normalizeElementId,
  parseId,
  resolveWith,
  suggestIds,
  type Anchor,
  type AnchorSite,
  type AnchorStatus,
  type Explainer,
  type FocusOptions,
  type FocusRange,
  type Range,
  type Tour,
  type TourStep,
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
  /** Where the anchor is stored: `views[1].steps[2].anchors[0]`; a derived range: the focus of its tour step. */
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
  /** The head and the tail of a long anchor's code (see `elided`). */
  lines?: ShownLine[];
  /** Code lines cut by the cap. */
  moreLines?: number;
  /** The lines between the head and the tail that were cut. */
  elided?: { startLine: number; endLine: number };
  /** Tour steps without `code`: this range is what the viewer derives from the focus, not a stored anchor. */
  derived?: true;
  /** For a derived range: the element of the step's `focus` it comes from. */
  from?: string;
}

interface ElementReport {
  id: string;
  type: AnchorSite["owner"];
  /** Steps: the sequence view they belong to. Tour steps: the view they show. */
  view?: string;
  origin?: string;
  /** Fields the user edited: `anchors` (or `steps`) means Claude cannot change these anchors. */
  userFields?: string[];
  /** A tour step without `code`: what follows is its derived focus, not stored anchors. */
  derived?: true;
  /** A derived tour step: its `focus`. */
  focus?: string[];
  /** A derived tour step: focus ids that have no code to show (no anchors, or none that resolves). */
  noCode?: string[];
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

/** A tour step to show by what its focus derives to (it has no `code` override). */
interface DerivedStep {
  /** `tour:intro/t2`. */
  id: string;
  tour: Tour;
  step: TourStep;
  /** Where the step is stored: `tours[0].steps[1]`. */
  path: string;
  origin?: string;
  userFields: string[];
}

/** One thing to print: the stored anchors of an element, or the derived focus of a tour step. */
interface Entry {
  id: string;
  derived?: DerivedStep;
}

interface Selection {
  entries: Entry[];
  /** Requested elements that exist but carry no stored anchors, with what they are. */
  bare: { id: string; type: string; note?: string }[];
}

/** Does the viewer use the step's `code`? (An empty override counts as none, like there.) */
function hasCode(step: TourStep): boolean {
  return Array.isArray(step.code) && step.code.length > 0;
}

function derivedStep(model: ExplainerModel, tour: Tour, step: TourStep): DerivedStep {
  const tours = model.tours;
  const ti = tours.findIndex((t) => t.id === tour.id);
  const si = tour.steps.findIndex((s) => s.id === step.id);
  return {
    id: `${tour.id}/${step.id}`,
    tour,
    step,
    path: `tours[${ti}].steps[${si}]`,
    ...(tour.provenance?.origin !== undefined ? { origin: tour.provenance.origin } : {}),
    userFields: tour.provenance?.userFields ?? [],
  };
}

/**
 * Turns what was typed into what to print: an element id as it is (`concept:x`, `dispatch:3`, `tour:intro/t2`), a
 * view (its steps), a tour (its steps: those with `code` show the stored anchors, the others their derived focus),
 * a tour step without `code` (its derived focus), or a structural id in any of the loose forms of the other
 * commands (`src/runner.ts#Runner.dispatch`).
 */
function select(
  inputs: readonly string[],
  groups: ReadonlyMap<string, AnchorSite[]>,
  model: ExplainerModel,
  ws: Workspace,
  name: string,
): Selection {
  const entries: Entry[] = [];
  const bare: Selection["bare"] = [];
  const add = (entry: Entry) => {
    if (!entries.some((known) => known.id === entry.id)) entries.push(entry);
  };
  for (const input of inputs) {
    if (groups.has(input)) {
      add({ id: input });
      continue;
    }
    const parsed = parseId(input);
    if (parsed.type === "view") {
      const view = model.view(input);
      if (view?.type === "sequence" || view?.type === "flow") {
        const steps = (Array.isArray(view.steps) ? view.steps : []).map((s) => s.id);
        const withAnchors = steps.filter((id) => groups.has(id));
        withAnchors.forEach((id) => add({ id }));
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
      const tour = model.tour(input);
      if (tour) {
        const steps = Array.isArray(tour.steps) ? tour.steps : [];
        if (steps.length === 0) {
          bare.push({ id: input, type: "tour", note: "it has no steps" });
        }
        for (const step of steps) {
          if (hasCode(step) && groups.has(`${tour.id}/${step.id}`)) {
            add({ id: `${tour.id}/${step.id}` });
          } else add({ id: `${tour.id}/${step.id}`, derived: derivedStep(model, tour, step) });
        }
        continue;
      }
      // `tour:intro/t2`: one step of a tour; with a `code` override it is in `groups`, else it is derived
      const slash = input.lastIndexOf("/");
      const owner = slash === -1 ? undefined : model.tour(input.slice(0, slash));
      const step = owner?.steps.find((s) => s.id === input.slice(slash + 1));
      if (owner && step) {
        add({ id: input, derived: derivedStep(model, owner, step) });
        continue;
      }
    }
    const loose = normalizeElementId(input, ws.model);
    if (loose.ok && groups.has(loose.id)) {
      add({ id: loose.id });
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
      ...model.groups.map((g) => g.id),
      ...model.views.map((v) => v.id),
      ...model.tours.map((t) => t.id),
      ...model.views.flatMap((v) => (v.type !== "graph" ? v.steps.map((s) => s.id) : [])),
    ];
    const needle = input.toLowerCase();
    const near = [
      ...new Set([
        ...suggestIds(input, known),
        ...known.filter(
          (id) => id.toLowerCase().includes(needle) || needle.includes(id.toLowerCase()),
        ),
      ]),
    ].slice(0, 5);
    throw new CliError(
      `no element "${input}" in ${name}` +
        (near.length > 0
          ? `. Did you mean: ${near.join(", ")}?`
          : ". `xpl anchors <explainer>` without ids lists every element with anchors."),
      1,
      near.length > 0 ? { candidates: near } : {},
    );
  }
  return { entries, bare };
}

/**
 * The code of an anchor's lines (or of a derived range): the head and, when there are more than `cap` lines, the
 * tail after an elision, so that the end of a span can be checked too (an off-by-one there is the usual mistake).
 */
function attachLines(
  report: AnchorReport,
  ws: Workspace,
  file: string,
  base: number,
  range: { startLine: number; endLine: number },
  cap: number,
): void {
  const lines = ws.texts.lines(file);
  if (!lines) {
    report.reason = `cannot read ${file} from the working tree`;
    return;
  }
  const first = Math.max(1, range.startLine);
  const last = Math.min(lines.length, range.endLine);
  const wanted = Math.max(0, last - first + 1);
  const shown: ShownLine[] = [];
  const push = (line: number) => shown.push({ line, offset: line - base, text: lines[line - 1]! });
  // Cutting two lines to write "2 lines elided" is no saving: the cap gives way to a couple of lines more.
  if (cap > 0 && wanted > cap + 2) {
    const tail = cap >= 3 ? Math.floor(cap / 3) : 0;
    const head = cap - tail;
    for (let line = first; line < first + head; line++) push(line);
    for (let line = last - tail + 1; line <= last; line++) push(line);
    report.elided = { startLine: first + head, endLine: last - tail };
    report.moreLines = wanted - cap;
  } else {
    for (let line = first; line <= last; line++) push(line);
  }
  report.lines = shown;
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

  const base =
    (anchor.symbol ? ws.model.symbolAt(anchor.file, anchor.symbol)?.range.startLine : 1) ?? 1;
  attachLines(report, ws, anchor.file, base, resolved.range, cap);
  return report;
}

/** A range of the derived focus, spelled like an anchor: the symbol that holds it and the offsets inside. */
function describeDerived(
  focus: FocusRange,
  step: DerivedStep,
  ws: Workspace,
  cap: number,
): AnchorReport {
  const { file, range } = focus;
  let symbol = ws.model.innermostSymbolAt(file, range.startLine);
  while (symbol && symbol.range.endLine < range.endLine) symbol = ws.model.parentSymbol(symbol.id);
  const base = symbol ? symbol.range.startLine : 1;
  const whole = symbol
    ? range.startLine === symbol.range.startLine && range.endLine === symbol.range.endLine
    : range.startLine === 1 && range.endLine === (ws.model.file(file)?.lines ?? range.endLine);
  const span = whole
    ? undefined
    : { from: Math.max(0, range.startLine - base), to: Math.max(0, range.endLine - base) };
  const report: AnchorReport = {
    path: `${step.path}.focus`,
    role: focus.role,
    file,
    ...(symbol ? { symbol: symbol.path } : {}),
    ...(span ? { span } : {}),
    where: describeAnchor({
      file,
      ...(symbol ? { symbol: symbol.path } : {}),
      ...(span ? { span } : {}),
    }),
    status: focus.status,
    range: { startLine: range.startLine, endLine: range.endLine },
    derived: true,
    from: focus.elementId,
  };
  attachLines(report, ws, file, base, range, cap);
  return report;
}

/** What the viewer shows for a tour step without `code`: the code of its focus, in the view's own terms. */
function describeDerivedStep(
  step: DerivedStep,
  model: ExplainerModel,
  ws: Workspace,
  cap: number,
  optionsOf: (viewId: string) => FocusOptions,
) {
  const focusIds = Array.isArray(step.step.focus) ? step.step.focus : [];
  const options = optionsOf(step.step.view);
  // one element at a time, like the viewer: every range says which focus id it comes from
  const ranges = focusIds.flatMap((id) => codeFocus([id], model, options));
  const noCode = focusIds.filter((id) => !ranges.some((range) => range.elementId === id));
  return {
    ranges: ranges.map((range) => describeDerived(range, step, ws, cap)),
    noCode,
    focus: [...focusIds],
  };
}

function renderCode(report: AnchorReport): string[] {
  const lines = report.lines ?? [];
  const absWidth = String(Math.max(...lines.map((l) => l.line))).length;
  const offWidth = String(Math.max(0, ...lines.map((l) => l.offset))).length;
  const elision = (): string => {
    const { startLine, endLine } = report.elided!;
    return `... ${report.moreLines} lines elided (${startLine}-${endLine}); --full shows all, or \`xpl show ${report.file}${report.symbol ? `#${report.symbol}` : ""} --lines ${startLine}-${endLine}\``;
  };
  const out: string[] = [];
  let elided = false;
  for (const l of lines) {
    // the elision sits between the head and the tail: before the first line after the cut
    if (report.elided && !elided && l.line > report.elided.endLine) {
      out.push(elision());
      elided = true;
    }
    const text =
      l.text.length > MAX_LINE_CHARS
        ? `${l.text.slice(0, MAX_LINE_CHARS)}…[+${l.text.length - MAX_LINE_CHARS} chars]`
        : l.text;
    out.push(
      `${String(l.line).padStart(absWidth)} ${String(l.offset).padStart(offWidth)}│ ${text}`.trimEnd(),
    );
  }
  if (report.elided && !elided) out.push(elision()); // no tail: the cut is the end
  return out;
}

function renderAnchor(a: AnchorReport, n: number, name: string): string[] {
  const parts = [`${n}. ${a.role}`, a.where, a.status];
  if (a.range) {
    const label = a.status === "missing" ? "last known lines" : "lines";
    parts.push(`${label} ${rangeText(a.range)}`);
  }
  if (a.derived) parts.push(`[derived from ${a.from}]`);
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
  if (a.lines && a.lines.length > 0) out.push(...renderCode(a).map((line) => `     ${line}`));
  return out;
}

function headerOf(e: ElementReport): string {
  if (e.derived) {
    const tail = e.userFields?.includes("steps") === true ? ", steps owned by the user" : "";
    return `${e.id}  (tour step in ${e.view}, no code override: what its focus shows, derived${tail})  ${plural(e.anchors.length, "range")}`;
  }
  const kind = e.type === "step" && e.view ? `step in ${e.view}` : e.type;
  const owner = e.origin ? `, ${e.origin}` : "";
  const locked =
    e.userFields?.includes(e.type === "step" || e.type === "tour-step" ? "steps" : "anchors") ===
    true
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
    "A tour step without a `code` override shows what the viewer will show for its focus: the code of the focused",
    "elements, marked `derived` (`xpl anchors <explainer> tour:intro` lists every step, with `code` or derived).",
    `A long anchor is cut to ${DEFAULT_ANCHOR_LINES} lines: its first lines, an elision line and its last ones (the`,
    "end of a span is the part that goes wrong); --full (or --max-lines 0) prints all of it.",
  ],
  options: {
    full: { type: "boolean", desc: "Print every line of every anchor (no cap)" },
    "max-lines": {
      type: "string",
      arg: "<n>",
      desc: `Cut each anchor's code to n lines, head and tail (default ${DEFAULT_ANCHOR_LINES}, 0 = no limit)`,
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
    const selection: Selection =
      requested.length > 0
        ? select(requested, groups, model, ws, loaded.name)
        : { entries: [...groups.keys()].map((id) => ({ id })), bare: [] };

    // the derived edges of a graph view are what its stubs and edges focus: computed once per view
    const focusOptions = new Map<string, FocusOptions>();
    const optionsOf = (viewId: string): FocusOptions => {
      let options = focusOptions.get(viewId);
      if (!options) {
        const view = model.view(viewId);
        options =
          view?.type === "graph" ? { derivedEdges: derivedEdgeMap(deriveGraph(view, model)) } : {};
        focusOptions.set(viewId, options);
      }
      return options;
    };
    const elements: ElementReport[] = selection.entries.map((entry) => {
      if (entry.derived) {
        const step = entry.derived;
        const found = describeDerivedStep(step, model, ws, cap, optionsOf);
        return {
          id: entry.id,
          type: "tour-step",
          view: step.step.view,
          ...(step.origin !== undefined ? { origin: step.origin } : {}),
          ...(step.userFields.length > 0 ? { userFields: step.userFields } : {}),
          derived: true,
          focus: found.focus,
          ...(found.noCode.length > 0 ? { noCode: found.noCode } : {}),
          anchors: found.ranges,
        };
      }
      const sites = groups.get(entry.id)!;
      const first = sites[0]!;
      return {
        id: entry.id,
        type: first.owner,
        ...(first.viewId !== undefined ? { view: first.viewId } : {}),
        ...(first.origin !== undefined ? { origin: first.origin } : {}),
        ...(first.userFields.length > 0 ? { userFields: first.userFields } : {}),
        anchors: sites.map((site) => describeOne(site, ws, cap)),
      };
    });
    const counts: Record<AnchorStatus, number> = { ok: 0, moved: 0, drifted: 0, missing: 0 };
    let total = 0;
    let stored = 0;
    let derivedRanges = 0;
    for (const element of elements) {
      if (element.derived) derivedRanges += element.anchors.length;
      else {
        stored++;
        for (const a of element.anchors) {
          counts[a.status]++;
          total++;
        }
      }
    }
    const derivedSteps = elements.filter((element) => element.derived).length;

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
      if (element.derived && element.noCode) {
        for (const id of element.noCode) {
          lines.push(`  no code for ${id}: it has no anchors, or none that resolves`);
        }
      }
      if (element.derived && element.anchors.length === 0 && !element.noCode?.length) {
        lines.push("  the focus is empty: this step shows no code");
      }
    }
    for (const b of selection.bare) {
      if (lines.length > 0) lines.push("");
      lines.push(`${b.id}  (${b.type})  no stored anchors${b.note ? `: ${b.note}` : ""}`);
    }
    if (elements.length === 0 && selection.bare.length === 0) {
      lines.push(`${loaded.rel} has no anchors yet`);
    }
    if (total > 0 || derivedRanges > 0) {
      const summary =
        total > 0
          ? `${plural(total, "anchor")} of ${plural(stored, "element")}: ok ${counts.ok}, moved ${counts.moved}, drifted ${counts.drifted}, missing ${counts.missing}`
          : "";
      const derivedNote =
        derivedSteps > 0
          ? `${plural(derivedRanges, "derived range")} of ${plural(derivedSteps, "tour step")} without a code override (not stored anchors)`
          : "";
      lines.push("", [summary, derivedNote].filter((part) => part !== "").join("; "));
    }
    ctx.out(lines.join("\n"));
    return 0;
  },
};
