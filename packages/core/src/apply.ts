/**
 * Patches (ARCHITECTURE.md section 4.7): `applyPatch` merges what Claude (or the viewer, as `user`)
 * writes into an explainer, atomically. Nothing is mutated: on any error the input explainer is
 * returned untouched. The merge rules are documented in patch.ts.
 *
 * Validation after the merge is strict, but only what the patch introduced or touched can reject it:
 * errors that were already in the explainer, on elements the patch did not change, become one
 * summary warning. Otherwise a single drifted anchor on a user-owned concept would block every later
 * patch. One more exception: an `llm` patch that changes an element whose anchors the user owns
 * (`anchors` in `userFields`) is not rejected for the drift of those anchors, which it cannot
 * repair; the problem is kept as a warning.
 */
import { makeAnchor, toTextCache, type GetText, type TextCache } from "./anchors.js";
import { EXPLAINER_SCHEMA } from "./constants.js";
import { EDGE_KINDS, nodeKindOfId, parseId, REPO_ID } from "./ids.js";
import { asIndexModel, type IndexModel } from "./index-model.js";
import { defaultLabel, ExplainerModel } from "./model.js";
import type { AnchorInput, ExplainerPatch } from "./patch.js";
import type {
  Anchor,
  Concept,
  Edge,
  Explainer,
  Node,
  Provenance,
  SequenceStep,
  SymbolIndex,
  Tour,
  TourStep,
} from "./schema.js";
import { cloneJson, deepEqual, isRecord, unique } from "./util.js";
import { validateExplainer, type Issue, type IssueCode } from "./validate.js";

export interface ApplyOptions {
  /** Who is writing. `llm` never modifies or removes `user` elements and keeps `userFields`. */
  actor: "llm" | "user";
}

export interface ApplyResult {
  /** No error. When false, `explainer` is the input, untouched, and nothing was applied. */
  ok: boolean;
  explainer: Explainer;
  issues: Issue[];
  /**
   * Ids of the elements, views, tours and steps the patch added, changed or removed (in patch order;
   * upserts that change nothing are not listed), plus `"title"` when the title changed.
   */
  changed: string[];
}

/** A new, empty explainer bound to an index. */
export function createExplainer(opts: {
  title: string;
  repoName: string;
  repoUrl?: string;
  index: SymbolIndex | IndexModel;
  /** Repo-root-relative path of the index file, e.g. `.explainer/index-a1b2c3d.json`. */
  indexPath: string;
}): Explainer {
  const commit = asIndexModel(opts.index).commit;
  return {
    schema: EXPLAINER_SCHEMA,
    title: opts.title,
    repo: {
      name: opts.repoName,
      ...(opts.repoUrl !== undefined ? { url: opts.repoUrl } : {}),
      commit,
    },
    index: { path: opts.indexPath, commit },
    nodes: [],
    edges: [],
    concepts: [],
    views: [],
    tours: [],
  };
}

// ─── Field specs (what a patch may contain) ─────────────────────────────────────────────────────

type FieldType =
  "string" | "string[]" | "number" | "boolean" | "object" | "array" | readonly string[];

interface Spec {
  fields: Readonly<Record<string, FieldType>>;
  /** Optional fields that `null` clears. */
  nullable: readonly string[];
}

const ORIGINS = ["static", "llm", "user"] as const;
const NODE_KINDS = ["repo", "dir", "file", "symbol", "group"] as const;

const NODE_SPEC: Spec = {
  fields: {
    id: "string",
    kind: NODE_KINDS,
    label: "string",
    summary: "string",
    detail: "string",
    parent: "string",
    members: "string[]",
    anchors: "array",
    provenance: "object",
  },
  nullable: ["summary", "detail", "members"],
};
const EDGE_SPEC: Spec = {
  fields: {
    id: "string",
    from: "string",
    to: "string",
    kind: EDGE_KINDS,
    label: "string",
    summary: "string",
    detail: "string",
    anchors: "array",
    provenance: "object",
  },
  nullable: ["summary", "detail"],
};
const CONCEPT_SPEC: Spec = {
  fields: {
    id: "string",
    label: "string",
    summary: "string",
    detail: "string",
    anchors: "array",
    related: "string[]",
    provenance: "object",
  },
  nullable: ["summary", "detail", "related"],
};
const GRAPH_SPEC: Spec = {
  fields: {
    id: "string",
    type: ["graph"],
    title: "string",
    scope: "object",
    provenance: "object",
    include: "string[]",
    edgeKinds: "array",
    hidden: "string[]",
    layout: "object",
  },
  nullable: ["edgeKinds", "hidden", "layout"],
};
const SEQUENCE_SPEC: Spec = {
  fields: {
    id: "string",
    type: ["sequence"],
    title: "string",
    scope: "object",
    provenance: "object",
    participants: "string[]",
    steps: "array",
    frames: "array",
  },
  nullable: ["frames"],
};
const TOUR_SPEC: Spec = {
  fields: { id: "string", title: "string", steps: "array" },
  nullable: [],
};
const STEP_SPEC: Spec = {
  fields: {
    id: "string",
    from: "string",
    to: "string",
    label: "string",
    kind: ["call", "return", "async"],
    edge: "string",
    anchors: "array",
    summary: "string",
  },
  nullable: [],
};
const FRAME_SPEC: Spec = {
  fields: {
    id: "string",
    kind: ["loop", "alt", "opt", "par"],
    label: "string",
    fromStep: "string",
    toStep: "string",
  },
  nullable: [],
};
const TOUR_STEP_SPEC: Spec = {
  fields: {
    id: "string",
    view: "string",
    focus: "string[]",
    code: "array",
    note: "string",
    editor: "object",
  },
  nullable: [],
};
const SCOPE_SPEC: Spec = {
  fields: { root: "string", depth: "number", question: "string", entryPoints: "string[]" },
  nullable: [],
};
const EDITOR_SPEC: Spec = {
  fields: { dimOthers: "boolean", hideFileTree: "boolean", primary: "string" },
  nullable: [],
};
const PROVENANCE_SPEC: Spec = {
  fields: { origin: ORIGINS, userFields: "string[]", commit: "string" },
  nullable: [],
};
const PATCH_KEYS = ["title", "nodes", "edges", "concepts", "views", "tours", "remove"];

