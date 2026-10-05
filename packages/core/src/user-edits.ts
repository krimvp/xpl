/** Bounded field edits and conditional inverses. Undo is another user patch, never an artifact replacement. */
import { applyPatch } from "./apply.js";
import type { GetText, TextCache } from "./anchors.js";
import type { IndexModel } from "./index-model.js";
import { ExplainerModel } from "./model.js";
import type { ExplainerPatch } from "./patch.js";
import type { Explainer } from "./schema.js";

export interface UserEdit {
  collection: "nodes" | "edges" | "concepts";
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
): asserts value is Record<string, unknown> {
  if (!record(value) || Object.keys(value).length === 0)
    throw new UserEditError("An edit needs changed fields.");
  for (const [name, field] of Object.entries(value)) {
    if (name === "related" && collection === "concepts") {
      if (field === null || (Array.isArray(field) && field.every((id) => typeof id === "string")))
        continue;
    } else if (["label", "summary", "detail"].includes(name)) {
      if (field === null && name !== "label") continue;
      if (typeof field === "string") continue;
    }
    throw new UserEditError(`Invalid or unsupported edit field: ${name}.`);
  }
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
        : model.concept(id);
  if (!item) throw new UserEditError(`Cannot edit missing ${collection} item ${id}.`, true);
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
  const item = target(explainer, index, collection, id);
  const before = Object.fromEntries(
    Object.keys(after).map((name) => [
      name,
      (item as unknown as Record<string, unknown>)[name] ?? null,
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
      !["nodes", "edges", "concepts"].includes(String(raw.collection)) ||
      typeof raw.id !== "string" ||
      raw.id.length > 200
    )
      throw new UserEditError("Expected only collection, id, before and after for each edit.");
    const collection = raw.collection as UserEdit["collection"];
    fields(raw.before, collection);
    fields(raw.after, collection);
    if (Object.keys(raw.before).sort().join(",") !== Object.keys(raw.after).sort().join(","))
      throw new UserEditError("Before and after must name the same fields.");
    const key = `${collection}:${raw.id}`;
    if (seen.has(key)) throw new UserEditError(`Duplicate edit target: ${raw.id}.`);
    seen.add(key);
    const current = makeUserEdit(explainer, index, collection, raw.id, raw.after);
    for (const name of Object.keys(raw.before)) {
      if (JSON.stringify(current.before[name]) !== JSON.stringify(raw.before[name]))
        throw new UserEditError(
          `${raw.id}: ${name} changed since this edit. Reload and inspect it before saving.`,
          true,
        );
    }
    // The bounded fields were checked above; applyPatch checks their schema and reference semantics.
    (patch[collection] ??= []).push({ id: raw.id, ...raw.after });
    inverse.push({ collection, id: raw.id, before: raw.after, after: current.before });
  }
  const result = applyPatch(explainer, patch, index, texts, { actor: "user" });
  if (!result.ok)
    throw new UserEditError(
      result.issues.find((i) => i.severity === "error")?.message ?? "Edit rejected.",
    );
  return { explainer: result.explainer, inverse };
}
