/**
 * The structure of the guide `xpl live` keeps, drafted from the index on every cycle with no LLM. Top-down:
 *
 * 1. `draft repo`: the system map (`view:system`: who uses the project, the project, what it relies on), whose
 *    service box `opens` the map of its parts (`view:overview`, or `view:<service>-inside` for each program).
 * 2. `draft map`: one map per folder (`view:map`, `view:map-<path>`) with a box per file. A part box of level 1
 *    that is a folder the map draws gets `opens` to that folder's map, so the reader zooms from the system to a
 *    part, to its files, to the code.
 *
 * `draft repo` makes new ids when it runs on a guide that has them, so it runs here on an empty copy of the guide
 * and its result is merged into what the guide has (`mergeRepoDraft`): new boxes, arrows and views are added,
 * stored views get the new parts (`includeAdd`), and what points at a file or folder the index no longer has goes
 * (`includeRemove`, group members, arrows). `draft map` refreshes itself (new files, gone files, moved files keep
 * their text). Neither ever overwrites written text: both are `llm` patches over drafts that skip stored nodes.
 * Drafted tours are left out: the explanation of a change is `tour:live`, written by an agent (`reference/live.md`).
 */
import {
  DESIGN_VIEW_ID,
  LIVE_TOUR_ID,
  applyPatch,
  isDesignBox,
  type AnchorInput,
  type Explainer,
  type ExplainerPatch,
  type IndexModel,
  type Issue,
  type PatchNode,
  type PatchView,
  type TextCache,
} from "@xpl/core";
import { draftRepo, type DraftInput } from "./draft.js";
import { draftMap } from "./draft-map.js";

/** A file or folder box whose code the index no longer has. */
function goneFrom(model: IndexModel): (id: string) => boolean {
  return (id) =>
    (id.startsWith("file:") && !model.hasFile(id.slice(5))) ||
    (id.startsWith("dir:") && !model.hasDirectory(id.slice(4)));
}

const llmOwned = (p?: { origin?: string; userFields?: string[] }) =>
  p?.origin !== "user" && (p?.userFields?.length ?? 0) === 0;

/** An element of a draft whose text nobody wrote: its summary is still the draft's `TODO`. */
const unwritten = (e: {
  summary?: string;
  provenance?: { origin?: string; userFields?: string[] };
}) => llmOwned(e.provenance) && (e.summary ?? "").startsWith("TODO");

/**
 * What a fresh `draft repo` (of an empty guide) adds to the guide: boxes, arrows and views it does not have, the new
 * parts of the views it has, and the removal of what points at gone files and folders in every view that is not a
 * folder map (`draft map` cleans those).
 */