function matches(value: unknown, type: FieldType): boolean {
  if (typeof type !== "string") return typeof value === "string" && type.includes(value);
  switch (type) {
    case "string":
      return typeof value === "string";
    case "string[]":
      return Array.isArray(value) && value.every((v) => typeof v === "string");
    case "number":
      return typeof value === "number" && Number.isFinite(value);
    case "boolean":
      return typeof value === "boolean";
    case "object":
      return isRecord(value);
    case "array":
      return Array.isArray(value);
  }
}

function describeType(type: FieldType): string {
  if (typeof type !== "string") return `one of ${type.map((t) => `"${t}"`).join(", ")}`;
  return type === "string[]" ? "an array of strings" : `a ${type}`;
}

/** Drops the `resolved` cache of anchors (a re-resolve is not a content change). */
function stripResolved(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripResolved);
  if (isRecord(value)) {
    const out: Record<string, unknown> = {};
    for (const [key, v] of Object.entries(value)) {
      if (key === "resolved" && isRecord(v) && "status" in v && "range" in v) continue;
      out[key] = stripResolved(v);
    }
    return out;
  }
  return value;
}

function sameContent(a: unknown, b: unknown): boolean {
  return deepEqual(stripResolved(a), stripResolved(b));
}

/** Loosely typed JSON object: patches and stored elements are handled field by field. */
type AnyRecord = Record<string, any>;
type Kind = "node" | "edge" | "concept" | "graph" | "sequence" | "tour";

// ─── applyPatch ─────────────────────────────────────────────────────────────────────────────────

/**
 * Applies a patch to an explainer.
 *
 * - Upsert by id; an existing element is shallow-merged (absent fields keep their values, `null`
 *   clears an optional field, arrays replace wholesale); a new id needs its required fields.
 * - Anchors go through `makeAnchor` (hash and `resolved` filled in; unresolvable anchors are errors).
 * - `actor: "llm"` never modifies or removes an element (or view) whose origin is `user` (skipped with
 *   a warning) and keeps fields listed in `provenance.userFields`. `actor: "user"` editing an element
 *   of another origin adds the changed fields to its `userFields`.
 * - New elements get `provenance = { origin: actor, commit: index.commit }` unless given; a changed
 *   `llm` element gets `provenance.commit = index.commit`.
 * - `remove` deletes elements, views, tours and steps by id.
 * - Atomic: any error (in the patch, or introduced by it: see the file header) returns `ok: false`
 *   and the input explainer, untouched. Issue paths point into the patch where they can.
 */
export function applyPatch(
  explainer: Explainer,
  patch: ExplainerPatch,
  index: SymbolIndex | IndexModel,
  getText: GetText | TextCache,
  opts: ApplyOptions,
): ApplyResult {
  return new Applier(explainer, asIndexModel(index), toTextCache(getText), opts.actor).run(patch);
}

class Applier {
  private readonly input: Explainer;
  private readonly index: IndexModel;
  private readonly texts: TextCache;
  private readonly actor: "llm" | "user";
  private readonly work: Explainer;
  private readonly structure: ExplainerModel;
  private readonly issues: Issue[] = [];
  private readonly changed: string[] = [];
  /** Touched (added or changed) ids -> their path in the patch. */
  private readonly touched = new Map<string, string>();
  /** Position of each id in `patch.remove`, for issue paths. */
  private readonly removeIndex = new Map<string, number>();
  private errors = 0;

  constructor(input: Explainer, index: IndexModel, texts: TextCache, actor: "llm" | "user") {
    this.input = input;
    this.index = index;
    this.texts = texts;
    this.actor = actor;
    this.work = cloneJson(input);
    this.structure = new ExplainerModel(this.work, index);
  }

  // ─── Reporting ──────────────────────────────────────────────────────────────────────────────

