/**
 * `xpl draft`: patch skeletons for the three scopes of the skill, built from the index (and, for a change, the change
 * record) with no LLM. A draft holds the structure the index proves: the boxes of a map, the participants and calls
 * of a sequence, the tour steps in the order the skill asks for, and anchors copied from the index (symbol ranges,
 * reference sites, the hunks of the change). Every text a person must write holds a `TODO: <what to write>`
 * placeholder, so Claude only writes and checks the text; `xpl lint` reports each one left (`todo-left`).
 *
 * - `draftChange`: a map of the change (changed symbols, or their files when there are many; direct callers outside
 *   tests; one group box for the tests), `stubs: none`, overlays whose summaries start with `New:`, `Changed:` or
 *   `Unchanged:`, and a tour in review order (what changes for users, where it enters, one step per changed piece,
 *   who else is affected, tests, risks), with step ids t10, t20, ... so inserted steps keep their order. Every changed file gets at least one anchor (test files too; a deleted file
 *   gets an anchor in the code before the change).
 * - `draftRepo`: two levels, top-down. A system map (`view:system`): the project as one service box (or one box per
 *   program under `services/`, `apps/` or `cmd/`), who reaches it (a web server or CLI framework) and what it relies
 *   on (databases, caches, queues, other systems' APIs), found from the import lines (outside.ts) and anchored there.
 *   Each service box `opens` a map of its inside: 4-8 boxes (top-level directories, or files; in a src layout below
 *   src) plus the outside systems they use, with an arrow from each part that imports one. Both maps have
 *   `excludeFiles` and `stubs: none`; the tour starts on the system map, then zooms into the main service. A library
 *   (no program to run) gets a "Your app" box for the code that calls it.
 * - `draftPath`: a sequence of the entry's outgoing calls (depth 1, source order, at most 6 participants), and a tour
 *   with one step per call after a big-picture step. Several entries: one sequence each, one tour. A method a class
 *   inherits starts at the base that defines it, and self calls follow the class's method order.
 *
 * `draftProblems` checks a draft for what `xpl apply` does not: ids named in a text that exist nowhere, and focus ids
 * off their step's view.
 *
 * The drafts never overwrite: ids already used in the explainer get a suffix (`view:change-map-2`), and nodes the
 * explainer already stores get no overlay.
 */
import {
  CODE_LANGUAGES,
  CODE_LANGUAGE_NAMES,
  RESERVED_PREFIXES,
  analyzeChange,
  baseName,
  basePathOf,
  dirOf,
  implementationsOf,
  isTestFile,
  matchesAnyGlob,
  parseId,
  symbolIdForElementId,
  type AnchorInput,
  type AnchorRole,
  type CallerEntry,
  type ChangeAnalysis,
  type ChangeRecord,
  type ChangedFile,
  type ChangedSymbol,
  type Explainer,
  type ExplainerPatch,
  type IndexModel,
  type IndexedSymbol,
  type PatchEdge,
  type PatchNode,
  type PatchSequenceStep,
  type PatchTourStep,
  type PatchView,
  type Reference,
  type TextCache,
} from "@xpl/core";
import {
  declaredLibrary,
  findOutsideSystems,
  isLibrary,
  ownModules,
  readmeUsage,
  workspaceParents,
} from "./outside.js";
import { plural } from "./format.js";

export const DRAFT_LIMITS = {
  /** Boxes on a drafted map (the skill: 4-8). */
  mapBoxes: 8,
  /** Boxes for the callers on a change map. */
  callerBoxes: 3,
  /** Steps of a change tour (the skill: up to 12). */
  changeSteps: 12,
  /** Calls in a drafted sequence. */
  pathCalls: 12,
  /** Calls that get a tour step of their own (the skill: 5-9 steps, the big picture first). */
  pathSteps: 8,
  /** Participants of a drafted sequence, the entry included. */
  participants: 6,
  /** Code ranges per tour step. */
  codeRanges: 2,
  /** Changed pieces merged into one tour step at most. */
  mergeSmall: 3,
  /** A changed piece of at most this many changed lines is small (it may share a step). */
  smallLines: 3,
  /** Names listed in one TODO hint before "and N more". */
  names: 6,
  /** Lines of the README the first step of a repo tour shows. */
  readmeLines: 30,
};

/** `excludeFiles` of a drafted overview: what the skill puts on every overview. */
export const OVERVIEW_EXCLUDE: readonly string[] = [
  "**/*_test.go",
  "**/test/**",
  "**/tests/**",
  "**/*.test.*",
  "**/test-d/**",
  "**/*.test-d.*",
  "**/test_*.py",
  "**/examples/**",
  "**/_examples/**",
  "docs/**",
  "benchmarks/**",
];

/** Code that is not the design: callers here stay off a change map, files here stay off an overview. */
const NOT_DESIGN: readonly string[] = [
  "**/examples/**",
  "**/example/**",
  "**/_examples/**",
  "**/testdata/**",
  "**/benchmarks/**",
  "**/benchmark/**",
  "**/docs/**",
  "**/scripts/**",
  "**/bench/**",
  "**/fixtures/**",
  "**/__fixtures__/**",
  "**/__mocks__/**",
];

/** File and directory names that usually hold the entry point of a project. */
const ENTRY_NAMES = /^(?:main|__main__|cli|cmd|app|apps|application|applications|index|server)$/;

export type DraftKind = "change" | "repo" | "path";

export interface DraftInput {
  explainer: Explainer;
  model: IndexModel;
  /** Head text, and (through its second reader) the text at the base of a change. */
  texts: TextCache;
}

export interface Draft {
  kind: DraftKind;
  patch: ExplainerPatch;
  /** What the person running the command should know: what was left out and why. Plain sentences. */
  notes: string[];
}

// ─── Text ───────────────────────────────────────────────────────────────────────────────────────

const todo = (text: string): string => `TODO: ${text}`;
const tick = (text: string): string => `\`${text}\``;

/** A tour note: `### <title>`, a blank line, then the body sentences (a part that starts with a newline: a block). */
function note(title: string, ...body: string[]): string {
  const text = body
    .filter((part) => part !== "")
    .reduce(
      (out, part) => (out === "" || part.startsWith("\n") ? out + part : `${out} ${part}`),
      "",
    );
  return `### ${title}\n\n${text}`;
}

/** `` `a`, `b` and `c` `` (at most `max` names, then "and N more"). */
function nameList(names: readonly string[], max = DRAFT_LIMITS.names): string {
  const unique = [...new Set(names)];
  const shown = unique.slice(0, max).map(tick);
  const more = unique.length - shown.length;
  if (more > 0) return `${shown.join(", ")} and ${more} more`;
  if (shown.length <= 1) return shown.join("");
  return `${shown.slice(0, -1).join(", ")} and ${shown.at(-1)}`;
}

/** "a, b and c": names of things that are not code (an outside system), so no code spans. */
function plainList(names: readonly string[], max = DRAFT_LIMITS.names): string {
  const unique = [...new Set(names)];
  const shown = unique.slice(0, max);
  const more = unique.length - shown.length;
  if (more > 0) return `${shown.join(", ")} and ${more} more`;
  if (shown.length <= 1) return shown.join("");
  return `${shown.slice(0, -1).join(", ")} and ${shown.at(-1)}`;
}

/** The name a reader knows an element by: a symbol path, a file or directory name. */
function displayName(id: string): string {
  const parsed = parseId(id);
  if (parsed.type === "symbol") return parsed.path;
  if (parsed.type === "file" || parsed.type === "dir") return baseName(parsed.path);
  return id;
}

// ─── Ids and stored nodes ───────────────────────────────────────────────────────────────────────

/** Ids already used in the explainer, so a draft never overwrites: `view:x` becomes `view:x-2`. */
class FreeIds {
  private readonly taken = new Set<string>();

  constructor(explainer: Explainer) {
    const add = (items: unknown) => {
      for (const item of Array.isArray(items) ? items : []) {
        const id = (item as { id?: unknown } | null)?.id;
        if (typeof id === "string") this.taken.add(id);
      }
    };
    add(explainer.nodes);
    add(explainer.edges);
    add(explainer.concepts);
    add(explainer.views);
    add(explainer.tours);
    for (const view of Array.isArray(explainer.views) ? explainer.views : []) {
      if (view.type !== "graph") add(view.steps);
    }
  }

  /** `<prefix>:<slug>`, or `<prefix>:<slug>-2`, `-3`, ... when that is taken. */
  get(prefix: string, slug: string): string {
    let id = `${prefix}:${slug}`;
    for (let n = 2; this.taken.has(id); n++) id = `${prefix}:${slug}-${n}`;
    this.taken.add(id);
    return id;
  }
}

function storedNodeIds(explainer: Explainer): Set<string> {
  return new Set(
    (Array.isArray(explainer.nodes) ? explainer.nodes : [])
      .map((node) => node?.id)
      .filter((id): id is string => typeof id === "string"),
  );
}

/** An overlay with a TODO summary, unless the explainer already stores the node (its text stays as it is). */
function overlay(
  stored: ReadonlySet<string>,
  id: string,
  summary: string,
  anchors: readonly (AnchorInput | undefined)[] = [],
): PatchNode | undefined {
  if (stored.has(id)) return undefined;
  const list = anchors.filter((a): a is AnchorInput => a !== undefined);
  return { id, summary, ...(list.length > 0 ? { anchors: list } : {}) };
}

// ─── Anchors ────────────────────────────────────────────────────────────────────────────────────

/** `start..end` without the blank lines at either end (a span on a blank line is probably off by one). */
function trimBlank(
  lines: readonly string[] | undefined,
  start: number,
  end: number,
): [number, number] | undefined {
  if (start > end) return undefined;
  if (!lines) return [start, end];
  const blank = (n: number) => (lines[n - 1] ?? "").trim() === "";
  while (start <= end && blank(start)) start++;
  while (end >= start && blank(end)) end--;
  return start <= end ? [start, end] : undefined;
}

/** Lines `start..end` (1-based) of a symbol: the whole symbol when they cover it, else a span from its first line. */
function symbolLines(
  texts: TextCache,
  sym: IndexedSymbol,
  start: number,
  end: number,
  role: AnchorRole,
): AnchorInput | undefined {
  const lines = trimBlank(
    texts.lines(sym.file),
    Math.max(start, sym.range.startLine),
    Math.min(end, sym.range.endLine),
  );
  if (!lines) return undefined;
  if (lines[0] === sym.range.startLine && lines[1] === sym.range.endLine) {
    return { file: sym.file, symbol: sym.path, role };
  }
  return {
    file: sym.file,
    symbol: sym.path,
    span: { from: lines[0] - sym.range.startLine, to: lines[1] - sym.range.startLine },
    role,
  };
}

/** The first line of a symbol after its decorators (`def handle(...)`, `async send(...)`). */
function signature(texts: TextCache, sym: IndexedSymbol): AnchorInput | undefined {
  const text = texts.lines(sym.file);
  let line = sym.range.startLine;
  while (line < sym.range.endLine && /^\s*(@|$)/.test(text?.[line - 1] ?? "")) line++;
  return symbolLines(texts, sym, line, line, "definition");
}

/** Lines `start..end` of a file, as a span from line 1 (no symbol). */
function fileLines(
  texts: TextCache,
  file: string,
  start: number,
  end: number,
  role: AnchorRole,
): AnchorInput | undefined {
  const text = texts.lines(file);
  const lines = trimBlank(text, Math.max(1, start), Math.min(end, text?.length ?? end));
  if (!lines) return undefined;
  return { file, span: { from: lines[0] - 1, to: lines[1] - 1 }, role };
}

/** Lines of the base version of a changed file (an anchor in the code before the change). */
function baseLines(
  texts: TextCache,
  change: ChangeRecord,
  file: ChangedFile,
  start: number,
  end: number,
  role: AnchorRole,
): AnchorInput | undefined {
  const text = texts.linesAt(change.base, basePathOf(file));
  if (!text) return undefined;
  const lines = trimBlank(text, Math.max(1, start), Math.min(end, text.length));
  if (!lines) return undefined;
  return { file: file.path, at: "base", span: { from: lines[0] - 1, to: lines[1] - 1 }, role };
}

/** The whole symbol (a config key as `config`). */
function definition(sym: IndexedSymbol, role: AnchorRole = "definition"): AnchorInput {
  return {
    file: sym.file,
    symbol: sym.path,
    role: sym.kind === "key" && role === "definition" ? "config" : role,
  };
}

