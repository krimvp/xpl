/** Scoped author inspection. Separate from artifact identity and source-anchor validity. */
import {
  collectAnchors,
  isBaseAnchor,
  resolveWith,
  toTextCache,
  type GetText,
  type TextCache,
} from "./anchors.js";
import { baseFileOf, basePathOf } from "./change.js";
import { asIndexModel, type IndexModel } from "./index-model.js";
import type { Explainer, ReviewFingerprint, ReviewScope, SymbolIndex } from "./schema.js";
import { hashText } from "./text.js";
import { isRecord } from "./util.js";

const COLLECTIONS = ["nodes", "edges", "concepts", "views", "tours"] as const;
const VERSION = "xpl-review@1";
const HASH = /^sha256-v2:[0-9a-f]{12}$/;

/** Validates stored/input review shapes without requiring historical content to still exist. */
export function reviewShapeIssues(
  value: unknown,
  stored = true,
): { path: string; message: string }[] {
  const issues: { path: string; message: string }[] = [];
  const error = (path: string, message: string) => issues.push({ path, message });
  const fields = (raw: Record<string, unknown>, allowed: string[], prefix: string) => {
    for (const key of Object.keys(raw))
      if (!allowed.includes(key)) error(`${prefix}.${key}`, `Unknown review field ${key}.`);
  };
  const nonempty = (v: unknown): v is string => typeof v === "string" && v.trim() !== "";
  const strings = (v: unknown): v is string[] =>
    Array.isArray(v) && v.every(nonempty) && new Set(v).size === v.length;
  if (!isRecord(value)) return [{ path: "review", message: "Review must be an object." }];
  fields(
    value,
    [
      "reviewer",
      "reviewedAt",
      "scope",
      "omissions",
      "fingerprint",
      ...(stored ? ["sourceCommit"] : []),
    ],
    "review",
  );
  if (!nonempty(value.reviewer))
    error("review.reviewer", "Reviewer must be a non-empty self-reported name.");
  if (
    typeof value.reviewedAt !== "string" ||
    !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{3})?Z$/.test(value.reviewedAt) ||
    !Number.isFinite(Date.parse(value.reviewedAt)) ||
    new Date(value.reviewedAt).toISOString().replace(".000Z", "Z") !==
      value.reviewedAt.replace(".000Z", "Z")
  )
    error("review.reviewedAt", "Review time must be a valid UTC ISO timestamp.");
  if (!Array.isArray(value.omissions) || !value.omissions.every(nonempty))
    error(
      "review.omissions",
      "Omissions must be an array of non-empty descriptions (empty means none named).",
    );
  if (stored && !nonempty(value.sourceCommit))
    error("review.sourceCommit", "Review source commit must be a non-empty string.");
  if (!isRecord(value.scope)) error("review.scope", "Review scope must be an object.");
  else {
    const scope = value.scope;
    fields(scope, ["content", "source", "files"], "review.scope");
    if (scope.content !== "all" && (!strings(scope.content) || scope.content.length === 0))
      error(
        "review.scope.content",
        "Content scope must be all or a non-empty list of unique stored IDs.",
      );
    if (scope.source !== "anchored" && scope.source !== "repository")
      error("review.scope.source", "Source scope must be anchored or repository.");
    if (
      scope.files !== undefined &&
      (!strings(scope.files) ||
        scope.files.some(
          (f) =>
            f.startsWith("/") ||
            f.includes("\\") ||
            f.split("/").some((s) => s === ".." || s === "." || s === ""),
        ))
    )
      error("review.scope.files", "Review files must be unique repository-relative paths.");
  }
  if (
    !isRecord(value.fingerprint) ||
    value.fingerprint.version !== VERSION ||
    typeof value.fingerprint.contentHash !== "string" ||
    !HASH.test(value.fingerprint.contentHash) ||
    typeof value.fingerprint.evidenceHash !== "string" ||
    !HASH.test(value.fingerprint.evidenceHash)
  )
    error(
      "review.fingerprint",
      "Review fingerprint must be xpl-review@1 with content and evidence hashes.",
    );
  else fields(value.fingerprint, ["version", "contentHash", "evidenceHash"], "review.fingerprint");
  return issues;
}

/** Sorted keys; author ownership and anchor locations do not change inspected prose/evidence. */
function project(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(project);
  if (!isRecord(value)) return value;
  const anchor =
    typeof value.file === "string" &&
    typeof value.role === "string" &&
    typeof value.hash === "string";
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .filter(
        (key) =>
          value[key] !== undefined &&
          key !== "provenance" &&
          !(anchor && (key === "span" || key === "resolved")),
      )
      .map((key) => [key, project(value[key])]),
  );
}

