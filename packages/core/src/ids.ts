/**
 * Element ids (ARCHITECTURE.md section 4.3): builders, parsers, and the SymbolId <-> ElementId
 * mapping. Pure string logic; nothing in here needs an index (see `normalizeElementId` in
 * index-model.ts for the index-aware, loose-input variant used by the CLI).
 *
 *   structural   repo | dir:<path> | file:<path> | sym:<file>#<symbolPath>
 *   stored       grp:<slug> | concept:<slug> | edge:<slug> | view:<slug> | tour:<slug> | frame:<slug>
 *                and sequence steps "<view-slug>:<n>" (e.g. "dispatch:3")
 *   derived      edge:<kind>:<fromId>-><toId>          (never stored under a slug)
 *   render-only  ghost:<id> | stub:<in|out>:<insideId>->ghost:<id>
 *
 * A `sym:` id is split into file and symbol path at the FIRST "#" (file paths containing "#" are not
 * supported by the id syntax; the index-aware helpers try every "#" when the index is at hand).
 */
import { asIndexModel, type IndexModel } from "./index-model.js";
import type {
  Edge,
  ElementId,
  FilePath,
  Node,
  Reference,
  SymbolId,
  SymbolIndex,
  SymbolPath,
} from "./schema.js";

export const REPO_ID: ElementId = "repo";

/** Edge kinds that static analysis derives from index references (ARCHITECTURE.md section 4.4). */
export const DERIVED_EDGE_KINDS = [
  "calls",
  "imports",
  "extends",
  "implements",
  "references",
  "reads",
  "writes",
] as const satisfies readonly Edge["kind"][];
export type DerivedEdgeKind = (typeof DERIVED_EDGE_KINDS)[number];

/** Every `Edge.kind`. */
export const EDGE_KINDS: readonly Edge["kind"][] = [...DERIVED_EDGE_KINDS, "emits", "custom"];

/** `Reference.kind` -> derived `Edge.kind`. */
export const REF_TO_EDGE_KIND: Readonly<Record<Reference["kind"], DerivedEdgeKind>> = {
  call: "calls",
  import: "imports",
  extends: "extends",
  implements: "implements",
  "type-ref": "references",
  read: "reads",
  write: "writes",
};

/** Derived `Edge.kind` -> `Reference.kind` (`emits` and `custom` have no references). */
export const EDGE_TO_REF_KIND: Readonly<Partial<Record<Edge["kind"], Reference["kind"]>>> = {
  calls: "call",
  imports: "import",
  extends: "extends",
  implements: "implements",
  references: "type-ref",
  reads: "read",
  writes: "write",
};

/** Id prefixes that are never valid view slugs (a step id `file:3` would be ambiguous). */
export const RESERVED_PREFIXES: readonly string[] = [
  "dir",
  "file",
  "sym",
  "grp",
  "concept",
  "edge",
  "view",
  "tour",
  "frame",
  "ghost",
  "stub",
];

/** Slugs (the part after `grp:`, `concept:`, `edge:`, `view:`, `tour:`, `frame:`). */
export const SLUG_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
export function isSlug(value: string): boolean {
  return SLUG_RE.test(value);
}

const STEP_RE = /^([A-Za-z0-9][A-Za-z0-9._-]*):(\d+)$/;

// ─── Symbol ids and module scopes ───────────────────────────────────────────────────────────────

/** `"<file>#<path>"`. */
export function symbolId(file: FilePath, path: SymbolPath): SymbolId {
  return `${file}#${path}`;
}

/** Module scope id of a file: `"<file>#"` (empty symbol path). */
export function moduleScopeId(file: FilePath): SymbolId {
  return `${file}#`;
}

export function isModuleScopeId(id: SymbolId): boolean {
  return id.length > 1 && id.endsWith("#");
}

/**
 * Splits a SymbolId into file and symbol path. Splits at the first "#"; when `hasFile` is given,
 * at the first "#" whose prefix is a known file (falling back to the first "#").
 */
export function splitSymbolId(
  id: SymbolId,
  hasFile?: (path: FilePath) => boolean,
): { file: FilePath; path: SymbolPath } {
  let first = -1;
  for (let at = id.indexOf("#"); at !== -1; at = id.indexOf("#", at + 1)) {
    if (first === -1) first = at;
    if (!hasFile || hasFile(id.slice(0, at))) {
      return { file: id.slice(0, at), path: id.slice(at + 1) };
    }
  }
  return first === -1
    ? { file: id, path: "" }
    : { file: id.slice(0, first), path: id.slice(first + 1) };
}

