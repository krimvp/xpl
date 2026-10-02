/**
 * Validation (ARCHITECTURE.md section 4.6). `validateExplainer` returns every problem it finds, with a
 * JSON-pointer-ish `path` (`views[1].steps[2].anchors[0]`) and, where there is one, the id of the
 * element it belongs to. Messages are written for Claude to read and fix its patch from.
 */
import { EXPLAINER_SCHEMA } from "./constants.js";
import {
  isBaseAnchor,
  resolveWith,
  storedSymbolHints,
  toTextCache,
  ANCHOR_ROLES,
  describeAnchor,
  NO_CHANGE_RECORD,
  type GetText,
  type TextCache,
} from "./anchors.js";
import { changeShapeIssues, shortSha } from "./change.js";
import {
  EDGE_KINDS,
  isSlug,
  normalizeElementId,
  parseId,
  RESERVED_PREFIXES,
  listIds,
  splitSymbolId,
  suggestIds,
  viewSlug,
  type ParsedId,
} from "./ids.js";
import { asIndexModel, type IndexModel } from "./index-model.js";
import { ExplainerModel } from "./model.js";
import { resolveFrames } from "./sequence.js";
import { parseGhostKey, STUB_MODES } from "./stubs.js";
import type {
  Anchor,
  AnchorStatus,
  ChangeRecord,
  Concept,
  Edge,
  ElementId,
  Explainer,
  Node,
  Provenance,
  Range,
  SequenceView,
  SymbolIndex,
} from "./schema.js";
import { isRecord } from "./util.js";

export type IssueSeverity = "error" | "warning";

/**
 * - `schema`: wrong shape or type of a field, unknown enum value.
 * - `duplicate-id`, `bad-id`: id namespace and prefix rules.
 * - `unknown-id`: a referenced id neither exists nor is derivable.
 * - `anchor-drifted`, `anchor-missing`, `anchor-invalid`: anchor problems.
 * - `evidence`: an llm edge lacks an anchor inside `from` or `to`.
 * - `frame`, `cycle`, `step`, `commit`: the remaining structural rules.
 * - `change`: the change record (`Explainer.change`) is malformed, or its head is not the commit of the index.
 * - `protected`: (patches only) a change was skipped because the element or field belongs to the user.
 */
export type IssueCode =
  | "schema"
  | "duplicate-id"
  | "bad-id"
  | "unknown-id"
  | "anchor-invalid"
  | "anchor-drifted"
  | "anchor-missing"
  | "evidence"
  | "frame"
  | "cycle"
  | "step"
  | "commit"
  | "change"
  | "protected";

export interface Issue {
  severity: IssueSeverity;
  /** JSON-pointer-ish location, e.g. `views[1].steps[2].anchors[0]`. Empty for the whole explainer. */
  path: string;
  /** The element / view / tour / step the issue belongs to, when there is one. */
  elementId?: string;
  message: string;
  code?: IssueCode;
  /**
   * Anchor problems (drifted, missing) of an element whose anchors the user owns (origin `user`, or `anchors`
   * / `steps` in `userFields`). An llm patch cannot repair them, so `applyPatch` never lets them reject one.
   */
  userLocked?: true;
}

export interface ValidateOptions {
  /**
   * `strict` (default): every anchor must resolve `ok` or `moved`, every id must exist. `lenient`
   * (after regeneration): drifted and missing anchors, and ids of files/directories/symbols that
   * vanished from the index, are warnings.
   */
  mode?: "strict" | "lenient";
  /**
   * Ids to treat as existing wherever they are referenced. `applyPatch` passes the elements, views and steps
   * that the patch tried to create and failed to, so that one error does not become one more error for
   * every reference to them.
   */
  assumeIds?: Iterable<string>;
}

const ORIGINS = ["static", "llm", "user"];
const STEP_KINDS = ["call", "return", "async"];
const FRAME_KINDS = ["loop", "alt", "opt", "par"];
const NODE_KIND_OF: Partial<Record<ParsedId["type"], Node["kind"]>> = {
  repo: "repo",
  dir: "dir",
  file: "file",
  symbol: "symbol",
  group: "group",
};

/** Validates an explainer against the index and the current file text. See the file header. */
export function validateExplainer(
  explainer: Explainer,
  index: SymbolIndex | IndexModel,
  getText: GetText | TextCache,
  opts: ValidateOptions = {},
): Issue[] {
  if (!isRecord(explainer)) {
    return [
      { severity: "error", path: "", message: "explainer must be an object", code: "schema" },
    ];
  }
  const validator = new Validator(explainer, asIndexModel(index), toTextCache(getText), opts);
  validator.run();
  return validator.issues;
}

interface CheckedAnchor {
  anchor: Anchor;
  range?: Range;
  status?: AnchorStatus;
}

class Validator {
  readonly issues: Issue[] = [];
  private readonly ex: Explainer;
  private readonly index: IndexModel;
  private readonly texts: TextCache;
  private readonly model: ExplainerModel;
  private readonly strict: boolean;
  private readonly assumed: ReadonlySet<string>;
  private hints: ReturnType<typeof storedSymbolHints> | undefined;
  private pools: IdPools | undefined;

  constructor(explainer: Explainer, index: IndexModel, texts: TextCache, opts: ValidateOptions) {
    this.ex = explainer;
    this.index = index;
    this.texts = texts;
    this.strict = opts.mode !== "lenient";
    this.assumed = new Set(opts.assumeIds ?? []);
    this.model = new ExplainerModel(explainer, index);
  }

  // ─── Reporting ──────────────────────────────────────────────────────────────────────────────