  private error(
    path: string,
    message: string,
    elementId?: string,
    code: IssueCode = "schema",
  ): void {
    this.errors++;
    this.issues.push({
      severity: "error",
      path,
      ...(elementId ? { elementId } : {}),
      message,
      code,
    });
  }

  private warn(
    path: string,
    message: string,
    elementId?: string,
    code: IssueCode = "schema",
  ): void {
    this.issues.push({
      severity: "warning",
      path,
      ...(elementId ? { elementId } : {}),
      message,
      code,
    });
  }

  private fail(): ApplyResult {
    return { ok: false, explainer: this.input, issues: this.issues, changed: [] };
  }

  // ─── Driver ─────────────────────────────────────────────────────────────────────────────────

  run(patch: ExplainerPatch): ApplyResult {
    if (this.actor !== "llm" && this.actor !== "user") {
      this.error("", `actor must be "llm" or "user"`);
      return this.fail();
    }
    if (!isRecord(patch)) {
      this.error(
        "",
        "patch must be an object {title?, nodes?, edges?, concepts?, views?, tours?, remove?}",
      );
      return this.fail();
    }
    for (const key of Object.keys(patch)) {
      if (!PATCH_KEYS.includes(key)) {
        this.error(key, `unknown patch field "${key}" (allowed: ${PATCH_KEYS.join(", ")})`);
      }
    }
    for (const key of ["nodes", "edges", "concepts", "views", "tours"] as const) {
      if (!Array.isArray((this.work as unknown as AnyRecord)[key])) {
        this.error("", `the explainer's ${key} is not an array; repair the file first`);
      }
    }
    if (this.errors > 0) return this.fail();

    const seen = new Map<string, string>();
    const each = (name: keyof ExplainerPatch, handler: (raw: unknown, i: number) => void) => {
      const list = patch[name];
      if (list === undefined) return;
      if (!Array.isArray(list)) {
        this.error(name, `${name} must be an array`);
        return;
      }
      list.forEach((raw: unknown, i) => {
        const id = isRecord(raw) ? raw.id : undefined;
        if (typeof id === "string") {
          const first = seen.get(id);
          if (first !== undefined) {
            this.error(
              `${name}[${i}].id`,
              `id "${id}" appears twice in the patch (also at ${first}); merge the two entries`,
              id,
              "duplicate-id",
            );
            return;
          }
          seen.set(id, `${name}[${i}]`);
        }
        handler(raw, i);
      });
    };

    const removals = this.removalList(patch.remove);
    each("nodes", (raw, i) => this.upsertElement("node", raw, i));
    each("edges", (raw, i) => this.upsertElement("edge", raw, i));
    each("concepts", (raw, i) => this.upsertElement("concept", raw, i));
    each("views", (raw, i) => this.upsertView(raw, i));
    each("tours", (raw, i) => this.upsertTour(raw, i));
    for (const id of removals) {
      const at = seen.get(id);
      if (at !== undefined) {
        this.error("remove", `${id} is both upserted (${at}) and removed by this patch`, id);
      }
    }
    if (patch.title !== undefined) {
      if (typeof patch.title !== "string" || patch.title.trim() === "") {
        this.error("title", "title must be a non-empty string");
      } else if (patch.title !== this.work.title) {
        this.work.title = patch.title;
        this.changed.push("title");
      }
    }
    if (this.errors === 0) this.remove(removals);
    if (this.errors > 0) return this.fail();

    return this.validate();
  }

  // ─── Removal ────────────────────────────────────────────────────────────────────────────────

  private removalList(remove: unknown): string[] {
    if (remove === undefined) return [];
    if (!Array.isArray(remove) || remove.some((id) => typeof id !== "string" || id === "")) {
      this.error("remove", "remove must be an array of element / view / tour ids");
      return [];
    }
    (remove as string[]).forEach((id, i) => {
      if (!this.removeIndex.has(id)) this.removeIndex.set(id, i);
    });
    return unique(remove as string[]);
  }

  private remove(ids: readonly string[]): void {
    const w = this.work as unknown as Record<
      "nodes" | "edges" | "concepts" | "views" | "tours",
      AnyRecord[]
    >;
    ids.forEach((id) => {
      const path = `remove[${this.removeIndex.get(id) ?? ids.indexOf(id)}]`;
      const protectedOwner = (origin: string | undefined): boolean => {
        if (this.actor === "llm" && origin === "user") {
          this.warn(
            path,
            `${id} is user-authored; an llm patch cannot remove it (skipped)`,
            id,
            "protected",
          );
          return true;
        }
        return false;
      };
      for (const list of ["nodes", "edges", "concepts"] as const) {
        const at = w[list].findIndex((e) => e.id === id);
        if (at === -1) continue;
        if (protectedOwner(w[list][at]!.provenance?.origin)) return;
        w[list].splice(at, 1);
        this.changed.push(id);
        return;
      }
      const viewAt = w.views.findIndex((v) => v.id === id);
      if (viewAt !== -1) {
        if (protectedOwner(w.views[viewAt]!.provenance?.origin)) return;
        w.views.splice(viewAt, 1);
        this.changed.push(id);
        return;
      }
      const tourAt = w.tours.findIndex((t) => t.id === id);
      if (tourAt !== -1) {
        w.tours.splice(tourAt, 1);
        this.changed.push(id);
        return;
      }
      for (const view of w.views) {
        const stepAt = Array.isArray(view.steps)
          ? view.steps.findIndex((s: AnyRecord) => s.id === id)
          : -1;
        if (stepAt === -1) continue;
        if (protectedOwner(view.provenance?.origin)) return;
        view.steps.splice(stepAt, 1);
        this.changed.push(id);
        return;
      }
      this.warn(path, `nothing to remove: no element, view, tour or step has the id ${id}`, id);
    });
  }