/** `"f#"` -> `file:f` (module scope lifts to its file); `"f#P"` -> `sym:f#P`. */
export function elementIdForSymbolId(id: SymbolId): ElementId {
  return isModuleScopeId(id) ? `file:${id.slice(0, -1)}` : `sym:${id}`;
}

/** Inverse of `elementIdForSymbolId` for `sym:` ids (`file:f` maps to its module scope `f#`). */
export function symbolIdForElementId(id: ElementId): SymbolId | undefined {
  if (id.startsWith("sym:")) return id.slice(4);
  if (id.startsWith("file:")) return moduleScopeId(id.slice(5));
  return undefined;
}

// ─── Builders ───────────────────────────────────────────────────────────────────────────────────

export const dirId = (path: FilePath): ElementId => `dir:${path}`;
export const fileId = (path: FilePath): ElementId => `file:${path}`;
export const symId = (file: FilePath, path: SymbolPath): ElementId => `sym:${file}#${path}`;
export const groupId = (slug: string): ElementId => `grp:${slug}`;
export const conceptId = (slug: string): ElementId => `concept:${slug}`;
/** Stored (llm / user) edge: `edge:<slug>`. */
export const storedEdgeId = (slug: string): ElementId => `edge:${slug}`;
/** Derived edge: `edge:<kind>:<fromId>-><toId>`. */
export const derivedEdgeId = (kind: Edge["kind"], from: ElementId, to: ElementId): ElementId =>
  `edge:${kind}:${from}->${to}`;
export const viewId = (slug: string): string => `view:${slug}`;
export const tourId = (slug: string): string => `tour:${slug}`;
export const frameId = (slug: string): string => `frame:${slug}`;
/** Slug of a view id (`view:dispatch` -> `dispatch`; anything else is returned unchanged). */
export const viewSlug = (id: string): string => (id.startsWith("view:") ? id.slice(5) : id);
/** Sequence step id: `stepId("view:dispatch", 3)` and `stepId("dispatch", 3)` are `dispatch:3`. */
export const stepId = (view: string, n: number): string => `${viewSlug(view)}:${n}`;
/** Render-only ghost box standing for `target` (an element outside the view). */
export const ghostId = (target: ElementId): ElementId => `ghost:${target}`;
/** Render-only stub: `stub:<in|out>:<insideId>->ghost:<ghostTarget>`. */
export const stubId = (
  direction: "in" | "out",
  inside: ElementId,
  ghostTarget: ElementId,
): ElementId => `stub:${direction}:${inside}->ghost:${ghostTarget}`;

// ─── Parsing ────────────────────────────────────────────────────────────────────────────────────

export type ParsedId =
  | { type: "repo" }
  | { type: "dir"; path: FilePath }
  | { type: "file"; path: FilePath }
  | { type: "symbol"; file: FilePath; path: SymbolPath; symbolId: SymbolId }
  | { type: "group"; slug: string }
  | { type: "concept"; slug: string }
  /** Stored edge `edge:<slug>`. */
  | { type: "edge"; slug: string }
  | { type: "derived-edge"; kind: DerivedEdgeKind; from: ElementId; to: ElementId }
  | { type: "view"; slug: string }
  | { type: "tour"; slug: string }
  | { type: "frame"; slug: string }
  /** `<view-slug>:<n>`. */
  | { type: "step"; view: string; n: number }
  /** `ghost:<target>`; `target` is the element the ghost box stands for. */
  | { type: "ghost"; target: ElementId }
  | { type: "stub"; direction: "in" | "out"; inside: ElementId; ghost: ElementId }
  | { type: "unknown" };

export type IdType = ParsedId["type"];

const UNKNOWN: ParsedId = { type: "unknown" };

/** Types whose ids are boxes in a diagram (`Node` ids). */
const NODE_TYPES: ReadonlySet<IdType> = new Set(["repo", "dir", "file", "symbol", "group"]);

