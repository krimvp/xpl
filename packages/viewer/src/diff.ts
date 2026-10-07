/**
 * The change an explainer is about (`Explainer.change`, written by `xpl change <name> <base>..<head>`), as the
 * viewer shows it. Pure: the store, the editor and the diagrams read their part of it from here.
 *
 * - `fileDiff`: for one changed file, the head lines the change added or rewrote, where its removed lines go
 *   between the head lines (the editor shows them there, read-only, from `baseFiles`), and the base lines it
 *   removes or rewrites (marked in a "before" pane).
 * - `changeStatus`: "new" or "changed" for a file or symbol node (the map's badges): whether its lines overlap
 *   the change.
 * - `changeFiles`: the list the Guide shows under the tour summary ("Files in this change").
 *
 * Lines are 1-based as in git. A hunk is what `git diff -U0` prints: `oldLines` base lines from `oldStart` were
 * replaced by `newLines` head lines from `newStart`; with a count of 0 the start is the line after which the
 * insertion or deletion happened (0: at the top).
 */
import {
  changedFile,
  changeStatusOfRange,
  changeShapeIssues,
  hasBaseVersion,
  isTestFile,
  parseId,
  type ChangedFile,
  type ChangeRecord,
  type ElementId,
  type Explainer,
  type FilePath,
  type IndexModel,
} from "@xpl/core";
import type { PaneDiff } from "./editor.js";

const checked = new WeakMap<object, ChangeRecord | null>();

/**
 * The explainer's change record, when it has a sound one. A record that `validate` would reject (a hand edit)
 * is ignored: the viewer then shows the code without a diff rather than a wrong one.
 */
export function changeOf(explainer: Pick<Explainer, "change">): ChangeRecord | undefined {
  const value: unknown = explainer.change;
  if (typeof value !== "object" || value === null) return undefined;
  let known = checked.get(value);
  if (known === undefined) {
    known = changeShapeIssues(value).length === 0 ? (value as ChangeRecord) : null;
    checked.set(value, known);
  }
  return known ?? undefined;
}

/** The changed file at this head path (a deleted file: its base path). Not the old path of a renamed file. */
export function changeAt(
  change: ChangeRecord | undefined,
  file: FilePath,
): ChangedFile | undefined {
  const found = changedFile(change, file);
  return found?.path === file ? found : undefined;
}

/** What the change did to a head line: added (a pure insertion) or changed (it replaces removed lines). */
export type LineMark = "added" | "changed";

/** Base lines the change removed, and where they go between the head lines. */
export interface RemovedBlock {
  /**
   * The head line they sit at: above it (`before`: the lines it replaced, or a deletion at the top), or below
   * it (`after`: a pure deletion after that line).
   */
  at: number;
  place: "before" | "after";
  /** The removed base lines, `from` to `to`. */
  from: number;
  to: number;
}

export interface FileDiff {
  /** Head lines the change added or rewrote. */
  lines: ReadonlyMap<number, LineMark>;
  /** Removed base lines, in head order. */
  removed: readonly RemovedBlock[];
  /** Base lines the change removes or rewrites (what a "before" pane marks). */
  gone: ReadonlySet<number>;
  /** Line counts, like `git diff --numstat`. */
  added: number;
  deleted: number;
}

/** Character offsets within a line, end exclusive. Only a visual hint; source ranges stay line based. */
export interface WordSpan {
  from: number;
  to: number;
}

/** The smallest changed run of words, punctuation or whitespace on two rewritten lines. */
function changedWords(before: string, after: string): { before: WordSpan; after: WordSpan } | null {
  if (before === after) return null;
  const tokens = (text: string) =>
    [...text.matchAll(/\s+|[\p{L}\p{N}_$]+|[^\s\p{L}\p{N}_$]+/gu)].map((m) => m[0]);
  const old = tokens(before);
  const next = tokens(after);
  let start = 0;
  while (start < old.length && start < next.length && old[start] === next[start]) start++;
  let oldEnd = old.length;
  let nextEnd = next.length;
  while (oldEnd > start && nextEnd > start && old[oldEnd - 1] === next[nextEnd - 1]) {
    oldEnd--;
    nextEnd--;
  }
  const offset = (parts: string[], end: number) => parts.slice(0, end).join("").length;
  return {
    before: { from: offset(old, start), to: offset(old, oldEnd) },
    after: { from: offset(next, start), to: offset(next, nextEnd) },
  };
}