  // ─── Field handling ─────────────────────────────────────────────────────────────────────────

  /** Checks the keys and value types of an object against a spec. */
  private checkFields(
    obj: AnyRecord,
    spec: Spec,
    path: string,
    id: string | undefined,
    allowNull: boolean,
  ): boolean {
    let ok = true;
    for (const [key, value] of Object.entries(obj)) {
      const type = spec.fields[key];
      if (type === undefined) {
        this.error(
          `${path}.${key}`,
          `unknown field "${key}" (allowed: ${Object.keys(spec.fields).join(", ")})`,
          id,
        );
        ok = false;
      } else if (value === undefined) {
        continue;
      } else if (value === null) {
        if (allowNull && spec.nullable.includes(key)) continue;
        this.error(
          `${path}.${key}`,
          `${key} cannot be null` +
            (allowNull && spec.nullable.length > 0
              ? ` (null clears only: ${spec.nullable.join(", ")})`
              : ""),
          id,
        );
        ok = false;
      } else if (!matches(value, type)) {
        this.error(`${path}.${key}`, `${key} must be ${describeType(type)}`, id);
        ok = false;
      }
    }
    return ok;
  }

  /** `AnchorInput[]` -> stored anchors (every failure is reported); undefined when any failed. */
  private anchors(value: unknown, path: string, id: string): Anchor[] | undefined {
    if (!Array.isArray(value)) {
      this.error(path, "anchors must be an array of {file, symbol?, span?|find?, role}", id);
      return undefined;
    }
    const out: Anchor[] = [];
    let ok = true;
    value.forEach((input: AnchorInput, i) => {
      const made = makeAnchor(input, this.index, this.texts);
      if (made.ok) out.push(made.anchor);
      else {
        ok = false;
        this.error(`${path}[${i}]`, made.error, id, "anchor-invalid");
      }
    });
    return ok ? out : undefined;
  }

  private convertSteps(value: unknown, path: string, viewId: string): SequenceStep[] | undefined {
    if (!Array.isArray(value)) {
      this.error(path, "steps must be an array", viewId);
      return undefined;
    }
    let ok = true;
    const out: SequenceStep[] = [];
    value.forEach((raw: unknown, j) => {
      const at = `${path}[${j}]`;
      if (!isRecord(raw)) {
        this.error(at, "step must be an object {id, from, to, label, kind, anchors?}", viewId);
        ok = false;
        return;
      }
      if (!this.checkFields(raw, STEP_SPEC, at, viewId, false)) {
        ok = false;
        return;
      }
      for (const key of ["id", "from", "to", "label", "kind"]) {
        if (raw[key] === undefined) {
          this.error(`${at}.${key}`, `step needs "${key}"`, viewId);
          ok = false;
        }
      }
      const anchors =
        raw.anchors === undefined
          ? []
          : this.anchors(raw.anchors, `${at}.anchors`, String(raw.id ?? viewId));
      if (!anchors || ["id", "from", "to", "label", "kind"].some((key) => raw[key] === undefined)) {
        ok = false;
        return;
      }
      out.push({
        id: raw.id,
        from: raw.from,
        to: raw.to,
        label: raw.label,
        kind: raw.kind,
        ...(raw.edge !== undefined ? { edge: raw.edge } : {}),
        anchors,
        ...(raw.summary !== undefined ? { summary: raw.summary } : {}),
      } as SequenceStep);
    });
    return ok ? out : undefined;
  }

