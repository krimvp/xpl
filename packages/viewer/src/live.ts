/**
 * The live page (`xpl live`, ARCHITECTURE §6 "Live"), as pure functions over the change record: the three lenses
 * (Before, Changes, Now) applied to a map, the marks its boxes carry, what a poll brought that is new, and the
 * words of the status line. Core owns what a change does to a box (`liftChange`, `removedBoxes`); this module
 * only decides what the page draws of it.
 */
import {
  boxChangeWords,
  liftChange,
  liveTrail,
  quietText,
  removedBoxes,
  type BoxChange,
  type ChangeRecord,
  type DerivedGraph,
  type ExplainerModel,
  type FilePath,
  type GraphNode,
  type LiveStatus,
  type View,
} from "@xpl/core";

/**
 * How the live page reads the change. `changes` (the default): everything, with marks on what the change touched,
 * removed boxes included. `before`: the architecture as it was, as far as the head index tells (new boxes hidden,
 * removed ones drawn as boxes, no marks, code from the base). `now`: the code as it is, without marks.
 */
export type Lens = "before" | "changes" | "now";

export const LENSES: readonly { id: Lens; label: string; hint: string }[] = [
  {
    id: "before",
    label: "Before",
    hint: "The architecture before the change, without what it adds",
  },
  { id: "changes", label: "Changes", hint: "What the change added, changed and removed, marked" },
  { id: "now", label: "Now", hint: "The architecture as it is now, without marks" },
];

/** What a box of a live map says about the change: the status picks the treatment, the text is its words. */
export interface PillMark {
  status: BoxChange["status"];
  text: string;
}

/** A map's boxes as a lens draws them: removed boxes added (`changes`, `before`), new ones taken out (`before`). */
export function lensGraph(
  graph: DerivedGraph,
  model: ExplainerModel,
  change: ChangeRecord | undefined,
  view: View | undefined,
  lens: Lens,
): DerivedGraph {
  if (!change || lens === "now" || view?.type !== "graph") return graph;
  const removed: GraphNode[] = removedBoxes(model, change, view).map((box) => ({
    id: box.id,
    label: box.label,
    kind: box.kind,
    container: false,
  }));
  let nodes = graph.nodes;
  let edges = graph.edges;
  let stubs = graph.stubs;
  if (lens === "before") {
    const lifted = liftChange(
      model,
      change,
      graph.nodes.map((node) => node.id),
    );
    const gone = new Set<string>();
    for (const node of graph.nodes) {
      if (lifted.get(node.id)?.status === "new" || (node.parent && gone.has(node.parent)))
        gone.add(node.id);
    }
    if (gone.size > 0) {
      nodes = nodes.filter((node) => !gone.has(node.id));
      edges = edges.filter((edge) => !gone.has(edge.from) && !gone.has(edge.to));
      stubs = stubs.filter((stub) => !gone.has(stub.inside));
    }
  }
  if (removed.length === 0 && nodes === graph.nodes) return graph;
  const ghosts = new Set(stubs.map((stub) => `ghost:${stub.ghost}`));
  return {
    ...graph,
    nodes: [...nodes, ...removed],
    edges,
    stubs,
    ghosts: graph.ghosts.filter((ghost) => ghosts.has(ghost.id)),
  };
}

/** The marks of a lens's map: only `changes` marks anything (removed boxes say "Removed"). */
export function lensMarks(
  graph: DerivedGraph,
  model: ExplainerModel,
  change: ChangeRecord | undefined,
  lens: Lens,
): Map<string, PillMark> | undefined {
  if (!change || lens !== "changes") return undefined;
  const marks = new Map<string, PillMark>();
  const ids = graph.nodes.map((node) => node.id).filter((id) => !isRemovedId(id));
  for (const [id, lifted] of liftChange(model, change, ids))
    marks.set(id, { status: lifted.status, text: boxChangeWords(lifted) });
  for (const node of graph.nodes)
    if (isRemovedId(node.id)) marks.set(node.id, { status: "removed", text: "Removed" });
  return marks;
}

export const isRemovedId = (id: string): boolean => id.startsWith("removed:");

/** The changed files a box holds, for the pulse of a box whose code a poll just changed. */
export function heldPaths(
  model: ExplainerModel,
  change: ChangeRecord,
  ids: readonly string[],
): Map<string, readonly FilePath[]> {
  const out = new Map<string, readonly FilePath[]>();
  for (const [id, lifted] of liftChange(model, change, ids)) {
    out.set(id, [...lifted.files.added, ...lifted.files.changed, ...lifted.files.removed]);
  }
  for (const id of ids) if (isRemovedId(id)) out.set(id, [id.slice("removed:".length)]);
  return out;
}