/** Whole indexed files explicitly added to scoped anchor evidence. */
export function reviewSourceFiles(scope: ReviewScope, index: SymbolIndex | IndexModel): string[] {
  return [
    ...new Set([
      ...(scope.source === "repository" ? asIndexModel(index).files.map((f) => f.path) : []),
      ...(scope.files ?? []),
    ]),
  ].sort();
}

/**
 * Fingerprint exactly the selected stored records and their attached evidence. No dependency closure:
 * a view includes its own steps, a tour includes its code overrides, but neither includes other records'
 * prose/anchors unless named. Additional files or repository scope explicitly widen source inspection.
 * Throws for missing scope/evidence or stale anchors; cached locations never substitute for source.
 */
export function reviewFingerprint(
  explainer: Explainer,
  index: SymbolIndex | IndexModel,
  source: GetText | TextCache,
  scope: ReviewScope,
): ReviewFingerprint {
  const model = asIndexModel(index);
  const texts = toTextCache(source);
  const selected = { ...explainer };
  const wanted = scope.content === "all" ? undefined : new Set(scope.content);
  for (const key of COLLECTIONS) {
    // Each list has a different record type, but filtering does not change that type.
    const records = explainer[key].filter((record) => !wanted || wanted.has(record.id));
    Object.assign(selected, { [key]: records });
  }
  if (wanted)
    for (const id of wanted)
      if (!COLLECTIONS.some((key) => selected[key].some((record) => record.id === id)))
        throw new Error(`Reviewed content ${id} is missing.`);
  const content = wanted
    ? Object.fromEntries(COLLECTIONS.map((key) => [key, selected[key]]))
    : {
        title: explainer.title,
        repo: { name: explainer.repo.name, url: explainer.repo.url },
        scope: explainer.scope,
        change: explainer.change,
        ...Object.fromEntries(COLLECTIONS.map((key) => [key, selected[key]])),
      };
  const evidence = collectAnchors(selected).map(({ path, anchor }) => {
    const baseFile =
      isBaseAnchor(anchor) && explainer.change
        ? baseFileOf(explainer.change, anchor.file)
        : undefined;
    const text = isBaseAnchor(anchor)
      ? baseFile && explainer.change
        ? texts.textAt(explainer.change.base, basePathOf(baseFile))
        : undefined
      : texts.text(anchor.file);
    if (text === undefined) throw new Error(`Reviewed evidence ${anchor.file} is unavailable.`);
    const resolved = resolveWith(anchor, model, texts, explainer.change);
    if (resolved.reason || (resolved.status !== "ok" && resolved.status !== "moved"))
      throw new Error(`Reviewed evidence ${anchor.file} is stale or missing.`);
    return {
      path,
      file: anchor.file,
      at: anchor.at,
      symbol: anchor.symbol,
      role: anchor.role,
      hash: resolved.hash,
    };
  });
  const manifest = reviewSourceFiles(scope, model).map((path) => {
    if (!model.hasFile(path)) throw new Error(`Reviewed file ${path} is not indexed.`);
    const text = texts.text(path);
    if (text === undefined) throw new Error(`Reviewed file ${path} is unavailable.`);
    return { path, hash: hashText(text) };
  });
  return {
    version: VERSION,
    contentHash: hashText(JSON.stringify(project({ scope, content }))),
    evidenceHash: hashText(JSON.stringify(project({ evidence, files: manifest }))),
  };
}

/** Missing legacy records are unchecked; invalid/unavailable scope never becomes a current review. */
export function checkReview(
  explainer: Explainer,
  index: SymbolIndex | IndexModel,
  source: GetText | TextCache,
): { status: "unchecked" | "reviewed" | "out-of-date" } {
  if (explainer.review === undefined) return { status: "unchecked" };
  if (reviewShapeIssues(explainer.review).length) return { status: "out-of-date" };
  try {
    const current = reviewFingerprint(explainer, index, source, explainer.review.scope);
    return {
      status:
        current.contentHash === explainer.review.fingerprint.contentHash &&
        current.evidenceHash === explainer.review.fingerprint.evidenceHash
          ? "reviewed"
          : "out-of-date",
    };
  } catch {
    return { status: "out-of-date" };
  }
}