/** Classifies and splits an id. Unrecognised input is `{ type: "unknown" }`, never a throw. */
export function parseId(id: string): ParsedId {
  if (id === REPO_ID) return { type: "repo" };
  const colon = id.indexOf(":");
  if (colon <= 0) return UNKNOWN;
  const prefix = id.slice(0, colon);
  const rest = id.slice(colon + 1);
  switch (prefix) {
    case "dir":
      return rest ? { type: "dir", path: rest } : UNKNOWN;
    case "file":
      return rest ? { type: "file", path: rest } : UNKNOWN;
    case "sym": {
      const hash = rest.indexOf("#");
      if (hash <= 0 || hash === rest.length - 1) return UNKNOWN;
      return {
        type: "symbol",
        file: rest.slice(0, hash),
        path: rest.slice(hash + 1),
        symbolId: rest,
      };
    }
    case "grp":
      return rest ? { type: "group", slug: rest } : UNKNOWN;
    case "concept":
      return rest ? { type: "concept", slug: rest } : UNKNOWN;
    case "view":
      return rest ? { type: "view", slug: rest } : UNKNOWN;
    case "tour":
      return rest ? { type: "tour", slug: rest } : UNKNOWN;
    case "frame":
      return rest ? { type: "frame", slug: rest } : UNKNOWN;
    case "edge":
      return rest ? parseEdgeRest(rest) : UNKNOWN;
    case "ghost":
      return rest ? { type: "ghost", target: rest } : UNKNOWN;
    case "stub": {
      const dirEnd = rest.indexOf(":");
      const direction = rest.slice(0, dirEnd);
      if (dirEnd <= 0 || (direction !== "in" && direction !== "out")) return UNKNOWN;
      const body = rest.slice(dirEnd + 1);
      const marker = body.indexOf("->ghost:");
      if (marker <= 0) return UNKNOWN;
      const ghost = body.slice(marker + "->ghost:".length);
      return ghost ? { type: "stub", direction, inside: body.slice(0, marker), ghost } : UNKNOWN;
    }
    default: {
      const step = STEP_RE.exec(id);
      return step && !RESERVED_PREFIXES.includes(step[1]!)
        ? { type: "step", view: step[1]!, n: Number(step[2]) }
        : UNKNOWN;
    }
  }
}

function parseEdgeRest(rest: string): ParsedId {
  const colon = rest.indexOf(":");
  const kind = rest.slice(0, colon);
  if (colon > 0 && (DERIVED_EDGE_KINDS as readonly string[]).includes(kind)) {
    const body = rest.slice(colon + 1);
    for (let at = body.indexOf("->"); at !== -1; at = body.indexOf("->", at + 1)) {
      const from = body.slice(0, at);
      const to = body.slice(at + 2);
      if (NODE_TYPES.has(parseId(from).type) && NODE_TYPES.has(parseId(to).type)) {
        return { type: "derived-edge", kind: kind as DerivedEdgeKind, from, to };
      }
    }
  }
  return { type: "edge", slug: rest };
}

/** True for ids of diagram boxes: repo, dir:, file:, sym:, grp:. */
export function isNodeId(id: string): boolean {
  return NODE_TYPES.has(parseId(id).type);
}

/** True for ids that live in the index: repo, dir:, file:, sym:. */
export function isStructuralId(id: string): boolean {
  const type = parseId(id).type;
  return type === "repo" || type === "dir" || type === "file" || type === "symbol";
}

/** `Node.kind` an id implies (`grp:x` -> "group"), or undefined when it is not a node id. */
export function nodeKindOfId(id: string): Node["kind"] | undefined {
  switch (parseId(id).type) {
    case "repo":
      return "repo";
    case "dir":
      return "dir";
    case "file":
      return "file";
    case "symbol":
      return "symbol";
    case "group":
      return "group";
    default:
      return undefined;
  }
}

// ─── Loose input (CLI arguments) ────────────────────────────────────────────────────────────────

export type NormalizeIdResult =
  | { ok: true; id: ElementId }
  | {
      ok: false;
      error: string;
      /** Nearby element ids worth suggesting, when there are any. */
      candidates?: string[];
    };

/**
 * Turns what a person (or Claude) types into an element id, checking structural ids against the
 * index. Accepts `sym:src/a.ts#A.b`, `file:src/a.ts`, `dir:src`, `repo`, and the loose forms
 * `src/a.ts#A.b`, `src/a.ts`, `src`, `./src/a.ts`, `src/`, `src/a.ts#` (= the file). Ids of stored
 * or render-only elements (`grp:`, `concept:`, `edge:`, steps, ...) pass through unchecked: without
 * an explainer there is nothing to check them against. Unknown files, directories and symbols are
 * errors that carry suggestions (same last path segment in that file, same path in other files).
 */
