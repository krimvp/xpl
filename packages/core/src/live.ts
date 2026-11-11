/**
 * What a live page shows (ARCHITECTURE §5 "xpl live", §6 "Live"): the status `xpl live` reports at `GET /api/live`
 * (type-only, like `WatchAttention`: the CLI fills it in, the viewer reads it, never embedded in a saved page), and
 * the pure reading of a change record across the levels of a guide: what the change did to each box, lifted from
 * the files under it to the part and the service that hold them (`liftChange`), the boxes of deleted files and
 * folders a map no longer has (`removedBoxes`), and the "What changed" list, part by part (`liveSummary`).
 */
import { analyzeChange, changeStatusOfRange } from "./change.js";
import { matchesAnyGlob } from "./glob.js";
import { parseId } from "./ids.js";
import { baseName, dirOf, isTestFile } from "./index-model.js";
import { CODE_LANGUAGES } from "./languages.js";
import { opensView, zoomTrail, type ZoomLevel } from "./levels.js";
import type { ExplainerModel } from "./model.js";
import type {
  ChangedFile,
  ChangeRecord,
  ElementId,
  FilePath,
  GraphView,
  Tour,
  TourStep,
} from "./schema.js";
import { isRecord } from "./util.js";

export interface LiveStatus {
  schema: "xpl-live@1";
  /** The guide `xpl live` keeps (its name: `live` by default). */
  guide: string;
  /**
   * `building`: an edit settled and a cycle runs (index, move the guide, record the change, draft); `watching`: the
   * last cycle finished and the guide matches the code; `failed`: the last cycle failed, the guide keeps the last
   * good state, and the next edit tries again.
   */
  state: "watching" | "building" | "failed";
  /** When the guide last matched the code (ISO time); null before the first cycle finished. */
  updatedAt: string | null;
  /** The commit id of the index the guide is on (`wt-35af5f4417` for a working tree); null before the first cycle. */
  index: string | null;
  /**
   * What the change is measured from. `rev` is what chose it: the `--since` revision, the default branch whose merge
   * base it is (`origin/main`), or `HEAD` at the first start. Null outside git or before the first commit.
   */
  base: { rev: string; sha: string; how: "since" | "merge-base" | "start" } | null;
  /** The recorded change (`explainer.change`) in numbers; null when the code is the code of the base. */
  change: { files: number; added: number; removed: number } | null;
  explanation: {
    /** `none`: nothing is spawned (the user's own agent writes, `reference/live.md`); `claude`: the installed CLI. */
    backend: "none" | "claude";
    /** `off` with backend none; `idle` between runs; `running` while one runs; `failed` after a run that failed. */
    state: "off" | "idle" | "running" | "failed";
    /** When a run of this process last applied an explanation (ISO time); null otherwise. */
    explainedAt: string | null;
    /**
     * The code moved since the explanation was written: the index commit differs from the one of the last applied
     * explanation (this process's run, else the `provenance.commit` of `tour:live`). False without a change.
     */
    stale: boolean;
    /** Why the last run failed; null otherwise. */
    error: string | null;
  };
  /** Why the last cycle failed (with `state: "failed"`); null otherwise. */
  error: string | null;
}

/** The tour the live agent writes and refreshes: what the change does to the architecture, part by part. */
export const LIVE_TOUR_ID = "tour:live";

/**
 * The design level of a live guide (ARCHITECTURE §6 "Live"): a stored graph view of the design concepts the change
 * touches, boxes `grp:design-<slug>` whose `members` are the files and folders that do each job. It is a second
 * lens on the level under the system map (`designLevel`), never opened by a box.
 */
export const DESIGN_VIEW_ID = "view:design";
export const DESIGN_PREFIX = "grp:design-";
export const isDesignBox = (id: string): boolean => id.startsWith(DESIGN_PREFIX);
/** The `tour:live` step of a design box: `grp:design-retry` -> `design-retry`. */
export const designStepId = (box: ElementId): string => `design-${box.slice(DESIGN_PREFIX.length)}`;

// ─── The change across the levels ──────────────────────────────────────────────────────────────

/**
 * What a change did to a box. `new`: everything it holds was added (a new file, a new folder, a function whose
 * every line is new); `changed`: its own code changed (a file, a symbol); `inside`: it holds changed code without
 * being new (a part, a service: the change is in there); `removed`: code the change deleted (`removedBoxes`).
 */