/** The lines of a reference site, as a span of the symbol the reference starts in (or of its file). */
function siteAnchor(
  model: IndexModel,
  texts: TextCache,
  from: string,
  file: string,
  startLine: number,
  endLine: number,
  role: AnchorRole = "call-site",
): AnchorInput | undefined {
  const sym = model.symbol(from);
  return sym
    ? symbolLines(texts, sym, startLine, endLine, role)
    : fileLines(texts, file, startLine, endLine, role);
}

interface Cluster {
  start: number;
  end: number;
  size: number;
}

/** Changed lines grouped into runs; lines at most `gap` apart join one run. */
function clusters(lines: readonly number[], gap = 3): Cluster[] {
  const sorted = [...new Set(lines)].sort((a, b) => a - b);
  const out: Cluster[] = [];
  for (const line of sorted) {
    const last = out.at(-1);
    if (last && line - last.end <= gap + 1) {
      last.end = line;
      last.size++;
    } else out.push({ start: line, end: line, size: 1 });
  }
  return out;
}

/** Head lines a hunk list touches, by run: added or edited lines, and the line after a pure deletion. */
function hunkRuns(file: ChangedFile): Cluster[] {
  const lines: number[] = [];
  for (const hunk of Array.isArray(file.hunks) ? file.hunks : []) {
    if (hunk.newLines > 0) {
      for (let line = hunk.newStart; line < hunk.newStart + hunk.newLines; line++) lines.push(line);
    } else lines.push(Math.max(1, hunk.newStart));
  }
  return clusters(lines);
}

/** Base lines the hunks remove or rewrite, by run. */
function baseRuns(file: ChangedFile): Cluster[] {
  const lines: number[] = [];
  for (const hunk of Array.isArray(file.hunks) ? file.hunks : []) {
    for (let line = hunk.oldStart; line < hunk.oldStart + hunk.oldLines; line++) lines.push(line);
  }
  return clusters(lines);
}

/**
 * One anchor in a changed file: its first changed run that holds text (in a symbol when the run lies in one, else as
 * a span of the file), the whole file when no run does (a pure rename), or, for a deleted file or one the index does
 * not hold, the first run of the lines the change removes, in the code before the change.
 */
function changedFileAnchor(
  model: IndexModel,
  texts: TextCache,
  change: ChangeRecord,
  file: ChangedFile,
  role: AnchorRole,
  runs: readonly Cluster[] = hunkRuns(file),
): AnchorInput | undefined {
  if (file.status !== "deleted" && model.hasFile(file.path)) {
    for (const run of runs) {
      const sym = model.innermostSymbolAt(file.path, run.start);
      const anchor =
        sym && sym.range.endLine >= run.end
          ? symbolLines(texts, sym, run.start, run.end, role)
          : fileLines(texts, file.path, run.start, run.end, role);
      if (anchor) return anchor;
    }
    return { file: file.path, role };
  }
  if (file.status === "added") return undefined;
  for (const run of baseRuns(file)) {
    const anchor = baseLines(texts, change, file, run.start, run.end, role);
    if (anchor) return anchor;
  }
  return undefined;
}

const filesOf = (anchors: readonly (AnchorInput | undefined)[]): string[] =>
  anchors.filter((a): a is AnchorInput => a !== undefined).map((a) => a.file);

function primary(code: readonly AnchorInput[], model: IndexModel): PatchTourStep["editor"] {
  const first = code.find((a) => a.at !== "base" && model.hasFile(a.file));
  return first ? { primary: first.file } : undefined;
}

/** A tour step with at most `DRAFT_LIMITS.codeRanges` code ranges. */
function tourStep(
  model: IndexModel,
  id: string,
  view: string,
  focus: string[],
  noteText: string,
  code: readonly (AnchorInput | undefined)[],
): PatchTourStep {
  const ranges = code
    .filter((a): a is AnchorInput => a !== undefined)
    .slice(0, DRAFT_LIMITS.codeRanges);
  const editor = primary(ranges, model);
  return {
    id,
    view,
    focus,
    note: noteText,
    ...(ranges.length > 0 ? { code: ranges } : {}),
    ...(editor ? { editor } : {}),
  };
}

// ─── Self-check ─────────────────────────────────────────────────────────────────────────────────

/** An element id written in a text (`grp:ky-changes`, `sym:a.py#f`), up to a space, a quote or a bracket. */
const ID_IN_TEXT = /\b(?:sym|file|dir|grp|view|tour|edge|concept):[^\s`'",;()[\]]+/g;
/** Fields of a patch that hold text for a reader (ids in them are written by hand, so nothing checks them). */
const TEXT_FIELDS: ReadonlySet<string> = new Set([
  "label",
  "summary",
  "detail",
  "title",
  "note",
  "question",
]);

/**
 * What `xpl apply` does not catch in a draft, and a reader would trip over: an id named in a text or a note that
 * exists nowhere (not in the draft, the explainer or the index), and a tour step whose focus is not on its view (a
 * map's boxes; a sequence's participants and steps). Empty when the draft is sound.
 */
export function draftProblems(draft: Draft, explainer: Explainer, model: IndexModel): string[] {
  const { patch } = draft;
  const problems: string[] = [];
  const known = new Set<string>(["repo"]);
  const views = new Map<string, PatchView>();
  const addAll = (items: unknown) => {
    for (const item of Array.isArray(items) ? items : []) {
      const id = (item as { id?: unknown } | null)?.id;
      if (typeof id === "string") known.add(id);
    }
  };
  for (const source of [explainer, patch] as const) {
    addAll(source.nodes);
    addAll(source.edges);
    addAll(source.concepts);
    addAll(source.tours);
    addAll(source.views);
    for (const view of (Array.isArray(source.views) ? source.views : []) as PatchView[]) {
      views.set(view.id, view);
      if (view.type !== "graph") addAll(view.steps);
    }
  }
  const exists = (id: string): boolean => {
    if (known.has(id)) return true;
    const parsed = parseId(id);
    if (parsed.type === "file") return model.hasFile(parsed.path);
    if (parsed.type === "dir") return model.hasDirectory(parsed.path);
    if (parsed.type !== "symbol") return false;
    if (model.symbol(symbolIdForElementId(id) ?? "") !== undefined) return true;
    // a test named in words ("sym:test/a.ts#limits the body") ends at the first space in a text
    return model.symbolsInFile(parsed.file).some((s) => s.path.startsWith(`${parsed.path} `));
  };
  // the texts a person reads: summaries, labels, titles, notes, and what the command prints
  const texts: string[] = [...draft.notes];
  const collect = (value: unknown, key = ""): void => {
    if (typeof value === "string") {
      if (TEXT_FIELDS.has(key)) texts.push(value);
    } else if (Array.isArray(value)) for (const item of value) collect(item, key);
    else if (value !== null && typeof value === "object")
      for (const [k, v] of Object.entries(value)) collect(v, k);
  };
  collect(patch);
  const dangling = new Set<string>();
  for (const text of texts) {
    for (const match of text.match(ID_IN_TEXT) ?? []) {
      const id = match.replace(/[.:]+$/, "");
      if (!exists(id)) dangling.add(id);
    }
  }
  for (const id of dangling) problems.push(`${id} is named but exists nowhere`);
  for (const tour of patch.tours ?? []) {
    for (const step of tour.steps ?? []) {
      const view = views.get(step.view);
      if (!view) {
        problems.push(`${tour.id} step ${step.id}: its view ${step.view} does not exist`);
        continue;
      }
      const on = new Set<string>(
        view.type === "graph"
          ? (view.include ?? [])
          : [...(view.participants ?? []), ...(view.steps ?? []).map((s) => s.id)],
      );
      if (view.type === "graph" && view.include === undefined) continue;
      for (const id of step.focus ?? []) {
        if (!on.has(id))
          problems.push(`${tour.id} step ${step.id}: focus ${id} is not on ${view.id}`);
      }
    }
  }
  return problems;
}

// ─── draft change ───────────────────────────────────────────────────────────────────────────────

/** A box of the change map made from changed code: one symbol, a group of small siblings, or a file. */
interface ChangeBox {
  /** `sym:`, `grp:` (small changes to methods of one class) or `file:`. */
  id: string;
  file: string;
  symbols: ChangedSymbol[];
  /** Changed lines in it. */
  lines: number;
  status: "new" | "changed";
}

/** Unchanged code outside tests that calls (or builds) changed code. */
interface Caller {
  id: string;
  file: string;
  /** Where it calls, with the changed symbol it reaches. */
  sites: { line: number; target: ChangedSymbol }[];
  /** It builds the class whose `__call__` / `handle` changed: the analysis says this is a guess. */
  guess: boolean;
  precise: boolean;
}

/** Reference kinds that only name a type or import a name: code with only these does not call anything. */
const TYPE_ONLY: ReadonlySet<Reference["kind"]> = new Set(["type-ref", "import"]);

function callersOf(analysis: ChangeAnalysis): Caller[] {
  const byId = new Map<string, Caller>();
  const add = (entry: CallerEntry, target: ChangedSymbol, guess: boolean) => {
    if (entry.changed || isTestFile(entry.file)) return;
    // a type annotation or an `import type` line uses the name, but runs nothing: not a caller
    if (entry.kinds.every((kind) => TYPE_ONLY.has(kind))) return;
    let caller = byId.get(entry.id);
    if (!caller) {
      caller = { id: entry.id, file: entry.file, sites: [], guess, precise: false };
      byId.set(entry.id, caller);
    }
    caller.guess &&= guess;
    caller.precise ||= entry.resolution === "precise";
    for (const line of entry.lines) caller.sites.push({ line, target });
  };
  for (const sym of analysis.symbols) {
    for (const entry of sym.callers) add(entry, sym, false);
    for (const entry of sym.viaInstance) add(entry, sym, true);
  }
  const targets = (c: Caller) => new Set(c.sites.map((s) => s.target.id)).size;
  const aside = (c: Caller) => Number(matchesAnyGlob(c.file, NOT_DESIGN));
  return [...byId.values()].sort(
    (a, b) =>
      aside(a) - aside(b) ||
      Number(a.guess) - Number(b.guess) ||
      Number(b.precise) - Number(a.precise) ||
      targets(b) - targets(a) ||
      (a.file < b.file ? -1 : a.file > b.file ? 1 : 0) ||
      Math.min(...a.sites.map((s) => s.line)) - Math.min(...b.sites.map((s) => s.line)),
  );
}

/** The full site of a call from `caller` at `line` (the index knows where a multi-line call ends). */
function callerSite(
  model: IndexModel,
  texts: TextCache,
  caller: Caller,
  line: number,
): AnchorInput | undefined {
  const from = symbolIdForElementId(caller.id) ?? `${caller.file}#`;
  const ref = model.refsFrom(from).find((r) => r.site.startLine === line);
  return siteAnchor(model, texts, from, caller.file, line, ref?.site.endLine ?? line);
}

/** The anchors of a box: its changed lines (up to `max` runs), or the whole symbol when it is new. */
function boxAnchors(
  model: IndexModel,
  texts: TextCache,
  box: ChangeBox,
  max: number,
  role: AnchorRole = "definition",
): AnchorInput[] {
  const out: AnchorInput[] = [];
  const runs = box.symbols.flatMap((sym) =>
    clusters(sym.lines).map((run) => ({ run, sym: model.symbol(sym.symbolId) })),
  );
  const chosen = [...runs]
    .sort((a, b) => b.run.size - a.run.size || a.run.start - b.run.start)
    .slice(0, max)
    .sort((a, b) =>
      a.sym && b.sym && a.sym.file !== b.sym.file
        ? a.sym.file < b.sym.file
          ? -1
          : 1
        : a.run.start - b.run.start,
    );
  for (const { run, sym } of chosen) {
    if (!sym) continue;
    const whole =
      box.status === "new" || (run.start <= sym.range.startLine && run.end >= sym.range.endLine);
    const anchor = whole
      ? definition(sym, role)
      : symbolLines(texts, sym, run.start, run.end, role);
    if (anchor) out.push(anchor);
  }
  return out;
}

