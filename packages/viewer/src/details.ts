/**
 * What the details panel shows for an element: one shape for nodes, edges (stored and derived), concepts,
 * sequence steps and stubs, built from the model and the derived graph of the current view.
 */
import {
  codeFocus,
  describeAnchor,
  isBaseAnchor,
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
import { isHolds, kindCount } from "./drawnEdges.js";
import { trustWords } from "./readerWords.js";

export interface AnchorRow {
  role: AnchorRole;
  file: string;
  /** A base anchor (`at: "base"`): its lines are lines of the code before the change. */
  base?: boolean;
  /** `src/runner.ts#Runner.dispatch +34..36`. */
  where: string;
  /** The symbol the anchor names (`Runner.dispatch`), for a reader's "in Runner.dispatch". */
  symbol?: string;
  /** Resolved lines, when the anchor has been resolved. */
  startLine?: number;
  endLine?: number;
  status: AnchorStatus | "unresolved";
}

export interface ElementInfo {
  id: ElementId;
  type: "node" | "edge" | "derived-edge" | "concept" | "step" | "stub" | "transition" | "unknown";
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
    ...(anchor.symbol ? { symbol: anchor.symbol } : {}),
    status: anchor.resolved?.status ?? "unresolved",
    ...(isBaseAnchor(anchor) ? { base: true } : {}),
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

/** What a derived arrow counts, in the word of its label ("calls ×3": 3 calls); other kinds count references. */
const COUNT_NOUN: Record<string, string> = { calls: "call", imports: "import" };
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
  const transition = vd.transitionMap.get(id);
  if (transition) {
    const endpoints = [transition.from, ...(transition.to ? [transition.to] : [])];
    return {
      id,
      type: "transition",
      title: transition.label ?? "Flow relationship",
      kind: transition.kind ?? "flow relationship",
      where: `${model.label(transition.from)} → ${transition.to ? model.label(transition.to) : "caller"}`,
      summary: `${vd.view?.type === "sequence" ? "Sequence order" : "Authored relationship"}. The source shows checked endpoint code; this link has no separate source anchor.`,
      facts: [
        { label: "From", value: model.label(transition.from) },
        { label: "To", value: transition.to ? model.label(transition.to) : "caller" },
      ],
      anchors: endpoints.flatMap((endpoint) => {
        const ref = model.element(endpoint);
        return ref?.type === "step" ? rowsFor(ref.step.anchors, endpoint, model, vd) : [];
      }),
      related: endpoints,
    };
  }
  const stub = vd.stubMap.get(id);
  if (stub) {
    const folded = isFoldedGhostKey(stub.ghost);
    const inside = model.label(stub.inside);
    const outside = stub.ghostLabel;
    const things = plural(stub.targets.length, "element");
    return {
      id,
      type: "stub",
      title: `${stub.kinds.join(" & ")} ×${stub.count}`,
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
      if (node.tech) facts.unshift({ label: "Technology", value: node.tech });
      const nested = node.kind === "group" ? 0 : model.children(id).length;
      if (nested > 0)
        facts.push({ label: "Inside it", value: `${nested} ${nested === 1 ? "part" : "parts"}` });
      // a field: named with its type ("Queue.ready"), and the type it holds
      const field = node.kindWord === "field";
      if (field) {
        const memberType = vd.graph?.nodes.find((n) => n.id === id)?.memberType;
        if (memberType) facts.unshift({ label: "Type", value: memberType });
        if (node.parent) facts.unshift({ label: "In", value: model.label(node.parent) });
      }
      const info: ElementInfo = {
        id,
        type: "node",
        title: field ? fieldName(id, model) : node.label,
        // an architecture box is what it is ("database"), not the kind of code it groups
        kind: node.role ?? node.kindWord ?? node.symbolKind ?? node.kind,
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
      const via = Array.isArray(edge.via) ? edge.via.filter((end) => model.hasNode(end)) : [];
      const info: ElementInfo = {
        id,
        type: "edge",
        title: edge.label || edge.kind,
        kind: edge.kind,
        where: [edge.from, ...via, edge.to].map((end) => model.label(end)).join(" → "),
        facts:
          edge.from === edge.to
            ? []
            : [
                { label: "From", value: model.label(edge.from) },
                // what the arrow passes through without a box of its own
                ...(via.length > 0
                  ? [{ label: "Through", value: via.map((end) => model.label(end)).join(", ") }]
                  : []),
                { label: "To", value: model.label(edge.to) },
              ],
        // (an edge via code with no anchors of its own: its code focus is the references of its hops)
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
      // a field's arrow on a data map (core labels it "holds"): "Queue.ready holds Job", one field, no count
      const holds = derived !== undefined && isHolds(derived);
      const from = holds ? fieldName(ref.from, model) : model.label(ref.from);
      const to = model.label(ref.to);
      // a type's place in a hierarchy (extends, implements; Go's embeds) is said once, not counted as
      // references: "queue.Queue implements JobQueue"
      const verb =
        derived && !holds && (ref.kind === "extends" || ref.kind === "implements")
          ? (derived.label ?? ref.kind)
          : undefined;
      const trust = derived && trustWords(derived.resolution);
      const info: ElementInfo = {
        id,
        type: "derived-edge",
        title: holds
          ? `${from} holds ${to}`
          : verb
            ? `${from} ${verb} ${to}`
            : derived
              ? (derived.label ?? kindCount(derived.kind, derived.count))
              : ref.kind,
        kind: holds ? "holds" : (verb ?? ref.kind),
        where: `${from} → ${to}`,
        summary: holds
          ? `The field ${from} holds a value of type ${to}, found in the code${trust ? ` (${trust})` : ""}.`
          : verb
            ? `${from} ${verb} ${to}, found in the code${trust ? ` (${trust})` : ""}.`
            : derived
              ? `${plural(derived.count, COUNT_NOUN[derived.kind] ?? "reference")} from ${from} to ${to}, found in the code${trust ? ` (${trust})` : ""}.`
              : `An arrow found in the code (${ref.kind}).`,
        facts: [
          { label: "From", value: from },
          { label: "To", value: to },
          ...(derived
            ? [
                ...(holds || verb ? [] : [{ label: "References", value: String(derived.count) }]),
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
        // A step inside one part is not a call to itself: "inside X", never "X → X".
        where:
          step.from === step.to
            ? `inside ${model.label(step.from)}`
            : `${model.label(step.from)} → ${model.label(step.to)}`,
        // "From X To X" says nothing the "inside X" line does not.
        facts: [
          ...(step.from === step.to
            ? []
            : [
                { label: "From", value: model.label(step.from) },
                { label: "To", value: model.label(step.to) },
              ]),
          { label: ref.view.type === "flow" ? "Flow" : "Sequence", value: ref.view.title },
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

/** A field named with the type that owns it ("Queue.ready"); any other element by its label. */
function fieldName(id: ElementId, model: ExplainerModel): string {
  const node = model.node(id);
  const owner =
    node?.parent !== undefined && node.parent !== null ? model.node(node.parent) : undefined;
  return owner?.kind === "symbol" ? `${owner.label}.${node!.label}` : model.label(id);
}
