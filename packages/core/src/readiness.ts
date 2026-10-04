/** Shared ready-export rules. Workspace discovery stays in the CLI; offline checks cover embedded source only. */
import {
  collectAnchors,
  isBaseAnchor,
  toTextCache,
  type GetText,
  type TextCache,
} from "./anchors.js";
import { baseFileOf, basePathOf, headPathsOf } from "./change.js";
import { deriveGraph } from "./graph.js";
import { lintExplainer } from "./lint.js";
import { ExplainerModel } from "./model.js";
import type { Explainer, SymbolIndex } from "./schema.js";
import { referencedFiles } from "./source-files.js";
import { hashText } from "./text.js";
import { validateExplainer } from "./validate.js";

export interface ArtifactIdentity {
  explainerHash: string;
  sourceHash: string;
}

/** Sorted object keys; array order remains meaningful. Missing and undefined fields are equivalent. */
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([, v]) => v !== undefined)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([k, v]) => [k, canonical(v)]),
    );
  }
  return value;
}

/**
 * Portable identity, independent of HTML, server URL, launch mode and embedding/pruning choices.
 * Explanation includes all stored text, provenance, anchors and index metadata. Source includes the full
 * indexed path/hash manifest and change base/head (base commits identify the before-source). Pruning retains
 * every file entry, so the source identity survives a pruned bundle. Re-resolved explanation fields change
 * explainerHash; reindexing unchanged source does not change sourceHash.
 * sourceHash identifies indexed source: equal identities do not prove a stale draft/workspace matches it.
 * Consumers must also check readiness/freshness before accepting or retargeting source-bound changes.
 */
export function artifactIdentity(explainer: Explainer, index: SymbolIndex): ArtifactIdentity {
  return {
    explainerHash: hashText(JSON.stringify(canonical(explainer))),
    sourceHash: hashText(
      JSON.stringify(
        canonical({
          files: index.files
            .map(({ path, hash }) => ({ path, hash }))
            .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0)),
          ...(explainer.change ? { base: explainer.change.base, head: explainer.change.head } : {}),
        }),
      ),
    ),
  };
}

export interface ReadinessFinding {
  severity: "error" | "warning";
  code: string;
  elementId: string;
  field: string;
  message: string;
  hint: string;
}

export interface ReadinessReport {
  ready: boolean;
  scope: "workspace" | "embedded-snapshot";
  identity: ArtifactIdentity;
  errors: number;
  warnings: number;
  findings: ReadinessFinding[];
  /** Author's explanation of intentional omissions or warnings; never overrides blockers. */
  decisionNote?: string;
}

export interface ReadinessOptions {
  scope: ReadinessReport["scope"];
  /** CLI compares all discovered working-tree file hashes, including added/deleted files. */
  sourceWarning?: string;
  decisionNote?: string;
}

function hasText(value: unknown): value is string {
  return typeof value === "string" && value.trim() !== "";
}

export interface ViewContentStatus {
  id: string;
  type: "graph" | "sequence" | "flow";
  title: string;
  nodes: { total: number; unexplained: string[] };
  edges: { total: number; unexplained: { id: string; stored: boolean }[] };
  steps: { total: number; unexplained: string[] };
}

/** The content counted by status: visible nodes/participants, stored arrows and flow/sequence steps. */
export function viewContentStatuses(model: ExplainerModel): ViewContentStatus[] {
  const explained = (id: string) => hasText(model.node(id)?.summary);
  return model.views.map((view) => {
    const status: ViewContentStatus = {
      id: view.id,
      type: view.type,
      title: view.title,
      nodes: { total: 0, unexplained: [] },
      edges: { total: 0, unexplained: [] },
      steps: { total: 0, unexplained: [] },
    };
    if (view.type === "graph") {
      const graph = deriveGraph(view, model);
      status.nodes = {
        total: graph.nodes.length,
        unexplained: graph.nodes.filter((n) => !explained(n.id)).map((n) => n.id),
      };
      status.edges = {
        total: graph.edges.length,
        unexplained: graph.edges
          .filter((e) => !hasText(e.summary))
          .map((e) => ({ id: e.id, stored: e.stored })),
      };
    } else {
      const participants = Array.isArray(view.participants) ? view.participants : [];
      const steps = Array.isArray(view.steps) ? view.steps : [];
      status.nodes = {
        total: participants.length,
        unexplained: participants.filter((id) => model.hasNode(id) && !explained(id)),
      };
      status.steps = {
        total: steps.length,
        unexplained: steps.filter((s) => !hasText(s.summary)).map((s) => s.id),
      };
    }
    return status;
  });
}

