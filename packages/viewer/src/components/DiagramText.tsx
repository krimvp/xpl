import { useId } from "react";
import type { DerivedGraph, ProcessFlow } from "@xpl/core";
import { readingOrder, type SequenceLayout } from "../layout/sequenceLayout.js";
import { drawnEdges } from "../drawnEdges.js";
import { useStore, useViewerState } from "../hooks.js";
import { boxOrder } from "../matrix.js";
import { mapEdgeSource } from "../readerWords.js";

type Props =
  | { graph: DerivedGraph; order?: readonly string[] | undefined }
  | { sequence: SequenceLayout }
  | { flow: ProcessFlow };

/**
 * What the diagram draws, as lists: each box and arrow is a button that shows its code. A sequence lists its
 * steps in reading order with its frames and their arms among them (V4-08); a data map nests each table's
 * fields under it, in code order, and names a field's arrow "Queue.ready holds Job" (V4-14).
 */
export function DiagramText(props: Props) {
  const store = useStore();
  const trustId = useId();
  const state = useViewerState();
  const selected = new Set(state.selection);
  const model = state.model;
  let nodes: { id: string; label: string; depth?: number }[];
  let relationships: { id: string; select: string; label: string; trust: string }[];
  let heading: string;
  if ("graph" in props) {
    const { graph } = props;
    heading = "Boxes";
    // in the map's reading order (the parts list's and the matrix's), a box's insides under it (N17); a
    // table's fields in code order, each with its type
    const byId = new Map(graph.nodes.map((node) => [node.id, node]));
    const depthOf = (id: string): number => {
      const parent = byId.get(id)?.parent;
      return parent !== undefined && byId.has(parent) ? depthOf(parent) + 1 : 0;
    };
    nodes = boxOrder(graph, props.order).map((id) => {
      const node = byId.get(id)!;
      const label = node.memberType ? `${node.label}: ${node.memberType}` : node.label;
      return { id, label, depth: depthOf(id) };
    });
    const names = new Map(graph.nodes.map((node) => [node.id, node.label]));
    // a field is named with its table: "Queue.ready"
    const nameOf = (id: string) => {
      const node = byId.get(id);
      const table = node?.row !== undefined && node.parent ? byId.get(node.parent) : undefined;
      return table ? `${table.label}.${node!.label}` : names.get(id);
    };
    relationships = drawnEdges(graph.edges).map((edge) => ({
      id: edge.id,
      select: edge.id,
      label:
        edge.label === "holds" && edge.kind === "references"
          ? `${nameOf(edge.from)} holds ${nameOf(edge.to)}`
          : `${nameOf(edge.from)} to ${nameOf(edge.to)}: ${edge.label ?? `${edge.kind} ×${edge.count}`}`,
      trust: mapEdgeSource(edge),
    }));
    relationships.push(
      ...graph.stubs.map((stub) => ({
        id: stub.id,
        select: stub.id,
        label:
          stub.direction === "out"
            ? `${names.get(stub.inside)} to ${stub.ghostLabel} (outside this map): ${stub.kinds.join(" & ")} ×${stub.count}`
            : `${stub.ghostLabel} (outside this map) to ${names.get(stub.inside)}: ${stub.kinds.join(" & ")} ×${stub.count}`,
        trust: "outside this map",
      })),
    );
  } else if ("sequence" in props) {
    return <SequenceText layout={props.sequence} />;
  } else {
    heading = "Steps";
    nodes = props.flow.stages.map(({ step }) => ({ id: step.id, label: step.label }));
    const names = new Map(nodes.map((node) => [node.id, node.label]));
    relationships = props.flow.transitions.map((edge) => ({
      id: edge.id,
      select: edge.id,
      label: `${names.get(edge.from)} to ${edge.to === undefined ? "caller" : names.get(edge.to)}${edge.label ? `: ${edge.label}` : ""}${edge.kind ? ` (${edge.kind})` : ""}`,
      trust: props.flow.projected ? "in the order of the sequence" : "drawn by the author",
    }));
  }
  return (
    <>
      <h3>{heading}</h3>
      <ul aria-label={heading}>
        {nodes.map((node) => (
          <li key={node.id} style={node.depth ? { marginLeft: `${node.depth * 14}px` } : undefined}>
            <button
              type="button"
              aria-pressed={selected.has(node.id)}
              onClick={() => store.click(node.id)}
            >
              {node.label}
            </button>
          </li>
        ))}
      </ul>
      <h3>Arrows</h3>
      {"flow" in props && <p>Click an arrow to see the code at both of its ends.</p>}
      {relationships.length === 0 && <p>This diagram has no arrows.</p>}
      <ul aria-label="Arrows">
        {relationships.map((edge, index) => (
          <li key={edge.id}>
            <button
              type="button"
              aria-pressed={selected.has(edge.select)}
              aria-describedby={`${trustId}-${index}`}
              onClick={() => store.click(edge.select)}
            >
              {edge.label}
            </button>
            <span id={`${trustId}-${index}`} className="diagram-text-trust">
              {edge.trust}
            </span>
          </li>
        ))}
      </ul>
      {"graph" in props && props.graph.ghosts.length > 0 && (
        <>
          <h3>Outside this map</h3>
          <ul aria-label="Outside this map">
            {props.graph.ghosts.map((ghost) => (
              <li key={ghost.id}>
                {ghost.label}
                <ul>
                  {ghost.targets.map((target) => (
                    <li key={target.target}>
                      <button
                        type="button"
                        onClick={() => store.expandStub({ ghost: target.target })}
                      >
                        Add {model.label(target.target)} to the map
                      </button>
                    </li>
                  ))}
                </ul>
              </li>
            ))}
          </ul>
        </>
      )}
    </>
  );
}

