/**
 * What the details panel shows for an element: one shape for nodes, edges (stored and derived), concepts,
 * sequence steps and stubs, built from the model and the derived graph of the current view.
 */
import {
  codeFocus,
  describeAnchor,
  type Anchor,
  type AnchorRole,
  type AnchorStatus,
  isFoldedGhostKey,
  type DerivedEdge,
  type ElementId,
  type ExplainerModel,
  type GhostTarget,
  type Provenance,
  type Stub,
} from "@xpl/core";
import type { ViewDerived } from "./derive.js";

export interface AnchorRow {
  role: AnchorRole;
  file: string;
  /** `src/runner.ts#Runner.dispatch +34..36`. */
  where: string;
  /** Resolved lines, when the anchor has been resolved. */
  startLine?: number;
  endLine?: number;
  status: AnchorStatus | "unresolved";
}

export interface ElementInfo {
  id: ElementId;
  type: "node" | "edge" | "derived-edge" | "concept" | "step" | "stub" | "unknown";
  title: string;
  /** Badge text: the node or symbol kind, the edge kind, `concept`, `step`, `stub`. */
  kind: string;
  /** A short location line under the title. */
  where?: string;
  summary?: string;
  detail?: string;
  provenance?: Provenance;
  facts: { label: string; value: string }[];
  anchors: AnchorRow[];
  /** Concepts: elements to co-highlight. */
  related: ElementId[];
  stub?: Stub;
  /** A stub to a folded ghost: the elements it stands for, to pick from (see `GhostTargetList`). */
  targets?: GhostTarget[];
  derived?: DerivedEdge;
}

function anchorRow(anchor: Anchor): AnchorRow {
  const row: AnchorRow = {
    role: anchor.role,
    file: anchor.file,
    where: describeAnchor(anchor),
    status: anchor.resolved?.status ?? "unresolved",
  };
  if (anchor.resolved && anchor.resolved.range.startLine > 0) {
    row.startLine = anchor.resolved.range.startLine;
    row.endLine = anchor.resolved.range.endLine;
  }
  return row;
}