/** The order to read changed pieces in: from the ones outside code reaches, down the calls between them. */
function callOrder(boxes: readonly ChangeBox[], analysis: ChangeAnalysis): ChangeBox[] {
  const boxOf = new Map<string, ChangeBox>();
  for (const box of boxes) for (const sym of box.symbols) boxOf.set(sym.id, box);
  const callees = new Map<ChangeBox, { box: ChangeBox; line: number }[]>();
  const called = new Set<ChangeBox>();
  for (const sym of analysis.symbols) {
    const target = boxOf.get(sym.id);
    if (!target) continue;
    for (const entry of [...sym.callers, ...sym.viaInstance]) {
      const from = entry.changed ? boxOf.get(entry.id) : undefined;
      if (!from || from === target) continue;
      const list = callees.get(from) ?? [];
      list.push({ box: target, line: Math.min(...entry.lines) });
      callees.set(from, list);
      called.add(target);
    }
  }
  const reached = (box: ChangeBox) =>
    box.symbols.some((s) => [...s.callers, ...s.viaInstance].some((c) => !c.changed));
  const position = (box: ChangeBox) => boxes.indexOf(box);
  // first the pieces outside code reaches, then those that call other pieces, then the biggest
  const roots = boxes
    .filter((box) => !called.has(box))
    .sort(
      (a, b) =>
        Number(reached(b)) - Number(reached(a)) ||
        Number(callees.has(b)) - Number(callees.has(a)) ||
        b.lines - a.lines ||
        position(a) - position(b),
    );
  // depth first: each piece, then the pieces it calls, in the order of the calls
  const out: ChangeBox[] = [];
  const seen = new Set<ChangeBox>();
  const visit = (box: ChangeBox) => {
    if (seen.has(box)) return;
    seen.add(box);
    out.push(box);
    const list = [...(callees.get(box) ?? [])].sort((a, b) => a.line - b.line);
    for (const { box: callee } of list) visit(callee);
  };
  for (const root of roots) visit(root);
  for (const box of boxes) visit(box);
  return out;
}