export interface BoxChange {
  status: "new" | "changed" | "inside" | "removed";
  /** The changed files it holds, by what happened to them (a rename counts as changed). */
  files: { added: FilePath[]; changed: FilePath[]; removed: FilePath[] };
  /** Lines added and removed in them, from the hunks. */
  lines: { added: number; removed: number };
}

/** A deleted file, or a folder of them, on the map of the folder that held it: it has no box any more. */
export interface RemovedBox {
  /** `removed:<path>`: not an element id; the viewer draws it and opens its code from the base. */
  id: string;
  path: FilePath;
  kind: "file" | "dir";
  /** Its name: `legacy.ts`, `old`. */
  label: string;
  change: BoxChange;
}

/** The id of the removed box of a deleted file or folder. */
export const removedId = (path: FilePath): string => `removed:${path}`;

const files = (change: ChangeRecord): ChangedFile[] =>
  (Array.isArray(change.files) ? change.files : []).filter(
    (f) => isRecord(f) && typeof f.path === "string",
  );

const linesOf = (file: ChangedFile) => {
  const hunks = Array.isArray(file.hunks) ? file.hunks : [];
  return {
    added: hunks.reduce((n, h) => n + h.newLines, 0),
    removed: hunks.reduce((n, h) => n + h.oldLines, 0),
  };
};

function summed(status: BoxChange["status"], held: readonly ChangedFile[]): BoxChange {
  const out: BoxChange = {
    status,
    files: { added: [], changed: [], removed: [] },
    lines: { added: 0, removed: 0 },
  };
  for (const file of held) {
    const key =
      file.status === "added" ? "added" : file.status === "deleted" ? "removed" : "changed";
    out.files[key].push(file.path);
    const lines = linesOf(file);
    out.lines.added += lines.added;
    out.lines.removed += lines.removed;
  }
  return out;
}

/**
 * The changed files a box holds: a file its own, a symbol the files whose hunks touch its lines, a folder the
 * files under it (deleted ones by their path), a group its members' and the code its own anchors point at, and any
 * box that opens a map the files of that map's boxes, so a change deep in a file reaches the part and the service
 * above it.
 */
function heldFiles(
  model: ExplainerModel,
  all: readonly ChangedFile[],
  id: ElementId,
  seen: Set<string>,
): Set<ChangedFile> {
  const out = new Set<ChangedFile>();
  if (seen.has(id)) return out;
  seen.add(id);
  const parsed = parseId(id);
  switch (parsed.type) {
    case "repo":
      for (const file of all) out.add(file);
      return out;
    case "file":
      for (const file of all) if (file.path === parsed.path) out.add(file);
      break;
    case "dir":
      for (const file of all) if (file.path.startsWith(`${parsed.path}/`)) out.add(file);
      break;
    case "symbol": {
      const sym = model.index.symbol(parsed.symbolId);
      for (const file of all) {
        if (sym && file.path === parsed.file && changeStatusOfRange(file, sym.range)) out.add(file);
      }
      break;
    }
    case "group": {
      for (const member of model.members(id))
        for (const file of heldFiles(model, all, member, seen)) out.add(file);
      const anchors = model.node(id)?.anchors;
      for (const anchor of Array.isArray(anchors) ? anchors : []) {
        if (!isRecord(anchor)) continue;
        // code the box held before the change that the change deleted (moved without `git mv`, or gone)
        if (anchor.at === "base") {
          for (const file of all)
            if (file.path === anchor.file && file.status === "deleted") out.add(file);
          continue;
        }
        const range = anchor.resolved?.range;
        for (const file of all) {
          if (file.path !== anchor.file) continue;
          if (!range || changeStatusOfRange(file, range)) out.add(file);
        }
      }
      break;
    }
    default:
      return out;
  }
  const opened = opensView(model, id);
  if (opened?.type === "graph") {
    for (const inner of Array.isArray(opened.include) ? opened.include : []) {
      if (typeof inner !== "string") continue;
      for (const file of heldFiles(model, all, inner, seen)) out.add(file);
    }
    // what the map no longer draws counts too: a deleted part is a change of the service
    for (const gone of deletedOn(model, all, opened)) for (const file of gone.held) out.add(file);
  }
  return out;
}

