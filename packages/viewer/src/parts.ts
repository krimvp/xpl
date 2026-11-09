/**
 * The parts of a diagram in words, in reading order (components/PartsPanel.tsx, "On this map"): each box with
 * what it is for, the arrows its author named, or the numbered steps of a flow or a sequence. Every row is an
 * element of the diagram (its id), so a click shows its code and a caret in that code marks the row.
 */
import {
  processFlow,
  type DerivedGraph,
  type ElementId,
  type ExplainerModel,
  type GraphView,
  type SequenceView,
} from "@xpl/core";
import { drawnEdges } from "./drawnEdges.js";
import { ROLE_WORDS } from "./layout/graphLayout.js";
import { readerBadge } from "./readerWords.js";

export interface BoxPart {
  id: ElementId;
  label: string;
  /** What it is, in a word or two ("file", "database", "Python 3"): none for a plain group or folder. */
  kind?: string;
  /** The first sentence of its summary. */
  summary?: string;
  /**
   * The boxes of this map it uses, and the ones that use it, by name (its drawn arrows; code outside the map
   * does not count).
   */
  uses: string[];
  usedBy: string[];
  /** 0 for a box on the map itself, 1 for a box drawn inside it, and so on. */
  depth: number;
}

export interface ArrowPart {
  id: ElementId;
  from: string;
  to: string;
  label: string;
  summary?: string;
}

export interface MapParts {
  boxes: BoxPart[];
  /** The named arrows (an author's label), in the order of the boxes they leave. */
  arrows: ArrowPart[];
  /** How many places outside the map link to it (its ghost boxes). */
  outside: number;
}

export interface StepPart {
  id: ElementId;
  /** The step's number: its place in the view, as the diagram and the text view number it. */
  number: number;
  label: string;
  summary?: string;
  /** Who does it and to whom (a sequence's arrow, a flow step's actor when it has another end). */
  from?: string;
  to?: string;
}

/** The first sentence of a text (all of it when it has one sentence), without trailing space. */
export function firstSentence(text: string | undefined): string | undefined {
  const trimmed = text?.trim();
  if (!trimmed) return undefined;
  const match = /^[\s\S]*?[.!?](?=\s+[A-Z`"'(]|$)/.exec(trimmed);
  return match ? match[0] : trimmed;
}

/** "uses worker.ts", "used by main.ts and test", "uses 3 boxes": the links of a box on its map, in words. */
export function linkWords(verb: string, names: readonly string[]): string | undefined {
  if (names.length === 0) return undefined;
  if (names.length <= 2) return `${verb} ${names.join(" and ")}`;
  return `${verb} ${names.length} boxes here`;
}

export function mapParts(graph: DerivedGraph, view: GraphView, model: ExplainerModel): MapParts {
  const order = new Map<string, number>();
  (Array.isArray(view.include) ? view.include : []).forEach((id, i) => order.set(id, i));
  const byId = new Map(graph.nodes.map((node) => [node.id, node]));
  const children = new Map<string | undefined, typeof graph.nodes>();
  for (const node of graph.nodes) {
    const parent = node.parent !== undefined && byId.has(node.parent) ? node.parent : undefined;
    const list = children.get(parent);
    if (list) list.push(node);
    else children.set(parent, [node]);
  }
  const rank = (id: string) => order.get(id) ?? Number.MAX_SAFE_INTEGER;
  const edges = drawnEdges(graph.edges.filter((edge) => byId.has(edge.from) && byId.has(edge.to)));
  const boxes: BoxPart[] = [];
  const walk = (parent: string | undefined, depth: number) => {
    const list = [...(children.get(parent) ?? [])].sort(
      (a, b) => rank(a.id) - rank(b.id) || a.label.localeCompare(b.label),
    );
    for (const node of list) {
      const inside = children.get(node.id)?.length ?? 0;
      // (a file is said by the box's own badge; a group says how many files it holds)
      const badge = readerBadge(node.symbolKind ?? node.kind);
      const kind =
        node.role !== undefined
          ? (node.tech ?? ROLE_WORDS[node.role])
          : node.kind === "group"
            ? inside > 0
              ? `group of ${inside}`
              : undefined
            : badge === "file"
              ? undefined
              : badge;
      const summary = firstSentence(node.summary ?? model.node(node.id)?.summary);
      boxes.push({
        id: node.id,
        label: node.label,
        ...(kind ? { kind } : {}),
        ...(summary ? { summary } : {}),
        uses: [
          ...new Set(edges.filter((e) => e.from === node.id && e.to !== node.id).map((e) => e.to)),
        ].map((id) => byId.get(id)!.label),
        usedBy: [
          ...new Set(
            edges.filter((e) => e.to === node.id && e.from !== node.id).map((e) => e.from),
          ),
        ].map((id) => byId.get(id)!.label),
        depth,
      });
      walk(node.id, depth + 1);
    }
  };
  walk(undefined, 0);
  const place = new Map(boxes.map((box, i) => [box.id, i]));
  const arrows = edges
    .filter((edge) => edge.stored && edge.label)
    .sort((a, b) => (place.get(a.from) ?? 0) - (place.get(b.from) ?? 0))
    .map((edge) => {
      const summary = firstSentence(edge.summary);
      return {
        id: edge.id,
        from: byId.get(edge.from)!.label,
        to: byId.get(edge.to)!.label,
        label: edge.label!,
        ...(summary ? { summary } : {}),
      };
    });
  return { boxes, arrows, outside: graph.ghosts?.length ?? 0 };
}

/** The steps of a flow or a sequence, numbered as the diagram numbers them. */
export function stepParts(view: SequenceView, model: ExplainerModel): StepPart[] {
  if (view.type === "flow")
    return processFlow(view).stages.map(({ step }, i) => part(step, i, model, false));
  return (Array.isArray(view.steps) ? view.steps : []).map((step, i) => part(step, i, model, true));
}

function part(
  step: SequenceView["steps"][number],
  index: number,
  model: ExplainerModel,
  ends: boolean,
): StepPart {
  const summary = firstSentence(step.summary);
  return {
    id: step.id,
    number: index + 1,
    label: step.label,
    ...(summary ? { summary } : {}),
    ...(ends && step.from ? { from: model.label(step.from) } : {}),
    ...(ends && step.to ? { to: model.label(step.to) } : {}),
  };
}