export function draftChange(input: DraftInput, change: ChangeRecord): Draft {
  const { explainer, model, texts } = input;
  const L = DRAFT_LIMITS;
  const analysis = analyzeChange(change, model, (file) => texts.text(file));
  const ids = new FreeIds(explainer);
  const stored = storedNodeIds(explainer);
  const notes: string[] = [];
  const nodes: PatchNode[] = [];
  const addNode = (node: PatchNode | undefined) => {
    if (node) nodes.push(node);
  };
  const changedFile = new Map(
    (Array.isArray(change.files) ? change.files : []).map((f) => [f.path, f]),
  );

  // ── the tests: one group box ──
  const testFiles = analysis.files.filter((f) => f.test);
  const changedTests = analysis.testSymbols;
  const testMembers: string[] = [];
  const testAnchors: AnchorInput[] = [];
  let testLabel = "Tests of this change";
  let testSummary: string;
  if (changedTests.length > 0 || testFiles.some((f) => f.indexed)) {
    const news = changedTests.filter((t) => t.status === "new").length;
    for (const file of testFiles) {
      const own = changedTests.filter((t) => t.file === file.path);
      if (own.length > 0) {
        testMembers.push(...own.map((t) => t.id));
        for (const t of own.slice(0, 3)) {
          const sym = model.symbol(t.symbolId);
          if (sym) testAnchors.push(definition(sym, "test"));
        }
      } else if (file.indexed) {
        testMembers.push(`file:${file.path}`);
      }
    }
    testSummary =
      `${news > 0 ? "New" : "Changed"}: ` +
      todo(
        `what these tests check (${news} new, ${changedTests.length - news} changed test functions).`,
      );
  } else {
    // no test changed: the tests that use the changed code
    const used = [...new Set(analysis.symbols.flatMap((s) => s.tests.map((t) => t.id)))];
    testMembers.push(...used.slice(0, 8));
    for (const id of used.slice(0, 2)) {
      const sym = model.symbol(symbolIdForElementId(id) ?? "");
      if (sym) testAnchors.push(definition(sym, "test"));
    }
    testLabel = "Tests that use the changed code";
    testSummary = `Unchanged: ${todo("what these tests check, and whether they reach the change.")}`;
  }
  // every changed test file gets an anchor: a changed line, or a removed one for a deleted file
  for (const file of testFiles) {
    if (filesOf(testAnchors).includes(file.path)) continue;
    const record = changedFile.get(file.path);
    const anchor = record ? changedFileAnchor(model, texts, change, record, "test") : undefined;
    if (anchor) testAnchors.push(anchor);
  }
  const hasTestBox = testMembers.length > 0;
  const testGroup = hasTestBox ? ids.get("grp", "change-tests") : undefined;

  // ── the changed code: symbol boxes, files when there are too many ──
  const allCallers = callersOf(analysis);
  const mapCallers = allCallers.filter((c) => !matchesAnyGlob(c.file, NOT_DESIGN));
  const changeSlots = Math.max(
    1,
    L.mapBoxes - (hasTestBox ? 1 : 0) - Math.min(mapCallers.length, 2),
  );
  let boxes: ChangeBox[] = analysis.symbols.map((sym) => ({
    id: sym.id,
    file: sym.file,
    symbols: [sym],
    lines: sym.lines.length,
    status: sym.status,
  }));
  // small changes to methods of one class (a few lines each) share one group box, and one tour step
  const smallSymbol = (box: ChangeBox) =>
    box.symbols.length === 1 &&
    box.status === "changed" &&
    box.lines <= L.smallLines &&
    (box.symbols[0]!.kind === "method" || box.symbols[0]!.kind === "function");
  const siblings = new Map<string, ChangeBox[]>();
  for (const box of boxes) {
    const parent = smallSymbol(box) ? model.parentSymbol(box.symbols[0]!.symbolId) : undefined;
    if (parent && OWNER_KINDS.has(parent.kind)) {
      siblings.set(parent.id, [...(siblings.get(parent.id) ?? []), box]);
    }
  }
  for (const [parentId, group] of siblings) {
    if (group.length < 2) continue;
    const parent = model.symbol(parentId)!;
    const merged: ChangeBox = {
      id: ids.get("grp", `${pathSlug(parent.path)}-changes`),
      file: parent.file,
      symbols: group.flatMap((b) => b.symbols),
      lines: group.reduce((sum, b) => sum + b.lines, 0),
      status: "changed",
    };
    const at = boxes.indexOf(group[0]!);
    boxes = boxes.filter((b) => !group.includes(b));
    boxes.splice(at, 0, merged);
  }
  // too many boxes: the file with the most changed pieces becomes one box (its group boxes too)
  const piece = (box: ChangeBox) => box.id.startsWith("sym:") || box.id.startsWith("grp:");
  while (boxes.length > changeSlots) {
    const counts = new Map<string, number>();
    for (const box of boxes) {
      if (piece(box)) counts.set(box.file, (counts.get(box.file) ?? 0) + 1);
    }
    const [file, count] = [...counts].sort((a, b) => b[1] - a[1])[0] ?? ["", 0];
    if (count < 2) break;
    const inFile = boxes.filter((b) => b.file === file && piece(b));
    const added = analysis.files.find((f) => f.path === file)?.status === "added";
    const merged: ChangeBox = {
      id: `file:${file}`,
      file,
      symbols: inFile.flatMap((b) => b.symbols),
      lines: inFile.reduce((sum, b) => sum + b.lines, 0),
      status: added ? "new" : "changed",
    };
    const at = boxes.indexOf(inFile[0]!);
    boxes = boxes.filter((b) => !inFile.includes(b));
    boxes.splice(at, 0, merged);
  }
  // a group box left off the map is never written: name its members
  const pieceIds = (box: ChangeBox) =>
    box.id.startsWith("grp:") ? box.symbols.map((sym) => sym.id) : [box.id];
  let offMap: ChangeBox[] = [];
  if (boxes.length > changeSlots) {
    const keep = new Set([...boxes].sort((a, b) => b.lines - a.lines).slice(0, changeSlots));
    offMap = boxes.filter((b) => !keep.has(b));
    boxes = boxes.filter((b) => keep.has(b));
    notes.push(
      `${offMap.length} changed ${offMap.length === 1 ? "piece is" : "pieces are"} left off the map (at most ${L.mapBoxes} boxes): ${offMap.flatMap(pieceIds).join(", ")}`,
    );
  }

  // ── the callers on the map (not the ones inside a file box: the box shows them) ──
  const fileBoxes = new Set(boxes.filter((b) => b.id.startsWith("file:")).map((b) => b.file));
  const shownCallers = mapCallers.filter((c) => !fileBoxes.has(c.file));
  const callerSlots = Math.max(
    0,
    Math.min(L.callerBoxes, L.mapBoxes - boxes.length - (hasTestBox ? 1 : 0)),
  );
  const changedFiles = new Set(boxes.map((b) => b.file));
  let callerUnits = shownCallers.map((c) => ({ id: c.id, callers: [c] }));
  if (callerUnits.length > callerSlots) {
    // callers in one file share a box (unless changed code lives in that file too)
    const units: { id: string; callers: Caller[] }[] = [];
    for (const caller of shownCallers) {
      const shared = !changedFiles.has(caller.file) && caller.id.startsWith("sym:");
      const key = shared ? `file:${caller.file}` : caller.id;
      const unit = units.find((u) => u.id === key || u.callers[0]!.file === caller.file);
      if (unit && shared) {
        unit.callers.push(caller);
        unit.id = `file:${caller.file}`;
      } else units.push({ id: caller.id, callers: [caller] });
    }
    callerUnits = units;
  }
  callerUnits = callerUnits.slice(0, callerSlots);
  const unitOf = (caller: Caller) => callerUnits.find((u) => u.callers.includes(caller));
  if (allCallers.length > 0 && callerUnits.length < allCallers.length) {
    const off = allCallers.filter((c) => !unitOf(c)).map((c) => c.id);
    if (off.length > 0) notes.push(`callers left off the map: ${off.join(", ")}`);
  }
  if (allCallers.some((c) => c.guess)) {
    notes.push(
      "callers marked as a guess build the class whose call method changed; the index cannot see that call: check them",
    );
  }

  if (boxes.length === 0 && !hasTestBox && callerUnits.length === 0) {
    throw new Error(
      "the change touches no indexed code outside tests and no tests: there is nothing to put on a map",
    );
  }

  // ── the view ──
  const mapId = ids.get("view", "change-map");
  const include = [
    ...new Set([
      ...boxes.map((b) => b.id),
      ...callerUnits.map((u) => u.id),
      ...(testGroup ? [testGroup] : []),
    ]),
  ];
  const view: PatchView = {
    id: mapId,
    type: "graph",
    title: "What this change touches",
    scope: { root: "repo", depth: 1 },
    include,
    stubs: { mode: "none" },
  };

  // ── overlays ──
  for (const box of boxes) {
    const tag = box.status === "new" ? "New" : "Changed";
    if (box.id.startsWith("grp:")) {
      const names = box.symbols.map((s) => displayName(s.id));
      nodes.push({
        id: box.id,
        label: todo(`a name for these ${box.symbols.length} methods`),
        summary: `${tag}: ${todo(`what changes in ${nameList(names, 4)}, in one sentence.`)}`,
        members: box.symbols.map((s) => s.id),
        anchors: boxAnchors(model, texts, box, 3),
      });
      continue;
    }
    const summary =
      box.symbols.length === 1
        ? `${tag}: ${todo(box.status === "new" ? "what it does, in one sentence." : "what it does now, in one sentence.")}`
        : `${tag}: ${todo(
            `what changes in this file (${box.symbols.length} changed symbols: ${nameList(
              box.symbols.map((s) => displayName(s.id)),
              4,
            )}).`,
          )}`;
    addNode(overlay(stored, box.id, summary, boxAnchors(model, texts, box, 3)));
  }
  for (const unit of callerUnits) {
    const targets = [
      ...new Set(unit.callers.flatMap((c) => c.sites.map((s) => displayName(s.target.id)))),
    ];
    const guess = unit.callers.every((c) => c.guess);
    const summary =
      `Unchanged: ${todo("how this code reaches the change.")} ` +
      (guess
        ? `The index shows that it builds the class of ${nameList(targets, 3)}, a guess.`
        : `The index shows that it calls ${nameList(targets, 3)}.`);
    const sites = unit.callers
      .flatMap((c) => c.sites.slice(0, 1).map((s) => callerSite(model, texts, c, s.line)))
      .slice(0, 2);
    addNode(overlay(stored, unit.id, summary, sites));
  }
  if (testGroup) {
    nodes.push({
      id: testGroup,
      label: testLabel,
      summary: testSummary!,
      members: testMembers,
      ...(testAnchors.length > 0 ? { anchors: testAnchors } : {}),
    });
  }

  // ── the tour, in review order ──
  const mainBox =
    [...boxes].sort((a, b) => b.lines - a.lines || boxes.indexOf(a) - boxes.indexOf(b))[0] ??
    undefined;
  const mainFocus = mainBox?.id ?? callerUnits[0]?.id ?? testGroup!;
  // pieces: the changed boxes in call order; small siblings share a step
  const ordered = callOrder(boxes, analysis);
  // where the change enters: the code outside that calls the first piece (else the biggest one, else any)
  const callsInto = (box: ChangeBox | undefined) =>
    box
      ? callerUnits.find((u) =>
          u.callers.some((c) => c.sites.some((s) => box.symbols.includes(s.target))),
        )
      : undefined;
  const entryUnit = callsInto(ordered[0]) ?? callsInto(mainBox) ?? callerUnits[0];
  const otherCallers = allCallers.filter((c) => !entryUnit?.callers.includes(c));
  // no caller outside tests (a framework, a library or a variable calls it): the changed public function or
  // method closest to callers, else the first changed symbol (the boxes hold no tests)
  const callable = (sym: ChangedSymbol) => sym.kind === "method" || sym.kind === "function";
  const isPublic = (sym: ChangedSymbol) =>
    !/^[_#]/.test(displayName(sym.id).split(".").at(-1) ?? "");
  const entrySymbol = entryUnit
    ? undefined
    : (ordered.flatMap((b) => b.symbols).find((sym) => callable(sym) && isPublic(sym)) ??
      ordered[0]?.symbols[0]);
  const entryBox = entrySymbol && ordered.find((b) => b.symbols.includes(entrySymbol));

  const small = (box: ChangeBox) =>
    box.symbols.length === 1 &&
    box.lines <= L.smallLines &&
    (box.status === "changed" || ["variable", "key"].includes(box.symbols[0]!.kind)) &&
    ["method", "function", "variable", "key"].includes(box.symbols[0]!.kind);
  const parentOf = (box: ChangeBox) => model.parentSymbol(box.symbols[0]!.symbolId)?.id ?? "";
  let pieces: ChangeBox[][] = [];
  for (const box of ordered) {
    const run = pieces.at(-1);
    const last = run?.at(-1);
    if (
      run &&
      last &&
      run.length < L.mergeSmall &&
      small(last) &&
      small(box) &&
      last.file === box.file &&
      parentOf(last) === parentOf(box)
    ) {
      run.push(box);
    } else pieces.push([box]);
  }

  // leftovers: changed files that no box or test anchor covers yet (module-level changes, deleted files, ...)
  const covered = new Set<string>([
    ...nodes.flatMap((n) => filesOf(n.anchors ?? [])),
    ...filesOf(testAnchors),
  ]);
  const leftovers: { path: string; anchor: AnchorInput }[] = [];
  const unanchored: string[] = [];
  for (const file of analysis.files) {
    if (file.test || covered.has(file.path)) continue;
    const record = changedFile.get(file.path);
    if (!record) continue;
    const runs = file.outside.length > 0 ? clusters(file.outside) : hunkRuns(record);
    const anchor = changedFileAnchor(model, texts, change, record, "usage", runs);
    if (anchor) leftovers.push({ path: file.path, anchor });
    else unanchored.push(file.path);
  }
  if (unanchored.length > 0) {
    notes.push(
      `no anchor for ${unanchored.join(", ")} (an added file the index does not hold, such as a binary file)`,
    );
  }
  const otherSteps = Math.min(2, Math.ceil(leftovers.length / L.codeRanges));

  const fixed =
    1 + (entryUnit || entryBox ? 1 : 0) + (otherCallers.length > 0 ? 1 : 0) + 1 + 1 + otherSteps;
  const pieceBudget = Math.max(0, L.changeSteps - fixed);
  const skipped: ChangeBox[] = [];
  while (pieces.length > pieceBudget) {
    const size = (run: ChangeBox[]) => run.reduce((sum, b) => sum + b.lines, 0);
    const smallest = [...pieces].sort((a, b) => size(a) - size(b))[0]!;
    skipped.push(...smallest);
    pieces = pieces.filter((run) => run !== smallest);
  }
  if (skipped.length > 0) {
    notes.push(
      `no tour step of its own (at most ${L.changeSteps} steps): ${skipped.map((b) => b.id).join(", ")}`,
    );
  }

  const steps: PatchTourStep[] = [];
  // t10, t20, ...: a step inserted later takes a free number between its neighbours (t15)
  const next = () => `t${(steps.length + 1) * 10}`;

  // 1. what changes for users
  const topRuns = boxes
    .flatMap((box) =>
      box.symbols.flatMap((sym) =>
        clusters(sym.lines).map((run) => ({ box: { ...box, symbols: [sym] }, run })),
      ),
    )
    .sort((a, b) => b.run.size - a.run.size)
    .slice(0, L.codeRanges);
  const firstCode = topRuns.flatMap(({ box, run }) => {
    const sym = model.symbol(box.symbols[0]!.symbolId);
    if (!sym) return [];
    const whole = box.status === "new";
    return [whole ? definition(sym) : symbolLines(texts, sym, run.start, run.end, "definition")];
  });
  const alsoChanged = [...offMap, ...skipped].flatMap(pieceIds).map(displayName);
  steps.push(
    tourStep(
      model,
      next(),
      mapId,
      [mainFocus],
      note(
        todo("what changes for users, as a plain statement"),
        todo(
          "the behaviour change: before, a user saw one thing; now, another. Give an input that shows it.",
        ),
        alsoChanged.length > 0
          ? `Also changed: ${nameList(alsoChanged)}. ${todo("say what they change, or why the tour skips them.")}`
          : "",
      ),
      firstCode.length > 0 ? firstCode : leftovers.slice(0, 1).map((l) => l.anchor),
    ),
  );

  // 2. where the change enters
  if (entryUnit) {
    const reach = entryUnit.callers.flatMap((c) => c.sites.map((s) => displayName(s.target.id)));
    const guess = entryUnit.callers.every((c) => c.guess);
    steps.push(
      tourStep(
        model,
        next(),
        mapId,
        [entryUnit.id],
        note(
          todo("where the change enters, as a plain statement"),
          todo(
            `how a request or a call from outside reaches ${nameList(reach, 3)} through this code.`,
          ),
          guess
            ? `The index shows that ${tick(displayName(entryUnit.id))} builds the class, a guess: ${todo("check that the changed method runs from here.")}`
            : "",
        ),
        entryUnit.callers.flatMap((c) =>
          c.sites.slice(0, 1).map((s) => callerSite(model, texts, c, s.line)),
        ),
      ),
    );
  } else if (entrySymbol && entryBox) {
    const sym = model.symbol(entrySymbol.symbolId);
    steps.push(
      tourStep(
        model,
        next(),
        mapId,
        [entryBox.id],
        note(
          todo("where the change enters, as a plain statement"),
          `The index shows no caller of ${tick(displayName(entrySymbol.id))} outside tests.`,
          todo(
            "who calls it. Search for its name, or for the line that hands it to a framework or a library. Anchor that line.",
          ),
        ),
        [sym ? signature(texts, sym) : undefined],
      ),
    );
  }

  // 3+. one step per changed piece
  for (const run of pieces) {
    const first = run[0]!;
    const names = run.flatMap((b) => b.symbols.map((s) => displayName(s.id)));
    const fresh = run.every((b) => b.status === "new");
    const code =
      run.length === 1
        ? boxAnchors(model, texts, first, L.codeRanges)
        : run.slice(0, L.codeRanges).flatMap((b) => boxAnchors(model, texts, b, 1));
    steps.push(
      tourStep(
        model,
        next(),
        mapId,
        [first.id],
        note(
          todo(
            fresh
              ? "what the new code does, as a plain statement"
              : "what this piece does differently, as a plain statement",
          ),
          fresh
            ? todo(`what ${tick(names[0]!)} adds, and which code uses it.`)
            : todo(
                "Before: what the old code did (read it with `xpl show --at base`). Now: what the new code does.",
              ),
          names.length > 1 && !fresh
            ? `${nameList(names)} change in a few lines each: ${todo("say what they have in common, or give each its own step.")}`
            : "",
        ),
        code,
      ),
    );
  }

  // the other changed files (module-level code, files left off the map, deleted files)
  const inSteps = leftovers.slice(0, otherSteps * L.codeRanges);
  for (let i = 0; i < otherSteps; i++) {
    const chunk = inSteps.slice(i * L.codeRanges, (i + 1) * L.codeRanges);
    if (chunk.length === 0) break;
    const firstPath = chunk[0]!.path;
    steps.push(
      tourStep(
        model,
        next(),
        mapId,
        // a step focuses a box of its map: the file when it is one, else the main box
        [include.includes(`file:${firstPath}`) ? `file:${firstPath}` : mainFocus],
        note(
          todo("what the other changed files do, as a plain statement"),
          `Changed outside the boxes of the map: ${nameList(chunk.map((c) => baseName(c.path)))}.`,
          todo("say whether each one matters to a reader of this change."),
        ),
        chunk.map((c) => c.anchor),
      ),
    );
  }
  // leftovers beyond the steps: anchored on an overlay of their file (or, deleted, on the main box)
  for (const rest of leftovers.slice(inSteps.length)) {
    const id = `file:${rest.path}`;
    const host = model.hasFile(rest.path) ? id : mainFocus;
    const existing = nodes.find((n) => n.id === host);
    if (existing) existing.anchors = [...(existing.anchors ?? []), rest.anchor];
    else if (!stored.has(host)) {
      nodes.push({
        id: host,
        summary: `Changed: ${todo("what changes in this file.")}`,
        anchors: [rest.anchor],
      });
    } else
      notes.push(
        `no anchor for ${rest.path}: ${host} is already explained, so the draft leaves it alone`,
      );
  }

  // who else is affected
  if (otherCallers.length > 0) {
    const onMap = otherCallers.map((c) => unitOf(c)).find((u) => u !== undefined);
    const names = otherCallers.map((c) => {
      const unit = unitOf(c);
      return displayName(unit ? unit.id : c.id);
    });
    const guesses = otherCallers.filter((c) => c.guess).map((c) => displayName(c.id));
    steps.push(
      tourStep(
        model,
        next(),
        mapId,
        [onMap?.id ?? mainFocus],
        note(
          todo("who else is affected, as a plain statement"),
          `Callers outside tests: ${nameList(names)}.`,
          todo(
            "what each one does with the changed code; anchor the ones that now behave differently.",
          ),
          guesses.length > 0
            ? `${nameList(guesses, 3)} build the class, a guess: ${todo("check them.")}`
            : "",
        ),
        otherCallers
          .slice(0, L.codeRanges)
          .map((c) => callerSite(model, texts, c, c.sites[0]!.line)),
      ),
    );
  }

  // tests and gaps
  const untested = analysis.untested.map(displayName);
  steps.push(
    tourStep(
      model,
      next(),
      mapId,
      [testGroup ?? mainFocus],
      note(
        todo("what the tests cover, as a plain statement"),
        todo("which test checks each behavior change, and whether the new branches are tested."),
        untested.length > 0
          ? `No indexed test reference found for ${nameList(untested)}: ${todo("check whether tests of other code exercise these symbols.")}`
          : "",
      ),
      testAnchors.length > 0
        ? testAnchors
        : analysis.symbols.slice(0, L.codeRanges).map((s) => {
            const sym = model.symbol(s.symbolId);
            return sym ? definition(sym) : undefined;
          }),
    ),
  );

  // risks and open questions
  const mainSym = mainBox ? model.symbol(mainBox.symbols[0]!.symbolId) : undefined;
  const entryCaller = entryUnit?.callers[0];
  steps.push(
    tourStep(
      model,
      next(),
      mapId,
      [mainFocus],
      note(
        todo("the worst realistic failure, as a plain statement"),
        todo("the input that triggers it, checked against the code."),
        todo("edge cases, inputs that still behave the old way, and open questions."),
      ),
      [
        mainSym ? definition(mainSym) : undefined,
        entryCaller ? callerSite(model, texts, entryCaller, entryCaller.sites[0]!.line) : undefined,
      ],
    ),
  );

  const tourId = ids.get("tour", "change");
  const newTests = changedTests.filter((t) => t.status === "new").length;
  const patch: ExplainerPatch = {
    nodes,
    views: [view],
    tours: [
      {
        id: tourId,
        title: todo(
          "the change in about 8 plain words, for example: config rejects invalid retry delays",
        ),
        summary: [
          todo("what changes for users, in one or two sentences."),
          todo("the worst realistic risk, with the input that triggers it."),
          todo(
            `what the tests cover (${newTests} new test functions` +
              (untested.length > 0
                ? `; no indexed test reference found for ${plural(untested.length, "changed symbol")}).`
                : ")."),
          ),
        ].join(" "),
        steps,
      },
    ],
  };
  return { kind: "change", patch, notes };
}

// ─── draft repo ─────────────────────────────────────────────────────────────────────────────────

interface Unit {
  id: string;
  path: string;
  dir: boolean;
  /** Code files in it (not tests, docs, examples or benchmarks). */
  files: string[];
}

/**
 * Where the project says what it is: the first paragraph of prose in the README (after the logo, badges and links),
 * else the description in the package metadata, else the metadata file.
 */
function aboutAnchor(model: IndexModel, texts: TextCache): AnchorInput | undefined {
  const rootFiles = model.dirChildren("").files;
  const readme = rootFiles.find((f) => /^readme(?:\.[a-z]+)?$/i.test(f));
  const lines = readme ? texts.lines(readme) : undefined;
  if (readme && lines) {
    const prose = (line: string) => {
      const text = line.trim();
      return (
        /[A-Za-z]{3,}.*\s.*[A-Za-z]{3,}/.test(text) &&
        !/^(?:<|!\[|\[!\[|\||-{3,}|={3,}|```|\*\*[A-Z][\w ]*\*\*:)/.test(text)
      );
    };
    const first = lines.findIndex(prose);
    if (first !== -1) {
      let end = first;
      while (end + 1 < lines.length && lines[end + 1]!.trim() !== "" && end - first < 7) end++;
      const heading = first > 0 && /^#{1,3}\s/.test(lines[first - 1]!.trim()) ? first - 1 : -1;
      const start = heading !== -1 ? heading : first;
      return { file: readme, span: { from: start, to: end }, role: "usage" };
    }
  }
  for (const [file, key] of [
    ["pyproject.toml", "project.description"],
    ["package.json", "description"],
    ["Cargo.toml", "package.description"],
  ] as const) {
    if (model.symbolAt(file, key)) return { file, symbol: key, role: "config" };
  }
  const metadata = rootFiles.find((f) =>
    ["package.json", "pyproject.toml", "go.mod", "Cargo.toml"].includes(f),
  );
  if (metadata) return { file: metadata, role: "config" };
  return readme ? fileLines(texts, readme, 1, DRAFT_LIMITS.readmeLines, "usage") : undefined;
}

/** Folders whose sub-folders are separate programs (`services/orders`, `apps/web`, `cmd/server`). */
const SERVICE_PARENTS = /^(?:services|apps|cmd|svc|microservices)$/;

/** A plain slug from a path or a name (`services/order-api` -> `order-api`). */
function slugOf(text: string): string {
  const slug = baseName(text)
    .replace(/\.[^.]+$/, "")
    .replace(/([a-z0-9])([A-Z])/g, "$1-$2")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (slug === "") return "part";
  return RESERVED_PREFIXES.includes(slug) ? `${slug}-part` : slug;
}

/** One map of the inside of a service: its parts, and the parts that were left off. */
interface Inside {
  /** The service box on the system map: a `grp:` (the whole repo is one service) or a `dir:` (one of several). */
  service: string;
  /** Where the service's code lives ("" for the whole repo). */
  root: string;
  units: Unit[];
  offMap: Unit[];
  viewId: string;
}

export function draftRepo(input: DraftInput): Draft {
  const { explainer, model, texts } = input;
  const L = DRAFT_LIMITS;
  const ids = new FreeIds(explainer);
  const stored = storedNodeIds(explainer);
  const notes: string[] = [
    "Provisional architecture: confirm project kind, primary users and entry points in the README and code; import lines identify dependencies.",
  ];
  /** A box of the architecture keeps its id across drafts: the service and the outside systems are the same things. */
  const reuse = (prefix: string, slug: string): string =>
    stored.has(`${prefix}:${slug}`) ? `${prefix}:${slug}` : ids.get(prefix, slug);

  const outside = (path: string) =>
    isTestFile(path) ||
    matchesAnyGlob(path, OVERVIEW_EXCLUDE) ||
    matchesAnyGlob(path, NOT_DESIGN) ||
    path.split("/").some((segment) => segment.startsWith("."));
  const isCode = (path: string) =>
    CODE_LANGUAGES.has(model.file(path)?.language ?? "") && !outside(path);
  const codeUnder = (dir: string) => model.filesUnder(dir).filter(isCode);

  const children = (dir: string): Unit[] => {
    const { dirs, files } = model.dirChildren(dir);
    const out: Unit[] = [];
    for (const start of dirs) {
      if (codeUnder(start).length === 0) continue;
      // a folder that holds one folder and no code of its own is that folder (cmd -> cmd/jobrunner)
      let path = start;
      for (let hops = 0; hops < 32; hops++) {
        const inner = model.dirChildren(path);
        const codeDirs = inner.dirs.filter((d) => codeUnder(d).length > 0);
        if (inner.files.some(isCode) || codeDirs.length !== 1) break;
        path = codeDirs[0]!;
      }
      out.push({ id: `dir:${path}`, path, dir: true, files: codeUnder(path) });
    }
    for (const file of files) {
      // a file of imports and constants only (a package's `__init__.py`) is not a part of its own
      const body = model
        .topLevelSymbols(file)
        .some((s) => s.kind !== "variable" && s.kind !== "key" && s.kind !== "other");
      if (isCode(file) && body) {
        out.push({ id: `file:${file}`, path: file, dir: false, files: [file] });
      }
    }
    return out;
  };

  // references between code files, for ranking
  const fileOf = (id: string) => model.fileOfSymbolId(id);
  const fileLinks = new Map<string, number>();
  const fileBetween = new Map<string, number>();
  const symbolIn = new Map<string, number>();
  for (const ref of model.refs) {
    const from = fileOf(ref.from);
    const to = fileOf(ref.to);
    if (!from || !to || from === to || outside(from) || outside(to)) continue;
    fileLinks.set(from, (fileLinks.get(from) ?? 0) + 1);
    fileLinks.set(to, (fileLinks.get(to) ?? 0) + 1);
    fileBetween.set(`${from}\0${to}`, (fileBetween.get(`${from}\0${to}`) ?? 0) + 1);
    // fan-in of top-level symbols from other files
    let sym = model.symbol(ref.to);
    while (sym && model.parentSymbol(sym.id)) sym = model.parentSymbol(sym.id);
    if (sym) symbolIn.set(sym.id, (symbolIn.get(sym.id) ?? 0) + 1);
  }
  const links = (u: Unit) => u.files.reduce((n, f) => n + (fileLinks.get(f) ?? 0), 0);
  const between = (a: Unit, b: Unit) => {
    let n = 0;
    for (const from of a.files)
      for (const to of b.files) n += fileBetween.get(`${from}\0${to}`) ?? 0;
    return n;
  };

  // the package folders of a monorepo (`packages/*`): one box per package, not one for them all
  const workspaces = new Set(workspaceParents(texts));

  /** The parts of the code under `root`: 4-8 boxes, and what did not fit on the map. */
  const partsOf = (root: string): { units: Unit[]; offMap: Unit[] } => {
    let units = children(root);
    if (root === "" && units.some((u) => u.dir && workspaces.has(u.path))) {
      units = units.flatMap((u) => (u.dir && workspaces.has(u.path) ? children(u.path) : [u]));
    }
    // one folder for the whole tree (src, the package): start below it
    for (let hops = 0; hops < 8 && units.length === 1 && units[0]!.dir; hops++) {
      units = children(units[0]!.path);
    }
    // too few boxes: open the biggest folder, while the map stays at most 8 boxes
    for (let hops = 0; hops < 8 && units.length < 4; hops++) {
      const biggest = units.filter((u) => u.dir).sort((a, b) => b.files.length - a.files.length)[0];
      if (!biggest) break;
      const inner = children(biggest.path);
      if (inner.length <= 1 || units.length - 1 + inner.length > L.mapBoxes) break;
      units = units.flatMap((u) => (u === biggest ? inner : [u]));
    }
    // one folder with most of the code (sympy/ next to bin/, release/ and setup.py): its parts are the map,
    // the eight that are linked the most, whatever else is around it
    for (let hops = 0; hops < 8; hops++) {
      const total = units.reduce((n, u) => n + u.files.length, 0);
      const biggest = units.filter((u) => u.dir).sort((a, b) => b.files.length - a.files.length)[0];
      if (!biggest || biggest.files.length * 4 < total * 3) break;
      const inner = children(biggest.path);
      if (inner.length <= 1) break;
      units = units.flatMap((u) => (u === biggest ? inner : [u]));
    }
    let offMap: Unit[] = [];
    if (units.length > L.mapBoxes) {
      const ranked = [...units].sort(
        (a, b) =>
          Number(b.dir) - Number(a.dir) || links(b) - links(a) || a.path.localeCompare(b.path),
      );
      const keep = new Set(ranked.slice(0, L.mapBoxes));
      offMap = units.filter((u) => !keep.has(u));
      units = units.filter((u) => keep.has(u));
    }
    return { units, offMap };
  };

  // ── Level 1: the services. Several programs in `services/`, `apps/` or `cmd/` are one box each; otherwise the
  // whole repo is one service.
  const serviceRoots: string[] = [];
  for (const parent of ["", "src"]) {
    if (parent !== "" && !model.hasDirectory(parent)) continue;
    for (const dir of model.dirChildren(parent).dirs) {
      if (!SERVICE_PARENTS.test(baseName(dir))) continue;
      for (const service of model.dirChildren(dir).dirs) {
        if (codeUnder(service).length > 0) serviceRoots.push(service);
      }
    }
  }
  // Programs that hold less than half of the code are the tools of a library (Go's `cmd/` next to the packages
  // they use: hcl, prometheus): the repository stays one service, and its programs are one of its parts.
  const inServices = serviceRoots.reduce((n, root) => n + codeUnder(root).length, 0);
  const total = codeUnder("").length;
  const multi = serviceRoots.length >= 2 && inServices * 2 >= total;
  if (serviceRoots.length >= 2 && !multi) {
    notes.push(
      `${serviceRoots.length} programs under ${nameList([...new Set(serviceRoots.map(dirOf))])} hold ${inServices} of ${total} code files: drafted as one project whose parts include them, not as separate services`,
    );
  }
  const repoName = explainer.repo?.name ?? "the project";

  const insides: Inside[] = [];
  if (multi) {
    for (const root of serviceRoots.sort()) {
      const { units, offMap } = partsOf(root);
      if (units.length === 0) continue;
      insides.push({
        service: `dir:${root}`,
        root,
        units,
        offMap,
        viewId: ids.get("view", `${slugOf(root)}-inside`),
      });
    }
    notes.push(
      `${insides.length} services found under ${nameList([...new Set(serviceRoots.map(dirOf))])}: one box each on the system map, and one map of the inside of each`,
    );
  } else {
    const { units, offMap } = partsOf("");
    if (units.length > 0) {
      insides.push({
        service: reuse("grp", slugOf(repoName)),
        root: "",
        units,
        offMap,
        viewId: ids.get("view", "overview"),
      });
    }
  }
  if (insides.length === 0) {
    const javaFiles =
      total === 0
        ? model.files.filter(
            (file) =>
              file.language === "text" &&
              file.path.toLowerCase().endsWith(".java") &&
              !outside(file.path),
          )
        : [];
    if (javaFiles.length > 0) {
      const file = javaFiles[0]!.path;
      const count = javaFiles.length;
      throw new Error(
        `the index has no supported code files outside tests, docs, examples and benchmarks; ` +
          `it contains ${count} eligible Java source file${count === 1 ? "" : "s"} (.java), indexed as text, ` +
          `so repository drafting cannot infer Java symbols or import structure. Inspect one with ` +
          `\`xpl show file:${file}\`. Importing Java SCIP data alone does not enable Java repository levels.`,
      );
    }
    throw new Error(
      "the index has no code files outside tests, docs, examples and benchmarks: there is nothing to put on an overview",
    );
  }
  for (const inside of insides) {
    if (inside.offMap.length > 0) {
      notes.push(
        `${inside.offMap.length} files or folders of ${inside.root || repoName} are left off its map (at most ${L.mapBoxes} boxes); its first step asks to group them`,
      );
    }
  }

  // ── What the code talks to outside itself, from its import lines.
  const systems = findOutsideSystems(model, texts, isCode, Number.MAX_SAFE_INTEGER);
  const systemIds = new Map(systems.map((s) => [s.slug, reuse("grp", s.slug)]));
  const unitOfFile = new Map<string, Unit>();
  for (const inside of insides)
    for (const unit of inside.units) for (const f of unit.files) unitOfFile.set(f, unit);
  const insideOfUnit = new Map<Unit, Inside>();
  for (const inside of insides) for (const unit of inside.units) insideOfUnit.set(unit, inside);
  /** Per system: the first import site in each part that imports it (the evidence of its arrows). */
  const reach = new Map<string, { unit: Unit; anchor: AnchorInput }[]>();
  for (const system of systems) {
    const seen = new Set<Unit>();
    const list: { unit: Unit; anchor: AnchorInput }[] = [];
    for (const site of system.sites) {
      const unit = unitOfFile.get(site.file);
      if (!unit || seen.has(unit)) continue;
      const anchor = fileLines(texts, site.file, site.line, site.line, "usage");
      if (!anchor) continue;
      seen.add(unit);
      list.push({ unit, anchor });
    }
    if (list.length > 0) reach.set(system.slug, list);
  }
  const linked = systems.filter((s) => reach.has(s.slug));
  const inbound = linked.filter((s) => s.inbound);
  const outbound = linked.filter((s) => !s.inbound);
  if (systems.length > linked.length) {
    notes.push(
      `${systems.length - linked.length} outside systems are only imported from files left off the maps: ${plainList(
        systems.filter((s) => !reach.has(s.slug)).map((s) => s.label),
      )}`,
    );
  }
  if (linked.length > 0) {
    notes.push(
      `outside systems found from the import lines (hints: check each in the code): ${plainList(
        linked.map((s) => `${s.label} (${s.tech})`),
        10,
      )}`,
    );
  }

  const nodes: PatchNode[] = [];
  const edges: PatchEdge[] = [];
  const views: PatchView[] = [];
  const library =
    !multi &&
    (declaredLibrary(model, texts) ||
      (inbound.length === 0 &&
        isLibrary(model, texts, model.files.map((file) => file.path).filter(isCode))));

  // the boxes of the outside systems: no members, anchored at the import lines that use them
  for (const system of linked) {
    const id = systemIds.get(system.slug)!;
    // a box an earlier draft made keeps its text and its arrows
    if (stored.has(id)) continue;
    nodes.push({
      id,
      label: system.label,
      role: system.role,
      tech: system.tech,
      parent: "repo",
      summary: system.inbound
        ? todo(
            `one line: who uses the project this way (found: ${system.sites.map((s) => s.module)[0]}), in plain words.`,
          )
        : todo(
            `one plain line: what the project keeps in it or asks of it. Name the real system if the code says (found: ${[...new Set(system.sites.map((s) => s.module))].slice(0, 3).join(", ")}).`,
          ),
      anchors: reach.get(system.slug)!.map((r) => r.anchor),
    });
    for (const { unit, anchor } of reach.get(system.slug)!) {
      edges.push({
        id: ids.get("edge", `${slugOf(unit.path)}-${system.slug}`),
        from: system.inbound ? id : unit.id,
        to: system.inbound ? unit.id : id,
        kind: "custom",
        label: todo(
          system.inbound
            ? "1-4 words: what they do with it (for example: sends requests)"
            : "1-4 words: what passes here (for example: stores orders)",
        ),
        anchors: [anchor],
      });
    }
  }

  const languageOf = (files: readonly string[]): string | undefined => {
    const count = new Map<string, number>();
    for (const f of files) {
      const language = model.file(f)?.language;
      const name = language ? CODE_LANGUAGE_NAMES[language] : undefined;
      if (name) count.set(name, (count.get(name) ?? 0) + 1);
    }
    return [...count].sort((a, b) => b[1] - a[1])[0]?.[0];
  };

  // ── The services, and the inside of each: the parts and the outside systems they use.
  for (const inside of insides) {
    const allFiles = inside.units.flatMap((u) => u.files);
    const language = languageOf(allFiles);
    const service: PatchNode = multi
      ? {
          id: inside.service,
          role: "service",
          opens: inside.viewId,
          ...(language ? { tech: language } : {}),
          summary: todo("one line: what this service does, for whom, in plain words."),
        }
      : {
          id: inside.service,
          label: repoName,
          role: library ? "component" : "service",
          opens: inside.viewId,
          ...(language ? { tech: language } : {}),
          parent: "repo",
          members: inside.units.map((u) => u.id),
          summary: todo("one line: what the project does, for whom, in plain words."),
        };
    if (!stored.has(inside.service)) nodes.push(service);
    const used = linked.filter((s) =>
      reach.get(s.slug)!.some((r) => insideOfUnit.get(r.unit) === inside),
    );
    const depth = Math.max(...inside.units.map((u) => u.path.split("/").length));
    views.push({
      id: inside.viewId,
      type: "graph",
      title: todo(
        `what the map shows, in plain words (for example: inside ${multi ? baseName(inside.root) : repoName}: its parts and what they use)`,
      ),
      scope: { root: multi ? inside.service : "repo", depth },
      include: [...inside.units.map((u) => u.id), ...used.map((s) => systemIds.get(s.slug)!)],
      excludeFiles: [...OVERVIEW_EXCLUDE],
      stubs: { mode: "none" },
    });
    for (const unit of inside.units) {
      const node = overlay(
        stored,
        unit.id,
        todo(
          unit.dir
            ? `one line: what this part does (${unit.files.length} code ${unit.files.length === 1 ? "file" : "files"}), in plain words.`
            : "one line: what this file does, in plain words.",
        ),
      );
      // a reader of the map knows the part by what it does ("Payments"), not by its folder name ("pay"),
      // and sees it is one component of the service (the level between the service and its code)
      if (node)
        nodes.push({
          ...node,
          label: todo(`1-3 plain words for this part (now: ${baseName(unit.path)})`),
          role: "component",
        });
    }
  }

  const systemViewId = ids.get("view", "system");
  views.unshift({
    id: systemViewId,
    type: "graph",
    title: todo(
      `the big picture in plain words (for example: ${repoName}, who uses it and what it relies on)`,
    ),
    scope: { root: "repo", depth: 1 },
    include: [
      ...inbound.map((s) => systemIds.get(s.slug)!),
      ...insides.map((i) => i.service),
      ...outbound.map((s) => systemIds.get(s.slug)!),
    ],
    excludeFiles: [...OVERVIEW_EXCLUDE],
    stubs: { mode: "none" },
  });

  // ── The tour: the big picture, what it relies on, then down one level into the main service.
  const about = aboutAnchor(model, texts);
  const main = [...insides].sort(
    (a, b) =>
      b.units.reduce((n, u) => n + u.files.length, 0) -
        a.units.reduce((n, u) => n + u.files.length, 0) || a.root.localeCompare(b.root),
  )[0]!;
  const stem = (path: string) => baseName(path).replace(/\.[^.]+$/, "");
  const mainUnit =
    main.units.find((u) => ENTRY_NAMES.test(stem(u.path))) ??
    main.units.find((u) => u.files.some((f) => ENTRY_NAMES.test(stem(f)))) ??
    [...main.units].sort((a, b) => links(b) - links(a))[0]!;
  const reachFromMain = (u: Unit) => between(mainUnit, u);
  const order = [
    mainUnit,
    ...main.units
      .filter((u) => u !== mainUnit)
      .sort(
        (a, b) =>
          reachFromMain(b) - reachFromMain(a) ||
          links(b) - links(a) ||
          a.path.localeCompare(b.path),
      ),
  ];

  /** The top-level symbols of a unit that other files use most. */
  const topSymbols = (unit: Unit, n: number): IndexedSymbol[] =>
    unit.files
      .flatMap((file) => model.topLevelSymbols(file))
      .filter((s) => s.kind !== "variable" && s.kind !== "key")
      .sort(
        (a, b) =>
          (symbolIn.get(b.id) ?? 0) - (symbolIn.get(a.id) ?? 0) ||
          b.range.endLine - b.range.startLine - (a.range.endLine - a.range.startLine) ||
          a.id.localeCompare(b.id),
      )
      .slice(0, n);
  const mainTop = topSymbols(mainUnit, 1)[0];

  // ── A library: nobody reaches it through a web server or a command line; the code of an app calls it. A box
  // for that app, anchored where the README shows an import of the project, with an arrow to the service.
  let appId: string | undefined;
  if (library && mainTop) {
    const readme = model.dirChildren("").files.find((f) => /^readme(?:\.[a-z]+)?$/i.test(f));
    const shown = readme
      ? readmeUsage(texts.lines(readme) ?? [], ownModules(model, texts))
      : undefined;
    const usage =
      readme && shown ? fileLines(texts, readme, shown.line, shown.line, "usage") : undefined;
    // what the app calls: the first name of the README example that is a top-level symbol of the service
    const top = new Map<string, IndexedSymbol>();
    // (in the files of the boxes: the arrow's evidence must lie inside the service)
    for (const sym of main.units.flatMap((u) => u.files).flatMap((f) => model.topLevelSymbols(f)))
      if (!top.has(sym.path) && sym.kind !== "key") top.set(sym.path, sym);
    const named = shown?.names.map((n) => top.get(n)).find((s) => s !== undefined);
    const callee = signature(texts, named ?? mainTop);
    if (usage && callee) {
      appId = reuse("grp", "your-app");
      if (!stored.has(appId)) {
        nodes.push({
          id: appId,
          label: "Your app",
          role: "system",
          parent: "repo",
          summary: todo(`one line: how an app uses ${repoName}, in plain words.`),
          anchors: [usage],
        });
        edges.push({
          id: ids.get("edge", `your-app-${slugOf(repoName)}`),
          from: appId,
          to: main.service,
          kind: "calls",
          label: todo("1-4 words: what the app calls (for example: ky.get(), ky.post())"),
          anchors: [usage, callee],
        });
      }
      const system = views[0]!;
      if (system.type === "graph") system.include = [appId, ...(system.include ?? [])];
      notes.push(
        `${repoName} looks like a library (no program to run, no web server or command line): "Your app" stands for the code that calls it`,
      );
    }
  }

  const steps: PatchTourStep[] = [];
  const nextId = () => `t${steps.length + 1}`;
  const otherServices = insides.filter((i) => i !== main).map((i) => baseName(i.root));
  steps.push(
    tourStep(
      model,
      nextId(),
      systemViewId,
      appId ? [main.service, appId] : [main.service],
      note(
        todo("what the project is, as a plain statement anyone can follow"),
        todo("its language, its kind and what it is for, from the README; no code names."),
        "Architecture roles are provisional. Confirm primary users and entry points in the code.",
        inbound.length > 0
          ? todo(
              `who uses it and how (${plainList(inbound.map((s) => s.label))}), in one sentence.`,
            )
          : appId
            ? todo("how an app uses it (Your app): what the app calls, in one sentence.")
            : todo("who uses it and how, in one sentence."),
        otherServices.length > 0
          ? todo(
              `what each of the other services does, one short sentence each: ${nameList(otherServices, 10)}.`,
            )
          : "",
      ),
      [about, mainTop ? definition(mainTop) : undefined],
    ),
  );
  if (outbound.length > 0) {
    steps.push(
      tourStep(
        model,
        nextId(),
        systemViewId,
        outbound.map((s) => systemIds.get(s.slug)!),
        note(
          todo("what the project relies on outside its own code, as a plain statement"),
          todo(
            `one short sentence per box, in plain words: what it keeps or does for the project (${plainList(
              outbound.map((s) => s.label),
              10,
            )}).`,
          ),
          todo("merge boxes that are the same system, and drop one the code only imports."),
          todo(
            "for each imported system, whether the default runtime path uses it or it is an optional integration.",
          ),
        ),
        outbound.slice(0, L.codeRanges).map((s) => reach.get(s.slug)![0]!.anchor),
      ),
    );
  }

  const offNames = main.offMap.map((u) => baseName(u.path));
  // a hint for the groups: the box each left-off file shares the most references with
  const near = new Map<Unit, string[]>();
  for (const off of main.offMap) {
    const shared = (u: Unit) => between(off, u) + between(u, off);
    const best = [...main.units].sort((a, b) => shared(b) - shared(a))[0];
    if (best && shared(best) > 0) near.set(best, [...(near.get(best) ?? []), baseName(off.path)]);
  }
  const nearHint = [...near].map(
    ([unit, files]) => `- with ${tick(baseName(unit.path))}: ${nameList(files, 4)}`,
  );
  steps.push(
    tourStep(
      model,
      nextId(),
      main.viewId,
      [mainUnit.id],
      note(
        todo(`what is inside ${multi ? baseName(main.root) : "the project"}, as a plain statement`),
        todo(
          "its parts and what each is for, in one or two plain sentences; then the main path through them.",
        ),
        offNames.length > 0
          ? `Not on the map: ${nameList(offNames, 10)}. ${todo("make one box per responsibility, and group files with grp boxes.")}` +
              (nearHint.length > 0
                ? `\n\nThe files they share the most references with:\n\n${nearHint.join("\n")}`
                : "")
          : todo("check that each box is one responsibility; merge or split boxes with grp boxes."),
      ),
      topSymbols(mainUnit, L.codeRanges).map((s) => definition(s)),
    ),
  );
  for (const unit of order.slice(1)) {
    const inner = unit.dir ? unit.files.map((f) => baseName(f)) : [];
    const uses = linked.filter((s) => reach.get(s.slug)!.some((r) => r.unit === unit));
    steps.push(
      tourStep(
        model,
        nextId(),
        main.viewId,
        [unit.id],
        note(
          todo("what this part is for, as a plain statement"),
          todo("its job in everyday words first; then how it connects to the other parts."),
          uses.some((s) => !s.inbound)
            ? todo(
                `what it asks of ${plainList(uses.filter((s) => !s.inbound).map((s) => s.label))}.`,
              )
            : "",
          uses.some((s) => s.inbound)
            ? todo(
                `how ${plainList(uses.filter((s) => s.inbound).map((s) => s.label.toLowerCase()))} reach the project here.`,
              )
            : "",
          inner.length > 1 ? `Files: ${nameList(inner, 5)}.` : "",
        ),
        topSymbols(unit, L.codeRanges).map((s) => definition(s)),
      ),
    );
  }

  const patch: ExplainerPatch = {
    nodes,
    ...(edges.length > 0 ? { edges } : {}),
    views,
    tours: [
      {
        id: ids.get("tour", "overview"),
        title: todo("what the tour covers, in about 8 plain words"),
        summary: [
          todo("what the project is and who it is for, in plain words."),
          todo("its main parts and what it relies on (databases, other systems), in one sentence."),
        ].join(" "),
        steps,
      },
    ],
  };
  return { kind: "repo", patch, notes };
}

// ─── draft path ─────────────────────────────────────────────────────────────────────────────────

/** Kinds of symbol that own methods: a call to one of their methods goes to them as a participant. */
const OWNER_KINDS: ReadonlySet<IndexedSymbol["kind"]> = new Set(["class", "interface", "enum"]);

/** The class (or interface) a method belongs to; a Go method may be declared in another file of its package. */
function ownerOf(model: IndexModel, sym: IndexedSymbol): IndexedSymbol | undefined {
  const parent = model.parentSymbol(sym.id);
  if (parent) return OWNER_KINDS.has(parent.kind) ? parent : undefined;
  const dot = sym.path.lastIndexOf(".");
  if (dot === -1) return undefined;
  const typePath = sym.path.slice(0, dot);
  for (const file of [sym.file, ...model.dirChildren(dirOf(sym.file)).files]) {
    const owner = model.symbolAt(file, typePath);
    if (owner) return OWNER_KINDS.has(owner.kind) ? owner : undefined;
  }
  return undefined;
}

/** Kinds of symbol a call can only convert to or build data of: no code of theirs runs (Go's `nodeTyp(t)`). */
const TYPE_KINDS: ReadonlySet<IndexedSymbol["kind"]> = new Set(["type", "interface", "enum"]);

/** The classes a class extends, in the order its declaration names them. */
function basesOf(model: IndexModel, cls: IndexedSymbol): IndexedSymbol[] {
  const out: IndexedSymbol[] = [];
  const refs = [...model.refsFrom(cls.id)]
    .filter((ref) => ref.kind === "extends")
    .sort(
      (a, b) =>
        a.site.startLine - b.site.startLine || (a.site.startCol ?? 0) - (b.site.startCol ?? 0),
    );
  for (const ref of refs) {
    const base = model.symbol(ref.to);
    if (base && base.id !== cls.id && !out.includes(base)) out.push(base);
  }
  return out;
}

/**
 * The order in which a class and its bases are searched for a method (Python's C3 order; for single inheritance,
 * the class, its base, the base's base, ...). The class comes first.
 */
export function methodOrder(model: IndexModel, cls: IndexedSymbol): IndexedSymbol[] {
  const memo = new Map<string, IndexedSymbol[]>();
  const linearize = (c: IndexedSymbol, depth: number): IndexedSymbol[] => {
    const known = memo.get(c.id);
    if (known) return known;
    const bases = depth > 32 ? [] : basesOf(model, c);
    const seqs = [...bases.map((b) => [...linearize(b, depth + 1)]), [...bases]].filter(
      (s) => s.length > 0,
    );
    const out = [c];
    while (seqs.some((s) => s.length > 0)) {
      const head = seqs
        .filter((s) => s.length > 0)
        .map((s) => s[0]!)
        .find((h) => !seqs.some((s) => s.indexOf(h) > 0));
      if (!head) {
        // no consistent order: the bases depth first
        for (const s of seqs) for (const x of s) if (!out.includes(x)) out.push(x);
        break;
      }
      out.push(head);
      for (const s of seqs) if (s[0] === head) s.shift();
    }
    memo.set(c.id, out);
    return out;
  };
  return linearize(cls, 0);
}

/** The method `name` as a class has it: its own, else the first base (in method order) that defines it. */
function methodOf(model: IndexModel, cls: IndexedSymbol, name: string): IndexedSymbol | undefined {
  for (const c of methodOrder(model, cls)) {
    const method = model.symbolAt(c.file, `${c.path}.${name}`);
    if (method && method.kind === "method") return method;
  }
  return undefined;
}

/** A method asked for on a class that inherits it: where it is defined, and the class it was asked on. */
export interface PathEntry {
  symbol: IndexedSymbol;
  /** The class the method was asked on (`URLSafeTimedSerializer`), when it inherits the method from a base. */
  via?: IndexedSymbol;
}

/**
 * `Class.method` in `file` when the class does not define the method but one of its bases does
 * (`sym:url_safe.py#URLSafeTimedSerializer.dumps` -> `Serializer.dumps`); undefined otherwise.
 */
export function inheritedEntry(
  model: IndexModel,
  file: string,
  path: string,
): PathEntry | undefined {
  const dot = path.lastIndexOf(".");
  if (dot === -1) return undefined;
  const cls = model.symbolAt(file, path.slice(0, dot));
  if (!cls || cls.kind !== "class") return undefined;
  const method = methodOf(model, cls, path.slice(dot + 1));
  return method ? { symbol: method, via: cls } : undefined;
}

interface Call {
  ref: Reference;
  callee: IndexedSymbol;
  participant: string;
  /** Reached through an interface: the one implementation outside tests the index knows. */
  hop: boolean;
  /** Found by the method order of the class the entry runs on (`self.dump_payload` -> the mixin's). */
  dispatched?: IndexedSymbol;
  /** How much the call matters: what it reaches and how much code is behind it (see `callScore`). */
  score: number;
}

/** `pop()`, `run(job, opts)`, `Options{…}`: the call as written at the site, its arguments cut when long. */
function callLabel(texts: TextCache, file: string, site: Reference["site"], name: string): string {
  const lines = texts.lines(file);
  let text = "";
  if (lines) {
    const parts: string[] = [];
    for (let line = site.startLine; line <= site.endLine; line++) {
      let row = lines[line - 1] ?? "";
      if (line === site.endLine && site.endCol !== undefined) row = row.slice(0, site.endCol);
      if (line === site.startLine && site.startCol !== undefined)
        row = row.slice(site.startCol - 1);
      parts.push(row.trim());
    }
    text = parts.join(" ").replace(/\s+/g, " ").trim();
  }
  // the first `name(` that is a whole name (`f(f(x))`, `new Node([new Node()])`: the outer call), to its own `)`
  let paren = -1;
  for (let at = text.indexOf(`${name}(`); at !== -1; at = text.indexOf(`${name}(`, at + 1)) {
    if (at === 0 || !/[\p{L}\p{N}_$]/u.test(text[at - 1]!)) {
      paren = at;
      break;
    }
  }
  if (paren === -1) return text.includes(`${name}{`) ? `${name}{…}` : `${name}()`;
  const open = paren + name.length;
  const close = matchingClose(text, open);
  const args = close > open ? text.slice(open + 1, close).trim() : "";
  return `${name}(${args.length > 32 || args.includes("\n") || close === -1 ? "…" : args})`;
}

/** The index of the bracket that closes the one at `open` (strings skipped), or -1 when the text ends first. */
function matchingClose(text: string, open: number): number {
  let depth = 0;
  let quote = "";
  for (let i = open; i < text.length; i++) {
    const c = text[i]!;
    if (quote) {
      if (c === "\\") i++;
      else if (c === quote) quote = "";
    } else if (c === '"' || c === "'" || c === "`") quote = c;
    else if (c === "(" || c === "[" || c === "{") depth++;
    else if (c === ")" || c === "]" || c === "}") {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/** The symbol whose code runs for a callee: a class's constructor when it has one. */
function runsFor(model: IndexModel, callee: IndexedSymbol): IndexedSymbol {
  if (callee.kind !== "class") return callee;
  for (const name of ["__init__", "constructor", "__new__"]) {
    const ctor = model.symbolAt(callee.file, `${callee.path}.${name}`);
    if (ctor) return ctor;
  }
  return callee;
}

/**
 * For a method of a base class that subclasses (outside tests) override: their names, since the code that runs may
 * be theirs (the index has the `extends` references, not which one runs).
 */
function overridesHint(model: IndexModel, callee: IndexedSymbol): string {
  const owner = ownerOf(model, callee);
  if (!owner || callee.kind !== "method") return "";
  const name = callee.path.slice(callee.path.lastIndexOf(".") + 1);
  const overrides = model
    .refsTo(owner.id)
    .filter((ref) => ref.kind === "extends")
    .map((ref) => model.symbol(ref.from))
    .filter((sub): sub is IndexedSymbol => sub !== undefined && !isTestFile(sub.file))
    .filter((sub) => model.symbolAt(sub.file, `${sub.path}.${name}`) !== undefined)
    .map((sub) => `${sub.path}.${name}`);
  if (overrides.length === 0) return "";
  return ` Subclasses override it: ${nameList(overrides, 4)}; ${todo("say which one runs here, and anchor it.")}`;
}

/** A view slug from a symbol path: its last two segments (`Runner.dispatch` -> `runner-dispatch`). */
function pathSlug(path: string): string {
  const slug = path
    .split(".")
    .slice(-2)
    .join("-")
    .replace(/~\d+$/, "")
    .replace(/([a-z0-9])([A-Z])/g, "$1-$2")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (slug === "") return "path";
  return RESERVED_PREFIXES.includes(slug) ? `${slug}-path` : slug;
}

/** Lines of a symbol. */
const lineCount = (sym: IndexedSymbol) => 1 + sym.range.endLine - sym.range.startLine;

/** Lines of code in a symbol's body: after its first line, not blank and not only closing brackets. */
function bodyLines(texts: TextCache, sym: IndexedSymbol): number {
  const lines = texts.lines(sym.file) ?? [];
  let n = 0;
  for (let line = sym.range.startLine + 1; line <= sym.range.endLine; line++) {
    if (!/^[\s{}()[\];]*$/.test(lines[line - 1] ?? "")) n++;
  }
  return n;
}

/** How many symbols of the repository (outside tests) a symbol reaches through calls, at most 3 calls deep. */
function reachOf(model: IndexModel, start: IndexedSymbol, skip: ReadonlySet<string>): number {
  const seen = new Set<string>([start.id]);
  let frontier = [start.id];
  for (let depth = 0; depth < 3 && frontier.length > 0 && seen.size < 60; depth++) {
    const next: string[] = [];
    for (const id of frontier) {
      for (const ref of model.refsFrom(id)) {
        if (ref.kind !== "call" || seen.has(ref.to) || skip.has(ref.to)) continue;
        const sym = model.symbol(ref.to);
        if (!sym || isTestFile(sym.file)) continue;
        seen.add(ref.to);
        next.push(ref.to);
      }
    }
    frontier = next;
  }
  return seen.size - 1;
}

/** One sequence of a path draft: the view, its participants and calls, and what was left out. */
interface PathSequence {
  entry: PathEntry;
  entryId: string;
  view: PatchView & { type: "sequence" };
  participants: string[];
  /** The calls, each with its sequence step. */
  calls: { call: Call; step: PatchSequenceStep }[];
  notes: string[];
}

function pathSequence(
  input: DraftInput,
  entry: PathEntry,
  ids: FreeIds,
): PathSequence | { error: string } {
  const { model, texts } = input;
  const L = DRAFT_LIMITS;
  const notes: string[] = [];
  const sym = entry.symbol;
  const entryId = `sym:${sym.id}`;
  const asked = entry.via
    ? `${entry.via.path}.${sym.path.slice(sym.path.lastIndexOf(".") + 1)}`
    : sym.path;

  // the entry and what it contains (nested functions are part of it)
  const inside = new Set<string>();
  const walk = (s: IndexedSymbol) => {
    inside.add(s.id);
    for (const child of model.childSymbols(s.id)) walk(child);
  };
  walk(sym);
  const entryOwner = ownerOf(model, sym);
  // the class the entry runs on: the one it was asked on, else its own
  const runtime = entry.via ?? entryOwner;
  const family = new Set(runtime ? methodOrder(model, runtime).map((c) => c.id) : []);
  if (entry.via) {
    notes.push(
      `${asked} is inherited: it resolves to ${entryId}, the first class in ${entry.via.path}'s method order ` +
        `that defines it. The path starts there, and its calls to methods of ${entry.via.path} and its bases go ` +
        `where that order finds them`,
    );
  }

  const refs = [...inside]
    .flatMap((id) => model.refsFrom(id))
    // a call out of the entry, or back into it (recursion)
    .filter(
      (ref) =>
        ref.kind === "call" && (!inside.has(ref.to) || ref.to === sym.id) && model.symbol(ref.to),
    )
    .sort(
      (a, b) =>
        a.site.startLine - b.site.startLine ||
        (a.site.startCol ?? 0) - (b.site.startCol ?? 0) ||
        a.to.localeCompare(b.to),
    );

  let calls: Call[] = [];
  const seen = new Set<string>();
  /** Callees called more than once: one step each, at the first call. */
  const repeated = new Map<string, number>();
  const built: string[] = [];
  const helpers: string[] = [];
  for (const ref of refs) {
    let callee = model.symbol(ref.to)!;
    let hop = false;
    let dispatched: IndexedSymbol | undefined;
    const recursion = callee.id === sym.id;
    const declared = recursion ? undefined : ownerOf(model, callee);
    if (declared?.kind === "interface" || callee.kind === "interface") {
      // a call through an interface: what runs is the implementation, when the index knows one outside tests
      const impls = implementationsOf(model, callee.id)
        .map((impl) => model.symbol(impl.id))
        .filter((s): s is IndexedSymbol => s !== undefined && !isTestFile(s.file));
      if (impls.length === 1) {
        callee = impls[0]!;
        hop = true;
      }
    } else if (runtime && declared && family.has(declared.id) && callee.kind === "method") {
      // a method of the class the entry runs on: the one its method order finds (a mixin's override)
      const name = callee.path.slice(callee.path.lastIndexOf(".") + 1);
      const found = methodOf(model, runtime, name);
      if (found && found.id !== callee.id) {
        dispatched = found;
        callee = found;
      }
    }
    if (!recursion && inside.has(callee.id)) continue;
    // a conversion to a type, or data built from a type with no constructor: no code of the repo runs
    if (
      !recursion &&
      (TYPE_KINDS.has(callee.kind) ||
        (callee.kind === "class" && runsFor(model, callee) === callee))
    ) {
      if (!built.includes(callee.path)) built.push(callee.path);
      continue;
    }
    const owner = callee.kind === "class" ? callee : ownerOf(model, callee);
    const runs = runsFor(model, callee);
    // a helper of the entry's own class (or of a class it inherits from), or of its file, that is one line and calls
    // nothing: not worth an arrow
    const own =
      (owner !== undefined && (owner.id === entryOwner?.id || family.has(owner.id))) ||
      (owner === undefined && callee.file === sym.file && callee.kind === "function");
    const callsMore = model.refsFrom(runs.id).some((r) => r.kind === "call" && r.to !== runs.id);
    if (!recursion && own && bodyLines(texts, runs) <= 1 && !callsMore) {
      if (!helpers.includes(runs.path)) helpers.push(runs.path);
      continue;
    }
    // each recursive call is drawn (they usually recurse on different inputs); other callees once
    if (!recursion && seen.has(callee.id)) {
      repeated.set(callee.id, (repeated.get(callee.id) ?? 1) + 1);
      continue;
    }
    seen.add(callee.id);
    // a method goes to the lifeline of its class (the entry's own class too: never the entry's lifeline, which
    // stands for the entry alone), a function to its own; only recursion is a call of the entry to itself
    const participant = recursion ? entryId : `sym:${(owner ?? callee).id}`;
    const skip = new Set([sym.id]);
    const score = recursion
      ? 1000
      : 3 * Math.min(reachOf(model, runs, skip), 20) +
        Math.min(lineCount(runs), 60) / 6 +
        (participant.startsWith(`sym:${sym.file}#`) ? 0 : 2);
    calls.push({ ref, callee, participant, hop, ...(dispatched ? { dispatched } : {}), score });
  }
  if (repeated.size > 0) {
    notes.push(
      "called more than once, drawn once at the first call: " +
        [...repeated].map(([id, n]) => `sym:${id} (${n} calls)`).join(", "),
    );
  }
  if (built.length > 0) {
    notes.push(
      `not drawn, a conversion to a type or data built from it (no code of it runs): ${built.join(", ")}`,
    );
  }
  if (helpers.length > 0) {
    notes.push(`not drawn, one-line helpers that call nothing: ${helpers.join(", ")}`);
  }
  if (calls.length === 0) {
    return {
      error:
        built.length + helpers.length > 0
          ? `${entryId} makes no call worth drawing, every call it makes is left out (${notes.join("; ")}): start from a callee with more code, or explain it in a guide step`
          : `${entryId} makes no call the index knows (calls into libraries outside the repository are not indexed): there is nothing to draw`,
    };
  }

  // what matters least goes first: the call that reaches the least code, the later one first
  const lightest = (list: readonly Call[]) =>
    [...list].sort((a, b) => a.score - b.score || list.indexOf(b) - list.indexOf(a))[0]!;
  const dropped: Call[] = [];
  while (calls.length > L.pathCalls) {
    const drop = lightest(calls);
    dropped.push(drop);
    calls = calls.filter((c) => c !== drop);
  }
  const participantsOf = () => [
    entryId,
    ...new Set(calls.map((c) => c.participant).filter((p) => p !== entryId)),
  ];
  while (participantsOf().length > L.participants) {
    // the participant whose calls matter least goes
    const weight = new Map<string, number>();
    for (const c of calls) {
      if (c.participant === entryId) continue;
      weight.set(c.participant, Math.max(weight.get(c.participant) ?? 0, c.score));
    }
    const order = participantsOf();
    const least = [...weight].sort(
      (a, b) => a[1] - b[1] || order.indexOf(b[0]) - order.indexOf(a[0]),
    )[0]![0];
    dropped.push(...calls.filter((c) => c.participant === least));
    calls = calls.filter((c) => c.participant !== least);
  }
  if (dropped.length > 0) {
    notes.push(
      `calls left out of the sequence (at most ${L.pathCalls} calls and ${L.participants} participants), ` +
        `the ones that reach the least code: ${dropped.map((c) => `sym:${c.callee.id}`).join(", ")}`,
    );
  }
  const participants = participantsOf();

  const viewId = ids.get("view", pathSlug(asked));
  const stepSlug = viewId.slice("view:".length);
  const steps = calls.map((call, i): { call: Call; step: PatchSequenceStep } => {
    const name = call.ref.to
      .slice(call.ref.to.indexOf("#") + 1)
      .split(".")
      .at(-1)!
      .replace(/~\d+$/, "");
    const site = siteAnchor(
      model,
      texts,
      call.ref.from,
      sym.file,
      call.ref.site.startLine,
      call.ref.site.endLine,
    );
    const recursion = call.callee.id === sym.id;
    const anchors = [site, recursion ? undefined : definition(runsFor(model, call.callee))].filter(
      (a): a is AnchorInput => a !== undefined,
    );
    const what = recursion
      ? "what this call into itself does (one level down: on what input, and when it stops)."
      : call.hop
        ? "what happens at this call, with its condition (the call goes through an interface)."
        : "what happens at this call, with its condition.";
    const hint = call.dispatched
      ? ` The index points at ${tick(model.symbol(call.ref.to)!.path)}; ${entry.via?.path ?? runtime?.path} runs ${tick(call.dispatched.path)} (its method order).`
      : recursion
        ? ""
        : overridesHint(model, call.callee);
    return {
      call,
      step: {
        id: `${stepSlug}:${i + 1}`,
        from: entryId,
        to: call.participant,
        label: callLabel(texts, sym.file, call.ref.site, name),
        kind: "call",
        summary: todo(what) + hint,
        anchors,
      },
    };
  });

  const view: PatchView & { type: "sequence" } = {
    id: viewId,
    type: "sequence",
    title: todo(`what this sequence shows, in plain words (it starts at ${tick(asked)})`),
    scope: {
      root: "repo",
      depth: 2,
      question: todo("the question this path answers"),
      entryPoints: [sym.id],
    },
    participants,
    steps: steps.map((s) => s.step),
  };
  return { entry, entryId, view, participants, calls: steps, notes };
}

/**
 * A sequence per entry (the calls each one makes, depth 1), and one tour: the big picture, then a step per main
 * call of each sequence. Two entries answer a question with two halves (`dumps`, then `loads`) in one tour.
 */
export function draftPath(input: DraftInput, entries: readonly PathEntry[]): Draft {
  const { explainer, model } = input;
  const L = DRAFT_LIMITS;
  const ids = new FreeIds(explainer);
  const stored = storedNodeIds(explainer);
  const notes: string[] = [];
  const sequences: PathSequence[] = [];
  for (const entry of entries) {
    const result = pathSequence(input, entry, ids);
    if ("error" in result) throw new Error(result.error);
    sequences.push(result);
    for (const n of result.notes)
      notes.push(entries.length > 1 ? `${tick(result.view.id)}: ${n}` : n);
  }

  // the main calls of each sequence get a tour step; the budget is shared between the sequences
  // (the tour stays at most one step longer than for one entry: each sequence has a big-picture step of its own)
  const perSequence = Math.max(
    2,
    Math.floor((L.pathSteps + 1 - sequences.length) / sequences.length),
  );
  const nodes: PatchNode[] = [];
  const overlaid = new Set<string>();
  const tourSteps: PatchTourStep[] = [];
  const next = () => `t${tourSteps.length + 1}`;
  for (const [index, seq] of sequences.entries()) {
    for (const id of seq.participants) {
      if (overlaid.has(id)) continue;
      overlaid.add(id);
      const node = overlay(stored, id, todo("one sentence: what it does on this path."));
      if (node) nodes.push(node);
    }
    let main = [...seq.calls];
    const quiet: Call[] = [];
    while (main.length > perSequence) {
      const drop = [...main].sort(
        (a, b) => a.call.score - b.call.score || main.indexOf(b) - main.indexOf(a),
      )[0]!;
      quiet.push(drop.call);
      main = main.filter((m) => m !== drop);
    }
    if (quiet.length > 0) {
      notes.push(
        `${sequences.length > 1 ? `${tick(seq.view.id)}: ` : ""}calls without a tour step of their own (at most ${perSequence}): ` +
          quiet.map((c) => `sym:${c.callee.id}`).join(", "),
      );
    }
    const quietNames = quiet.map((c) => c.callee.path);
    const start = seq.entry.via
      ? `${seq.entry.via.path}.${seq.entry.symbol.path.slice(seq.entry.symbol.path.lastIndexOf(".") + 1)}`
      : seq.entry.symbol.path;
    tourSteps.push(
      tourStep(
        model,
        next(),
        seq.view.id,
        [seq.entryId],
        note(
          index === 0
            ? todo("the answer to the question, as a plain statement")
            : todo(`the next part of the answer, from ${tick(start)}, as a plain statement`),
          todo("where this path starts, what it ends with, and which call decides the outcome."),
          "Draft scope: selected direct call sites in source order. Review conditions, loops, repeated calls and omitted branches before publishing.",
          ...seq.notes
            .filter((text) => /called more than once|calls left out of the sequence/.test(text))
            .map((text) => {
              const targets = (text.match(/sym:[^\s,)]+/g) ?? []).map(tick).join(", ");
              return text.startsWith("called more than once")
                ? `Repeated targets: ${targets}. The sequence draws the first call site.`
                : `Omitted targets: ${targets}. The draft reached its call or participant limit.`;
            }),
          quietNames.length > 0
            ? `Calls without a step of their own: ${nameList(quietNames)}. ${todo("say what they do in one sentence, or drop this one.")}`
            : "",
        ),
        [definition(seq.entry.symbol)],
      ),
    );
    for (const { step } of main) {
      tourSteps.push(
        tourStep(
          model,
          next(),
          seq.view.id,
          [step.id],
          note(
            todo("what this call does for the reader, as a plain statement"),
            todo("why this call matters here, and the condition under which it runs."),
          ),
          step.anchors ?? [],
        ),
      );
    }
  }

  const first = sequences[0]!;
  const tourSlug = first.view.id.slice("view:".length);
  const patch: ExplainerPatch = {
    nodes,
    views: sequences.map((s) => s.view),
    tours: [
      {
        id: ids.get("tour", tourSlug),
        title: todo("the question this tour answers, in about 8 plain words"),
        summary: [
          todo("the answer in one or two sentences, naming the key functions."),
          todo("what the tour leaves out."),
        ].join(" "),
        steps: tourSteps,
      },
    ],
  };
  return { kind: "path", patch, notes };
}
