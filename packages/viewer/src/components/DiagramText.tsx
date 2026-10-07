import { useId } from "react";
import type { DerivedGraph, ProcessFlow } from "@xpl/core";
import type { SequenceLayout } from "../layout/sequenceLayout.js";
import { drawnEdges } from "../drawnEdges.js";
import { useStore, useViewerState } from "../hooks.js";

type Props = { graph: DerivedGraph } | { sequence: SequenceLayout } | { flow: ProcessFlow };

/** The same visible elements as the diagram, with native lists and source-linked buttons. */
export function DiagramText(props: Props) {
  const store = useStore();
  const trustId = useId();
  const state = useViewerState();
  const selected = new Set(state.selection);
  const model = state.model;
  let nodes: { id: string; label: string }[];
  let relationships: { id: string; select: string; label: string; trust: string }[];
  let heading: string;
  if ("graph" in props) {
    const { graph } = props;
    heading = "Nodes";
    nodes = graph.nodes;
    const names = new Map(nodes.map((node) => [node.id, node.label]));
    relationships = drawnEdges(graph.edges).map((edge) => ({
      id: edge.id,
      select: edge.id,
      label: `${names.get(edge.from)} to ${names.get(edge.to)}: ${edge.label ?? `${edge.kind} ×${edge.count}`}`,
      trust: edge.resolution === "mixed" ? "mixed precise and heuristic" : edge.resolution,
    }));
    relationships.push(
      ...graph.stubs.map((stub) => ({
        id: stub.id,
        select: stub.id,
        label:
          stub.direction === "out"
            ? `${names.get(stub.inside)} to ${stub.ghostLabel} (outside this map): ${stub.kinds.join(", ")} ×${stub.count}`
            : `${stub.ghostLabel} (outside this map) to ${names.get(stub.inside)}: ${stub.kinds.join(", ")} ×${stub.count}`,
        trust: "boundary evidence; inspect the source",
      })),
    );
  } else if ("sequence" in props) {
    heading = "Participants";
    nodes = props.sequence.lifelines;
    relationships = props.sequence.rows.map(({ step }) => ({
      id: step.id,
      select: step.id,
      label: `${model.label(step.from)} to ${model.label(step.to)}: ${step.label} (${step.kind})`,
      trust: "authored sequence",
    }));
  } else {
    heading = "Stages";
    nodes = props.flow.stages.map(({ step }) => ({ id: step.id, label: step.label }));
    const names = new Map(nodes.map((node) => [node.id, node.label]));
    relationships = props.flow.transitions.map((edge) => ({
      id: edge.id,
      select: edge.from,
      label: `${names.get(edge.from)} to ${edge.to === undefined ? "caller" : names.get(edge.to)}${edge.label ? `: ${edge.label}` : ""}${edge.kind ? ` (${edge.kind})` : ""}`,
      trust: props.flow.projected ? "sequence order" : "authored flow",
    }));
  }
  return (
    <>
      <h3>{heading}</h3>
      <ul aria-label={heading}>
        {nodes.map((node) => (
          <li key={node.id}>
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
      <h3>Relationships</h3>
      {"flow" in props && <p>Choose a relationship to show its source stage's code.</p>}
      {relationships.length === 0 && <p>No relationships are shown in this view.</p>}
      <ul aria-label="Relationships">
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
