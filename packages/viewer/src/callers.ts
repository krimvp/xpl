/**
 * "Who calls this": the code that calls (or extends, implements) a file or a symbol, from the index's
 * references, one row per calling symbol (its first call site). Calls from inside the element itself are
 * left out: a method calling its own class is not an answer to "who uses this". A function that calls itself
 * gets one "itself (recursion)" row with every line it does so.
 *
 * And what a change did to an element ("Added by this change", "+5 −2 in it"), for the details of a picked
 * box and the guide of a change.
 */
import {
  codeFocus,
  deriveGraph,
  derivedEdgeMap,
  elementIdForSymbolId,
  parseId,
  relatedFiles,
  viewCandidates,
  type FocusOptions,
  type ChangeRecord,
  type ElementId,
  type ExplainerModel,
  type FilePath,
  type IndexedSymbol,
  type IndexModel,
  type SymbolId,
} from "@xpl/core";
import { changeAt, changeStatus, fileDiff } from "./diff.js";

/** One caller: the symbol (or a file's top level) that calls, and where. */
export interface Caller {
  from: SymbolId;
  /** `Runner.dispatch`, or `main.ts (top level)`. */
  label: string;
  file: FilePath;
  line: number;
  /** A function's calls to itself: every line, in order (`line` is the first). */
  recursion?: number[];
}

const USES = new Set(["call", "extends", "implements"]);

const base = (path: string) => path.slice(path.lastIndexOf("/") + 1);

/** What `id` (a file or a symbol) is called from; empty for any other element. Sorted by file, then line. */
export function callersOf(id: ElementId, index: IndexModel): Caller[] {
  const parsed = parseId(id);
  let targets: SymbolId[];
  let inside: (from: SymbolId) => boolean;
  if (parsed.type === "symbol") {
    const prefix = parsed.symbolId;
    targets = index
      .symbolsInFile(parsed.file)
      .filter((sym) => sym.id === prefix || sym.id.startsWith(prefix + "."))
      .map((sym) => sym.id);
    inside = (from) => from === prefix || from.startsWith(prefix + ".");
  } else if (parsed.type === "file") {
    targets = [`${parsed.path}#`, ...index.symbolsInFile(parsed.path).map((sym) => sym.id)];
    inside = (from) => index.fileOfSymbolId(from) === parsed.path;
  } else return [];
  const byCaller = new Map<SymbolId, Caller>();
  const selfLines = new Set<number>();
  for (const target of targets) {
    for (const ref of index.refsTo(target)) {
      const recursive = parsed.type === "symbol" && ref.from === parsed.symbolId;
      if (recursive && ref.kind === "call" && target === parsed.symbolId)
        selfLines.add(ref.site.startLine);
      if (!USES.has(ref.kind) || inside(ref.from)) continue;
      const known = byCaller.get(ref.from);
      const file = index.fileOfSymbolId(ref.from) ?? ref.from.slice(0, ref.from.indexOf("#"));
      if (known && known.line <= ref.site.startLine) continue;
      const sym = index.symbol(ref.from);
      byCaller.set(ref.from, {
        from: ref.from,
        label: sym ? sym.path : `${base(file)} (top level)`,
        file,
        line: ref.site.startLine,
      });
    }
  }
  const out = [...byCaller.values()].sort(
    (a, b) => a.file.localeCompare(b.file) || a.line - b.line,
  );
  if (selfLines.size > 0 && parsed.type === "symbol") {
    const lines = [...selfLines].sort((a, b) => a - b);
    out.unshift({
      from: parsed.symbolId,
      label: "itself (recursion)",
      file: parsed.file,
      line: lines[0]!,
      recursion: lines,
    });
  }
  return out;
}

/** What the change did to a file or a symbol, in a reader's words, and where to look at it. */
export interface ChangeSummary {
  /** "Added by this change", "Edited by this change", "Renamed by this change, from old/path". */
  words: string;
  /** Lines the change added or rewrote in the element, and the lines it removed from it. */
  added: number;
  deleted: number;
  /** All of it: "Edited by this change · +5 −1". */
  text: string;
  file: FilePath;
  /** The line to open the file at: the first change inside the element. */
  line: number;
}