  private convertTourSteps(value: unknown, path: string, tourId: string): TourStep[] | undefined {
    if (!Array.isArray(value)) {
      this.error(path, "steps must be an array", tourId);
      return undefined;
    }
    let ok = true;
    const out: TourStep[] = [];
    value.forEach((raw: unknown, j) => {
      const at = `${path}[${j}]`;
      if (!isRecord(raw)) {
        this.error(
          at,
          "tour step must be an object {id, view, focus, code?, note?, editor?}",
          tourId,
        );
        ok = false;
        return;
      }
      if (!this.checkFields(raw, TOUR_STEP_SPEC, at, tourId, false)) {
        ok = false;
        return;
      }
      if (
        isRecord(raw.editor) &&
        !this.checkFields(raw.editor, EDITOR_SPEC, `${at}.editor`, tourId, false)
      ) {
        ok = false;
        return;
      }
      for (const key of ["id", "view", "focus"]) {
        if (raw[key] === undefined) {
          this.error(`${at}.${key}`, `tour step needs "${key}"`, tourId);
          ok = false;
        }
      }
      const code =
        raw.code === undefined ? undefined : this.anchors(raw.code, `${at}.code`, tourId);
      if (
        (raw.code !== undefined && !code) ||
        raw.id === undefined ||
        raw.view === undefined ||
        raw.focus === undefined
      ) {
        ok = false;
        return;
      }
      out.push({
        id: raw.id,
        view: raw.view,
        focus: [...(raw.focus as string[])],
        ...(code ? { code } : {}),
        ...(raw.note !== undefined ? { note: raw.note } : {}),
        ...(raw.editor !== undefined ? { editor: cloneJson(raw.editor) } : {}),
      } as TourStep);
    });
    return ok ? out : undefined;
  }

  private convertFrames(value: unknown, path: string, viewId: string): unknown[] | undefined {
    if (!Array.isArray(value)) {
      this.error(path, "frames must be an array", viewId);
      return undefined;
    }
    let ok = true;
    value.forEach((raw: unknown, j) => {
      const at = `${path}[${j}]`;
      if (!isRecord(raw)) {
        this.error(at, "frame must be an object {id, kind, label, fromStep, toStep}", viewId);
        ok = false;
        return;
      }
      if (!this.checkFields(raw, FRAME_SPEC, at, viewId, false)) ok = false;
      for (const key of Object.keys(FRAME_SPEC.fields)) {
        if (raw[key] === undefined) {
          this.error(`${at}.${key}`, `frame needs "${key}"`, viewId);
          ok = false;
        }
      }
    });
    return ok ? cloneJson(value) : undefined;
  }

  /**
   * Converts the fields of a patch element into stored form: anchors through `makeAnchor`, steps and
   * tour steps likewise, everything else copied. `id` and `provenance` are handled separately.
   * Fields in `protectedKeys` are skipped (with a warning). Returns the fields to set and the keys
   * to clear; undefined when anything failed.
   */
  private convertFields(
    kind: Kind,
    raw: AnyRecord,
    path: string,
    id: string,
    protectedKeys: ReadonlySet<string>,
  ): { set: AnyRecord; clear: string[] } | undefined {
    const set: AnyRecord = {};
    const clear: string[] = [];
    let ok = true;
    for (const [key, value] of Object.entries(raw)) {
      if (key === "id" || key === "provenance" || value === undefined) continue;
      if (protectedKeys.has(key)) {
        this.warn(
          `${path}.${key}`,
          `${key} of ${id} was edited by the user and is kept as it is`,
          id,
          "protected",
        );
        continue;
      }
      if (value === null) {
        clear.push(key);
        continue;
      }
      let converted: unknown = value;
      if (key === "anchors") converted = this.anchors(value, `${path}.anchors`, id);
      else if (key === "steps" && kind === "sequence")
        converted = this.convertSteps(value, `${path}.steps`, id);
      else if (key === "steps" && kind === "tour")
        converted = this.convertTourSteps(value, `${path}.steps`, id);
      else if (key === "frames") converted = this.convertFrames(value, `${path}.frames`, id);
      else if (key === "scope") {
        if (!this.checkFields(value, SCOPE_SPEC, `${path}.scope`, id, false)) converted = undefined;
        else converted = cloneJson(value);
      } else converted = cloneJson(value);
      if (converted === undefined) ok = false;
      else set[key] = converted;
    }
    return ok ? { set, clear } : undefined;
  }

  private newProvenance(raw: AnyRecord, path: string, id: string): Provenance | undefined {
    const base: Provenance = { origin: this.actor, commit: this.index.commit };
    if (raw.provenance === undefined) return base;
    const given = raw.provenance;
    if (
      !isRecord(given) ||
      !this.checkFields(given, PROVENANCE_SPEC, `${path}.provenance`, id, false)
    ) {
      if (!isRecord(given))
        this.error(`${path}.provenance`, "provenance must be {origin?, userFields?, commit?}", id);
      return undefined;
    }
    if (this.actor === "llm" && given.origin === "user") {
      this.error(
        `${path}.provenance.origin`,
        `an llm patch cannot create user-authored elements (origin "user")`,
        id,
      );
      return undefined;
    }
    return { ...base, ...(cloneJson(given) as Partial<Provenance>) };
  }

  // ─── Elements (nodes, edges, concepts) ──────────────────────────────────────────────────────