/** Pair nearby rewrites within a hunk; unpaired lines keep only their existing line-level marks. */
function alignedLines(before: readonly string[], after: readonly string[]): [number, number][] {
  const oldCount = before.length;
  const newCount = after.length;
  if (oldCount === 1 && newCount === 1) return [[0, 0]];
  // Large replacement hunks remain readable as whole-line diffs without quadratic alignment work.
  if (oldCount === 0 || newCount === 0 || oldCount > 80 || newCount > 80) return [];
  const cost = Array.from({ length: oldCount + 1 }, () => new Array<number>(newCount + 1).fill(0));
  const step = Array.from(
    { length: oldCount + 1 },
    () => new Array<"pair" | "old" | "new">(newCount + 1),
  );
  for (let i = 1; i <= oldCount; i++) cost[i]![0] = i * 0.5;
  for (let j = 1; j <= newCount; j++) cost[0]![j] = j * 0.5;
  for (let i = 1; i <= oldCount; i++) {
    for (let j = 1; j <= newCount; j++) {
      const old = before[i - 1]!.trimStart();
      const next = after[j - 1]!.trimStart();
      let prefix = 0;
      while (prefix < old.length && prefix < next.length && old[prefix] === next[prefix]) prefix++;
      let suffix = 0;
      while (
        suffix < old.length - prefix &&
        suffix < next.length - prefix &&
        old[old.length - 1 - suffix] === next[next.length - 1 - suffix]
      )
        suffix++;
      const similarity = (prefix + suffix) / Math.max(old.length, next.length, 1);
      const drop = cost[i - 1]![j]! + 0.5;
      const add = cost[i]![j - 1]! + 0.5;
      const pair = similarity >= 0.25 ? cost[i - 1]![j - 1]! + 1 - similarity : Infinity;
      if (pair < drop && pair < add) {
        cost[i]![j] = pair;
        step[i]![j] = "pair";
      } else if (drop <= add) {
        cost[i]![j] = drop;
        step[i]![j] = "old";
      } else {
        cost[i]![j] = add;
        step[i]![j] = "new";
      }
    }
  }
  const pairs: [number, number][] = [];
  for (let i = oldCount, j = newCount; i > 0 && j > 0;) {
    switch (step[i]![j]) {
      case "pair":
        pairs.push([--i, --j]);
        break;
      case "old":
        i--;
        break;
      default:
        j--;
    }
  }
  return pairs.reverse();
}

const diffs = new WeakMap<ChangedFile, FileDiff>();

/** The diff of one changed file, from its hunks. */
export function fileDiff(file: ChangedFile): FileDiff {
  const known = diffs.get(file);
  if (known) return known;
  const lines = new Map<number, LineMark>();
  const removed: RemovedBlock[] = [];
  const gone = new Set<number>();
  let added = 0;
  let deleted = 0;
  const hunks = (Array.isArray(file.hunks) ? file.hunks : [])
    .slice()
    .sort((a, b) => a.newStart - b.newStart || a.oldStart - b.oldStart);
  for (const hunk of hunks) {
    added += hunk.newLines;
    deleted += hunk.oldLines;
    const mark: LineMark = hunk.oldLines > 0 ? "changed" : "added";
    for (let n = hunk.newStart; n < hunk.newStart + hunk.newLines; n++) lines.set(n, mark);
    if (hunk.oldLines > 0) {
      for (let n = hunk.oldStart; n < hunk.oldStart + hunk.oldLines; n++) gone.add(n);
      const block = { from: hunk.oldStart, to: hunk.oldStart + hunk.oldLines - 1 };
      if (hunk.newLines > 0) removed.push({ at: hunk.newStart, place: "before", ...block });
      else if (hunk.newStart <= 0) removed.push({ at: 1, place: "before", ...block });
      else removed.push({ at: hunk.newStart, place: "after", ...block });
    }
  }
  const diff = { lines, removed, gone, added, deleted };
  diffs.set(file, diff);
  return diff;
}