/** Whether a box is wholly new: a new file or symbol, a folder all of whose files are new, a group of new members. */
function whollyNew(
  model: ExplainerModel,
  id: ElementId,
  held: ReadonlySet<ChangedFile>,
  added: ReadonlySet<FilePath>,
): boolean {
  const parsed = parseId(id);
  if (parsed.type === "dir") {
    const under = model.index.filesUnder(parsed.path);
    return under.length > 0 && under.every((path) => added.has(path));
  }
  if (parsed.type === "group") {
    const members = model.members(id);
    return (
      members.length > 0 &&
      members.every((m) => wholeStatus(model, m, added) === "new") &&
      [...held].every((f) => f.status === "added")
    );
  }
  return false;
}

function wholeStatus(
  model: ExplainerModel,
  id: ElementId,
  added: ReadonlySet<FilePath>,
): "new" | undefined {
  const parsed = parseId(id);
  if (parsed.type === "file") return added.has(parsed.path) ? "new" : undefined;
  if (parsed.type === "dir") {
    const under = model.index.filesUnder(parsed.path);
    return under.length > 0 && under.every((path) => added.has(path)) ? "new" : undefined;
  }
  return undefined;
}

/**
 * What the change did to each of `ids` that it touched (absent: untouched). A file or a symbol says what happened
 * to its own code; anything else that holds changed files (a folder, a group, a box that opens a map) is `new` when
 * all of it is new, else `inside`, with the counts of what it holds. Lifting goes down through `members` and `opens`,
 * so the service box on the system map counts every changed file of its parts.
 */
export function liftChange(
  model: ExplainerModel,
  change: ChangeRecord,
  ids: Iterable<ElementId>,
): Map<ElementId, BoxChange> {
  const all = files(change);
  const added = new Set(all.filter((f) => f.status === "added").map((f) => f.path));
  const out = new Map<ElementId, BoxChange>();
  for (const id of ids) {
    const held = heldFiles(model, all, id, new Set());
    if (held.size === 0) continue;
    const parsed = parseId(id);
    let status: BoxChange["status"];
    if (parsed.type === "file") {
      const own = [...held][0]!;
      if (own.status === "deleted") continue;
      status = own.status === "added" ? "new" : "changed";
    } else if (parsed.type === "symbol") {
      const sym = model.index.symbol(parsed.symbolId);
      const own = [...held][0]!;
      status = (sym && changeStatusOfRange(own, sym.range)) || "changed";
    } else if (
      parsed.type === "group" &&
      model.members(id).length === 0 &&
      [...held].every((f) => f.status === "deleted")
    ) {
      // a box of only code the change deleted (a design box whose files are gone)
      status = "removed";
    } else {
      status = whollyNew(model, id, held, added) ? "new" : "inside";
    }
    out.set(id, summed(status, [...held]));
  }
  return out;
}

/** The parent folder of each file and folder box of a view: the folders whose deleted files belong on it. */
function viewFolders(view: GraphView): Set<string> {
  const out = new Set<string>();
  for (const id of Array.isArray(view.include) ? view.include : []) {
    if (typeof id !== "string") continue;
    const parsed = parseId(id);
    if (parsed.type === "file" || parsed.type === "dir") out.add(dirOf(parsed.path));
  }
  return out;
}

/**
 * The deleted files and folders a graph view would draw if they still existed: a deleted file whose folder is
 * the folder the view's file and folder boxes are in, or, for a whole folder that is gone, that folder as one
 * box. A deleted file inside a folder that is still a box of the view is counted on that box (`liftChange`),
 * never drawn twice. Files the view's `excludeFiles` leaves out are left out. Sorted by path.
 */
export function removedBoxes(
  model: ExplainerModel,
  change: ChangeRecord,
  view: GraphView,
): RemovedBox[] {
  return deletedOn(model, files(change), view).map(({ path, kind, held }) => ({
    id: removedId(path),
    path,
    kind,
    label: baseName(path),
    change: summed("removed", held),
  }));
}