  private upsertElement(kind: "node" | "edge" | "concept", raw: unknown, i: number): void {
    const listName = kind === "node" ? "nodes" : kind === "edge" ? "edges" : "concepts";
    const path = `${listName}[${i}]`;
    const spec = kind === "node" ? NODE_SPEC : kind === "edge" ? EDGE_SPEC : CONCEPT_SPEC;
    if (!isRecord(raw)) {
      this.error(path, `${kind} must be an object with an "id"`);
      return;
    }
    const id = raw.id;
    if (typeof id !== "string" || id === "") {
      this.error(`${path}.id`, `${kind} needs a non-empty string "id"`);
      return;
    }
    if (!this.checkFields(raw, spec, path, id, true)) return;
    const list = (this.work as unknown as Record<string, AnyRecord[]>)[listName]!;
    const at = list.findIndex((e) => e.id === id);
    if (at === -1) {
      const created = this.createElement(kind, raw, path, id);
      if (!created) return;
      list.push(created);
      this.touched.set(id, path);
      this.changed.push(id);
      return;
    }
    const existing = list[at]!;
    if (this.skipUserOwned(existing, id, path)) return;
    const merged = this.mergeExisting(
      kind,
      existing,
      raw,
      path,
      id,
      kind === "node" ? "kind" : undefined,
    );
    if (!merged) return;
    if (merged !== existing) {
      list[at] = merged;
      this.touched.set(id, path);
      this.changed.push(id);
    }
  }

  private skipUserOwned(existing: AnyRecord, id: string, path: string): boolean {
    if (this.actor === "llm" && existing.provenance?.origin === "user") {
      this.warn(
        path,
        `${id} is user-authored; an llm patch cannot modify it (skipped)`,
        id,
        "protected",
      );
      return true;
    }
    return false;
  }

  /**
   * Shallow-merges the patch onto an existing element (or view / tour). Returns the existing object
   * itself when nothing changed, the merged copy otherwise, undefined on errors.
   */
  private mergeExisting(
    kind: Kind,
    existing: AnyRecord,
    raw: AnyRecord,
    path: string,
    id: string,
    immutableKey: "kind" | "type" | undefined,
  ): AnyRecord | undefined {
    if (
      immutableKey &&
      raw[immutableKey] !== undefined &&
      raw[immutableKey] !== existing[immutableKey]
    ) {
      this.error(
        `${path}.${immutableKey}`,
        `cannot change ${immutableKey} of ${id} from "${String(existing[immutableKey])}" to "${String(raw[immutableKey])}"`,
        id,
      );
      return undefined;
    }
    const protectedKeys: ReadonlySet<string> =
      this.actor === "llm"
        ? new Set<string>(existing.provenance?.userFields ?? [])
        : new Set<string>();
    const fields = this.convertFields(kind, raw, path, id, protectedKeys);
    if (!fields) return undefined;

    const merged: AnyRecord = cloneJson(existing);
    for (const [key, value] of Object.entries(fields.set)) {
      if (key === immutableKey) continue;
      merged[key] = value;
    }
    for (const key of fields.clear) delete merged[key];
    if (this.actor === "user" && isRecord(raw.provenance)) {
      merged.provenance = { ...(merged.provenance ?? {}), ...cloneJson(raw.provenance) };
    }
    if (sameContent(existing, merged)) return existing;
    if (kind === "tour") return merged; // tours carry no provenance

    const changedFields = Object.keys({ ...fields.set })
      .concat(fields.clear)
      .filter((key) => {
        return key !== immutableKey && !sameContent(existing[key], merged[key]);
      });
    if (merged.provenance === undefined) merged.provenance = { origin: "static" };
    const provenance: Provenance = merged.provenance;
    if (this.actor === "user") {
      if (provenance.origin !== "user" && changedFields.length > 0) {
        provenance.userFields = unique([...(provenance.userFields ?? []), ...changedFields]);
      }
    } else if (provenance.origin === "llm") {
      provenance.commit = this.index.commit;
    }
    return merged;
  }

