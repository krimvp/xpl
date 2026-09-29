/**
 * Patches (ARCHITECTURE.md section 4.7): `applyPatch` merges what Claude (or the viewer, as `user`)
 * writes into an explainer, atomically. Nothing is mutated: on any error the input explainer is
 * returned untouched. The merge rules are documented in patch.ts.
 *
 * One wave of errors: a patch is judged whole, so that one `apply` shows everything that is wrong with it. An
 * element whose anchors fail is still merged, without the failed anchors, so that the references it carries
 * (a tour's `focus`, a concept's `related`, a step's ends) are checked in the same pass; an element that cannot
 * be built at all (a wrong field, a missing one) is left out and the ids it would have had are assumed to exist,
 * so that its failure does not become a second error at every reference to it. What depends on an anchor that
 * failed (the evidence an llm edge needs) is not checked until the anchor is fixed.
 *
 * Validation after the merge is strict, but only what the patch introduced or touched can reject it:
 * errors that were already in the explainer, on elements the patch did not change, become one
 * summary warning. Otherwise a single drifted anchor on a user-owned concept would block every later
 * patch. One more exception: an `llm` patch that changes an element whose anchors the user owns
 * (`anchors` in `userFields`) is not rejected for the drift of those anchors, which it cannot
 * repair; the problem is kept as a warning.
 */