function deletedOn(
  model: ExplainerModel,
  all: readonly ChangedFile[],
  view: GraphView,
): { path: FilePath; kind: "file" | "dir"; held: ChangedFile[] }[] {
  const folders = viewFolders(view);
  if (folders.size === 0) return [];
  const exclude = Array.isArray(view.excludeFiles) ? view.excludeFiles : [];
  const byPath = new Map<FilePath, { kind: "file" | "dir"; held: ChangedFile[] }>();
  for (const file of all) {
    if (file.status !== "deleted" || matchesAnyGlob(file.path, exclude)) continue;
    if (folders.has(dirOf(file.path))) {
      byPath.set(file.path, { kind: "file", held: [file] });
      continue;
    }
    // the folder right under one of the view's folders, when nothing of it is left
    for (let dir = dirOf(file.path); dir !== ""; dir = dirOf(dir)) {
      if (!folders.has(dirOf(dir))) continue;
      if (!model.index.hasDirectory(dir)) {
        const known = byPath.get(dir) ?? { kind: "dir" as const, held: [] };
        known.held.push(file);
        byPath.set(dir, known);
      }
      break;
    }
  }
  return [...byPath.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([path, { kind, held }]) => ({ path, kind, held }));
}

/** The words a box shows for what the change did to it: "New", "Changed", "Removed", "2 changed · 1 new". */
export function boxChangeWords(change: BoxChange): string {
  switch (change.status) {
    case "new":
      return "New";
    case "changed":
      return "Changed";
    case "removed":
      return "Removed";
    default: {
      const { added, changed, removed } = change.files;
      return (
        [
          changed.length > 0 ? `${changed.length} changed` : "",
          added.length > 0 ? `${added.length} new` : "",
          removed.length > 0 ? `${removed.length} removed` : "",
        ]
          .filter(Boolean)
          .join(" · ") || "Changed"
      );
    }
  }
}

// ─── What changed, part by part ────────────────────────────────────────────────────────────────

/** A changed file in the "What changed" list. */
export interface LiveFile {
  path: FilePath;
  status: ChangedFile["status"];
  oldPath?: FilePath;
  added: number;
  removed: number;
  /** Where its box is: the deepest map that draws it (a removed box for a deleted file); absent when none does. */
  box?: { id: string; view: string };
  /** The functions, methods, classes and other symbols the change touched in it, in line order. */
  symbols: { name: string; status: "new" | "changed" }[];
}

/** A part of the project (a box of the level under the system map) that the change touched. */
export interface LivePart {
  /** The part's box (`dir:`, `file:`), or a `removed:` box. */
  id: string;
  /** The view it is a box of. */
  view: string;
  label: string;
  change: BoxChange;
  /** The note of its `tour:live` step (`part-<path slug>`), when the explanation has one. */
  note?: string;
  stepId?: string;
  files: LiveFile[];
}

/** A design box of `view:design` that the change touched, in "What changed". */
export interface LiveDesignBox {
  id: ElementId;
  label: string;
  change: BoxChange;
  /** The note of its `tour:live` step (`design-<slug>`), when the explanation has one. */
  note?: string;
  stepId?: string;
  files: LiveFile[];
}

export interface LiveSummary {
  totals: { files: number; added: number; removed: number };
  /** With a design level: its changed boxes in the order of the view, and the changed files in none of them. */
  design?: { view: string; boxes: LiveDesignBox[]; outside: LiveFile[] };
  /** The changed parts, in the order of their view. */
  parts: LivePart[];
  /** Changed files no part holds (tests, settings, files outside the maps). */
  elsewhere: LiveFile[];
}