function mergeRepoDraft(
  guide: Explainer,
  fresh: ExplainerPatch,
  model: IndexModel,
): ExplainerPatch {
  const gone = goneFrom(model);
  const nodes = new Map(guide.nodes.map((n) => [n.id, n]));
  const views = new Map(guide.views.map((v) => [v.id, v]));
  const outNodes: PatchNode[] = [];
  const outViews: PatchView[] = [];
  const remove: string[] = [];

  for (const node of fresh.nodes ?? []) {
    const stored = nodes.get(node.id);
    if (!stored) {
      outNodes.push(node);
      continue;
    }
    // a box nobody wrote yet follows its code: its drafted evidence again, so it never drifts
    if (unwritten(stored) && node.anchors) outNodes.push({ id: node.id, anchors: node.anchors });
    // the service: its parts as the index has them now, and the ones it had that still exist
    if (node.members && stored.members) {
      const members = [...new Set([...stored.members.filter((m) => !gone(m)), ...node.members])];
      if (members.join("\0") !== stored.members.join("\0")) outNodes.push({ id: node.id, members });
    }
  }
  const freshNodes = new Set(outNodes.map((n) => n.id));
  // groups the fresh draft does not know (the user's): without the members that are gone
  for (const stored of guide.nodes) {
    if (freshNodes.has(stored.id) || stored.id.startsWith("grp:map-") || !stored.members) continue;
    // the design level's own upkeep (`refreshDesign`)
    if (isDesignBox(stored.id) && llmOwned(stored.provenance)) continue;
    const members = stored.members.filter((m) => !gone(m));
    if (members.length !== stored.members.length) outNodes.push({ id: stored.id, members });
  }

  const freshViews = new Map((fresh.views ?? []).map((v) => [v.id, v]));
  for (const view of fresh.views ?? []) if (!views.has(view.id)) outViews.push(view);
  for (const stored of guide.views) {
    if (stored.type !== "graph" || stored.id.startsWith("view:map")) continue;
    const drafted = freshViews.get(stored.id);
    const have = new Set(stored.include);
    const includeAdd =
      drafted?.type === "graph" ? (drafted.include ?? []).filter((id) => !have.has(id)) : [];
    const includeRemove = stored.include.filter(gone);
    if (includeAdd.length > 0 || includeRemove.length > 0) {
      outViews.push({
        id: stored.id,
        type: "graph",
        ...(includeAdd.length > 0 ? { includeAdd } : {}),
        ...(includeRemove.length > 0 ? { includeRemove } : {}),
      });
    }
  }

  const stored = new Map(guide.edges.map((e) => [e.id, e]));
  const edges = (fresh.edges ?? []).flatMap((e) => {
    const old = stored.get(e.id);
    if (!old) return [e];
    return unwritten(old) && e.anchors ? [{ id: e.id, anchors: e.anchors }] : [];
  });
  for (const edge of guide.edges) {
    if ((gone(edge.from) || gone(edge.to)) && llmOwned(edge.provenance)) remove.push(edge.id);
  }
  return {
    ...(outNodes.length > 0 ? { nodes: outNodes } : {}),
    ...(edges.length > 0 ? { edges } : {}),
    ...(outViews.length > 0 ? { views: outViews } : {}),
    ...(remove.length > 0 ? { remove } : {}),
  };
}

/**
 * The design level (`grp:design-*` boxes on `view:design`, written by the agent) kept true to the code. For each
 * design box nobody edited: a member that was renamed, or moved without `git mv` (an added file has the text it had
 * at the base), follows its file; a member file or folder the change deleted leaves `members` and stays as code before the change (a
 * whole-file base anchor per deleted file), so the box counts it as removed; a member that is gone and never was
 * at the base goes. A base anchor whose file the change no longer deletes becomes a member again when the file
 * exists, else it goes (it would be "not changed by" the change). Without a change record the design level goes,
 * with `tour:live`. A new file under a `dir:` member needs nothing: the box holds the folder. The design map gets
 * `stubs: none` unless it says otherwise.
 */
