/** Bounded field edits and conditional inverses. Undo is another user patch, never an artifact replacement. */
import { applyPatch } from "./apply.js";
import type { GetText, TextCache } from "./anchors.js";
import type { IndexModel } from "./index-model.js";
import { ExplainerModel } from "./model.js";
import { deriveGraph } from "./graph.js";
import { parseId } from "./ids.js";
import type { ExplainerPatch } from "./patch.js";
import type { Explainer } from "./schema.js";
import { deepEqual } from "./util.js";

export interface UserEdit {
  collection: "nodes" | "edges" | "concepts" | "views" | "groups";
  id: string;
  /** Missing optional fields are represented by null, matching the patch contract. */
  before: Record<string, unknown>;
  after: Record<string, unknown>;
}

export class UserEditError extends Error {
  constructor(
    message: string,
    readonly conflict = false,
  ) {
    super(message);
  }
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function fields(
  value: unknown,
  collection: UserEdit["collection"],
  groupSnapshot = false,
): asserts value is Record<string, unknown> {
  if (!record(value) || Object.keys(value).length === 0)
    throw new UserEditError("An edit needs changed fields.");
  if (collection === "groups") {
    if (Object.keys(value).join(",") !== "node")
      throw new UserEditError("A group existence edit needs only node.");
    if (value.node !== null) {
      fields(value.node, "nodes", true);
      if (
        !record(value.node) ||
        typeof value.node.label !== "string" ||
        typeof value.node.parent !== "string" ||
        !Array.isArray(value.node.members) ||
        !Array.isArray(value.node.anchors)
      )
        throw new UserEditError("A group needs label, parent, members and anchors.");
    }
    return;
  }
  for (const [name, field] of Object.entries(value)) {
    if (collection === "views") {
      if (
        (name === "include" || name === "hidden") &&
        ((name === "hidden" && field === null) || stringIds(field))
      )
        continue;
      throw new UserEditError(`Invalid or unsupported graph edit field: ${name}.`);
    }
    if (name === "anchors" && Array.isArray(field) && field.length <= 64 && field.every(record)) {
      continue;
    } else if (name === "related" && collection === "concepts") {
      if (field === null || (Array.isArray(field) && field.every((id) => typeof id === "string")))
        continue;
    } else if (["label", "summary", "detail"].includes(name)) {
      if (field === null && name !== "label") continue;
      if (typeof field === "string") continue;
    } else if (collection === "nodes") {
      if (name === "members" && stringIds(field)) continue;
      if (
        groupSnapshot &&
        ["parent", "role", "tech", "opens"].includes(name) &&
        typeof field === "string"
      )
        continue;
    }
    throw new UserEditError(`Invalid or unsupported edit field: ${name}.`);
  }
}

function stringIds(value: unknown): value is string[] {
  return (
    Array.isArray(value) && value.length <= 10000 && value.every((id) => typeof id === "string")
  );
}

/** Existence preconditions inspect the whole group, so undo cannot erase later enrichment. */
function groupValue(explainer: Explainer, id: string): Record<string, unknown> | null {
  if (parseId(id).type !== "group")
    throw new UserEditError("Only group nodes support existence edits.");
  const node = explainer.nodes.find((node) => node.id === id);
  return node
    ? Object.fromEntries(
        Object.entries(node)
          .filter(([key]) => !["id", "kind", "provenance"].includes(key))
          .map(([key, value]) => [key, editValue(key, value)]),
      )
    : null;
}

/** Resolution is a cache, not an author edit; keep every evidence hash and coordinate. */
function editValue(name: string, value: unknown): unknown {
  return name === "anchors" && Array.isArray(value)
    ? value.map((anchor) =>
        Object.fromEntries(Object.entries(anchor).filter(([key]) => key !== "resolved")),
      )
    : value;
}

function target(
  explainer: Explainer,
  index: IndexModel,
  collection: UserEdit["collection"],
  id: string,
) {
  const model = new ExplainerModel(explainer, index);
  const item =
    collection === "nodes"
      ? model.node(id)
      : collection === "edges"
        ? explainer.edges.find((e) => e.id === id)
        : collection === "views"
          ? model.view(id)
          : model.concept(id);
  if (!item) throw new UserEditError(`Cannot edit missing ${collection} item ${id}.`, true);
  if (collection === "views" && !("type" in item && item.type === "graph"))
    throw new UserEditError("Only stored graph views support graph edits.");
  return item;
}

/** Capture the effective fields shown to the author, including defaults of structural nodes. */
export function makeUserEdit(
  explainer: Explainer,
  index: IndexModel,
  collection: UserEdit["collection"],
  id: string,
  after: Record<string, unknown>,
): UserEdit {
  fields(after, collection);
  if (collection === "groups")
    return { collection, id, before: { node: groupValue(explainer, id) }, after };
  const item = target(explainer, index, collection, id);
  if (collection === "nodes" && "members" in after && parseId(id).type !== "group")
    throw new UserEditError("Structural graph fields can only edit groups.");
  const before = Object.fromEntries(
    Object.keys(after).map((name) => [
      name,
      editValue(name, (item as unknown as Record<string, unknown>)[name] ?? null),
    ]),
  );
  return { collection, id, before, after };
}

/** Validate at the trust boundary, check touched fields, then use core's normal provenance and validation. */
export function applyUserEdits(
  explainer: Explainer,
  input: unknown,
  index: IndexModel,
  texts: GetText | TextCache,
): { explainer: Explainer; inverse: UserEdit[] } {
  if (!Array.isArray(input) || input.length === 0 || input.length > 32)
    throw new UserEditError("Expected between 1 and 32 bounded edits.");
  const patch: ExplainerPatch = {};
  const inverse: UserEdit[] = [];
  const seen = new Set<string>();
  for (const raw of input) {
    if (
      !record(raw) ||
      Object.keys(raw).sort().join(",") !== "after,before,collection,id" ||
      !["nodes", "edges", "concepts", "views", "groups"].includes(String(raw.collection)) ||
      typeof raw.id !== "string" ||
      raw.id.length > 200
    )
      throw new UserEditError("Expected only collection, id, before and after for each edit.");
    const collection = raw.collection as UserEdit["collection"];
    fields(raw.before, collection);
    fields(raw.after, collection);
    if (collection === "groups" && (raw.before.node === null) === (raw.after.node === null))
      throw new UserEditError("A group existence edit must create or remove one group.");
    if (Object.keys(raw.before).sort().join(",") !== Object.keys(raw.after).sort().join(","))
      throw new UserEditError("Before and after must name the same fields.");
    const key = `${collection}:${raw.id}`;
    if (seen.has(key)) throw new UserEditError(`Duplicate edit target: ${raw.id}.`);
    seen.add(key);
    const current = makeUserEdit(explainer, index, collection, raw.id, raw.after);
    for (const name of Object.keys(raw.before)) {
      if (!deepEqual(current.before[name], editValue(name, raw.before[name])))
        throw new UserEditError(
          `${raw.id}: ${name} changed since this edit. Reload and inspect it before saving.`,
          true,
        );
    }
    // The bounded fields were checked above; applyPatch checks their schema and reference semantics.
    if (collection === "groups") {
      if (raw.after.node === null) (patch.remove ??= []).push(raw.id);
      else
        (patch.nodes ??= []).push({ id: raw.id, ...(raw.after.node as Record<string, unknown>) });
    } else if (collection === "views") {
      (patch.views ??= []).push({ id: raw.id, type: "graph", ...raw.after });
    } else (patch[collection] ??= []).push({ id: raw.id, ...raw.after });
    inverse.push({ collection, id: raw.id, before: raw.after, after: current.before });
  }
  const result = applyPatch(explainer, patch, index, texts, { actor: "user" });
  if (!result.ok)
    throw new UserEditError(
      result.issues.find((i) => i.severity === "error")?.message ?? "Edit rejected.",
    );
  for (const edit of inverse) {
    // find/base-path normalization and generated hashes belong to the actual stored result.
    edit.before = makeUserEdit(
      result.explainer,
      index,
      edit.collection,
      edit.id,
      edit.before,
    ).before;
  }
  return { explainer: result.explainer, inverse };
}

export type GraphEdit =
  | { type: "group"; id: string; label: string; members: string[] }
  | { type: "ungroup"; id: string }
  | { type: "hide" | "restore"; ids: string[] };

/** Explicit author actions operate on stored inclusion, never on transiently opened levels. */
export function makeGraphEdits(
  explainer: Explainer,
  index: IndexModel,
  viewId: string,
  action: GraphEdit,
): UserEdit[] {
  const model = new ExplainerModel(explainer, index);
  const view = model.view(viewId);
  if (view?.type !== "graph") throw new UserEditError("Choose a stored graph view to edit.");
  const edit = (after: Record<string, unknown>) =>
    makeUserEdit(explainer, index, "views", viewId, after);
  if (action.type === "group") {
    if (!action.label.trim()) throw new UserEditError("Name the group.");
    if (model.hasElement(action.id)) throw new UserEditError("This group ID already exists.", true);
    const members = [...new Set(action.members)];
    // Hidden containers still own their members; hiding only changes their rendered parents.
    const graph = deriveGraph({ ...view, hidden: [] }, model);
    const nodes = members.map((id) => graph.nodes.find((node) => node.id === id));
    if (
      members.length < 2 ||
      nodes.some(
        (node) => !node || !view.include.includes(node.id) || view.hidden?.includes(node.id),
      ) ||
      nodes.some((node) => node?.parent !== nodes[0]?.parent)
    )
      throw new UserEditError("Select at least two visible sibling boxes included in this map.");
    const parent = nodes[0]?.parent ?? "repo";
    const edits = [
      makeUserEdit(explainer, index, "groups", action.id, {
        node: { label: action.label.trim(), parent, members, anchors: [] },
      }),
      edit({ include: [...view.include, action.id] }),
    ];
    const container = model.node(parent);
    if (container?.kind === "group") {
      // Keep nested containment through the new group; direct membership would compete with it.
      edits.push(
        makeUserEdit(explainer, index, "nodes", parent, {
          members: [...(container.members ?? []).filter((id) => !members.includes(id)), action.id],
        }),
      );
    }
    return edits;
  }
  if (action.type === "ungroup") {
    const node = model.node(action.id);
    if (node?.kind !== "group" || !view.include.includes(node.id))
      throw new UserEditError("Select a group included in this map.");
    return [
      edit({
        include: [
          ...new Set(view.include.flatMap((id) => (id === node.id ? (node.members ?? []) : [id]))),
        ],
      }),
    ];
  }
  const hidden = view.hidden ?? [];
  if (action.type === "restore")
    return [edit({ hidden: hidden.filter((id) => !action.ids.includes(id)) })];
  // The viewer may show a transiently opened level. Persist visibility without copying that inclusion.
  // applyUserEdits/applyPatch checks every hidden ID against the index and stored graph references.
  if (!action.ids.length) throw new UserEditError("Select boxes or arrows to hide.");
  return [edit({ hidden: [...new Set([...hidden, ...action.ids])] })];
}