/** The slug of a path in ids that name it (`view:map-src-store`, step `part-src-store`). */
export function pathSlug(path: string): string {
  return path
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/** The top map of a guide: `view:system`, else the first graph view no box opens (the design level aside). */
function topView(model: ExplainerModel): GraphView | undefined {
  const system = model.view("view:system");
  if (system?.type === "graph") return system;
  return model.views.find(
    (view): view is GraphView =>
      view.type === "graph" && view.id !== DESIGN_VIEW_ID && zoomTrail(model, view.id).length === 0,
  );
}

/**
 * The views of the parts: the maps the boxes of the top map open (`view:system` -> `view:overview`). The top map
 * is `view:system`, else the first graph view no box opens. A guide whose top map opens nothing has its parts on
 * the top map itself.
 */
export function partViews(model: ExplainerModel): GraphView[] {
  const top = topView(model);
  if (!top) return [];
  const out: GraphView[] = [];
  for (const id of Array.isArray(top.include) ? top.include : []) {
    const opened = typeof id === "string" ? opensView(model, id) : undefined;
    if (opened?.type === "graph" && !out.includes(opened)) out.push(opened);
  }
  return out.length > 0 ? out : [top];
}

const partNote = (tour: Tour | undefined, path: string, id: string): TourStep | undefined => {
  const steps = Array.isArray(tour?.steps) ? tour.steps : [];
  return (
    steps.find((s) => s.id === `part-${pathSlug(path)}`) ??
    steps.find((s) => s.id.startsWith("part-") && Array.isArray(s.focus) && s.focus.includes(id))
  );
};

/**
 * The "What changed" list of a live page: the totals, then each changed part of the level under the system map
 * (removed ones too) with its changed files, each with the symbols it touched and where its box is, and the note of
 * the part's step in `tour` (`tour:live`) when there is one. Files no part holds come last.
 */
export function liveSummary(
  model: ExplainerModel,
  change: ChangeRecord,
  tour?: Tour,
  getText?: (file: FilePath) => string | undefined,
): LiveSummary {
  const all = files(change);
  const analysis = analyzeChange(change, model.index, getText);
  const symbols = new Map<FilePath, LiveFile["symbols"]>();
  for (const sym of [...analysis.symbols, ...analysis.testSymbols]) {
    const list = symbols.get(sym.file) ?? [];
    list.push({ name: sym.symbolId.slice(sym.symbolId.indexOf("#") + 1), status: sym.status });
    symbols.set(sym.file, list);
  }

  // where each changed file is drawn: the deepest map with its box
  const graphs = model.views.filter((v): v is GraphView => v.type === "graph");
  const depth = new Map(graphs.map((v) => [v.id, zoomTrail(model, v.id).length]));
  const where = new Map<FilePath, { id: string; view: string; depth: number }>();
  const place = (path: FilePath, id: string, view: string) => {
    const d = depth.get(view) ?? 0;
    const known = where.get(path);
    if (!known || d > known.depth) where.set(path, { id, view, depth: d });
  };
  for (const view of graphs) {
    const include = new Set(Array.isArray(view.include) ? view.include : []);
    for (const file of all)
      if (include.has(`file:${file.path}`)) place(file.path, `file:${file.path}`, view.id);
    for (const box of removedBoxes(model, change, view))
      if (box.kind === "file") place(box.path, box.id, view.id);
  }
  const fileRow = (file: ChangedFile): LiveFile => {
    const box = where.get(file.path);
    return {
      path: file.path,
      status: file.status,
      ...(file.status === "renamed" && file.oldPath ? { oldPath: file.oldPath } : {}),
      ...linesOf(file),
      ...(box ? { box: { id: box.id, view: box.view } } : {}),
      symbols: symbols.get(file.path) ?? [],
    };
  };

  const parts: LivePart[] = [];
  const held = new Set<FilePath>();
  const seen = new Set<string>();
  for (const view of partViews(model)) {
    const include = (Array.isArray(view.include) ? view.include : []).filter(
      (id): id is string => typeof id === "string" && !seen.has(id),
    );
    const lifted = liftChange(model, change, include);
    const rows: LivePart[] = include.flatMap((id) => {
      const boxChange = lifted.get(id);
      if (!boxChange) return [];
      seen.add(id);
      const parsed = parseId(id);
      const path = parsed.type === "file" || parsed.type === "dir" ? parsed.path : id;
      const step = partNote(tour, path, id);
      const mine = [
        ...boxChange.files.changed,
        ...boxChange.files.added,
        ...boxChange.files.removed,
      ];
      return [
        {
          id,
          view: view.id,
          label: model.label(id),
          change: boxChange,
          ...(step?.note ? { note: step.note, stepId: step.id } : {}),
          files: all.filter((f) => mine.includes(f.path)).map(fileRow),
        },
      ];
    });
    for (const box of removedBoxes(model, change, view)) {
      if (seen.has(box.id)) continue;
      seen.add(box.id);
      const step = partNote(tour, box.path, box.id);
      rows.push({
        id: box.id,
        view: view.id,
        label: box.label,
        change: box.change,
        ...(step?.note ? { note: step.note, stepId: step.id } : {}),
        files: all.filter((f) => box.change.files.removed.includes(f.path)).map(fileRow),
      });
    }
    for (const row of rows) for (const file of row.files) held.add(file.path);
    parts.push(...rows);
  }
  const level = designLevel(model);
  let design: LiveSummary["design"];
  if (level) {
    const ids = (Array.isArray(level.view.include) ? level.view.include : []).filter(
      (id): id is string => typeof id === "string" && isDesignBox(id),
    );
    const lifted = liftChange(model, change, ids);
    const steps = Array.isArray(tour?.steps) ? tour.steps : [];
    const inBox = new Set<FilePath>();
    const boxes = ids.flatMap((id): LiveDesignBox[] => {
      const boxChange = lifted.get(id);
      if (!boxChange) return [];
      const mine = new Set([
        ...boxChange.files.changed,
        ...boxChange.files.added,
        ...boxChange.files.removed,
      ]);
      for (const path of mine) inBox.add(path);
      const step = steps.find((s) => s.id === designStepId(id));
      return [
        {
          id,
          label: model.label(id),
          change: boxChange,
          ...(step?.note ? { note: step.note, stepId: step.id } : {}),
          files: all.filter((f) => mine.has(f.path)).map(fileRow),
        },
      ];
    });
    design = {
      view: level.view.id,
      boxes,
      outside: all.filter((f) => !inBox.has(f.path)).map(fileRow),
    };
  }
  return {
    ...(design ? { design } : {}),
    totals: {
      files: all.length,
      added: all.reduce((n, f) => n + linesOf(f).added, 0),
      removed: all.reduce((n, f) => n + linesOf(f).removed, 0),
    },
    parts,
    elsewhere: all.filter((f) => !held.has(f.path)).map(fileRow),
  };
}

// ─── The design level ──────────────────────────────────────────────────────────────────────────

/**
 * The design level of a guide and the view it is a lens of: the map of the parts (`view:overview`) when the system
 * map has one service, else the system map itself (several programs, or parts drawn on it). Undefined without a
 * graph view `view:design`.
 */
export function designLevel(model: ExplainerModel): { view: GraphView; of: GraphView } | undefined {
  const view = model.view(DESIGN_VIEW_ID);
  const top = topView(model);
  if (view?.type !== "graph" || !top) return undefined;
  const parts = partViews(model);
  return { view, of: parts.length === 1 && parts[0] !== view ? parts[0]! : top };
}

/** `zoomTrail` on a live page: the design level sits on the trail of the view it is a lens of. */
export function liveTrail(model: ExplainerModel, viewId: string): ZoomLevel[] {
  if (viewId === DESIGN_VIEW_ID) {
    const level = designLevel(model);
    if (level) return zoomTrail(model, level.of.id);
  }
  return zoomTrail(model, viewId);
}

/** The files a design box holds now: its `file:` members and the files under its `dir:` members. */
export function designFiles(model: ExplainerModel, box: ElementId): Set<FilePath> {
  const out = new Set<FilePath>();
  for (const member of model.members(box)) {
    const parsed = parseId(member);
    if (parsed.type === "file") out.add(parsed.path);
    else if (parsed.type === "dir")
      for (const path of model.index.filesUnder(parsed.path)) out.add(path);
  }
  return out;
}

/**
 * The source files the change added that no design box holds (not tests, and not what the level the design is a
 * lens of leaves out with `excludeFiles`): what the agent still has to place. Empty without a design level.
 */
export function unassignedFiles(model: ExplainerModel): FilePath[] {
  const level = designLevel(model);
  const change = model.explainer.change;
  if (!level || !change) return [];
  const held = new Set<FilePath>();
  for (const node of model.explainer.nodes)
    if (isDesignBox(node.id)) for (const path of designFiles(model, node.id)) held.add(path);
  const exclude = Array.isArray(level.of.excludeFiles) ? level.of.excludeFiles : [];
  return files(change)
    .filter(
      (f) =>
        f.status === "added" &&
        CODE_LANGUAGES.has(model.index.file(f.path)?.language ?? "") &&
        !isTestFile(f.path) &&
        !matchesAnyGlob(f.path, exclude) &&
        !held.has(f.path),
    )
    .map((f) => f.path);
}