function refreshDesign(guide: Explainer, model: IndexModel, texts: TextCache): ExplainerPatch {
  const boxes = guide.nodes.filter((n) => isDesignBox(n.id) && llmOwned(n.provenance));
  const change = guide.change;
  if (!change) {
    // with nothing to explain, the explanation goes: `tour:live` and the design level it walks, together
    const tour = guide.tours.find((t) => t.id === LIVE_TOUR_ID);
    if (tour && !llmOwned(tour.provenance)) return {};
    const view = guide.views.find((v) => v.id === DESIGN_VIEW_ID);
    const remove = [
      ...(tour ? [tour.id] : []),
      ...boxes.map((n) => n.id),
      ...(view && llmOwned(view.provenance) ? [view.id] : []),
    ];
    return remove.length > 0 ? { remove } : {};
  }
  const deleted = new Set(change.files.filter((f) => f.status === "deleted").map((f) => f.path));
  // where a file went: a rename, or a move without `git mv` (a deleted file whose text an added file has)
  const followed = new Map<string, string>();
  for (const f of change.files)
    if (f.status === "renamed" && f.oldPath) followed.set(f.oldPath, f.path);
  const added = change.files.filter((f) => f.status === "added").map((f) => f.path);
  const movedTo = (path: string): string | undefined => {
    const old = texts.textAt(change.base, path);
    const same = old === undefined ? [] : added.filter((f) => texts.text(f) === old);
    return same.length === 1 ? same[0] : undefined;
  };
  const nodes: PatchNode[] = [];
  for (const box of boxes) {
    if (box.sketch === true) continue;
    const members: string[] = [];
    const removed: string[] = [];
    for (const member of box.members ?? []) {
      if (member.startsWith("file:")) {
        const path = member.slice(5);
        const to = followed.get(path) ?? (deleted.has(path) ? movedTo(path) : undefined);
        if (model.hasFile(path)) members.push(member);
        else if (to !== undefined && model.hasFile(to)) members.push(`file:${to}`);
        else if (deleted.has(path)) removed.push(path);
      } else if (member.startsWith("dir:")) {
        const path = member.slice(4);
        if (model.hasDirectory(path)) members.push(member);
        else removed.push(...[...deleted].filter((f) => f.startsWith(`${path}/`)));
      } else members.push(member);
    }
    const anchors: AnchorInput[] = [];
    for (const a of box.anchors ?? []) {
      if (a.at === "base" && !deleted.has(a.file)) {
        if (model.hasFile(a.file)) members.push(`file:${a.file}`);
        continue;
      }
      anchors.push({
        file: a.file,
        role: a.role,
        ...(a.at ? { at: a.at } : {}),
        ...(a.symbol ? { symbol: a.symbol } : {}),
        ...(a.span ? { span: a.span } : {}),
      });
    }
    const held = new Set(anchors.filter((a) => a.at === "base").map((a) => a.file));
    for (const path of removed)
      if (!held.has(path)) {
        held.add(path);
        anchors.push({ file: path, at: "base", role: "definition" });
      }
    const unique = [...new Set(members)];
    const same =
      unique.join("\0") === (box.members ?? []).join("\0") &&
      anchors.length === (box.anchors ?? []).length;
    if (!same) nodes.push({ id: box.id, members: unique, anchors });
  }
  // the design map draws its boxes only: the dashed boxes of code outside it would be folders again
  const view = guide.views.find((v) => v.id === DESIGN_VIEW_ID);
  const views: PatchView[] =
    view?.type === "graph" && view.stubs === undefined && llmOwned(view.provenance)
      ? [{ id: DESIGN_VIEW_ID, type: "graph", stubs: { mode: "none" } }]
      : [];
  return {
    ...(nodes.length > 0 ? { nodes } : {}),
    ...(views.length > 0 ? { views } : {}),
  };
}

/**
 * The guide with its structure drafted again against `input.model`: the merged `draft repo`, then `draft map`
 * (without the tours it would start), then the upkeep of the design level (`refreshDesign`; when the guide records
 * no change, `tour:live` goes with it). Each step
 * is applied as actor `llm`. Throws when a step does not apply (a bug in a draft: the index is the snapshot's).
 */
export function draftLiveStructure(input: DraftInput): { explainer: Explainer; issues: Issue[] } {
  const { model, texts } = input;
  let explainer = input.explainer;
  const issues: Issue[] = [];
  const apply = (what: string, patch: ExplainerPatch) => {
    if (Object.keys(patch).length === 0) return;
    const result = applyPatch(explainer, patch, model, texts, { actor: "llm" });
    if (!result.ok) {
      const errors = result.issues.filter((i) => i.severity === "error");
      throw new Error(
        `the ${what} draft does not apply (a bug in xpl live; please report it): ${errors
          .slice(0, 3)
          .map((i) => `${i.path}: ${i.message}`)
          .join("; ")}`,
      );
    }
    issues.push(...result.issues);
    explainer = result.explainer;
  };
  const blank: Explainer = {
    ...explainer,
    nodes: [],
    edges: [],
    views: [],
    concepts: [],
    tours: [],
  };
  apply("repo", mergeRepoDraft(explainer, draftRepo({ ...input, explainer: blank }).patch, model));

  const map = draftMap({ ...input, explainer }).patch;
  // refreshes of the tours the guide has stay (they drop what is gone); new tours are not drafted
  const tours = new Set(explainer.tours.map((t) => t.id));
  const kept = (map.tours ?? []).filter((t) => tours.has(t.id));
  if (kept.length > 0) map.tours = kept;
  else delete map.tours;
  apply("map", map);
  apply("design", refreshDesign(explainer, model, texts));
  return { explainer, issues };
}