  private createElement(
    kind: "node" | "edge" | "concept",
    raw: AnyRecord,
    path: string,
    id: string,
  ): AnyRecord | undefined {
    const fields = this.convertFields(kind, raw, path, id, new Set());
    const provenance = this.newProvenance(raw, path, id);
    if (!fields || !provenance) return undefined;
    const f = fields.set;
    if (fields.clear.length > 0) {
      this.warn(
        `${path}.${fields.clear[0]}`,
        `${fields.clear.join(", ")} is null on a new element; ignored`,
        id,
      );
    }
    const anchors: Anchor[] = f.anchors ?? [];

    if (kind === "node") {
      const expected = nodeKindOfId(id);
      if (expected === undefined) {
        this.error(
          `${path}.id`,
          `node id "${id}" must be "dir:<path>", "file:<path>", "sym:<file>#<symbol>", "repo" or "grp:<slug>"`,
          id,
          "bad-id",
        );
        return undefined;
      }
      if (f.kind !== undefined && f.kind !== expected) {
        this.error(
          `${path}.kind`,
          `node ${id} has kind "${String(f.kind)}" but its id says "${expected}"`,
          id,
          "bad-id",
        );
        return undefined;
      }
      let label = f.label as string | undefined;
      let parent: string | null;
      if (expected === "group") {
        if (label === undefined) return this.missing(path, id, "label");
        if (f.members === undefined) return this.missing(path, id, "members");
        parent = (f.parent as string | undefined) ?? REPO_ID;
      } else {
        if (!this.structure.hasNode(id)) {
          this.error(
            `${path}.id`,
            `${expected} ${id} does not exist in the index; only existing files, directories and symbols can be given a stored overlay`,
            id,
            "unknown-id",
          );
          return undefined;
        }
        label ??= defaultLabel(id, this.index, this.work.repo?.name ?? "repo");
        parent = this.structure.parent(id) ?? null;
      }
      const node: Node = {
        id,
        kind: expected,
        label,
        ...(f.summary !== undefined ? { summary: f.summary } : {}),
        ...(f.detail !== undefined ? { detail: f.detail } : {}),
        parent,
        ...(f.members !== undefined ? { members: f.members } : {}),
        anchors,
        provenance,
      };
      return node;
    }

    if (kind === "edge") {
      const parsed = parseId(id);
      if (parsed.type !== "edge" && parsed.type !== "derived-edge") {
        this.error(
          `${path}.id`,
          `edge id "${id}" must start with "edge:" (stored edges are "edge:<slug>")`,
          id,
          "bad-id",
        );
        return undefined;
      }
      const derived = parsed.type === "derived-edge" ? parsed : undefined;
      const from = (f.from as string | undefined) ?? derived?.from;
      const to = (f.to as string | undefined) ?? derived?.to;
      const edgeKind = (f.kind as Edge["kind"] | undefined) ?? derived?.kind;
      const label = (f.label as string | undefined) ?? (derived ? "" : undefined);
      if (from === undefined) return this.missing(path, id, "from");
      if (to === undefined) return this.missing(path, id, "to");
      if (edgeKind === undefined) return this.missing(path, id, "kind");
      if (label === undefined) return this.missing(path, id, "label");
      const edge: Edge = {
        id,
        from,
        to,
        kind: edgeKind,
        label,
        ...(f.summary !== undefined ? { summary: f.summary } : {}),
        ...(f.detail !== undefined ? { detail: f.detail } : {}),
        anchors,
        provenance,
      };
      return edge;
    }

    if (f.label === undefined) return this.missing(path, id, "label");
    const concept: Concept = {
      id,
      label: f.label,
      ...(f.summary !== undefined ? { summary: f.summary } : {}),
      ...(f.detail !== undefined ? { detail: f.detail } : {}),
      anchors,
      ...(f.related !== undefined ? { related: f.related } : {}),
      provenance,
    };
    return concept;
  }

  private missing(path: string, id: string, field: string): undefined {
    this.error(
      `${path}.${field}`,
      `new ${path.split("[")[0]!.replace(/s$/, "")} ${id} needs "${field}"`,
      id,
    );
    return undefined;
  }

  // ─── Views and tours ────────────────────────────────────────────────────────────────────────

  private upsertView(raw: unknown, i: number): void {
    const path = `views[${i}]`;
    if (!isRecord(raw)) {
      this.error(path, `view must be an object with an "id" and a "type"`);
      return;
    }
    const id = raw.id;
    if (typeof id !== "string" || id === "") {
      this.error(`${path}.id`, `view needs a non-empty string "id"`);
      return;
    }
    const views = this.work.views as unknown as AnyRecord[];
    const at = views.findIndex((v) => v.id === id);
    const type = raw.type ?? (at !== -1 ? views[at]!.type : undefined);
    if (type !== "graph" && type !== "sequence") {
      this.error(
        `${path}.type`,
        `view.type must be "graph" or "sequence" (got ${JSON.stringify(raw.type)})`,
        id,
      );
      return;
    }
    const spec = type === "graph" ? GRAPH_SPEC : SEQUENCE_SPEC;
    if (!this.checkFields({ ...raw, type }, spec, path, id, true)) return;

    if (at === -1) {
      const created = this.createView(type, raw, path, id);
      if (!created) return;
      views.push(created);
      this.touched.set(id, path);
      this.changed.push(id);
      return;
    }
    const existing = views[at]!;
    if (this.skipUserOwned(existing, id, path)) return;
    const before = Array.isArray(existing.steps)
      ? (existing.steps as AnyRecord[]).map((s) => s.id)
      : [];
    const merged = this.mergeExisting(type, existing, raw, path, id, "type");
    if (!merged) return;
    if (merged === existing) return;
    if (type === "sequence" && Array.isArray(merged.steps)) {
      const after = new Set((merged.steps as AnyRecord[]).map((s) => s.id));
      const dropped = before.filter((sid) => !after.has(sid));
      if (dropped.length > 0) {
        this.warn(
          `${path}.steps`,
          `steps ${dropped.join(", ")} were dropped from ${id}; tours may point at step ids, and step ids should never be renumbered`,
          id,
          "step",
        );
      }
    }
    views[at] = merged;
    this.touched.set(id, path);
    this.changed.push(id);
  }

