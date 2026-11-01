/**
 * `xpl draft map`: the quick map of a whole project. Where `draft repo` draws the architecture top-down and leaves the
 * grouping to the writer, a map covers every code file, so a reader can find any file by what it does:
 *
 * - One graph view per folder (`view:map` for the top, `view:map-<path>` below it), holding its sub-folders and its
 *   files. A folder box `opens` the view of its own folder, so the reader zooms from the project down to one file. The
 *   top starts below folders that hold all the code (`src/`); a folder of one file is that file, and a folder that only
 *   holds one folder is that folder.
 * - Every box gets a name and a one-sentence summary to write. The TODO of a file carries what the index knows: its
 *   header comment, what it defines, who uses it and what it uses. That is usually enough to write the sentence
 *   without opening the file.
 * - A tour "start here": the top map, then each top-level folder.
 * - With a change recorded (`xpl change`), a tour of the changed files on their folder's map, one step per file,
 *   asking how each change serves what was asked. Its id names the head commit, so a later change gets a new tour.
 *
 * Run again on a map, it changes only what the code changed: boxes for new files and folders (`includeAdd`), boxes of
 * files that are gone are removed (`remove`, `includeRemove`), and the names and summaries already written stay.
 * Tests, examples, fixtures, docs and benchmarks stay off the map.
 */
import {
  CODE_LANGUAGES,
  DEFAULT_EDGE_KINDS,
  analyzeChange,
  baseName,
  isTestFile,
  matchesAnyGlob,
  type AnchorInput,
  type ExplainerPatch,
  type PatchNode,
  type PatchTourStep,
  type PatchView,
} from "@xpl/core";
import {
  NOT_DESIGN,
  aboutAnchor,
  OVERVIEW_EXCLUDE,
  changedFileAnchor,
  nameList,
  note,
  storedNodeIds,
  todo,
  tourStep,
  type Draft,
  type DraftInput,
} from "./draft.js";
import { plural } from "./format.js";

export const MAP_LIMITS = {
  /** A folder map with more boxes than this gets a note: group them, or split the folder. */
  boxes: 30,
  /** Names in a TODO hint (definitions, users, used files). */
  hints: 4,
  /** Top-level folders the start tour visits. */
  tourParts: 8,
  /** Changed files the change tour visits. */
  changeSteps: 12,
  /** A group proposed on a crowded map holds at most this many files. */
  groupFiles: 8,
  /** A header comment is cut to about this many characters. */
  headerChars: 100,
};

/** The view of a folder: `view:map` for the top, `view:map-<path>` below it. */
function viewIdOf(root: string, path: string): string {
  if (path === root) return "view:map";
  const slug = path
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return `view:map-${slug || "root"}`;
}

/**
 * The first comment of a file, when the file starts with one (after a shebang, blank lines or a Python coding line):
 * its first sentence, without comment markers. `undefined` when the file starts with code.
 */