const KIND_WORDS = { call: "", return: " (answer)", async: " (sent, no wait)" } as const;

/** A sequence as text: its participants, then its steps top to bottom, each frame and arm where it starts. */
function SequenceText({ layout }: { layout: SequenceLayout }) {
  const store = useStore();
  const state = useViewerState();
  const model = state.model;
  const selected = new Set(state.selection);
  const number = new Map(layout.rows.map((row, i) => [row.step.id, i + 1]));
  const span = (steps: readonly string[]) => {
    const [first, last] = [number.get(steps[0]!), number.get(steps[steps.length - 1]!)];
    return steps.length === 1 ? `step ${first}` : `steps ${first} to ${last}`;
  };
  const items = readingOrder(layout).map((item) => {
    if (item.kind === "step") {
      const { step, depth } = item.row;
      return {
        key: step.id,
        depth,
        ids: [step.id],
        text: `${item.row.index + 1}. ${model.label(step.from)} to ${model.label(step.to)}: ${step.label}${KIND_WORDS[step.kind] ?? ""}`,
      };
    }
    const { frame, depth } = item.box;
    if (item.kind === "frame") {
      const name = item.box.arms.length > 0 ? frame.label : `[${frame.label}]`;
      return {
        key: frame.id,
        depth: depth,
        ids: item.box.steps,
        text: `${frame.kind} ${name}: ${span(item.box.steps)}`,
      };
    }
    return {
      key: `${frame.id}:${item.n}`,
      depth: depth + 1,
      ids: item.arm.steps,
      text: `[${item.arm.label}]: ${span(item.arm.steps)}`,
    };
  });
  return (
    <>
      <h3>Participants</h3>
      <ul aria-label="Participants">
        {layout.lifelines.map((lifeline) => (
          <li key={lifeline.id}>
            <button
              type="button"
              aria-pressed={selected.has(lifeline.id)}
              onClick={() => store.click(lifeline.id)}
            >
              {lifeline.label}
            </button>
          </li>
        ))}
      </ul>
      <h3>Steps</h3>
      {items.length === 0 && <p>This diagram has no steps.</p>}
      <ul aria-label="Steps">
        {items.map((item) => (
          <li
            key={item.key}
            style={item.depth > 0 ? { marginLeft: `${item.depth * 14}px` } : undefined}
          >
            <button
              type="button"
              aria-pressed={item.ids.length > 0 && item.ids.every((id) => selected.has(id))}
              onClick={() =>
                item.ids.length === 1 ? store.click(item.ids[0]!) : store.select(item.ids)
              }
            >
              {item.text}
            </button>
          </li>
        ))}
      </ul>
    </>
  );
}