export function normalizeElementId(
  input: string,
  indexLike: SymbolIndex | IndexModel,
): NormalizeIdResult {
  const index = asIndexModel(indexLike);
  const raw = input.trim().replace(/\\/g, "/");
  if (raw === "") return { ok: false, error: "empty id" };
  const parsed = parseId(raw);
  switch (parsed.type) {
    case "repo":
      return { ok: true, id: REPO_ID };
    case "dir":
      return normalizeDir(index, parsed.path);
    case "file":
      return normalizeFile(index, parsed.path);
    case "symbol":
      return normalizeSymbol(index, parsed.symbolId);
    case "unknown":
      break;
    default:
      return { ok: true, id: raw };
  }
  if (raw.startsWith("sym:")) return normalizeSymbol(index, raw.slice(4));
  if (raw.startsWith("file:")) return normalizeFile(index, raw.slice(5));
  if (raw.startsWith("dir:")) return normalizeDir(index, raw.slice(4));
  if (raw.includes("#")) return normalizeSymbol(index, raw);
  return normalizePath(index, raw);
}

function cleanPath(path: string): string {
  return path.replace(/^(\.\/)+/, "").replace(/\/+$/, "");
}

function suggestions(items: readonly string[]): string {
  return items.length > 0 ? ` Did you mean: ${items.join(", ")}?` : "";
}

function normalizeFile(index: IndexModel, rawPath: string): NormalizeIdResult {
  const path = cleanPath(rawPath);
  if (index.hasFile(path)) return { ok: true, id: fileId(path) };
  if (index.hasDirectory(path)) {
    return {
      ok: false,
      error: `"${path}" is a directory; use dir:${path}`,
      candidates: [dirId(path)],
    };
  }
  const candidates = index.suggestFiles(path).map(fileId);
  return {
    ok: false,
    error: `unknown file "${path}" (not in the index).${suggestions(candidates)}`,
    candidates,
  };
}

function normalizeDir(index: IndexModel, rawPath: string): NormalizeIdResult {
  const path = cleanPath(rawPath);
  if (path === "" || path === ".") return { ok: true, id: REPO_ID };
  if (index.hasDirectory(path)) return { ok: true, id: dirId(path) };
  if (index.hasFile(path)) {
    return {
      ok: false,
      error: `"${path}" is a file; use file:${path}`,
      candidates: [fileId(path)],
    };
  }
  const candidates = index.directories
    .filter((d) => d.includes(path))
    .slice(0, 5)
    .map(dirId);
  return {
    ok: false,
    error: `unknown directory "${path}" (no indexed file under it).${suggestions(candidates)}`,
    candidates,
  };
}

function normalizeSymbol(index: IndexModel, symbolIdLike: string): NormalizeIdResult {
  const cleaned = symbolIdLike.replace(/^(\.\/)+/, "");
  const { file, path } = splitSymbolId(cleaned, (p) => index.hasFile(p));
  if (!index.hasFile(file)) {
    const candidates = index.suggestFiles(file).map(fileId);
    return {
      ok: false,
      error: `unknown file "${file}" (not in the index).${suggestions(candidates)}`,
      candidates,
    };
  }
  if (path === "") return { ok: true, id: fileId(file) };
  if (index.symbolAt(file, path)) return { ok: true, id: symId(file, path) };
  const found = index.suggestSymbols(file, path);
  const candidates = found.map((sym) => `sym:${sym.id}`);
  return {
    ok: false,
    error: `symbol "${path}" not found in ${file}.${suggestions(found.map((sym) => sym.id))}`,
    candidates,
  };
}

function normalizePath(index: IndexModel, raw: string): NormalizeIdResult {
  const path = cleanPath(raw);
  if (path === "" || path === ".") return { ok: true, id: REPO_ID };
  if (index.hasFile(path)) return { ok: true, id: fileId(path) };
  if (index.hasDirectory(path)) return { ok: true, id: dirId(path) };
  const candidates = [
    ...index.suggestFiles(path, 3).map(fileId),
    ...index.directories
      .filter((d) => d.includes(path))
      .slice(0, 2)
      .map(dirId),
  ];
  return {
    ok: false,
    error: `"${raw}" is not a file, directory or symbol in the index.${suggestions(candidates)}`,
    candidates,
  };
}