/** The first head line the change touches (where the code view opens a changed file); 1 when none. */
export function firstChangedLine(file: ChangedFile): number {
  const diff = fileDiff(file);
  const first = Math.min(...diff.lines.keys(), ...diff.removed.map((block) => block.at));
  return Number.isFinite(first) && first >= 1 ? first : 1;
}

/** What the map says about a box: the change added all of it ("new"), or some of it ("changed"). */
export type ChangeStatus = "new" | "changed";

/**
 * The change status of a graph node: a file the change added is new, any other changed file is changed; a
 * symbol is new when the change purely inserted every line of it, changed when it rewrote or removed lines
 * inside it. Other nodes (groups, directories) and unchanged code have none.
 */
export function changeStatus(
  id: ElementId,
  index: Pick<IndexModel, "symbol">,
  change: ChangeRecord,
): ChangeStatus | undefined {
  const parsed = parseId(id);
  if (parsed.type === "file") {
    const file = changeAt(change, parsed.path);
    if (!file || file.status === "deleted") return undefined;
    return file.status === "added" ? "new" : "changed";
  }
  if (parsed.type !== "symbol") return undefined;
  const file = changeAt(change, parsed.file);
  if (!file || file.status === "deleted") return undefined;
  if (file.status === "added") return "new";
  const sym = index.symbol(parsed.symbolId);
  if (!sym) return undefined;
  return changeStatusOfRange(file, sym.range);
}

/** One row of "Files in this change". */
export interface ChangeFileRow {
  path: FilePath;
  status: ChangedFile["status"];
  oldPath?: FilePath;
  added: number;
  deleted: number;
  /** A test file (`isTestFile`). */
  test: boolean;
  /** The line the code view opens it at (the first change), in the head file; base line 1 for a deleted file. */
  line: number;
}

/** The changed files, source files first (in the record's order), then the test files. */
export function changeFiles(change: ChangeRecord): ChangeFileRow[] {
  const rows = change.files.map((file): ChangeFileRow => {
    const diff = fileDiff(file);
    return {
      path: file.path,
      status: file.status,
      ...(file.status === "renamed" && file.oldPath ? { oldPath: file.oldPath } : {}),
      added: diff.added,
      deleted: diff.deleted,
      test: isTestFile(file.path),
      line: file.status === "deleted" ? 1 : firstChangedLine(file),
    };
  });
  return [...rows.filter((row) => !row.test), ...rows.filter((row) => row.test)];
}

/** Most changed files a change can have for the tree to widen to their names. */
const WIDE_TREE_FILES = 40;

/**
 * How wide the file tree of a change explainer should be (px) so that the names of the changed files show
 * whole: `test-d/response-size.ts` and `test/response-size.ts` must not both read "response-siz…". Undefined
 * without a change, or with too many files to make room for all; at most 300.
 */
export function changeTreeWidth(change: ChangeRecord | undefined): number | undefined {
  if (!change || change.files.length === 0 || change.files.length > WIDE_TREE_FILES)
    return undefined;
  // a row: its indent (14px a level, the file's own 14px), the name at about 7.2px a character, the mark
  const widest = Math.max(
    ...change.files.map((file) => {
      const parts = file.path.split("/");
      return 8 + parts.length * 14 + parts[parts.length - 1]!.length * 7.2 + 36;
    }),
  );
  return Math.min(300, Math.ceil(widest));
}

/** The words for a file's status, as a reader sees them. */
export const STATUS_WORDS: Record<ChangedFile["status"], string> = {
  added: "New",
  modified: "Changed",
  deleted: "Removed",
  renamed: "Renamed",
};

/** Whether the code before the change of this file can be shown (modified, renamed or deleted). */
export function hasBase(change: ChangeRecord | undefined, file: FilePath): boolean {
  const found = changeAt(change, file);
  return found !== undefined && hasBaseVersion(found);
}

/** Whether the head pane of this file needs the base text: the change removed lines from it. */
export function needsBase(change: ChangeRecord | undefined, file: FilePath): boolean {
  const found = changeAt(change, file);
  return found !== undefined && found.status !== "added" && fileDiff(found).removed.length > 0;
}