export function changeSummary(
  id: ElementId,
  index: IndexModel,
  change: ChangeRecord | undefined,
): ChangeSummary | undefined {
  if (!change) return undefined;
  const parsed = parseId(id);
  const path =
    parsed.type === "file" ? parsed.path : parsed.type === "symbol" ? parsed.file : undefined;
  const file = path ? changeAt(change, path) : undefined;
  if (!path || !file || file.status === "deleted") return undefined;
  const diff = fileDiff(file);
  const lines = [...diff.lines.keys(), ...diff.removed.map((block) => block.at)];
  const summary = (words: string, added: number, deleted: number, line: number) => ({
    words,
    added,
    deleted,
    text: `${words} · +${added} −${deleted}`,
    file: path,
    line,
  });
  if (parsed.type === "file") {
    const words =
      file.status === "added"
        ? "Added by this change"
        : file.status === "renamed"
          ? `Renamed by this change, from ${file.oldPath ?? "?"}`
          : "Edited by this change";
    return summary(
      words,
      diff.added,
      diff.deleted,
      Math.min(...lines.filter((n) => n >= 1), Infinity) || 1,
    );
  }
  const status = changeStatus(id, index, change);
  const sym = parsed.type === "symbol" ? index.symbol(parsed.symbolId) : undefined;
  if (!status || !sym) return undefined;
  const { startLine, endLine } = sym.range;
  const inside = (n: number) => n >= startLine && n <= endLine;
  const within = lines.filter(inside);
  // Removed lines count where they sit: above a line of the symbol, or below one that is not its last.
  const deleted = diff.removed
    .filter((block) => inside(block.at) && !(block.place === "after" && block.at === endLine))
    .reduce((sum, block) => sum + block.to - block.from + 1, 0);
  return summary(
    status === "new" ? "Added by this change" : "Edited by this change",
    [...diff.lines.keys()].filter(inside).length,
    deleted,
    within.length ? Math.min(...within) : startLine,
  );
}

/**
 * The element whose callers answer "who calls this": a file or a symbol itself; for a flow step inside one
 * part (from = to), the symbol that holds its code (a step of `findRoute` asks who calls `findRoute`, not who
 * calls its file). Undefined for anything else.
 */
export function callerSubject(id: ElementId, model: ExplainerModel): ElementId | undefined {
  const parsed = parseId(id);
  if (parsed.type === "file" || parsed.type === "symbol") return id;
  const element = model.element(id);
  if (element?.type !== "step" || element.step.from !== element.step.to) return undefined;
  const first = codeFocus([id], model)[0];
  const holder = first
    ? model.index.innermostSymbolAt(first.file, first.range.startLine)
    : undefined;
  if (holder) return elementIdForSymbolId(holder.id);
  const owner = parseId(element.step.from).type;
  return owner === "symbol" || owner === "file" ? element.step.from : undefined;
}