  private createView(
    type: "graph" | "sequence",
    raw: AnyRecord,
    path: string,
    id: string,
  ): AnyRecord | undefined {
    const fields = this.convertFields(type, raw, path, id, new Set());
    const provenance = this.newProvenance(raw, path, id);
    if (!fields || !provenance) return undefined;
    const f = fields.set;
    if (f.title === undefined) return this.missing(path, id, "title");
    const scope = f.scope ?? { root: REPO_ID, depth: 1 };
    if (f.scope !== undefined && (f.scope.root === undefined || f.scope.depth === undefined)) {
      this.error(
        `${path}.scope`,
        `scope needs "root" and "depth" (or omit scope for {root: "repo", depth: 1})`,
        id,
      );
      return undefined;
    }
    if (type === "graph") {
      if (f.include === undefined) return this.missing(path, id, "include");
      return {
        id,
        type: "graph",
        title: f.title,
        scope,
        include: f.include,
        ...(f.edgeKinds !== undefined ? { edgeKinds: f.edgeKinds } : {}),
        ...(f.hidden !== undefined ? { hidden: f.hidden } : {}),
        ...(f.layout !== undefined ? { layout: f.layout } : {}),
        provenance,
      };
    }
    if (f.participants === undefined) return this.missing(path, id, "participants");
    if (f.steps === undefined) return this.missing(path, id, "steps");
    return {
      id,
      type: "sequence",
      title: f.title,
      scope,
      participants: f.participants,
      steps: f.steps,
      ...(f.frames !== undefined ? { frames: f.frames } : {}),
      provenance,
    };
  }

  private upsertTour(raw: unknown, i: number): void {
    const path = `tours[${i}]`;
    if (!isRecord(raw)) {
      this.error(path, `tour must be an object with an "id"`);
      return;
    }
    const id = raw.id;
    if (typeof id !== "string" || id === "") {
      this.error(`${path}.id`, `tour needs a non-empty string "id"`);
      return;
    }
    if (!this.checkFields(raw, TOUR_SPEC, path, id, true)) return;
    const tours = this.work.tours as unknown as AnyRecord[];
    const at = tours.findIndex((t) => t.id === id);
    if (at === -1) {
      const fields = this.convertFields("tour", raw, path, id, new Set());
      if (!fields) return;
      for (const required of ["title", "steps"]) {
        if (fields.set[required] === undefined) {
          this.missing(path, id, required);
          return;
        }
      }
      tours.push({ id, title: fields.set.title, steps: fields.set.steps } satisfies Tour);
      this.touched.set(id, path);
      this.changed.push(id);
      return;
    }
    const existing = tours[at]!;
    const merged = this.mergeExisting("tour", existing, raw, path, id, undefined);
    if (!merged || merged === existing) return;
    tours[at] = merged;
    this.touched.set(id, path);
    this.changed.push(id);
  }

  // ─── Validation of the result ───────────────────────────────────────────────────────────────

  private validate(): ApplyResult {
    const before = validateExplainer(this.input, this.index, this.texts, { mode: "strict" });
    const after = validateExplainer(this.work, this.index, this.texts, { mode: "strict" });
    const key = (issue: Issue) => `${issue.code ?? ""}|${issue.elementId ?? ""}|${issue.message}`;
    const knownBefore = new Set(before.map(key));
    const rewrite = this.pathRewriter();

    let ignored = 0;
    let firstIgnored: string | undefined;
    for (const issue of after) {
      const touched = issue.elementId !== undefined && this.touched.has(issue.elementId);
      const isNew = !knownBefore.has(key(issue));
      const shown = { ...issue, path: rewrite(issue.path) };
      if (issue.severity === "error") {
        if (this.actor === "llm" && issue.userLocked && touched && !isNew) {
          // The patch changed an element whose anchors the user owns and cannot repair them: the problem
          // stays visible, but it must not block the re-explanation (it would need the user first).
          this.issues.push({ ...shown, severity: "warning" });
        } else if (isNew || touched) this.issues.push(shown);
        else {
          ignored++;
          firstIgnored ??= `${issue.path}: ${issue.message}`;
        }
      } else if (isNew || touched || issue.code === "commit") {
        this.issues.push(shown);
      }
    }
    if (ignored > 0) {
      this.warn(
        "",
        `${ignored} existing validation error(s) in parts of the explainer this patch did not touch were ignored (first: ${firstIgnored}); run \`xpl validate\` to see them`,
      );
    }
    if (this.issues.some((issue) => issue.severity === "error")) return this.fail();
    return { ok: true, explainer: this.work, issues: this.issues, changed: unique(this.changed) };
  }

  /** Maps paths into the merged explainer (`nodes[3]`) back to the patch (`nodes[0]`). */
  private pathRewriter(): (path: string) => string {
    const prefixes: [string, string][] = [];
    const w = this.work as unknown as Record<string, AnyRecord[]>;
    for (const [id, patchPath] of this.touched) {
      const list = patchPath.slice(0, patchPath.indexOf("["));
      const at = w[list]?.findIndex((e) => e.id === id) ?? -1;
      if (at !== -1) prefixes.push([`${list}[${at}]`, patchPath]);
    }
    return (path) => {
      for (const [from, to] of prefixes) {
        if (path === from || path.startsWith(`${from}.`) || path.startsWith(`${from}[`)) {
          return to + path.slice(from.length);
        }
      }
      return path;
    };
  }
}