/**
 * What the change did to the file of a pane, for the editor (`applyDiff`): on a pane of the code as it is
 * (`side` undefined), the added and rewritten lines and the removed ones in between (their text from the code
 * before the change, `baseLines`; without it the editor says why: `missing`); on a "Before" pane (`side:
 * "base"`), the lines the change removes or rewrites. Null: nothing to mark.
 */
export function paneDiff(
  side: "base" | undefined,
  changed: ChangedFile | undefined,
  baseLines: readonly string[] | undefined,
  missing: string | undefined,
  headLines?: readonly string[],
): PaneDiff | null {
  if (!changed) return null;
  const diff = fileDiff(changed);
  const headWords = new Map<number, WordSpan>();
  const baseWords = new Map<number, WordSpan>();
  if (baseLines && headLines) {
    for (const hunk of changed.hunks) {
      const oldText = baseLines.slice(hunk.oldStart - 1, hunk.oldStart + hunk.oldLines - 1);
      const newText = headLines.slice(hunk.newStart - 1, hunk.newStart + hunk.newLines - 1);
      for (const [oldIndex, newIndex] of alignedLines(oldText, newText)) {
        const oldLine = hunk.oldStart + oldIndex;
        const newLine = hunk.newStart + newIndex;
        const before = baseLines[oldLine - 1];
        const after = headLines[newLine - 1];
        if (before === undefined || after === undefined) continue;
        const spans = changedWords(before, after);
        if (!spans) continue;
        if (spans.before.to > spans.before.from) baseWords.set(oldLine, spans.before);
        if (spans.after.to > spans.after.from) headWords.set(newLine, spans.after);
      }
    }
  }
  if (side === "base") return diff.gone.size > 0 ? { gone: diff.gone, words: baseWords } : null;
  if (changed.status === "deleted") return null;
  return {
    lines: diff.lines,
    words: headWords,
    removed: diff.removed.map((block) => {
      const count = block.to - block.from + 1;
      return {
        at: block.at,
        place: block.place,
        from: block.from,
        count,
        text: baseLines?.slice(block.from - 1, block.to),
        ...(baseWords.size ? { words: baseWords } : {}),
        ...(baseLines === undefined ? { missing: missing ?? "loading" } : {}),
      };
    }),
  };
}

/** The language of a file the index does not know (a deleted file), from its extension. */
export function languageOfPath(path: FilePath): import("@xpl/core").FileLanguage {
  const ext = path.slice(path.lastIndexOf(".")).toLowerCase();
  switch (ext) {
    case ".ts":
    case ".mts":
    case ".cts":
      return "typescript";
    case ".tsx":
      return "tsx";
    case ".js":
    case ".mjs":
    case ".cjs":
    case ".jsx":
      return "javascript";
    case ".py":
    case ".pyi":
      return "python";
    case ".rs":
      return "rust";
    case ".go":
      return "go";
    case ".yaml":
    case ".yml":
      return "yaml";
    case ".json":
      return "json";
    case ".toml":
      return "toml";
    default:
      return "text";
  }
}

/**
 * The change status of each node of a graph that the change touched (the map's "New" / "Changed" pills). A box
 * that holds code without being a file or a symbol (a group, a directory) is "changed" when one of the files
 * it covers (`filesOf`) is: a reader sees which part of the map the change is in without opening each box.
 */
export function changeMarks(
  nodeIds: readonly ElementId[],
  index: Pick<IndexModel, "symbol">,
  change: ChangeRecord | undefined,
  filesOf?: (id: ElementId) => Iterable<FilePath>,
): Map<ElementId, ChangeStatus> {
  const marks = new Map<ElementId, ChangeStatus>();
  if (!change) return marks;
  for (const id of nodeIds) {
    const status = changeStatus(id, index, change);
    if (status) marks.set(id, status);
    else if (filesOf && !["file", "symbol"].includes(parseId(id).type)) {
      for (const file of filesOf(id)) {
        if (changeAt(change, file)) {
          marks.set(id, "changed");
          break;
        }
      }
    }
  }
  return marks;
}