/** Structural and source blockers, unfinished required content, then mechanical reader warnings. */
export function checkReadiness(
  explainer: Explainer,
  index: SymbolIndex,
  source: GetText | TextCache,
  options: ReadinessOptions,
): ReadinessReport {
  const texts = toTextCache(source);
  const findings: ReadinessFinding[] = validateExplainer(explainer, index, texts, {
    mode: "strict",
  }).map((issue) => ({
    severity: issue.severity,
    code: issue.code ?? "structure",
    elementId: issue.elementId ?? "(explainer)",
    field: issue.path,
    message: issue.message,
    hint:
      issue.code === "change"
        ? "Regenerate the change record with xpl change <name> <base>..<head>."
        : issue.code === "commit" || /anchor/.test(issue.code ?? "")
          ? "Run xpl resolve --write; re-explain drifted code or repair missing anchors."
          : "Repair this field with xpl apply; run xpl validate again.",
  }));
  if (options.sourceWarning)
    findings.unshift({
      severity: "error",
      code: "stale-index",
      elementId: "(source)",
      field: "index",
      message: options.sourceWarning,
      hint: "Run xpl index, then xpl resolve --write and repair drifted claims.",
    });
  // A resolver may retain cached ranges when text is unavailable. Ready output needs readable evidence.
  for (const site of collectAnchors(explainer)) {
    const anchor = site.anchor;
    const changed = explainer.change && baseFileOf(explainer.change, anchor.file);
    const text = isBaseAnchor(anchor)
      ? changed && explainer.change
        ? texts.textAt(explainer.change.base, basePathOf(changed))
        : undefined
      : texts.text(anchor.file);
    if (
      text === undefined &&
      !findings.some((f) => f.field === site.path && f.severity === "error")
    )
      findings.push({
        severity: "error",
        code: "source-unavailable",
        elementId: site.elementId,
        field: site.path,
        message: `${anchor.file}${isBaseAnchor(anchor) ? "@base" : ""}: source text is unavailable.`,
        hint: "Rebuild the snapshot with the referenced source; repair or remove anchors whose code is gone.",
      });
  }
  for (const file of index.files) {
    const text = texts.text(file.path);
    if (text !== undefined && hashText(text) !== file.hash && !options.sourceWarning)
      findings.push({
        severity: "error",
        code: "source-mismatch",
        elementId: `file:${file.path}`,
        field: "source",
        message: "Source text does not match the indexed file hash.",
        hint: "Run xpl index and resolve; rebuild this snapshot.",
      });
  }
  const structurallyValid = !findings.some(
    (f) => f.severity === "error" && !/anchor|source|stale/.test(f.code),
  );
  const model = structurallyValid ? new ExplainerModel(explainer, index) : undefined;
  const missing = (elementId: string, field: string) =>
    findings.push({
      severity: "error",
      code: "required-content",
      elementId,
      field,
      message: "Required reader text is empty.",
      hint: "Write this text with xpl apply, or remove the element from the explanation's scope.",
    });
  if (!hasText(explainer.title)) missing("(explainer)", "title");
  if (model) {
    if (model.views.length === 0) missing("(explainer)", "views");
    for (const path of new Set([
      ...referencedFiles(explainer, model.index),
      ...(explainer.change
        ? headPathsOf(explainer.change).filter((path) => model.index.hasFile(path))
        : []),
    ])) {
      if (
        texts.text(path) === undefined &&
        !findings.some((f) => f.code === "source-unavailable" && f.message.startsWith(path))
      )
        findings.push({
          severity: "error",
          code: "source-unavailable",
          elementId: `file:${path}`,
          field: "source",
          message: `${path}: source needed by the explanation is unavailable.`,
          hint: "Rebuild the snapshot with its referenced source files.",
        });
    }
    if (explainer.change)
      for (const file of explainer.change.files) {
        if (
          ["modified", "deleted", "renamed"].includes(file.status) &&
          texts.textAt(explainer.change.base, basePathOf(file)) === undefined &&
          !findings.some(
            (f) => f.code === "source-unavailable" && f.message.startsWith(`${file.path}@base`),
          )
        )
          findings.push({
            severity: "error",
            code: "source-unavailable",
            elementId: `file:${file.path}`,
            field: "baseFiles",
            message: `${file.path}@base: before-source needed by the change is unavailable.`,
            hint: "Rebuild from a checkout with the change's base commit available.",
          });
      }
    const ids = new Set<string>();
    for (const view of viewContentStatuses(model)) {
      for (const id of [
        ...view.nodes.unexplained,
        ...view.edges.unexplained.filter((e) => e.stored).map((e) => e.id),
        ...view.steps.unexplained,
      ])
        ids.add(id);
    }
    for (const concept of model.concepts) if (!hasText(concept.summary)) ids.add(concept.id);
    for (const id of ids) missing(id, "summary");
    for (const view of model.views) if (!hasText(view.title)) missing(view.id, "title");
    for (const tour of model.tours) {
      if (!hasText(tour.title)) missing(tour.id, "title");
      if (tour.steps.length === 0) missing(tour.id, "steps");
      if (!hasText(tour.summary)) missing(tour.id, "summary");
      for (const step of tour.steps)
        if (!hasText(step.note) || !hasText(step.note.replace(/^\s*### [^\n]*(?:\n|$)/, "")))
          missing(`${tour.id}/${step.id}`, "note");
    }
  }
  for (const finding of lintExplainer(explainer, model).findings) {
    if (
      findings.some(
        (f) =>
          f.code === "required-content" &&
          f.elementId === finding.elementId &&
          f.field === finding.field,
      )
    )
      continue;
    findings.push({
      severity: finding.severity ?? "warning",
      code: finding.rule,
      elementId: finding.elementId,
      field: finding.field,
      message: finding.message,
      hint: finding.hint,
    });
  }
  const errors = findings.filter((f) => f.severity === "error").length;
  return {
    ready: errors === 0,
    scope: options.scope,
    identity: artifactIdentity(explainer, index),
    errors,
    warnings: findings.length - errors,
    findings,
    ...(options.decisionNote?.trim() ? { decisionNote: options.decisionNote.trim() } : {}),
  };
}