/** Stored anchors as rows; an element without any shows where its structural fallback points. */
function rowsFor(
  anchors: readonly Anchor[],
  id: ElementId,
  model: ExplainerModel,
  vd: ViewDerived,
) {
  if (anchors.length > 0) return anchors.map(anchorRow);
  return codeFocus([id], model, { derivedEdges: vd.edgeMap }).map<AnchorRow>((focus) => ({
    role: focus.role,
    file: focus.file,
    where: focus.file,
    startLine: focus.range.startLine,
    endLine: focus.range.endLine,
    status: focus.status,
  }));
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

/** `llm, commit abc123; edited by you: summary` */
function describeProvenance(provenance: Provenance): string {
  const parts: string[] = [provenance.origin];
  if (provenance.commit) parts.push(`commit ${provenance.commit}`);
  const text = parts.join(", ");
  return provenance.userFields?.length
    ? `${text}; edited by you: ${provenance.userFields.join(", ")}`
    : text;
}

export function describeElement(
  id: ElementId,
  model: ExplainerModel,
  vd: ViewDerived,
): ElementInfo {
  const info = buildInfo(id, model, vd);
  if (info.provenance) {
    info.facts.push({ label: "Origin", value: describeProvenance(info.provenance) });
  }
  return info;
}

function buildInfo(id: ElementId, model: ExplainerModel, vd: ViewDerived): ElementInfo {
  const stub = vd.stubMap.get(id);
  if (stub) {
    const folded = isFoldedGhostKey(stub.ghost);
    const inside = model.label(stub.inside);
    const outside = stub.ghostLabel;
    const things = plural(stub.targets.length, "element");
    return {
      id,
      type: "stub",
      title: `${stub.kinds.join(", ")} ×${stub.count}`,
      kind: "stub",
      where: `${stub.direction === "out" ? "leaves" : "enters"} the view here`,
      summary: folded
        ? stub.direction === "out"
          ? `${inside} reaches ${outside} (${things} not in this view). Pick one below to add it, or click the dashed box to choose there.`
          : `${outside} (${things} not in this view) reaches ${inside}. Pick one below to add it, or click the dashed box to choose there.`
        : stub.direction === "out"
          ? `${inside} reaches ${outside}, which is not in this view. Click the dashed box to add it.`
          : `${outside}, which is not in this view, reaches ${inside}. Click the dashed box to add it.`,
      facts: [
        { label: "Inside", value: inside },
        { label: "Outside", value: outside },
        ...(folded ? [{ label: "Elements", value: String(stub.targets.length) }] : []),
        { label: "Direction", value: stub.direction },
        { label: "References", value: String(stub.count) },
      ],
      anchors: [],
      related: [],
      stub,
      ...(folded ? { targets: stub.targets } : {}),
    };
  }

  const ref = model.element(id);
  if (!ref) {
    return { id, type: "unknown", title: id, kind: "unknown", facts: [], anchors: [], related: [] };
  }

  switch (ref.type) {
    case "node": {
      const node = ref.node;
      const facts: ElementInfo["facts"] = [];
      let where: string | undefined;
      const parsed = id.startsWith("sym:") ? model.index.symbol(id.slice(4)) : undefined;
      if (parsed) {
        where = parsed.file;
        facts.push({ label: "Lines", value: `${parsed.range.startLine}–${parsed.range.endLine}` });
      } else if (node.kind === "file" || node.kind === "dir") {
        where = id.slice(id.indexOf(":") + 1);
      } else if (node.kind === "group") {
        facts.push({
          label: "Members",
          value: model
            .members(id)
            .map((m) => model.label(m))
            .join(", "),
        });
      }
      const nested = node.kind === "group" ? 0 : model.children(id).length;
      if (nested > 0) facts.push({ label: "Contains", value: `${nested} nested elements` });
      const info: ElementInfo = {
        id,
        type: "node",
        title: node.label,
        kind: node.symbolKind ?? node.kind,
        facts,
        anchors: rowsFor(node.anchors, id, model, vd),
        related: [],
        provenance: node.provenance,
      };
      if (where) info.where = where;
      if (node.summary) info.summary = node.summary;
      if (node.detail) info.detail = node.detail;
      return info;
    }
    case "edge": {
      const edge = ref.edge;
      const derived = vd.edgeMap.get(id);
      const info: ElementInfo = {
        id,
        type: "edge",
        title: edge.label || edge.kind,
        kind: edge.kind,
        where: `${model.label(edge.from)} → ${model.label(edge.to)}`,
        facts: [
          { label: "From", value: model.label(edge.from) },
          { label: "To", value: model.label(edge.to) },
        ],
        anchors: rowsFor(edge.anchors, id, model, vd),
        related: [],
        provenance: edge.provenance,
      };
      if (derived) info.derived = derived;
      if (edge.summary) info.summary = edge.summary;
      if (edge.detail) info.detail = edge.detail;
      return info;
    }
    case "derived-edge": {
      const derived = vd.edgeMap.get(id);
      const info: ElementInfo = {
        id,
        type: "derived-edge",
        title: derived ? `${derived.kind} ×${derived.count}` : ref.kind,
        kind: ref.kind,
        where: `${model.label(ref.from)} → ${model.label(ref.to)}`,
        summary: derived
          ? `${plural(derived.count, "reference")} from ${model.label(ref.from)} to ${model.label(ref.to)}, found by static analysis${derived.resolution === "heuristic" ? " (heuristic resolution: treat as a hint)" : ""}.`
          : `Static ${ref.kind} edge.`,
        facts: [
          { label: "From", value: model.label(ref.from) },
          { label: "To", value: model.label(ref.to) },
          ...(derived
            ? [
                { label: "References", value: String(derived.count) },
                { label: "Resolution", value: derived.resolution },
              ]
            : []),
        ],
        anchors: derived ? derived.anchors.map(anchorRow) : rowsFor([], id, model, vd),
        related: [],
        provenance: { origin: "static" },
      };
      if (derived) info.derived = derived;
      return info;
    }
    case "concept": {
      const concept = ref.concept;
      const info: ElementInfo = {
        id,
        type: "concept",
        title: concept.label,
        kind: "concept",
        facts: [],
        anchors: rowsFor(concept.anchors, id, model, vd),
        related: [...(concept.related ?? [])],
        provenance: concept.provenance,
      };
      if (concept.summary) info.summary = concept.summary;
      if (concept.detail) info.detail = concept.detail;
      return info;
    }
    case "step": {
      const step = ref.step;
      const info: ElementInfo = {
        id,
        type: "step",
        title: step.label,
        kind: `${step.kind} step`,
        where: `${model.label(step.from)} → ${model.label(step.to)}`,
        facts: [
          { label: "From", value: model.label(step.from) },
          { label: "To", value: model.label(step.to) },
          { label: "Sequence", value: ref.view.title },
        ],
        anchors: rowsFor(step.anchors, id, model, vd),
        related: [],
        provenance: ref.view.provenance,
      };
      if (step.summary) info.summary = step.summary;
      return info;
    }
  }
}