export function headerComment(lines: readonly string[] | undefined): string | undefined {
  if (!lines) return undefined;
  const text: string[] = [];
  let i = 0;
  while (i < lines.length && /^\s*(?:#!|#.*coding[:=]|$)/.test(lines[i]!)) i++;
  const first = lines[i]?.trim() ?? "";
  const block = /^(?:\/\*\*?|"""|''')/.exec(first);
  /** The line after the comment. */
  let after = i;
  if (block) {
    const close = block[0].startsWith("/*") ? "*/" : block[0];
    for (let n = i; n < lines.length && n < i + 20; n++) {
      let line = lines[n]!.trim();
      if (n === i) line = line.slice(block[0].length);
      const end = line.indexOf(close);
      if (end !== -1) line = line.slice(0, end);
      text.push(line.replace(/^\*\s?/, ""));
      after = n + 1;
      if (end !== -1) break;
    }
  } else if (/^(?:\/\/|#)/.test(first)) {
    for (; after < lines.length && /^\s*(?:\/\/|#)/.test(lines[after]!); after++) {
      text.push(lines[after]!.trim().replace(/^(?:\/\/+|#+)\s?/, ""));
    }
  }
  // a comment right above a declaration is that declaration's doc, not the file's
  const next = lines[after]?.trim() ?? "";
  if (
    next !== "" &&
    !/^(?:import|from|package|module|require|use|["']use strict["'])\b/.test(next)
  ) {
    return undefined;
  }
  const prose = text
    .filter((line) => !/^@\w/.test(line))
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
  if (!/[A-Za-z]{3,}/.test(prose)) return undefined;
  const sentence = /^.*?[.!?](?=\s|$)/.exec(prose)?.[0] ?? prose;
  return sentence.length > MAP_LIMITS.headerChars
    ? `${sentence.slice(0, MAP_LIMITS.headerChars - 1).trimEnd()}…`
    : sentence;
}

interface Folder {
  dirs: string[];
  files: string[];
}

export function draftMap(input: DraftInput): Draft {
  const { explainer, model, texts } = input;
  const stored = storedNodeIds(explainer);
  const notes: string[] = [];

  const offMap = (path: string) =>
    isTestFile(path) ||
    matchesAnyGlob(path, OVERVIEW_EXCLUDE) ||
    matchesAnyGlob(path, NOT_DESIGN) ||
    path.split("/").some((segment) => segment.startsWith("."));
  const isCodeFile = (path: string) => CODE_LANGUAGES.has(model.file(path)?.language ?? "");
  const mapped = (path: string) => isCodeFile(path) && !offMap(path);
  const mappedUnder = (dir: string) => model.filesUnder(dir).filter(mapped);

  /** The boxes of a folder: its sub-folders (a folder that only holds one folder is that folder) and its files. */
  const folderOf = (dir: string): Folder => {
    const { dirs, files } = model.dirChildren(dir);
    const out: Folder = { dirs: [], files: files.filter(mapped) };
    for (const start of dirs) {
      let path = start;
      for (let hops = 0; hops < 32; hops++) {
        const inner = model.dirChildren(path);
        const codeDirs = inner.dirs.filter((d) => mappedUnder(d).length > 0);
        if (inner.files.some(mapped) || codeDirs.length !== 1) break;
        path = codeDirs[0]!;
      }
      const under = mappedUnder(path);
      if (under.length === 1) out.files.push(under[0]!);
      else if (under.length > 1) out.dirs.push(path);
    }
    out.dirs.sort();
    out.files.sort();
    return out;
  };

  let root = "";
  for (let hops = 0; hops < 32; hops++) {
    const top = folderOf(root);
    if (top.files.length > 0 || top.dirs.length !== 1) break;
    root = top.dirs[0]!;
  }
  const allMapped = mappedUnder(root);
  if (allMapped.length === 0) {
    throw new Error(
      "the index has no code files outside tests, docs, examples and benchmarks: there is nothing to map",
    );
  }

  // ── Names in hints: a file's name, or as many of its last folders as it takes to tell it from another mapped file
  // of the same name (`core/src/anchors.ts`, `commands/anchors.ts`).
  const shortNames = new Map<string, string>();
  const byName = new Map<string, string[]>();
  for (const file of allMapped)
    byName.set(baseName(file), [...(byName.get(baseName(file)) ?? []), file]);
  for (const files of byName.values()) {
    for (const file of files) {
      const segments = file.split("/");
      let n = 1;
      const tail = (path: string, k: number) => path.split("/").slice(-k).join("/");
      while (n < segments.length && files.some((o) => o !== file && tail(o, n) === tail(file, n)))
        n++;
      shortNames.set(file, tail(file, n));
    }
  }
  const shortName = (file: string) => shortNames.get(file) ?? baseName(file);
  /** A box's path below the folder whose map shows it (`core/src` in `packages`). */
  const below = (folder: string, path: string) =>
    folder === "" ? path : path.slice(folder.length + 1);

  // ── What the index knows about each file: who uses it and what it uses (code outside tests only).
  const usedBy = new Map<string, Map<string, number>>();
  const uses = new Map<string, Map<string, number>>();
  const bump = (map: Map<string, Map<string, number>>, key: string, other: string) => {
    const inner = map.get(key) ?? new Map<string, number>();
    inner.set(other, (inner.get(other) ?? 0) + 1);
    map.set(key, inner);
  };
  for (const ref of model.refs) {
    const from = model.fileOfSymbolId(ref.from);
    const to = model.fileOfSymbolId(ref.to);
    if (!from || !to || from === to || !mapped(from) || !mapped(to)) continue;
    bump(usedBy, to, from);
    bump(uses, from, to);
  }
  const ranked = (map: Map<string, number> | undefined): string[] =>
    [...(map ?? [])]
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .map(([file]) => shortName(file));
  const definitions = (file: string): string[] => {
    const top = model.topLevelSymbols(file).filter((s) => s.kind !== "other");
    const named = top.filter((s) => s.kind !== "variable" && s.kind !== "key");
    return (named.length > 0 ? named : top).map((s) => s.path);
  };
  const fileHint = (file: string): string => {
    const parts: string[] = [];
    const header = headerComment(texts.lines(file));
    if (header) parts.push(`header: ${JSON.stringify(header)}`);
    const defined = definitions(file);
    if (defined.length > 0) parts.push(`defines ${nameList(defined, MAP_LIMITS.hints)}`);
    const users = ranked(usedBy.get(file));
    if (users.length > 0) parts.push(`used by ${nameList(users, MAP_LIMITS.hints)}`);
    const used = ranked(uses.get(file));
    if (used.length > 0) parts.push(`uses ${nameList(used, MAP_LIMITS.hints)}`);
    return parts.length > 0 ? ` (${parts.join("; ")})` : "";
  };

  // ── The maps: one per folder, from the top down.
  const existingViews = new Map(
    (Array.isArray(explainer.views) ? explainer.views : []).map((v) => [v.id, v]),
  );
  const storedNodes = new Map(
    (Array.isArray(explainer.nodes) ? explainer.nodes : []).map((n) => [n.id, n]),
  );
  const nodes: PatchNode[] = [];
  const views: PatchView[] = [];
  const viewOfFile = new Map<string, string>();
  const computed = new Set<string>();
  const crowded: string[] = [];
  const grouping: string[] = [];

  /**
   * Groups of the files of one folder that use each other: pairs joined by the most references first, a group at
   * most `MAP_LIMITS.groupFiles` files, kept when it has at least 3. Ties go by path, so a draft is stable.
   */
  const groupFiles = (path: string, files: readonly string[]): PatchNode[] => {
    const inFolder = new Set(files);
    const weight = new Map<string, number>();
    for (const to of files) {
      for (const [from, n] of usedBy.get(to) ?? []) {
        if (!inFolder.has(from) || from === to) continue;
        const key = from < to ? `${from}\0${to}` : `${to}\0${from}`;
        weight.set(key, (weight.get(key) ?? 0) + n);
      }
    }
    const owner = new Map(files.map((f) => [f, f]));
    const find = (f: string): string => {
      let at = f;
      while (owner.get(at) !== at) at = owner.get(at)!;
      owner.set(f, at);
      return at;
    };
    const size = new Map(files.map((f) => [f, 1]));
    const pairs = [...weight].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
    for (const [key] of pairs) {
      const [a, b] = key.split("\0") as [string, string];
      const [ra, rb] = [find(a), find(b)];
      if (ra === rb || size.get(ra)! + size.get(rb)! > MAP_LIMITS.groupFiles) continue;
      const [keep, drop] = ra < rb ? [ra, rb] : [rb, ra];
      owner.set(drop, keep);
      size.set(keep, size.get(keep)! + size.get(drop)!);
    }
    const clusters = new Map<string, string[]>();
    for (const f of files) clusters.set(find(f), [...(clusters.get(find(f)) ?? []), f]);
    const slug = path
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "");
    return [...clusters.values()]
      .filter((members) => members.length >= 3)
      .sort((a, b) => b.length - a.length || a[0]!.localeCompare(b[0]!))
      .map((members, i) => ({
        id: `grp:map-${slug || "top"}-${i + 1}`,
        label: todo(
          `1-3 plain words for what these files do together (${nameList(members.map(shortName), MAP_LIMITS.hints)})`,
        ),
        summary: todo("one plain sentence: the job these files share."),
        members: members.map((f) => `file:${f}`),
      }));
  };
  const topFolder = folderOf(root);

  // ── Files that moved: a box whose file is gone, and a new file with the same text as that file had at the
  // commit the box was written at. The box's name and sentence go to the new path (exact moves only).
  const owned = (p?: { origin?: string; userFields?: string[] }) =>
    p?.origin !== "user" && (p?.userFields?.length ?? 0) === 0;
  const moves = new Map<string, NonNullable<(typeof explainer.nodes)[number]>>();
  const moved: string[] = [];
  const newFiles = allMapped.filter((f) => !stored.has(`file:${f}`));
  let byText: Map<string, string[]> | undefined;
  for (const [id, n] of storedNodes) {
    if (!id.startsWith("file:") || model.hasFile(id.slice(5)) || !owned(n.provenance)) continue;
    const commit = n.provenance?.commit;
    const full = commit ? (input.commits?.get(commit) ?? commit) : undefined;
    const old = full ? texts.textAt(full, id.slice(5)) : undefined;
    if (old === undefined) continue;
    byText ??= newFiles.reduce((map, f) => {
      const text = texts.text(f);
      if (text !== undefined) map.set(text, [...(map.get(text) ?? []), f]);
      return map;
    }, new Map<string, string[]>());
    const same = (byText.get(old) ?? []).filter((f) => !moves.has(f));
    if (same.length !== 1) continue;
    moves.set(same[0]!, n);
    moved.push(`${id.slice(5)} -> ${same[0]}`);
  }
  if (moved.length > 0) {
    notes.push(
      `${plural(moved.length, "moved file")} ${moved.length === 1 ? "keeps its" : "keep their"} text: ${moved.join(", ")}`,
    );
  }

  // Groups of an earlier draft (`grp:map-…`, each opening the map of its files): their files stay on their group's
  // map, which a refresh keeps and updates like a folder's.
  const groupOfFile = new Map<string, string>();
  let topInclude: string[] = [];
  for (const [id, n] of storedNodes) {
    if (!id.startsWith("grp:map-") || typeof n.opens !== "string") continue;
    for (const member of n.members ?? []) groupOfFile.set(member, id);
  }

  const hasRequests = model.refs.some((ref) => ref.kind === "request");
  const visit = (path: string, folder: Folder) => {
    const viewId = viewIdOf(root, path);
    computed.add(viewId);
    const include = [
      ...folder.dirs.map((d) => `dir:${d}`),
      ...folder.files.filter((f) => !groupOfFile.has(`file:${f}`)).map((f) => `file:${f}`),
    ];
    for (const file of folder.files) viewOfFile.set(file, viewId);
    const existing = existingViews.get(viewId);
    // a crowded new map: its files that use each other become groups, each a box that opens the map of its files
    const groups =
      existing === undefined && include.length > MAP_LIMITS.boxes
        ? groupFiles(path, folder.files)
        : [];
    for (const group of groups) {
      const members = group.members ?? [];
      const opens = `view:${group.id.slice("grp:".length)}`;
      computed.add(opens);
      nodes.push({ ...group, opens });
      views.push({
        id: opens,
        type: "graph",
        title: todo("what this group's files do together, in plain words"),
        scope: { root: group.id, depth: 1 },
        include: [...members],
        ...(hasRequests ? { edgeKinds: [...DEFAULT_EDGE_KINDS, "requests" as const] } : {}),
        excludeFiles: [...OVERVIEW_EXCLUDE],
        boxText: "summary",
      });
      for (const member of members) {
        viewOfFile.set(member.slice("file:".length), opens);
        include.splice(include.indexOf(member), 1);
      }
    }
    if (groups.length > 0) {
      include.splice(folder.dirs.length, 0, ...groups.map((g) => g.id));
      const grouped = groups.reduce((n, g) => n + (g.members?.length ?? 0), 0);
      grouping.push(
        `${path === root ? "the top" : path}: ${plural(groups.length, "group")} of ${grouped} files`,
      );
    }
    if (include.length > MAP_LIMITS.boxes)
      crowded.push(`${path === root ? "the top" : path} (${include.length})`);
    if (path === root) topInclude = [...include];
    if (existing?.type === "graph") {
      const current = new Set(existing.include);
      const includeAdd = include.filter((id) => !current.has(id));
      const includeRemove = existing.include.filter((id) => {
        if (id.startsWith("file:")) return !model.hasFile(id.slice(5));
        if (id.startsWith("dir:")) return !model.hasDirectory(id.slice(4));
        return false;
      });
      if (includeAdd.length > 0 || includeRemove.length > 0) {
        views.push({
          id: viewId,
          type: "graph",
          ...(includeAdd.length > 0 ? { includeAdd } : {}),
          ...(includeRemove.length > 0 ? { includeRemove } : {}),
        });
      }
    } else {
      views.push({
        id: viewId,
        type: "graph",
        title:
          path === root
            ? todo(
                `the map in plain words (for example: ${explainer.repo?.name ?? "the project"}, its parts and how they connect)`,
              )
            : todo(`what this map shows, in plain words (now: the files of ${path})`),
        scope: { root: path === "" ? "repo" : `dir:${path}`, depth: 1 },
        include,
        // Web requests to the repository's own routes: the arrow from the screen code to the server code.
        ...(hasRequests ? { edgeKinds: [...DEFAULT_EDGE_KINDS, "requests" as const] } : {}),
        excludeFiles: [...OVERVIEW_EXCLUDE],
        boxText: "summary",
      });
    }
    for (const dir of folder.dirs) {
      const inner = folderOf(dir);
      const id = `dir:${dir}`;
      const opens = viewIdOf(root, dir);
      if (!stored.has(id)) {
        const count = inner.files.length + inner.dirs.length;
        const names = [...inner.dirs, ...inner.files].map((p) => below(dir, p));
        nodes.push({
          id,
          label: todo(`1-3 plain words for this part (now: ${below(path, dir)})`),
          summary: todo(
            `one plain sentence: what this part does for the project (${plural(count, inner.dirs.length > 0 ? "box" : "file", inner.dirs.length > 0 ? "boxes" : "files")}: ${nameList(names, MAP_LIMITS.hints)}).`,
          ),
          opens,
        });
      } else if (storedNodes.get(id)?.opens === undefined) {
        nodes.push({ id, opens });
      }
      visit(dir, inner);
    }
    for (const file of folder.files) {
      const id = `file:${file}`;
      if (stored.has(id)) continue;
      const from = moves.get(file);
      if (from) {
        nodes.push({
          id,
          ...(from.label !== undefined ? { label: from.label } : {}),
          ...(from.summary !== undefined ? { summary: from.summary } : {}),
        });
        continue;
      }
      nodes.push({
        id,
        label: todo(`2-5 plain words for this file (now: ${baseName(file)})`),
        summary: todo(`one plain sentence: what this file does for the project${fileHint(file)}.`),
      });
    }
  };
  visit(root, topFolder);

  // ── What is gone: boxes of files and folders no longer in the index, and the maps of folders no longer drawn.
  const remove: string[] = [];
  const kept: string[] = [];
  for (const [id, n] of storedNodes) {
    const gone =
      (id.startsWith("file:") && !model.hasFile(id.slice(5))) ||
      (id.startsWith("dir:") && !model.hasDirectory(id.slice(4)));
    if (!gone) continue;
    if (n.provenance?.origin === "user" || (n.provenance?.userFields?.length ?? 0) > 0)
      kept.push(id);
    else remove.push(id);
  }
  // the maps of the groups of an earlier draft: kept, without the files that are gone
  for (const [id, n] of storedNodes) {
    if (!id.startsWith("grp:map-") || typeof n.opens !== "string" || remove.includes(id)) continue;
    const members = n.members ?? [];
    const present = members.filter((m) => model.hasFile(m.slice("file:".length)));
    for (const m of present) viewOfFile.set(m.slice("file:".length), n.opens);
    computed.add(n.opens);
    if (present.length === members.length) continue;
    nodes.push({ id, members: present });
    const view = existingViews.get(n.opens);
    if (view?.type === "graph") {
      const includeRemove = view.include.filter(
        (m) => m.startsWith("file:") && !present.includes(m),
      );
      if (includeRemove.length > 0) views.push({ id: n.opens, type: "graph", includeRemove });
    }
  }
  for (const [id, v] of existingViews) {
    if (!id.startsWith("view:map") || computed.has(id)) continue;
    if (v.provenance?.origin === "user" || (v.provenance?.userFields?.length ?? 0) > 0) continue;
    remove.push(id);
    for (const [nodeId, n] of storedNodes) {
      if (n.opens === id && !remove.includes(nodeId)) nodes.push({ id: nodeId, opens: null });
    }
  }
  if (kept.length > 0) {
    notes.push(
      `boxes you edited whose code is gone, left for you to remove: ${nameList(kept, MAP_LIMITS.hints)}`,
    );
  }

  // ── Tours: start here (once), and the change (once per recorded change).
  const tourIds = new Set((Array.isArray(explainer.tours) ? explainer.tours : []).map((t) => t.id));
  const tours: NonNullable<ExplainerPatch["tours"]> = [];
  // the boxes of the top map, as drawn (with its groups)
  const topIds = topInclude;
  /** The first definition of the part's most used file: where a reader of the part starts. */
  const mainDefinition = (dir: string) => {
    const users = (file: string) =>
      [...(usedBy.get(file) ?? new Map<string, number>()).values()].reduce((n, c) => n + c, 0);
    const main = [...mappedUnder(dir)].sort((a, b) => users(b) - users(a) || a.localeCompare(b))[0];
    const first = main ? definitions(main)[0] : undefined;
    return main && first ? { file: main, symbol: first, role: "definition" as const } : undefined;
  };
  // The map's own tours (start here, changes) follow the code: steps lose the boxes and code that are gone, a
  // folder step of the start tour gets its folder's code again, and a step with nothing left to show goes.
  const goneId = (id: string) =>
    (id.startsWith("file:") && !model.hasFile(id.slice(5))) ||
    (id.startsWith("dir:") && !model.hasDirectory(id.slice(4)));
  for (const tour of Array.isArray(explainer.tours) ? explainer.tours : []) {
    if (!/^tour:(?:map$|changes-)/.test(tour.id) || !owned(tour.provenance)) continue;
    let changed = false;
    const steps: PatchTourStep[] = [];
    for (const step of tour.steps) {
      const focus = step.focus.filter((id) => !goneId(id));
      const kept = (step.code ?? []).filter((a) => a.at === "base" || model.hasFile(a.file));
      let code: (AnchorInput | undefined)[] = kept.map((a) => ({
        file: a.file,
        role: a.role,
        ...(a.at ? { at: a.at } : {}),
        ...(a.symbol ? { symbol: a.symbol } : {}),
        ...(a.span ? { span: a.span } : {}),
      }));
      if (kept.length < (step.code ?? []).length && tour.id === "tour:map" && focus.length === 1) {
        code = focus[0]!.startsWith("dir:") ? [mainDefinition(focus[0]!.slice(4))] : [];
      }
      const gone =
        focus.length === 0 || (step.view.startsWith("view:map") && remove.includes(step.view));
      if (gone || focus.length < step.focus.length || kept.length < (step.code ?? []).length) {
        changed = true;
      }
      if (gone) continue;
      const anchors = code.filter((a): a is AnchorInput => a !== undefined);
      steps.push({
        id: step.id,
        view: step.view,
        focus,
        ...(step.note !== undefined ? { note: step.note } : {}),
        ...(anchors.length > 0 ? { code: anchors } : {}),
        ...(step.editor && anchors.some((a) => a.file === step.editor?.primary)
          ? { editor: step.editor }
          : {}),
      });
    }
    if (!changed) continue;
    if (steps.length === 0) remove.push(tour.id);
    else tours.push({ id: tour.id, steps });
  }

  if (!tourIds.has("tour:map")) {
    const parts = [...topFolder.dirs]
      .sort((a, b) => mappedUnder(b).length - mappedUnder(a).length || a.localeCompare(b))
      .slice(0, MAP_LIMITS.tourParts);
    const steps: PatchTourStep[] = [
      tourStep(
        model,
        "t1",
        "view:map",
        topIds,
        note(
          todo("what the project is, as a plain statement anyone can follow"),
          todo("what it is for and its main parts, in one or two plain sentences; no code names."),
        ),
        [aboutAnchor(model, texts)],
      ),
      ...parts.map((dir, i) =>
        tourStep(
          model,
          `t${i + 2}`,
          "view:map",
          [`dir:${dir}`],
          note(
            todo("what this part is for, as a plain statement"),
            todo("its job in everyday words, and which other parts it works with."),
          ),
          [mainDefinition(dir)],
        ),
      ),
    ];
    tours.push({
      id: "tour:map",
      title: todo("start here: about 5 plain words"),
      summary: `${todo("what the project is and who it is for, in plain words.")} ${todo("its main parts, in one sentence.")}`,
      steps,
    });
  }

  const change = explainer.change;
  if (change && !tourIds.has(`tour:changes-${change.head.slice(0, 7)}`)) {
    const analysis = analyzeChange(change, model);
    const changed = change.files.filter(
      (f) => f.status !== "deleted" && model.hasFile(f.path) && viewOfFile.has(f.path),
    );
    const steps = changed.slice(0, MAP_LIMITS.changeSteps).map((file, i) => {
      const names = [
        ...new Set(
          analysis.symbols
            .filter((s) => s.file === file.path)
            .map((s) => model.symbol(s.symbolId)?.path)
            .filter((p): p is string => p !== undefined),
        ),
      ];
      const fresh = file.status === "added";
      const hint =
        names.length > 0
          ? ` (${fresh ? "new" : "changed"}: ${nameList(names, MAP_LIMITS.hints)})`
          : "";
      return tourStep(
        model,
        `t${i + 1}`,
        viewOfFile.get(file.path)!,
        [`file:${file.path}`],
        fresh
          ? note(
              todo("what this new file is for, as a plain statement"),
              todo(
                `what it does and how it serves what was asked, in one or two plain sentences${hint}.`,
              ),
            )
          : note(
              todo("what changed in this file, as a plain statement"),
              todo(
                `what changed here and how it serves what was asked, in one or two plain sentences${hint}.`,
              ),
            ),
        [changedFileAnchor(model, texts, change, file, "definition")],
      );
    });
    const deleted = change.files.filter((f) => f.status === "deleted").map((f) => baseName(f.path));
    const offFiles = change.files.filter(
      (f) => f.status !== "deleted" && !viewOfFile.has(f.path),
    ).length;
    if (changed.length > MAP_LIMITS.changeSteps) {
      notes.push(
        `${changed.length} changed files are on the map; the change tour shows the first ${MAP_LIMITS.changeSteps}`,
      );
    }
    if (offFiles > 0) {
      notes.push(
        `${plural(offFiles, "changed file")} off the map (tests, docs and others) have no step`,
      );
    }
    if (steps.length > 0) {
      tours.push({
        id: `tour:changes-${change.head.slice(0, 7)}`,
        title: todo("2-5 plain words: what was worked on"),
        summary:
          `${todo("what was asked for, in the words of whoever asked.")} ${todo("what was done and where it stands; name anything deleted.")}` +
          (deleted.length > 0 ? ` Deleted: ${nameList(deleted, MAP_LIMITS.hints)}.` : ""),
        steps,
      });
    } else {
      notes.push("no changed file is on the map: no change tour");
    }
  }

  const left = model.files.filter((f) => isCodeFile(f.path) && !mapped(f.path)).length;
  notes.unshift(
    `${plural(allMapped.length, "code file")} on ${plural(computed.size, "map")}; ${plural(left, "file")} left off (tests, examples, fixtures, docs and benchmarks)`,
  );
  if (grouping.length > 0) {
    notes.push(
      `crowded maps get groups of files that use each other (${grouping.join("; ")}): name each group, or remove the ones that are not one job`,
    );
  }
  if (crowded.length > 0) {
    notes.push(
      `maps with more than ${MAP_LIMITS.boxes} boxes: ${crowded.join(", ")}. Consider grp boxes for the files that work together`,
    );
  }

  const patch: ExplainerPatch = {
    ...(nodes.length > 0 ? { nodes } : {}),
    ...(views.length > 0 ? { views } : {}),
    ...(tours.length > 0 ? { tours } : {}),
    ...(remove.length > 0 ? { remove } : {}),
  };
  return { kind: "map", patch, notes };
}