import {
  describeAnchor,
  makeAnchor,
  storedSymbolHints,
  toTextCache,
  type GetText,
  type MakeAnchorOptions,
  type TextCache,
} from "./anchors.js";
import { EXPLAINER_SCHEMA } from "./constants.js";
import { EDGE_KINDS, listIds, nodeKindOfId, parseId, REPO_ID, suggestIds } from "./ids.js";
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
    includeAdd: "string[]",
    includeRemove: "string[]",
    edgeKinds: "array",
    hidden: "string[]",
    excludeFiles: "string[]",
    stubs: "object",
    layout: "object",
  },
  nullable: ["edgeKinds", "hidden", "excludeFiles", "stubs", "layout"],
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
    stepsUpdate: "array",
    frames: "array",
  },
  nullable: ["frames"],
};
const TOUR_SPEC: Spec = {
  fields: { id: "string", title: "string", steps: "array", provenance: "object" },
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
  // only `stepsUpdate` clears them (a step sent whole leaves them out instead)
  nullable: ["summary", "edge"],
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
/** `includeAdd` / `includeRemove` of a graph view patch (ids, without duplicates). */
interface IncludeOps {
  add: string[];
  remove: string[];
}
/** `stepsUpdate` of a sequence view patch: the entries (checked for shape), with their path in the patch. */
interface StepOps {
  updates: { id: string; fields: AnyRecord; path: string }[];
}

// ─── applyPatch ─────────────────────────────────────────────────────────────────────────────────

/**
 * Applies a patch to an explainer.
 *
 * - Upsert by id; an existing element is shallow-merged (absent fields keep their values, `null`
 *   clears an optional field, arrays replace wholesale); a new id needs its required fields.
 * - Anchors go through `makeAnchor` (hash and `resolved` filled in; unresolvable anchors are errors).
 * - `actor: "llm"` never modifies or removes an element (or view) whose origin is `user` (skipped with
 *   a warning) and keeps fields listed in `provenance.userFields`; it does not remove an element or view
 *   that carries `userFields`, nor single steps of a view whose `steps` are user fields. The one edit it
 *   may still make to a field the user owns is `includeAdd` on a graph view (it only adds; see patch.ts).
 *   `actor: "user"` editing an element of another origin adds the changed fields to its `userFields`.
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
  /** `includeAdd` of the graph views the patch edits (view id -> ids), to point issues at the patch. */
  private readonly includeAdds = new Map<string, readonly string[]>();
  /** Steps changed by `stepsUpdate` (view id -> step id -> its entry's path in the patch), to point issues at it. */
  private readonly stepUpdatePaths = new Map<string, Map<string, string>>();
  /** Views whose `stepsUpdate` the patch sends without `steps`: their step paths have nothing to map to. */
  private readonly stepsUpdateOnly = new Set<string>();
  /** Every step a `stepsUpdate` entry names (step id -> its entry's path), changed or not. */
  private readonly updatedSteps = new Map<string, string>();
  /**
   * Ids of elements, views and steps that the patch tried to create and failed to: references to them are
   * not errors (the failure is the error).
   */
  private readonly assumed = new Set<string>();
  /** Elements with an anchor that failed to build: what depends on their anchors is not judged yet. */
  private readonly anchorFailures = new Set<string>();
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
    let corrupt = false;
    for (const key of ["nodes", "edges", "concepts", "views", "tours"] as const) {
      if (!Array.isArray((this.work as unknown as AnyRecord)[key])) {
        this.error("", `the explainer's ${key} is not an array; repair the file first`);
        corrupt = true;
      }
    }
    if (corrupt) return this.fail();

    const seen = new Map<string, string>();
    const each = (name: keyof ExplainerPatch, handler: (raw: unknown, i: number) => boolean) => {
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
        if (!handler(raw, i)) this.assumeFailed(raw);
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
      const step = this.updatedSteps.get(id);
      if (step !== undefined) {
        this.error("remove", `${id} is both updated (${step}) and removed by this patch`, id);
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
    this.remove(removals);
    // Validation runs whatever went wrong above: it is what finds the references that are wrong too.
    return this.validate();
  }

  /**
   * An element, view or tour the patch could not build: its id (and the ids of the steps it carries) are
   * assumed to exist when references are checked, so that the failure is reported once, where it is.
   */
  private assumeFailed(raw: unknown): void {
    if (!isRecord(raw) || typeof raw.id !== "string") return;
    const assume = (id: string): void => {
      switch (parseId(id).type) {
        case "group":
        case "concept":
        case "edge":
        case "view":
        case "tour":
        case "step":
          this.assumed.add(id);
      }
    };
    assume(raw.id);
    if (Array.isArray(raw.steps)) {
      for (const step of raw.steps) {
        if (isRecord(step) && typeof step.id === "string") assume(step.id);
      }
    }
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
      // An llm patch leaves alone what the user owns: user-authored elements, anything carrying userFields
      // (the user edited part of it, so deleting it would throw that work away), and the steps of a view whose
      // `steps` the user edited.
      const protectedOwner = (provenance: AnyRecord | undefined, steps = false): boolean => {
        if (this.actor !== "llm") return false;
        const fields: string[] = Array.isArray(provenance?.userFields) ? provenance.userFields : [];
        let why: string | undefined;
        if (provenance?.origin === "user") why = "is user-authored";
        else if (steps && fields.includes("steps")) {
          why = "belongs to a view whose steps were edited by the user";
        } else if (!steps && fields.length > 0) {
          why = `has fields edited by the user (${fields.join(", ")})`;
        }
        if (why === undefined) return false;
        this.warn(path, `${id} ${why}; an llm patch cannot remove it (skipped)`, id, "protected");
        return true;
      };
      for (const list of ["nodes", "edges", "concepts"] as const) {
        const at = w[list].findIndex((e) => e.id === id);
        if (at === -1) continue;
        if (protectedOwner(w[list][at]!.provenance)) return;
        w[list].splice(at, 1);
        this.changed.push(id);
        return;
      }
      const viewAt = w.views.findIndex((v) => v.id === id);
      if (viewAt !== -1) {
        if (protectedOwner(w.views[viewAt]!.provenance)) return;
        w.views.splice(viewAt, 1);
        this.changed.push(id);
        return;
      }
      const tourAt = w.tours.findIndex((t) => t.id === id);
      if (tourAt !== -1) {
        if (protectedOwner(w.tours[tourAt]!.provenance)) return;
        w.tours.splice(tourAt, 1);
        this.changed.push(id);
        return;
      }
      for (const view of w.views) {
        const stepAt = Array.isArray(view.steps)
          ? view.steps.findIndex((s: AnyRecord) => s.id === id)
          : -1;
        if (stepAt === -1) continue;
        if (protectedOwner(view.provenance, true)) return;
        view.steps.splice(stepAt, 1);
        this.changed.push(id);
        return;
      }
      this.warn(
        path,
        `nothing to remove: no element, view, tour or step has the id ${id}${this.didYouMean(id)}`,
        id,
      );
    });
  }

  /** `. Did you mean: a, b?` for an id that names nothing in the explainer; empty when no id is close. */
  private didYouMean(id: string): string {
    const w = this.work as unknown as Record<string, AnyRecord[]>;
    const ids: string[] = [];
    for (const list of ["nodes", "edges", "concepts", "views", "tours"]) {
      for (const item of w[list] ?? []) if (typeof item.id === "string") ids.push(item.id);
    }
    for (const view of w.views ?? []) {
      for (const step of Array.isArray(view.steps) ? (view.steps as AnyRecord[]) : []) {
        if (typeof step.id === "string") ids.push(step.id);
      }
    }
    const found = suggestIds(id, ids);
    return found.length > 0 ? `. Did you mean: ${found.join(", ")}?` : "";
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

  private hintOptions: MakeAnchorOptions | undefined;

  /**
   * When an anchor names a symbol that is gone, the stored anchors of the explainer remember how big it was
   * (a whole-symbol anchor keeps its old range and hash), which helps to find where it went.
   */
  private anchorOptions(): MakeAnchorOptions {
    return (this.hintOptions ??= { symbolHint: storedSymbolHints(this.input) });
  }

  /**
   * `AnchorInput[]` -> stored anchors. Every failure is reported and the anchors that did build are returned
   * (the element is still merged, so that the rest of it is checked in the same pass); undefined when `value`
   * is not an array.
   */
  private anchors(value: unknown, path: string, id: string): Anchor[] | undefined {
    if (!Array.isArray(value)) {
      this.error(path, "anchors must be an array of {file, symbol?, span?|find?, role}", id);
      return undefined;
    }
    const out: Anchor[] = [];
    value.forEach((input: AnchorInput, i) => {
      const made = makeAnchor(input, this.index, this.texts, this.anchorOptions());
      if (made.ok) {
        out.push(made.anchor);
        this.warnBlankSpanEdges(input, made.anchor, `${path}[${i}]`, id);
      } else {
        this.anchorFailures.add(id);
        this.error(`${path}[${i}]`, made.error, id, "anchor-invalid");
      }
    });
    return out;
  }

  /**
   * A span written in this patch that starts or ends on a blank line is most likely off by one (the code it
   * means starts a line later, or ended a line earlier): a warning that says which lines the code is on.
   * Anchors resent with their `hash` came from an explainer, not from a person counting lines.
   */
  private warnBlankSpanEdges(input: AnchorInput, anchor: Anchor, path: string, id: string): void {
    if (input.span === undefined || input.hash !== undefined || anchor.span === undefined) return;
    const range = anchor.resolved?.range;
    const lines = this.texts.lines(anchor.file);
    if (!range || !lines) return;
    const blank = (line: number): boolean => (lines[line - 1] ?? "").trim() === "";
    const base = range.startLine - anchor.span.from;
    const where = describeAnchor(anchor);
    if (blank(range.startLine)) {
      let first = range.startLine;
      while (first < range.endLine && blank(first)) first++;
      this.warn(
        path,
        `span ${where} starts on a blank line (line ${range.startLine}): probably off by one, the code in it starts at line ${first} (offset ${first - base}); check the offsets with \`xpl show\` or \`xpl anchors\``,
        id,
        "anchor-invalid",
      );
    }
    if (blank(range.endLine)) {
      let last = range.endLine;
      while (last > range.startLine && blank(last)) last--;
      this.warn(
        path,
        `span ${where} ends on a blank line (line ${range.endLine}): probably off by one, the code in it ends at line ${last} (offset ${last - base}); check the offsets with \`xpl show\` or \`xpl anchors\``,
        id,
        "anchor-invalid",
      );
    }
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
      if (kind === "graph" && (key === "includeAdd" || key === "includeRemove")) continue; // see includeOps
      if (kind === "sequence" && key === "stepsUpdate") continue; // see stepOps
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

  /** True when the element was merged or legitimately skipped (protected); false when it could not be built. */
  private upsertElement(kind: "node" | "edge" | "concept", raw: unknown, i: number): boolean {
    const listName = kind === "node" ? "nodes" : kind === "edge" ? "edges" : "concepts";
    const path = `${listName}[${i}]`;
    const spec = kind === "node" ? NODE_SPEC : kind === "edge" ? EDGE_SPEC : CONCEPT_SPEC;
    if (!isRecord(raw)) {
      this.error(path, `${kind} must be an object with an "id"`);
      return false;
    }
    const id = raw.id;
    if (typeof id !== "string" || id === "") {
      this.error(`${path}.id`, `${kind} needs a non-empty string "id"`);
      return false;
    }
    if (!this.checkFields(raw, spec, path, id, true)) return false;
    const list = (this.work as unknown as Record<string, AnyRecord[]>)[listName]!;
    const at = list.findIndex((e) => e.id === id);
    if (at === -1) {
      const created = this.createElement(kind, raw, path, id);
      if (!created) return false;
      list.push(created);
      this.touched.set(id, path);
      this.changed.push(id);
      return true;
    }
    const existing = list[at]!;
    if (this.skipUserOwned(existing, id, path)) return true;
    const merged = this.mergeExisting(
      kind,
      existing,
      raw,
      path,
      id,
      kind === "node" ? "kind" : undefined,
    );
    if (!merged) return false;
    if (merged !== existing) {
      list[at] = merged;
      this.touched.set(id, path);
      this.changed.push(id);
    }
    return true;
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
    includeOps?: IncludeOps,
    stepOps?: StepOps,
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
    if (includeOps)
      this.applyIncludeOps(merged, includeOps, protectedKeys.has("include"), path, id);
    if (stepOps && !this.applyStepUpdates(merged, stepOps, protectedKeys.has("steps"), path, id)) {
      return undefined;
    }
    if (this.actor === "user" && isRecord(raw.provenance)) {
      merged.provenance = { ...(merged.provenance ?? {}), ...cloneJson(raw.provenance) };
    }
    if (sameContent(existing, merged)) return existing;

    const changedFields = Object.keys({ ...fields.set })
      .concat(fields.clear)
      .filter((key) => {
        return key !== immutableKey && !sameContent(existing[key], merged[key]);
      });
    if (
      includeOps &&
      !changedFields.includes("include") &&
      !sameContent(existing.include, merged.include)
    ) {
      changedFields.push("include");
    }
    if (stepOps && !changedFields.includes("steps") && !sameContent(existing.steps, merged.steps)) {
      changedFields.push("steps");
    }
    // Elements without provenance are static (from the index); a tour without it predates tour provenance
    // and counts as written by the llm.
    if (merged.provenance === undefined) {
      merged.provenance = { origin: kind === "tour" ? "llm" : "static" };
    }
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

  /**
   * `stepsUpdate` of a sequence view patch: the shape of the list (an array of objects with the `id` of a step
   * and fields the step has) is checked here. Undefined when the patch has none, null after an error.
   */
  private stepOps(raw: AnyRecord, path: string, viewId: string): StepOps | undefined | null {
    if (raw.stepsUpdate === undefined) return undefined;
    if (!Array.isArray(raw.stepsUpdate)) {
      this.error(
        `${path}.stepsUpdate`,
        "stepsUpdate must be an array of {id, ...fields of the step to change}",
        viewId,
      );
      return null;
    }
    const updates: StepOps["updates"] = [];
    const first = new Map<string, number>();
    let ok = true;
    raw.stepsUpdate.forEach((entry: unknown, j) => {
      const at = `${path}.stepsUpdate[${j}]`;
      if (!isRecord(entry)) {
        this.error(at, "stepsUpdate entry must be an object {id, ...fields to change}", viewId);
        ok = false;
        return;
      }
      if (typeof entry.id !== "string" || entry.id === "") {
        this.error(`${at}.id`, `stepsUpdate entry needs the "id" of an existing step`, viewId);
        ok = false;
        return;
      }
      const again = first.get(entry.id);
      if (again !== undefined) {
        this.error(
          `${at}.id`,
          `step "${entry.id}" appears twice in stepsUpdate (also at stepsUpdate[${again}]); merge the two entries`,
          viewId,
          "duplicate-id",
        );
        ok = false;
        return;
      }
      first.set(entry.id, j);
      if (!this.checkFields(entry, STEP_SPEC, at, viewId, true)) {
        ok = false;
        return;
      }
      updates.push({ id: entry.id, fields: entry, path: at });
    });
    return ok ? { updates } : null;
  }

  /** Why `stepId` is not a step of `viewId`, and what to use instead. */
  private unknownStep(viewId: string, stepId: string, steps: readonly string[]): string {
    const views = this.work.views as unknown as AnyRecord[];
    const owner = views.find(
      (other) =>
        other.id !== viewId &&
        Array.isArray(other.steps) &&
        (other.steps as AnyRecord[]).some((step) => step.id === stepId),
    );
    if (owner) return `step ${stepId} belongs to ${String(owner.id)}, not to ${viewId}`;
    const near = suggestIds(stepId, steps);
    return (
      `step ${stepId} is not a step of ${viewId} (its steps: ${steps.length > 0 ? listIds(steps) : "none"})` +
      (near.length > 0 ? `. Did you mean: ${near.join(", ")}?` : "")
    );
  }

  /**
   * Merges the `stepsUpdate` entries into `merged.steps` (after `steps`, when the patch sent both): each entry's
   * fields go into the step with its id; `anchors` are built like anywhere else and replace the step's; `null`
   * clears `summary` or `edge`. Skipped with a `protected` warning when the user edited the view's steps.
   * False when an entry names no step or a field is wrong (every problem is reported).
   */
  private applyStepUpdates(
    merged: AnyRecord,
    ops: StepOps,
    locked: boolean,
    path: string,
    viewId: string,
  ): boolean {
    if (locked) {
      this.warn(
        `${path}.stepsUpdate`,
        `stepsUpdate of ${viewId} was skipped: its steps were edited by the user and are kept as they are`,
        viewId,
        "protected",
      );
      return true;
    }
    const steps: AnyRecord[] = Array.isArray(merged.steps)
      ? [...(merged.steps as AnyRecord[])]
      : [];
    const known = steps.map((step) => String(step.id));
    let ok = true;
    for (const update of ops.updates) {
      const at = steps.findIndex((step) => step.id === update.id);
      if (at === -1) {
        this.error(
          `${update.path}.id`,
          this.unknownStep(viewId, update.id, known),
          viewId,
          "unknown-id",
        );
        ok = false;
        continue;
      }
      this.updatedSteps.set(update.id, update.path);
      const next: AnyRecord = { ...steps[at]! };
      for (const [key, value] of Object.entries(update.fields)) {
        if (key === "id" || value === undefined) continue;
        if (value === null) delete next[key];
        else if (key === "anchors") {
          const anchors = this.anchors(value, `${update.path}.anchors`, update.id);
          if (anchors === undefined) ok = false;
          else next.anchors = anchors;
        } else next[key] = value;
      }
      steps[at] = next;
    }
    merged.steps = steps;
    return ok;
  }

  /**
   * After a view was merged: the steps `stepsUpdate` changed are changed ids too, and their issues point at
   * their entry in the patch.
   */
  private noteStepUpdates(
    viewId: string,
    before: AnyRecord,
    after: AnyRecord,
    ops: StepOps,
    hasSteps: boolean,
  ): void {
    const stepsOf = (view: AnyRecord): AnyRecord[] =>
      Array.isArray(view.steps) ? (view.steps as AnyRecord[]) : [];
    const old = new Map(stepsOf(before).map((step) => [step.id, step] as const));
    const paths = new Map<string, string>();
    for (const update of ops.updates) {
      const now = stepsOf(after).find((step) => step.id === update.id);
      if (!now || sameContent(old.get(update.id), now)) continue;
      this.changed.push(update.id);
      this.touched.set(update.id, update.path);
      paths.set(update.id, update.path);
    }
    if (paths.size > 0) this.stepUpdatePaths.set(viewId, paths);
    if (!hasSteps) this.stepsUpdateOnly.add(viewId);
  }

  /**
   * `includeAdd` / `includeRemove` of a graph view: validated here (types are checked with the other
   * fields). Returns undefined when the patch has neither, null after reporting an error.
   */
  private includeOps(raw: AnyRecord, path: string, id: string): IncludeOps | undefined | null {
    if (raw.includeAdd === undefined && raw.includeRemove === undefined) return undefined;
    const add = unique<string>(Array.isArray(raw.includeAdd) ? raw.includeAdd : []);
    const remove = unique<string>(Array.isArray(raw.includeRemove) ? raw.includeRemove : []);
    let ok = true;
    for (const [k, rid] of remove.entries()) {
      if (add.includes(rid)) {
        this.error(
          `${path}.includeRemove[${k}]`,
          `${rid} is in both includeAdd and includeRemove of ${id}; give it to one of them`,
          id,
        );
        ok = false;
      }
    }
    return ok ? { add, remove } : null;
  }

  /** Applies `includeRemove`, then `includeAdd`, to `merged.include` (see patch.ts for the rules). */
  private applyIncludeOps(
    merged: AnyRecord,
    ops: IncludeOps,
    locked: boolean,
    path: string,
    id: string,
  ): void {
    let list: string[] = Array.isArray(merged.include) ? [...merged.include] : [];
    if (ops.remove.length > 0) {
      if (locked) {
        this.warn(
          `${path}.includeRemove`,
          `includeRemove of ${id} was skipped: its include was edited by the user and is kept as it is (includeAdd still works)`,
          id,
          "protected",
        );
      } else {
        const present = new Set(list);
        ops.remove.forEach((rid, k) => {
          if (!present.has(rid)) {
            this.warn(
              `${path}.includeRemove[${k}]`,
              `${rid} is not in the include of ${id}; nothing to remove`,
              id,
            );
          }
        });
        const drop = new Set(ops.remove);
        list = list.filter((entry) => !drop.has(entry));
      }
    }
    const have = new Set(list);
    for (const add of ops.add) {
      if (!have.has(add)) {
        have.add(add);
        list.push(add);
      }
    }
    merged.include = list;
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

  private upsertView(raw: unknown, i: number): boolean {
    const path = `views[${i}]`;
    if (!isRecord(raw)) {
      this.error(path, `view must be an object with an "id" and a "type"`);
      return false;
    }
    const id = raw.id;
    if (typeof id !== "string" || id === "") {
      this.error(`${path}.id`, `view needs a non-empty string "id"`);
      return false;
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
      return false;
    }
    const spec = type === "graph" ? GRAPH_SPEC : SEQUENCE_SPEC;
    if (!this.checkFields({ ...raw, type }, spec, path, id, true)) return false;
    const ops = type === "graph" ? this.includeOps(raw, path, id) : undefined;
    if (ops === null) return false;
    const stepOps = type === "sequence" ? this.stepOps(raw, path, id) : undefined;
    if (stepOps === null) return false;

    if (at === -1) {
      if (stepOps) {
        this.error(
          `${path}.stepsUpdate`,
          `stepsUpdate changes steps that exist already, and ${id} is a new view: send its steps whole`,
          id,
        );
        return false;
      }
      const created = this.createView(type, raw, path, id, ops);
      if (!created) return false;
      views.push(created);
      this.touched.set(id, path);
      this.changed.push(id);
      if (ops && ops.add.length > 0) this.includeAdds.set(id, ops.add);
      return true;
    }
    const existing = views[at]!;
    if (this.skipUserOwned(existing, id, path)) return true;
    const before = Array.isArray(existing.steps)
      ? (existing.steps as AnyRecord[]).map((s) => s.id)
      : [];
    const merged = this.mergeExisting(type, existing, raw, path, id, "type", ops, stepOps);
    if (!merged) return false;
    if (merged === existing) return true;
    if (ops && ops.add.length > 0) this.includeAdds.set(id, ops.add);
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
    if (stepOps) this.noteStepUpdates(id, existing, merged, stepOps, raw.steps !== undefined);
    return true;
  }

  private createView(
    type: "graph" | "sequence",
    raw: AnyRecord,
    path: string,
    id: string,
    ops?: IncludeOps,
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
      // A new view may be given its nodes as `include` or as `includeAdd`.
      if (f.include === undefined && (ops === undefined || ops.add.length === 0)) {
        return this.missing(path, id, "include");
      }
      const draft: AnyRecord = { include: f.include ?? [] };
      if (ops) this.applyIncludeOps(draft, ops, false, path, id);
      return {
        id,
        type: "graph",
        title: f.title,
        scope,
        include: draft.include,
        ...(f.edgeKinds !== undefined ? { edgeKinds: f.edgeKinds } : {}),
        ...(f.hidden !== undefined ? { hidden: f.hidden } : {}),
        ...(f.excludeFiles !== undefined ? { excludeFiles: f.excludeFiles } : {}),
        ...(f.stubs !== undefined ? { stubs: f.stubs } : {}),
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

  private upsertTour(raw: unknown, i: number): boolean {
    const path = `tours[${i}]`;
    if (!isRecord(raw)) {
      this.error(path, `tour must be an object with an "id"`);
      return false;
    }
    const id = raw.id;
    if (typeof id !== "string" || id === "") {
      this.error(`${path}.id`, `tour needs a non-empty string "id"`);
      return false;
    }
    if (!this.checkFields(raw, TOUR_SPEC, path, id, true)) return false;
    const tours = this.work.tours as unknown as AnyRecord[];
    const at = tours.findIndex((t) => t.id === id);
    if (at === -1) {
      const fields = this.convertFields("tour", raw, path, id, new Set());
      const provenance = this.newProvenance(raw, path, id);
      if (!fields || !provenance) return false;
      for (const required of ["title", "steps"]) {
        if (fields.set[required] === undefined) {
          this.missing(path, id, required);
          return false;
        }
      }
      tours.push({
        id,
        title: fields.set.title,
        steps: fields.set.steps,
        provenance,
      } satisfies Tour);
      this.touched.set(id, path);
      this.changed.push(id);
      return true;
    }
    const existing = tours[at]!;
    if (this.skipUserOwned(existing, id, path)) return true;
    const merged = this.mergeExisting("tour", existing, raw, path, id, undefined);
    if (!merged) return false;
    if (merged === existing) return true;
    tours[at] = merged;
    this.touched.set(id, path);
    this.changed.push(id);
    return true;
  }

  // ─── Validation of the result ───────────────────────────────────────────────────────────────

  private validate(): ApplyResult {
    const before = validateExplainer(this.input, this.index, this.texts, { mode: "strict" });
    const after = validateExplainer(this.work, this.index, this.texts, {
      mode: "strict",
      assumeIds: this.assumed,
    });
    const key = (issue: Issue) => `${issue.code ?? ""}|${issue.elementId ?? ""}|${issue.message}`;
    const knownBefore = new Set(before.map(key));
    const rewrite = this.pathRewriter();

    let ignored = 0;
    let firstIgnored: string | undefined;
    for (const issue of after) {
      // What an llm edge's evidence needs is an anchor at each end: one that failed to build is reported
      // already, and the edge cannot be judged until it is fixed.
      if (
        issue.code === "evidence" &&
        issue.elementId !== undefined &&
        this.anchorFailures.has(issue.elementId)
      ) {
        continue;
      }
      const touched = issue.elementId !== undefined && this.touched.has(issue.elementId);
      const isNew = !knownBefore.has(key(issue));
      const shown = { ...issue, path: this.includeAddPath(issue) ?? rewrite(issue.path) };
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

  /**
   * An issue on `views[n].include[j]` whose id came from the patch's `includeAdd` points at
   * `views[i].includeAdd[k]` in the patch; undefined for every other issue.
   */
  private includeAddPath(issue: Issue): string | undefined {
    const adds = issue.elementId !== undefined ? this.includeAdds.get(issue.elementId) : undefined;
    const patchPath = issue.elementId !== undefined ? this.touched.get(issue.elementId) : undefined;
    const at = /^views\[(\d+)\]\.include\[(\d+)\]$/.exec(issue.path);
    if (!adds || patchPath === undefined || !at) return undefined;
    const view = (this.work.views as unknown as AnyRecord[])[Number(at[1])];
    const k = adds.indexOf(view?.include?.[Number(at[2])]);
    return k === -1 ? undefined : `${patchPath}.includeAdd[${k}]`;
  }

  /** Maps paths into the merged explainer (`nodes[3]`) back to the patch (`nodes[0]`). */
  private pathRewriter(): (path: string) => string {
    const prefixes: [string, string][] = [];
    const collapse: [string, string][] = [];
    const w = this.work as unknown as Record<string, AnyRecord[]>;
    // A step that `stepsUpdate` changed is the entry of that list in the patch, not `steps[j]`; the other steps
    // of a view sent only `stepsUpdate` are not in the patch at all (the message names the step).
    for (const [viewId, steps] of this.stepUpdatePaths) {
      const at = w.views?.findIndex((view) => view.id === viewId) ?? -1;
      const list: unknown = at === -1 ? undefined : w.views![at]!.steps;
      if (!Array.isArray(list)) continue;
      for (const [stepId, patchPath] of steps) {
        const stepAt = (list as AnyRecord[]).findIndex((step) => step.id === stepId);
        if (stepAt !== -1) prefixes.push([`views[${at}].steps[${stepAt}]`, patchPath]);
      }
    }
    for (const viewId of this.stepsUpdateOnly) {
      const at = w.views?.findIndex((view) => view.id === viewId) ?? -1;
      const patchPath = this.touched.get(viewId);
      if (at !== -1 && patchPath !== undefined) collapse.push([`views[${at}].steps[`, patchPath]);
    }
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
      for (const [from, to] of collapse) if (path.startsWith(from)) return to;
      return path;
    };
  }
}
