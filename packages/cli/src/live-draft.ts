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
  LIVE_TOUR_ID,
  applyPatch,
  type Explainer,
  type ExplainerPatch,
  type IndexModel,
  type Issue,
  type PatchNode,
  type PatchView,
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
 * The guide with its structure drafted again against `input.model`: the merged `draft repo`, then `draft map`
 * (without the tours it would start), then, when the guide records no change, without its `tour:live`. Each step
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

  const live = explainer.tours.find((t) => t.id === LIVE_TOUR_ID);
  if (!explainer.change && live && llmOwned(live.provenance)) {
    apply("live tour", { remove: [LIVE_TOUR_ID] });
  }
  return { explainer, issues };
}