/** The last name of a symbol path, as the code writes it: `Ky.#retry` -> `retry`, `Signer.sign` -> `sign`. */
const nameOf = (path: string) => path.slice(path.lastIndexOf(".") + 1).replace(/^#/, "");

/**
 * The symbol a name in the code stands for, at a line of a file: what a reference on that line points at, or
 * the symbol declared there. Undefined when the index knows neither.
 */
export function symbolAtWord(
  index: IndexModel,
  file: FilePath,
  line: number,
  word: string,
): IndexedSymbol | undefined {
  const name = word.replace(/^#/, "");
  if (!name) return undefined;
  for (const from of [index.moduleScopeId(file), ...index.symbolsInFile(file).map((s) => s.id)]) {
    for (const ref of index.refsFrom(from)) {
      if (ref.site.startLine > line || ref.site.endLine < line || ref.kind === "import") continue;
      const target = index.symbol(ref.to);
      if (target && nameOf(target.path) === name) return target;
    }
  }
  // A declaration: the symbol of that name whose range starts on that line (or just above: a decorator).
  return index
    .symbolsInFile(file)
    .filter(
      (sym) =>
        nameOf(sym.path) === name && sym.range.startLine <= line && line <= sym.range.startLine + 3,
    )
    .sort((a, b) => b.range.startLine - a.range.startLine)[0];
}

/** The files the explainer itself points at: its boxes, anchors, steps' code, and the change. */
function explainedFiles(model: ExplainerModel, change: ChangeRecord | undefined): Set<FilePath> {
  const out = new Set<FilePath>();
  const addId = (id: unknown) => {
    if (typeof id !== "string") return;
    const parsed = parseId(id);
    if (parsed.type === "file") out.add(parsed.path);
    else if (parsed.type === "symbol") out.add(parsed.file);
  };
  const addAnchors = (anchors: unknown) => {
    if (!Array.isArray(anchors)) return;
    for (const anchor of anchors as { file?: unknown }[])
      if (typeof anchor?.file === "string") out.add(anchor.file);
  };
  const { nodes, edges, concepts, views, tours } = model.explainer;
  for (const node of nodes) {
    addId(node.id);
    addAnchors(node.anchors);
    for (const member of node.members ?? []) addId(member);
  }
  for (const element of [...edges, ...concepts]) addAnchors(element.anchors);
  for (const view of views)
    if (view.type !== "graph") for (const step of view.steps ?? []) addAnchors(step.anchors);
  for (const tour of tours) for (const step of tour.steps) addAnchors(step.code);
  for (const file of change?.files ?? []) out.add(file.path);
  // What the views and the tours show: the code of their boxes, arrows and steps, and their related files.
  const add = (ids: readonly ElementId[], options: FocusOptions = {}) => {
    for (const focus of codeFocus(ids, model, options)) out.add(focus.file);
    for (const link of relatedFiles(ids, model)) for (const file of link.files) out.add(file);
  };
  for (const view of model.views) {
    const graph = view.type === "graph" ? deriveGraph(view, model) : undefined;
    add(viewCandidates(view, model, graph), graph ? { derivedEdges: derivedEdgeMap(graph) } : {});
  }
  for (const tour of model.tours) for (const step of tour.steps) add(step.focus ?? []);
  return out;
}

/**
 * Files the page carries for context only (`xpl bundle --files boundary`): nothing in the explainer points at
 * them. Each with why it is there, in a reader's words ("Ky.create calls it", "it calls Ky.create"), or ""
 * when the index does not say.
 */
export function contextFiles(
  model: ExplainerModel,
  files: readonly FilePath[],
  change: ChangeRecord | undefined,
): Map<FilePath, string> {
  const explained = explainedFiles(model, change);
  const index = model.index;
  const out = new Map<FilePath, string>();
  for (const file of files) {
    if (explained.has(file)) continue;
    const ids = [index.moduleScopeId(file), ...index.symbolsInFile(file).map((sym) => sym.id)];
    const label = (id: SymbolId) => index.symbol(id)?.path ?? base(id.slice(0, id.indexOf("#")));
    const outside = (id: SymbolId) => {
      const at = index.fileOfSymbolId(id);
      return at !== undefined && at !== file && explained.has(at);
    };
    let why = "";
    for (const id of ids) {
      const caller = index.refsTo(id).find((ref) => USES.has(ref.kind) && outside(ref.from));
      if (caller) {
        why = `${label(caller.from)} calls it`;
        break;
      }
    }
    if (!why) {
      for (const id of ids) {
        const callee = index.refsFrom(id).find((ref) => USES.has(ref.kind) && outside(ref.to));
        if (callee) {
          why = `it calls ${label(callee.to)}`;
          break;
        }
      }
    }
    out.set(file, why);
  }
  return out;
}