  private error(
    path: string,
    message: string,
    elementId?: string,
    code: IssueCode = "schema",
  ): void {
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

  /** Something that stopped being true because the code changed: an error, or a warning when lenient. */
  private stale(
    path: string,
    message: string,
    elementId: string | undefined,
    code: IssueCode,
    userLocked = false,
  ): void {
    this.issues.push({
      severity: this.strict ? "error" : "warning",
      path,
      ...(elementId ? { elementId } : {}),
      message,
      code,
      ...(userLocked ? { userLocked: true as const } : {}),
    });
  }

  // ─── Driver ─────────────────────────────────────────────────────────────────────────────────

  run(): void {
    const ex = this.ex;
    if (!isRecord(ex)) {
      this.error("", "explainer must be an object");
      return;
    }
    if (ex.schema !== EXPLAINER_SCHEMA) {
      this.error(
        "schema",
        `schema must be "${EXPLAINER_SCHEMA}" (got ${JSON.stringify(ex.schema)})`,
      );
    }
    if (typeof ex.title !== "string" || ex.title === "")
      this.warn("title", "title should be a non-empty string");
    if (
      !isRecord(ex.repo) ||
      typeof ex.repo.name !== "string" ||
      typeof ex.repo.commit !== "string"
    ) {
      this.error("repo", "repo must be {name: string, url?: string, commit: string}");
    }
    if (
      !isRecord(ex.index) ||
      typeof ex.index.path !== "string" ||
      typeof ex.index.commit !== "string"
    ) {
      this.error("index", "index must be {path: string, commit: string}");
    } else if (ex.index.commit !== this.index.commit) {
      this.warn(
        "index.commit",
        `explainer was last resolved against index ${ex.index.commit}, but the index given is ${this.index.commit}; run \`xpl resolve --write\` to re-resolve the anchors`,
        undefined,
        "commit",
      );
    }
    for (const key of ["nodes", "edges", "concepts", "views", "tours"] as const) {
      if (!Array.isArray(ex[key])) this.error(key, `${key} must be an array`);
    }
    this.checkChange();

    const claimed = new Map<string, string>();
    (Array.isArray(ex.nodes) ? ex.nodes : []).forEach((node, i) =>
      this.checkNode(node, i, claimed),
    );
    (Array.isArray(ex.edges) ? ex.edges : []).forEach((edge, i) =>
      this.checkEdge(edge, i, claimed),
    );
    (Array.isArray(ex.concepts) ? ex.concepts : []).forEach((c, i) =>
      this.checkConcept(c, i, claimed),
    );
    const viewIds = new Map<string, string>();
    (Array.isArray(ex.views) ? ex.views : []).forEach((view, i) =>
      this.checkView(view as unknown as Record<string, unknown>, i, claimed, viewIds),
    );
    const tourIds = new Map<string, string>();
    (Array.isArray(ex.tours) ? ex.tours : []).forEach((tour, i) =>
      this.checkTour(tour, i, tourIds),
    );
    this.checkGroupCycles();
  }

  /** The change record, when it is well formed (base anchors resolve against it). */
  private change: ChangeRecord | undefined;

  /**
   * `Explainer.change`: its shape (written by `xpl change`, so a problem means a hand edit), and its head, which must
   * be the commit of the index in use (a warning: the base anchors still work, but the current code the explainer
   * shows is not the head of the change).
   */
  private checkChange(): void {
    const value = this.ex.change;
    if (value === undefined) return;
    const problems = changeShapeIssues(value);
    for (const problem of problems) this.error(problem.path, problem.message, undefined, "change");
    if (problems.length > 0) return;
    const change = value as ChangeRecord;
    this.change = change;
    const commit = this.index.commit;
    // an index of a directory below the git top level is named `wt-<hash>`: no commit to compare with
    if (/^[0-9a-f]{7,}$/i.test(commit) && !change.head.startsWith(commit)) {
      this.warn(
        "change.head",
        `the change ends at ${shortSha(change.head)}, but the explainer's index was built from ${commit}: ` +
          `check out ${shortSha(change.head)}, run \`xpl index\` and \`xpl resolve <name> --write\`, ` +
          `or write the change again with \`xpl change <name> <base>..${commit}\``,
        undefined,
        "change",
      );
    }
  }

  // ─── Ids ────────────────────────────────────────────────────────────────────────────────────

  /** Claims an id in the shared element/step namespace; false when it is missing or a duplicate. */
  private claim(id: unknown, path: string, claimed: Map<string, string>): id is string {
    if (typeof id !== "string" || id === "") {
      this.error(`${path}.id`, "id must be a non-empty string");
      return false;
    }
    const first = claimed.get(id);
    if (first !== undefined) {
      this.error(
        `${path}.id`,
        `duplicate id "${id}" (already used at ${first}; ids of elements and steps share one namespace)`,
        id,
        "duplicate-id",
      );
      return false;
    }
    claimed.set(id, path);
    return true;
  }

  private checkSlug(slug: string, path: string, id: string, what: string): void {
    if (!isSlug(slug)) {
      this.error(
        `${path}.id`,
        `${what} id "${id}" has an invalid slug "${slug}" (letters, digits, ".", "_" and "-" only; must start with a letter or digit)`,
        id,
        "bad-id",
      );
    }
  }

  /** What the explainer's own whole-symbol anchors remember about a symbol: finds a renamed one by its size. */
  private hintFor(file: string, path: string) {
    return (this.hints ??= storedSymbolHints(this.ex))(file, path);
  }

  /** A `sym:`/`file:`/`dir:` id that is not in the index: suggestions from `normalizeElementId`. */
  private describeMissing(id: string): string {
    const result = normalizeElementId(id, this.index, {
      symbolHint: (file, path) => this.hintFor(file, path),
    });
    if (!result.ok) return result.error;
    return `${id} does not exist in the index`;
  }

  /** The ids of this explainer that a mistyped id may have meant, by kind (built once, on the first error). */
  private known(): IdPools {
    if (this.pools) return this.pools;
    const idsOf = (list: unknown): string[] =>
      (Array.isArray(list) ? list : [])
        .filter(isRecord)
        .map((item) => item.id)
        .filter((id): id is string => typeof id === "string" && id !== "");
    const steps = new Map<string, string[]>();
    for (const view of Array.isArray(this.ex.views) ? this.ex.views : []) {
      if (
        isRecord(view) &&
        (view.type === "sequence" || view.type === "flow") &&
        typeof view.id === "string"
      ) {
        steps.set(view.id, idsOf(view.steps));
      }
    }
    const all = [
      ...idsOf(this.ex.nodes).filter((id) => parseId(id).type === "group"),
      ...idsOf(this.ex.concepts),
      ...idsOf(this.ex.edges),
      ...idsOf(this.ex.views),
      ...idsOf(this.ex.tours),
      ...[...steps.values()].flat(),
      ...this.assumed,
    ];
    return (this.pools = { all, views: idsOf(this.ex.views), steps });
  }

  /** `. Did you mean: a, b?` for an id that does not exist, or nothing when no id of the explainer is close. */
  private didYouMean(id: string): string {
    const found = suggestIds(id, this.known().all);
    return found.length > 0 ? `. Did you mean: ${found.join(", ")}?` : "";
  }

  /** For a tour step's unknown view: the closest view ids, else the views there are. */
  private viewHint(value: unknown): string {
    const views = this.known().views;
    const near = typeof value === "string" ? suggestIds(value, views) : [];
    if (near.length > 0) return `. Did you mean: ${near.join(", ")}?`;
    return views.length > 0 ? ` (views: ${listIds(views)})` : " (it has no views yet)";
  }

  /** Checks that `id` is a node id that exists (or is derivable from the index). */
  private refNode(id: unknown, path: string, elementId: string | undefined, what: string): boolean {
    if (typeof id !== "string" || id === "") {
      this.error(path, `${what} must be an element id string`, elementId);
      return false;
    }
    if (this.assumed.has(id) || this.model.hasNode(id)) return true;
    const parsed = parseId(id);
    switch (parsed.type) {
      case "dir":
      case "file":
      case "symbol":
        this.stale(path, `${what}: ${this.describeMissing(id)}`, elementId, "unknown-id");
        break;
      case "group":
        this.error(
          path,
          `${what}: no group ${id} in this explainer${this.didYouMean(id)}`,
          elementId,
          "unknown-id",
        );
        break;
      case "unknown":
        this.error(path, `${what}: ${this.describeNotAnId(id)}`, elementId, "unknown-id");
        break;
      default:
        this.error(
          path,
          `${what}: ${id} is not a node (expected repo, dir:, file:, sym: or grp:)`,
          elementId,
          "unknown-id",
        );
    }
    return false;
  }

  /** Checks that `id` names any element: a node, stored or derivable edge, concept, or step. */
  private refElement(
    id: unknown,
    path: string,
    elementId: string | undefined,
    what: string,
  ): boolean {
    if (typeof id !== "string" || id === "") {
      this.error(path, `${what} must be an element id string`, elementId);
      return false;
    }
    if (this.assumed.has(id) || this.model.hasElement(id)) return true;
    const parsed = parseId(id);
    switch (parsed.type) {
      case "dir":
      case "file":
      case "symbol":
        this.stale(path, `${what}: ${this.describeMissing(id)}`, elementId, "unknown-id");
        break;
      case "derived-edge":
        this.stale(
          path,
          `${what}: derived edge ${id} has an end that does not exist (${!this.model.hasNode(parsed.from) ? parsed.from : parsed.to})`,
          elementId,
          "unknown-id",
        );
        break;
      case "group":
      case "concept":
      case "edge":
        this.error(
          path,
          `${what}: no ${parsed.type} with id ${id} in this explainer${this.didYouMean(id)}`,
          elementId,
          "unknown-id",
        );
        break;
      case "step": {
        // the view exists: name its steps; else the step of a view with a similar name and the same number
        const steps = this.known().steps.get(`view:${parsed.view}`);
        this.error(
          path,
          steps
            ? `${what}: no step ${id} in view:${parsed.view} (its steps: ${listIds(steps)})`
            : `${what}: no step with id ${id} in this explainer${this.didYouMean(id)}`,
          elementId,
          "unknown-id",
        );
        break;
      }
      default:
        this.error(path, `${what}: ${this.describeNotAnId(id)}`, elementId, "unknown-id");
    }
    return false;
  }

  /** `"src/a.ts#A.b"` and friends are not ids: say what was probably meant. */
  private describeNotAnId(id: string): string {
    const loose = normalizeElementId(id, this.index);
    if (loose.ok && loose.id !== id) {
      return `"${id}" is not an element id; did you mean ${loose.id}?`;
    }
    const near = suggestIds(id, this.known().all);
    if (near.length > 0) return `"${id}" is not an element id; did you mean ${near.join(", ")}?`;
    return `"${id}" is not an element id (expected repo, dir:<path>, file:<path>, sym:<file>#<symbol> or grp:<slug>)`;
  }

  /** Like `refElement`, restricted to edges (stored, or derivable `edge:<kind>:<a>-><b>`). */
  private refEdge(id: unknown, path: string, elementId: string | undefined, what: string): boolean {
    if (!this.refElement(id, path, elementId, what)) return false;
    const ref = this.model.element(id as string);
    if (ref && ref.type !== "edge" && ref.type !== "derived-edge") {
      this.error(path, `${what}: ${id} is not an edge`, elementId, "unknown-id");
      return false;
    }
    return true;
  }

  // ─── Shared field checks ────────────────────────────────────────────────────────────────────

  private checkProvenance(p: unknown, path: string, elementId: string): void {
    if (!isRecord(p)) {
      this.error(path, "provenance must be {origin, userFields?, commit?}", elementId);
      return;
    }
    const prov = p as unknown as Provenance;
    if (!ORIGINS.includes(prov.origin)) {
      this.error(
        `${path}.origin`,
        `provenance.origin must be one of ${ORIGINS.join(", ")}`,
        elementId,
      );
    }
    if (
      prov.userFields !== undefined &&
      (!Array.isArray(prov.userFields) || prov.userFields.some((f) => typeof f !== "string"))
    ) {
      this.error(
        `${path}.userFields`,
        "provenance.userFields must be an array of field names",
        elementId,
      );
    }
    if (prov.commit !== undefined && typeof prov.commit !== "string") {
      this.error(`${path}.commit`, "provenance.commit must be a string", elementId);
    }
  }

  private checkLabel(
    value: unknown,
    path: string,
    elementId: string,
    required: boolean,
    what = "label",
  ): void {
    if (value === undefined && !required) return;
    if (typeof value !== "string")
      this.error(`${path}.${what}`, `${what} must be a string`, elementId);
    else if (value.trim() === "" && required)
      this.warn(`${path}.${what}`, `${what} is empty`, elementId);
  }

  private checkStringField(value: unknown, path: string, elementId: string, name: string): void {
    if (value !== undefined && typeof value !== "string") {
      this.error(`${path}.${name}`, `${name} must be a string`, elementId);
    }
  }

  /**
   * Resolves and validates every anchor of a list. Anchors that resolve `drifted` / `missing` are
   * errors in strict mode and warnings in lenient mode.
   */
  private checkAnchors(
    anchors: unknown,
    path: string,
    elementId: string,
    owner?: { provenance: unknown; field: string },
  ): CheckedAnchor[] {
    if (!Array.isArray(anchors)) {
      this.error(path, "anchors must be an array", elementId);
      return [];
    }
    const locked = owner ? lockedBy(owner.provenance, owner.field) : undefined;
    const out: CheckedAnchor[] = [];
    anchors.forEach((raw: unknown, i) => {
      const at = `${path}[${i}]`;
      if (!isRecord(raw)) {
        this.error(at, "anchor must be an object", elementId, "anchor-invalid");
        return;
      }
      const anchor = raw as unknown as Anchor;
      if (typeof anchor.file !== "string" || anchor.file === "") {
        this.error(
          `${at}.file`,
          "anchor.file must be a repo-relative path",
          elementId,
          "anchor-invalid",
        );
        return;
      }
      if (!ANCHOR_ROLES.includes(anchor.role)) {
        this.error(
          `${at}.role`,
          `anchor.role must be one of ${ANCHOR_ROLES.join(", ")}`,
          elementId,
          "anchor-invalid",
        );
      }
      if (anchor.symbol !== undefined && typeof anchor.symbol !== "string") {
        this.error(`${at}.symbol`, "anchor.symbol must be a string", elementId, "anchor-invalid");
        return;
      }
      if (typeof anchor.hash !== "string") {
        this.error(`${at}.hash`, "anchor.hash must be a string", elementId, "anchor-invalid");
      }
      if (anchor.at !== undefined) {
        // what makes a base anchor unusable whatever the code does: errors in every mode
        const bad =
          anchor.at !== "base"
            ? `anchor.at must be "base" or absent (got ${JSON.stringify(anchor.at)})`
            : typeof anchor.symbol === "string" && anchor.symbol !== ""
              ? `base anchor ${describeAnchor(anchor)}#${anchor.symbol}: a base anchor cannot name a symbol (only the head is indexed); use find or a span from line 1 of the base file`
              : !this.change && this.ex.change === undefined
                ? `base anchor ${describeAnchor(anchor)}: ${NO_CHANGE_RECORD}`
                : undefined;
        if (bad !== undefined) {
          this.error(at, bad, elementId, "anchor-invalid");
          return;
        }
      }
      const result = resolveWith(anchor, this.index, this.texts, this.change);
      const where = describeAnchor(anchor);
      // Only the user can repair what the user owns: an llm patch skips it, so say who acts.
      const userFix = locked
        ? ` This element ${locked}, so an llm patch cannot change it (it is skipped): tell the user, or fix it with \`xpl apply --actor user\`.`
        : undefined;
      if (result.status === "missing") {
        this.stale(
          at,
          `anchor ${where} is missing: ${endSentence(result.reason ?? "not found")}${
            userFix ??
            " Re-anchor it to where the code went, or drop it (resend the element without this anchor, or remove the element)."
          }`,
          elementId,
          "anchor-missing",
          locked !== undefined,
        );
      } else if (result.status === "drifted") {
        this.stale(
          at,
          `anchor ${where} drifted: ${endSentence(result.reason ?? "the code changed since it was written")}${
            userFix ??
            " Re-read the code and rewrite the anchor (and the explanation that depends on it)."
          }`,
          elementId,
          "anchor-drifted",
          locked !== undefined,
        );
      }
      out.push({
        anchor,
        range: result.status === "missing" ? anchor.resolved?.range : result.range,
        status: result.status,
      });
    });
    return out;
  }

  // ─── Nodes ──────────────────────────────────────────────────────────────────────────────────

  private checkNode(node: Node, i: number, claimed: Map<string, string>): void {
    const path = `nodes[${i}]`;
    if (!isRecord(node)) {
      this.error(path, "node must be an object");
      return;
    }
    this.claim(node.id, path, claimed);
    const idOk = typeof node.id === "string" && node.id !== "";
    const id = idOk ? node.id : `nodes[${i}]`;
    const parsed = idOk ? parseId(node.id) : ({ type: "unknown" } as ParsedId);
    const expected = NODE_KIND_OF[parsed.type];
    if (idOk && expected === undefined) {
      this.error(
        `${path}.id`,
        `node id "${node.id}" must be "repo", "dir:<path>", "file:<path>", "sym:<file>#<symbol>" or "grp:<slug>"`,
        id,
        "bad-id",
      );
    } else if (idOk && node.kind !== expected) {
      this.error(
        `${path}.kind`,
        `node ${node.id} has kind "${String(node.kind)}" but its id says "${expected}"`,
        id,
        "bad-id",
      );
    }
    if (parsed.type === "group") this.checkSlug(parsed.slug, path, node.id, "group");

    // Structural overlays must point at something in the index.
    if (idOk && (parsed.type === "dir" || parsed.type === "file" || parsed.type === "symbol")) {
      if (!this.model.hasNode(node.id)) {
        this.stale(`${path}.id`, `stored node ${this.describeMissing(node.id)}`, id, "unknown-id");
      }
    }

    const structural = expected !== undefined && expected !== "group";
    this.checkLabel(node.label, path, id, !structural);
    this.checkStringField(node.summary, path, id, "summary");
    this.checkStringField(node.detail, path, id, "detail");
    if (node.provenance === undefined)
      this.error(`${path}.provenance`, "provenance is required", id);
    else this.checkProvenance(node.provenance, `${path}.provenance`, id);

    // parent
    if (expected === "repo") {
      if (node.parent !== null)
        this.error(`${path}.parent`, "the repo node's parent must be null", id);
    } else if (node.parent === null || node.parent === undefined) {
      if (expected === "group")
        this.error(`${path}.parent`, `group ${id} needs a parent (use "repo")`, id);
    } else if (expected === "group") {
      this.refNode(node.parent, `${path}.parent`, id, "parent");
    } else if (structural && idOk && this.model.hasNode(node.id)) {
      const derived = this.model.parent(node.id);
      if (derived !== node.parent) {
        this.warn(
          `${path}.parent`,
          `stored parent ${String(node.parent)} is ignored; the structural parent of ${id} is ${derived}`,
          id,
        );
      }
    }

    // members
    if (expected === "group") {
      if (!Array.isArray(node.members))
        this.error(`${path}.members`, `group ${id} needs members: an array of node ids`, id);
      else {
        node.members.forEach((member, j) => {
          if (member === node.id)
            this.error(
              `${path}.members[${j}]`,
              `group ${id} lists itself as a member`,
              id,
              "cycle",
            );
          else this.refNode(member, `${path}.members[${j}]`, id, "member");
        });
        if (node.members.length === 0)
          this.warn(`${path}.members`, `group ${id} has no members`, id);
      }
    } else if (node.members !== undefined) {
      this.warn(`${path}.members`, "members only apply to groups and are ignored here", id);
    }

    this.checkAnchors(node.anchors ?? [], `${path}.anchors`, id, {
      provenance: node.provenance,
      field: "anchors",
    });
  }

  /** Groups must not (transitively) contain themselves. */
  private checkGroupCycles(): void {
    const groups = new Map<string, Node>();
    (Array.isArray(this.ex.nodes) ? this.ex.nodes : []).forEach((node) => {
      if (
        isRecord(node) &&
        typeof node.id === "string" &&
        parseId(node.id).type === "group" &&
        !groups.has(node.id)
      ) {
        groups.set(node.id, node);
      }
    });
    const state = new Map<string, "visiting" | "done">();
    const reported = new Set<string>();
    const visit = (id: string, stack: string[]): void => {
      state.set(id, "visiting");
      stack.push(id);
      for (const member of Array.isArray(groups.get(id)?.members) ? groups.get(id)!.members! : []) {
        if (!groups.has(member) || member === id) continue;
        if (state.get(member) === "visiting") {
          const cycle = [...stack.slice(stack.indexOf(member)), member];
          const key = [...cycle].sort().join("|");
          if (!reported.has(key)) {
            reported.add(key);
            this.error(
              "nodes",
              `groups contain each other: ${cycle.join(" -> ")}`,
              member,
              "cycle",
            );
          }
        } else if (state.get(member) !== "done") visit(member, stack);
      }
      stack.pop();
      state.set(id, "done");
    };
    for (const id of groups.keys()) if (!state.has(id)) visit(id, []);
  }

  // ─── Edges ──────────────────────────────────────────────────────────────────────────────────

  private checkEdge(edge: Edge, i: number, claimed: Map<string, string>): void {
    const path = `edges[${i}]`;
    if (!isRecord(edge)) {
      this.error(path, "edge must be an object");
      return;
    }
    this.claim(edge.id, path, claimed);
    const idOk = typeof edge.id === "string" && edge.id !== "";
    const id = idOk ? edge.id : path;
    const parsed = idOk ? parseId(edge.id) : ({ type: "unknown" } as ParsedId);
    if (idOk && parsed.type !== "edge" && parsed.type !== "derived-edge") {
      this.error(
        `${path}.id`,
        `edge id "${edge.id}" must start with "edge:" (stored edges are "edge:<slug>")`,
        id,
        "bad-id",
      );
    }
    if (parsed.type === "edge") this.checkSlug(parsed.slug, path, edge.id, "edge");
    if (!EDGE_KINDS.includes(edge.kind)) {
      this.error(`${path}.kind`, `edge.kind must be one of ${EDGE_KINDS.join(", ")}`, id);
    }
    if (parsed.type === "derived-edge") {
      if (edge.kind !== parsed.kind || edge.from !== parsed.from || edge.to !== parsed.to) {
        this.error(
          path,
          `edge ${edge.id} overlays a derived edge, so its kind, from and to must match the id (${parsed.kind}: ${parsed.from} -> ${parsed.to})`,
          id,
          "bad-id",
        );
      }
    }
    this.checkLabel(edge.label, path, id, true);
    this.checkStringField(edge.summary, path, id, "summary");
    this.checkStringField(edge.detail, path, id, "detail");
    const fromOk = this.refNode(edge.from, `${path}.from`, id, "from");
    const toOk = this.refNode(edge.to, `${path}.to`, id, "to");
    if (edge.provenance === undefined)
      this.error(`${path}.provenance`, "provenance is required", id);
    else this.checkProvenance(edge.provenance, `${path}.provenance`, id);
    const checked = this.checkAnchors(edge.anchors ?? [], `${path}.anchors`, id, {
      provenance: edge.provenance,
      field: "anchors",
    });

    if (isRecord(edge.provenance) && edge.provenance.origin === "llm") {
      for (const [end, label, ok] of [
        [edge.from, "from", fromOk],
        [edge.to, "to", toOk],
      ] as const) {
        if (!ok) continue;
        // evidence is in the current code: an anchor in the code before the change does not count
        const covered = checked.some(
          (c) =>
            !isBaseAnchor(c.anchor) &&
            this.model.containsCode(end, {
              file: c.anchor.file,
              ...(c.anchor.symbol !== undefined ? { symbol: c.anchor.symbol } : {}),
              ...(c.range ? { range: c.range } : {}),
            }),
        );
        if (!covered) {
          this.error(
            `${path}.anchors`,
            `llm edge ${id} needs at least one anchor inside its ${label} (${end}): ${describeInside(end)}. Evidence is required at both ends (e.g. the call site and the target's definition).`,
            id,
            "evidence",
          );
        }
      }
    }
  }

  // ─── Concepts ───────────────────────────────────────────────────────────────────────────────

  private checkConcept(concept: unknown, i: number, claimed: Map<string, string>): void {
    const path = `concepts[${i}]`;
    if (!isRecord(concept)) {
      this.error(path, "concept must be an object");
      return;
    }
    const c = concept as unknown as Concept;
    this.claim(c.id, path, claimed);
    const idOk = typeof c.id === "string" && c.id !== "";
    const id = idOk ? c.id : path;
    const parsed = idOk ? parseId(c.id) : ({ type: "unknown" } as ParsedId);
    if (idOk && parsed.type !== "concept") {
      this.error(`${path}.id`, `concept id "${c.id}" must start with "concept:"`, id, "bad-id");
    }
    if (parsed.type === "concept") this.checkSlug(parsed.slug, path, c.id, "concept");
    this.checkLabel(c.label, path, id, true);
    this.checkStringField(c.summary, path, id, "summary");
    this.checkStringField(c.detail, path, id, "detail");
    if (c.provenance === undefined) this.error(`${path}.provenance`, "provenance is required", id);
    else this.checkProvenance(c.provenance, `${path}.provenance`, id);
    if (c.related !== undefined) {
      if (!Array.isArray(c.related))
        this.error(`${path}.related`, "related must be an array of element ids", id);
      else c.related.forEach((r, j) => this.refElement(r, `${path}.related[${j}]`, id, "related"));
    }
    this.checkAnchors(c.anchors ?? [], `${path}.anchors`, id, {
      provenance: c.provenance,
      field: "anchors",
    });
  }

  // ─── Views ──────────────────────────────────────────────────────────────────────────────────

  private checkView(
    view: Record<string, unknown>,
    i: number,
    claimed: Map<string, string>,
    viewIds: Map<string, string>,
  ): void {
    const path = `views[${i}]`;
    if (!isRecord(view)) {
      this.error(path, "view must be an object");
      return;
    }
    const id = typeof view.id === "string" ? view.id : path;
    if (typeof view.id !== "string" || view.id === "")
      this.error(`${path}.id`, "id must be a non-empty string");
    else {
      const first = viewIds.get(view.id);
      if (first !== undefined)
        this.error(
          `${path}.id`,
          `duplicate view id "${view.id}" (also at ${first})`,
          id,
          "duplicate-id",
        );
      else viewIds.set(view.id, path);
      const parsed = parseId(view.id);
      if (parsed.type !== "view")
        this.error(`${path}.id`, `view id "${view.id}" must start with "view:"`, id, "bad-id");
      else {
        this.checkSlug(parsed.slug, path, view.id, "view");
        if (RESERVED_PREFIXES.includes(parsed.slug)) {
          this.error(
            `${path}.id`,
            `view slug "${parsed.slug}" is reserved (its step ids would be ambiguous)`,
            id,
            "bad-id",
          );
        }
      }
    }
    if (typeof view.title !== "string") this.error(`${path}.title`, "title must be a string", id);
    if (view.provenance === undefined)
      this.error(`${path}.provenance`, "provenance is required", id);
    else this.checkProvenance(view.provenance, `${path}.provenance`, id);
    this.checkScope(view.scope, `${path}.scope`, id);

    if (view.type === "graph") this.checkGraphView(view, path, id);
    else if (view.type === "sequence" || view.type === "flow")
      this.checkSequenceView(view as unknown as SequenceView, path, id, claimed);
    else this.error(`${path}.type`, `view.type must be "graph", "sequence" or "flow"`, id);
  }

  private checkScope(scope: unknown, path: string, viewId: string): void {
    if (!isRecord(scope)) {
      this.error(path, "scope must be {root, depth, question?, entryPoints?}", viewId);
      return;
    }
    this.refNode(scope.root, `${path}.root`, viewId, "scope.root");
    if (typeof scope.depth !== "number" || !Number.isInteger(scope.depth) || scope.depth < 0) {
      this.error(`${path}.depth`, "scope.depth must be a non-negative integer", viewId);
    }
    if (scope.question !== undefined && typeof scope.question !== "string") {
      this.error(`${path}.question`, "scope.question must be a string", viewId);
    }
    if (scope.entryPoints !== undefined) {
      if (!Array.isArray(scope.entryPoints))
        this.error(
          `${path}.entryPoints`,
          'scope.entryPoints must be an array of symbol ids ("file#Symbol.path")',
          viewId,
        );
      else {
        scope.entryPoints.forEach((entry: unknown, j) => {
          if (typeof entry !== "string" || !this.index.symbol(entry)) {
            this.stale(
              `${path}.entryPoints[${j}]`,
              `entry point ${JSON.stringify(entry)} is not a symbol id in the index (form: "src/a.ts#Class.method")${this.entryPointHint(entry)}`,
              viewId,
              "unknown-id",
            );
          }
        });
      }
    }
  }

  /** `; did you mean src/a.ts#Class.run?` for an entry point whose file exists but whose symbol does not. */
  private entryPointHint(entry: unknown): string {
    if (typeof entry !== "string") return "";
    const { file, path } = splitSymbolId(entry, (candidate) => this.index.hasFile(candidate));
    if (!this.index.hasFile(file) || path === "") return "";
    const found = this.index.suggestSymbols(file, path, 3, this.hintFor(file, path) ?? {});
    return found.length > 0 ? `; did you mean ${found.map((sym) => sym.id).join(", ")}?` : "";
  }

  private checkGraphView(view: Record<string, unknown>, path: string, id: string): void {
    const listOfIds = (
      value: unknown,
      name: string,
      check: (item: unknown, at: string) => void,
    ) => {
      if (value === undefined) return;
      if (!Array.isArray(value)) {
        this.error(`${path}.${name}`, `${name} must be an array of element ids`, id);
        return;
      }
      const seen = new Set<unknown>();
      value.forEach((item, j) => {
        if (seen.has(item))
          this.warn(`${path}.${name}[${j}]`, `${String(item)} is listed twice`, id);
        seen.add(item);
        check(item, `${path}.${name}[${j}]`);
      });
    };
    if (!Array.isArray(view.include)) {
      this.error(`${path}.include`, "include must be an array of node ids", id);
    } else {
      listOfIds(view.include, "include", (item, at) => this.refNode(item, at, id, "include"));
    }
    listOfIds(view.hidden, "hidden", (item, at) => this.refHidden(item, at, id));
    if (view.edgeKinds !== undefined) {
      if (
        !Array.isArray(view.edgeKinds) ||
        view.edgeKinds.some((k) => !EDGE_KINDS.includes(k as Edge["kind"]))
      ) {
        this.error(
          `${path}.edgeKinds`,
          `edgeKinds must be an array of ${EDGE_KINDS.join(", ")}`,
          id,
        );
      }
    }
    if (view.excludeFiles !== undefined) {
      if (
        !Array.isArray(view.excludeFiles) ||
        view.excludeFiles.some((p) => typeof p !== "string")
      ) {
        this.error(
          `${path}.excludeFiles`,
          'excludeFiles must be an array of glob patterns on repo-relative paths, e.g. ["**/*_test.go", "**/test/**"]',
          id,
        );
      } else {
        (view.excludeFiles as string[]).forEach((pattern, j) => {
          const at = `${path}.excludeFiles[${j}]`;
          if (pattern.trim() === "") this.warn(at, "empty glob pattern matches nothing", id);
          else if (/^\.?\//.test(pattern) || pattern.includes("\\")) {
            this.warn(
              at,
              `glob pattern "${pattern}" is matched against repo-relative POSIX paths ("src/a.ts"): drop the leading "/" or "./" and use "/" as the separator`,
              id,
            );
          }
        });
      }
    }
    if (view.stubs !== undefined) this.checkStubPolicy(view.stubs, `${path}.stubs`, id);
    if (view.layout !== undefined) {
      if (!isRecord(view.layout)) this.error(`${path}.layout`, "layout must map ids to {x, y}", id);
      else {
        for (const [key, pos] of Object.entries(view.layout)) {
          this.refLayoutKey(key, `${path}.layout.${key}`, id);
          if (
            !isRecord(pos) ||
            typeof pos.x !== "number" ||
            typeof pos.y !== "number" ||
            !Number.isFinite(pos.x) ||
            !Number.isFinite(pos.y)
          ) {
            this.error(
              `${path}.layout.${key}`,
              "layout position must be {x: number, y: number}",
              id,
            );
          }
        }
      }
    }
  }

  /** `GraphView.stubs`: `{ mode?: "top" | "all" | "none", max?: a whole number, 0 or more }`. */
  private checkStubPolicy(stubs: unknown, at: string, viewId: string): void {
    if (!isRecord(stubs)) {
      this.error(at, 'stubs must be an object like {"mode": "top", "max": 8}', viewId);
      return;
    }
    for (const key of Object.keys(stubs)) {
      if (key !== "mode" && key !== "max") {
        this.warn(`${at}.${key}`, `unknown field "${key}" in stubs (mode, max)`, viewId);
      }
    }
    if (stubs.mode !== undefined && !(STUB_MODES as readonly unknown[]).includes(stubs.mode)) {
      this.error(
        `${at}.mode`,
        `stubs.mode must be one of ${STUB_MODES.map((mode) => `"${mode}"`).join(", ")}`,
        viewId,
      );
    }
    const max = stubs.max;
    if (max !== undefined && (typeof max !== "number" || !Number.isInteger(max) || max < 0)) {
      this.error(`${at}.max`, "stubs.max must be a whole number, 0 or more", viewId);
    }
  }

  /** Hidden entries: nodes, edges (stored or derived), ghosts and stubs. */
  private refHidden(item: unknown, at: string, viewId: string): void {
    if (typeof item !== "string") {
      this.error(at, "hidden entries must be element id strings", viewId);
      return;
    }
    const parsed = parseId(item);
    if (parsed.type === "ghost") this.refGhostKey(parsed.target, at, viewId, "hidden ghost");
    else if (parsed.type === "stub") {
      this.refNode(parsed.inside, at, viewId, "hidden stub");
      this.refGhostKey(parsed.ghost, at, viewId, "hidden stub");
    } else this.refElement(item, at, viewId, "hidden");
  }

  /**
   * The key of a ghost (`ghost:<key>`, or the end of a stub id): an element outside the view, `rest:file:<path>`
   * (an indexed file: the rest of it) or `more:in` / `more:out` (the overflow ghosts of `stubs.max`).
   */
  private refGhostKey(key: string, at: string, viewId: string, what: string): void {
    const info = parseGhostKey(key);
    if (info.kind === "more") return;
    this.refNode(info.kind === "rest" ? info.file : info.target, at, viewId, what);
  }

  private refLayoutKey(key: string, at: string, viewId: string): void {
    const parsed = parseId(key);
    if (parsed.type === "ghost") this.refGhostKey(parsed.target, at, viewId, "layout key");
    else this.refNode(key, at, viewId, "layout key");
  }

  private checkSequenceView(
    view: SequenceView,
    path: string,
    id: string,
    claimed: Map<string, string>,
  ): void {
    if (!Array.isArray(view.participants)) {
      this.error(
        `${path}.participants`,
        "participants must be an array of node ids (the lifelines, left to right)",
        id,
      );
    }
    const participants = Array.isArray(view.participants) ? view.participants : [];
    const seenParticipants = new Set<string>();
    participants.forEach((p, j) => {
      if (seenParticipants.has(p))
        this.warn(`${path}.participants[${j}]`, `${p} is listed twice`, id);
      seenParticipants.add(p);
      this.refNode(p, `${path}.participants[${j}]`, id, "participant");
    });
    if (!Array.isArray(view.steps)) {
      this.error(`${path}.steps`, "steps must be an array", id);
      return;
    }
    if (view.steps.length === 0) this.warn(`${path}.steps`, "sequence view has no steps", id);
    const slug = viewSlug(view.id);
    const stepIds = new Set<string>();
    view.steps.forEach((step, j) => {
      const at = `${path}.steps[${j}]`;
      if (!isRecord(step)) {
        this.error(at, "step must be an object", id);
        return;
      }
      this.claim(step.id, at, claimed);
      const stepOk = typeof step.id === "string" && step.id !== "";
      const sid = stepOk ? step.id : at;
      if (stepOk) {
        stepIds.add(step.id);
        const parsed = parseId(step.id);
        if (parsed.type !== "step") {
          this.error(
            `${at}.id`,
            `step id "${step.id}" must look like "<view-slug>:<n>", e.g. "${slug}:${j + 1}"`,
            sid,
            "step",
          );
        } else if (parsed.view !== slug) {
          this.warn(
            `${at}.id`,
            `step id "${step.id}" should start with the view slug "${slug}:"`,
            sid,
            "step",
          );
        }
      }
      if (!STEP_KINDS.includes(step.kind))
        this.error(`${at}.kind`, `step.kind must be one of ${STEP_KINDS.join(", ")}`, sid, "step");
      this.checkLabel(step.label, at, sid, true);
      this.checkStringField(step.summary, at, sid, "summary");
      for (const end of ["from", "to"] as const) {
        if (
          this.refNode(step[end], `${at}.${end}`, sid, `step ${end}`) &&
          !participants.includes(step[end])
        ) {
          this.error(
            `${at}.${end}`,
            `step ${sid}: ${step[end]} is not a participant of ${view.id}; add it to participants or use a participant`,
            sid,
            "step",
          );
        }
      }
      if (step.edge !== undefined) this.refEdge(step.edge, `${at}.edge`, sid, "step edge");
      // a step belongs to its view: the view's provenance says who may rewrite it
      this.checkAnchors(step.anchors ?? [], `${at}.anchors`, sid, {
        provenance: view.provenance,
        field: "steps",
      });
    });

    view.steps.forEach((step, j) => {
      if (!isRecord(step)) return;
      const at = `${path}.steps[${j}]`;
      if (step.shape !== undefined && !["stage", "decision", "terminal"].includes(step.shape))
        this.error(`${at}.shape`, "shape must be stage, decision or terminal", id);
      if (step.next !== undefined) {
        if (!Array.isArray(step.next))
          this.error(`${at}.next`, "next must be an array of {step, label?}", id);
        else
          step.next.forEach((link: unknown, k: number) => {
            if (
              !isRecord(link) ||
              typeof link.step !== "string" ||
              !stepIds.has(link.step) ||
              (link.label !== undefined && typeof link.label !== "string") ||
              Object.keys(link).some((key) => key !== "step" && key !== "label")
            )
              this.error(
                `${at}.next[${k}]`,
                "transition must reference a step of this view and have an optional string label",
                id,
              );
          });
      }
      if (step.shape === "terminal" && Array.isArray(step.next) && step.next.length > 0)
        this.error(`${at}.next`, "terminal stages cannot have outgoing transitions", id);
    });

    // frames
    if (view.frames === undefined) return;
    if (!Array.isArray(view.frames)) {
      this.error(`${path}.frames`, "frames must be an array", id);
      return;
    }
    const frameIds = new Map<string, string>();
    view.frames.forEach((frame, j) => {
      const at = `${path}.frames[${j}]`;
      if (!isRecord(frame)) {
        this.error(at, "frame must be an object", id);
        return;
      }
      if (typeof frame.id !== "string" || parseId(frame.id).type !== "frame") {
        this.error(
          `${at}.id`,
          `frame id ${JSON.stringify(frame.id)} must look like "frame:<slug>"`,
          id,
          "bad-id",
        );
      } else {
        const first = frameIds.get(frame.id);
        if (first !== undefined)
          this.error(
            `${at}.id`,
            `duplicate frame id "${frame.id}" (also at ${first})`,
            id,
            "duplicate-id",
          );
        else frameIds.set(frame.id, at);
        const parsed = parseId(frame.id);
        if (parsed.type === "frame") this.checkSlug(parsed.slug, at, frame.id, "frame");
      }
      if (!FRAME_KINDS.includes(frame.kind))
        this.error(
          `${at}.kind`,
          `frame.kind must be one of ${FRAME_KINDS.join(", ")}`,
          id,
          "frame",
        );
      if (typeof frame.label !== "string")
        this.error(`${at}.label`, "frame.label must be a string", id, "frame");
      const known = (name: "fromStep" | "toStep") => {
        const stepId = frame[name];
        if (typeof stepId === "string" && stepIds.has(stepId)) return true;
        this.error(
          `${at}.${name}`,
          `frame ${name} "${String(stepId)}" is not a step of ${view.id} (steps: ${[...stepIds].join(", ") || "none"})`,
          id,
          "frame",
        );
        return false;
      };
      const fromOk = known("fromStep");
      const toOk = known("toStep");
      if (fromOk && toOk) {
        const from = view.steps.findIndex((s) => s?.id === frame.fromStep);
        const to = view.steps.findIndex((s) => s?.id === frame.toStep);
        if (from > to) {
          this.error(
            `${at}`,
            `frame ${String(frame.id)}: fromStep ${frame.fromStep} comes after toStep ${frame.toStep}`,
            id,
            "frame",
          );
        }
      }
    });
    const resolved = resolveFrames(view);
    for (let a = 0; a < resolved.length; a++) {
      for (let b = a + 1; b < resolved.length; b++) {
        const x = resolved[a]!;
        const y = resolved[b]!;
        const crossing = x.from < y.from && y.from <= x.to && x.to < y.to;
        if (crossing) {
          this.warn(
            `${path}.frames`,
            `frames ${x.frame.id} and ${y.frame.id} overlap without nesting; a frame must lie inside another or apart from it`,
            id,
            "frame",
          );
        }
      }
    }
  }

  // ─── Tours ──────────────────────────────────────────────────────────────────────────────────

  private checkTour(tour: unknown, i: number, tourIds: Map<string, string>): void {
    const path = `tours[${i}]`;
    if (!isRecord(tour)) {
      this.error(path, "tour must be an object");
      return;
    }
    const id = typeof tour.id === "string" ? tour.id : path;
    if (typeof tour.id !== "string" || tour.id === "")
      this.error(`${path}.id`, "id must be a non-empty string");
    else {
      const first = tourIds.get(tour.id);
      if (first !== undefined)
        this.error(
          `${path}.id`,
          `duplicate tour id "${tour.id}" (also at ${first})`,
          id,
          "duplicate-id",
        );
      else tourIds.set(tour.id, path);
      const parsed = parseId(tour.id);
      if (parsed.type !== "tour")
        this.error(`${path}.id`, `tour id "${tour.id}" must start with "tour:"`, id, "bad-id");
      else this.checkSlug(parsed.slug, path, tour.id, "tour");
    }
    if (typeof tour.title !== "string") this.error(`${path}.title`, "title must be a string", id);
    this.checkStringField(tour.summary, path, id, "summary");
    // Optional: a tour written before tours had provenance counts as written by the llm.
    if (tour.provenance !== undefined)
      this.checkProvenance(tour.provenance, `${path}.provenance`, id);
    if (!Array.isArray(tour.steps)) {
      this.error(`${path}.steps`, "steps must be an array", id);
      return;
    }
    const stepIds = new Map<string, string>();
    tour.steps.forEach((step: unknown, j) => {
      const at = `${path}.steps[${j}]`;
      if (!isRecord(step)) {
        this.error(at, "tour step must be an object", id);
        return;
      }
      if (typeof step.id !== "string" || step.id === "")
        this.error(`${at}.id`, "tour step id must be a non-empty string", id);
      else {
        const first = stepIds.get(step.id);
        if (first !== undefined)
          this.error(
            `${at}.id`,
            `duplicate tour step id "${step.id}" (also at ${first})`,
            id,
            "duplicate-id",
          );
        else stepIds.set(step.id, at);
      }
      const view = typeof step.view === "string" ? this.model.view(step.view) : undefined;
      if (!view && !(typeof step.view === "string" && this.assumed.has(step.view))) {
        this.error(
          `${at}.view`,
          `tour step view ${JSON.stringify(step.view)} is not a view of this explainer${this.viewHint(step.view)}`,
          id,
          "unknown-id",
        );
      }
      if (!Array.isArray(step.focus))
        this.error(`${at}.focus`, "focus must be an array of element ids", id);
      else {
        step.focus.forEach((f: unknown, k) => {
          if (!this.refElement(f, `${at}.focus[${k}]`, id, "focus")) return;
          const owner = typeof f === "string" ? this.model.stepViewId(f) : undefined;
          if (owner !== undefined && view && owner !== view.id) {
            this.warn(
              `${at}.focus[${k}]`,
              `focus step ${String(f)} belongs to ${owner}, not to the tour step's view ${view.id}`,
              id,
            );
          }
        });
      }
      // a tour step's code belongs to its tour: the tour's provenance says who may rewrite it
      if (step.code !== undefined) {
        this.checkAnchors(step.code, `${at}.code`, id, {
          provenance: tour.provenance,
          field: "steps",
        });
      }
      if (step.note !== undefined && typeof step.note !== "string")
        this.error(`${at}.note`, "note must be a string", id);
      if (step.editor !== undefined) {
        if (!isRecord(step.editor))
          this.error(`${at}.editor`, "editor must be {dimOthers?, hideFileTree?, primary?}", id);
        else if (
          typeof step.editor.primary === "string" &&
          !this.index.hasFile(step.editor.primary)
        ) {
          this.stale(
            `${at}.editor.primary`,
            `editor.primary ${step.editor.primary} is not a file in the index`,
            id,
            "unknown-id",
          );
        }
      }
    });
  }
}

/** Ids of the explainer that a mistyped id may have meant (see `Validator.known`). */
interface IdPools {
  /** Groups, concepts, stored edges, views, tours and steps. */
  all: string[];
  views: string[];
  /** Step ids by sequence view id. */
  steps: Map<string, string[]>;
}

/** Why an llm patch cannot rewrite `field` of an element with this provenance (undefined: it can). */
function lockedBy(provenance: unknown, field: string): string | undefined {
  if (!isRecord(provenance)) return undefined;
  if (provenance.origin === "user") return "is user-authored";
  const fields = provenance.userFields;
  if (Array.isArray(fields) && fields.includes(field)) return `has its ${field} edited by the user`;
  return undefined;
}

/** `text` with a full stop, unless it already ends a sentence (a "did you mean ...?" hint does). */
function endSentence(text: string): string {
  return /[.?!]$/.test(text) ? text : `${text}.`;
}

function describeInside(end: ElementId): string {
  const parsed = parseId(end);
  switch (parsed.type) {
    case "file":
      return `a place in ${parsed.path}`;
    case "dir":
      return `a place under ${parsed.path}/`;
    case "symbol":
      return `a place in ${parsed.symbolId} (or a symbol inside it)`;
    case "group":
      return "a place in one of the group's members";
    default:
      return "a place in the code it stands for";
  }
}