/** What each changed file looks like in a record: its status and hunks. A file whose signature moved changed again. */
export function fileSignatures(change: ChangeRecord | undefined): Map<FilePath, string> {
  const out = new Map<FilePath, string>();
  for (const file of Array.isArray(change?.files) ? change.files : []) {
    out.set(file.path, `${file.status}:${JSON.stringify(file.hunks ?? [])}`);
  }
  return out;
}

/**
 * The files whose part of the change differs from `seen` (a file the change now touches, or touches differently):
 * what a poll brought, or what is new since the reader last looked. A file the change no longer touches is not
 * fresh: its box simply loses its mark.
 */
export function freshFiles(
  seen: ReadonlyMap<FilePath, string>,
  change: ChangeRecord | undefined,
): Set<FilePath> {
  const out = new Set<FilePath>();
  for (const [path, signature] of fileSignatures(change)) {
    if (seen.get(path) !== signature) out.add(path);
  }
  return out;
}

/** "since origin/main", "since you started", "since HEAD~3": what the change is measured from, in plain words. */
export function baseWords(base: LiveStatus["base"] | undefined, change?: ChangeRecord): string {
  if (base) {
    if (base.how === "start") return "since you started";
    if (base.rev === "HEAD") return "since your last commit";
    return `since ${base.rev}`;
  }
  return change ? `since ${change.base.slice(0, 7)}` : "";
}

/** "just now", "5 s ago", "3 min ago", "2 h ago". */
export function agoWords(iso: string | null | undefined, now: number): string {
  if (!iso) return "";
  const seconds = Math.max(0, Math.round((now - Date.parse(iso)) / 1000));
  if (!Number.isFinite(seconds)) return "";
  if (seconds < 3) return "just now";
  if (seconds < 60) return `${seconds} s ago`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)} min ago`;
  return `${Math.floor(seconds / 3600)} h ago`;
}

/**
 * Where the explanation stands, in one plain line, and the command that gets one when there is none (undefined:
 * it is current, nothing to say).
 */
export function explanationWords(
  status: LiveStatus | undefined,
  hasTour: boolean,
): { text: string; tone: "busy" | "warn" | "quiet"; command?: string } | undefined {
  if (!status || status.change === null) return undefined;
  const { explanation } = status;
  if (explanation.state === "running") return { text: "Writing the explanation…", tone: "busy" };
  if (explanation.state === "failed")
    return {
      text: `The explanation could not be written${explanation.error ? `: ${explanation.error}` : "."}`,
      tone: "warn",
    };
  if (hasTour && explanation.stale)
    return { text: "The explanation is from before your latest edits.", tone: "warn" };
  if (hasTour) return undefined;
  return explanation.backend === "none"
    ? {
        text: "Not explained yet. Ask your agent to “explain live” (the code-explainer skill), or start",
        tone: "quiet",
        command: "xpl live --backend claude",
      }
    : {
        text: "Not explained yet: Claude writes it once the code has been quiet for a while.",
        tone: "quiet",
      };
}

/** The top map of a live guide: `view:system`, else the first view. */
export function topViewId(model: ExplainerModel): string | undefined {
  return model.view("view:system")?.id ?? model.views[0]?.id;
}

/** The file a removed box opens: its own path, or the first deleted file of a removed folder. */
export function removedFile(change: ChangeRecord | undefined, id: string): FilePath | undefined {
  const path = id.slice("removed:".length);
  const files = Array.isArray(change?.files) ? change.files : [];
  return files.find(
    (file) => file.status === "deleted" && (file.path === path || file.path.startsWith(`${path}/`)),
  )?.path;
}

/**
 * A level's title on a live page: its own words when someone wrote them (or the name a draft knows), else what the
 * level is: "The system" at the top, "Inside store" below a box.
 */
export function liveViewTitle(model: ExplainerModel, viewId: string): string {
  const title = quietText(model.view(viewId)?.title ?? "");
  if (title) return title.charAt(0).toUpperCase() + title.slice(1);
  const trail = liveTrail(model, viewId);
  const box = trail[trail.length - 1]?.box;
  if (!box) return "The system";
  return `Inside ${quietText(model.label(box)) || "this part"}`;
}
