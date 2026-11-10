/**
 * The texts of a diagram as its boxes and arrows draw them: a draft's `TODO: <what to write>` shows what the
 * index found, marked (`shortText` in core: "worker (TODO)", an arrow "TODO"), so the structure reads before
 * anyone writes the text. The details of the selected element (`details.ts`, read from the model) keep the
 * whole instruction. A written text is returned as it is, so a finished guide draws exactly as before.
 */
import { shortText, type DerivedGraph, type SequenceView } from "@xpl/core";

/** The graph with its box, arrow, ghost and via labels short. */
export function shortGraph(graph: DerivedGraph): DerivedGraph {
  return {
    ...graph,
    nodes: graph.nodes.map((node) => ({ ...node, label: shortText(node.label) })),
    edges: graph.edges.map((edge) => ({
      ...edge,
      ...(edge.label !== undefined ? { label: shortText(edge.label) } : {}),
      ...(edge.via ? { via: edge.via.map((v) => ({ ...v, label: shortText(v.label) })) } : {}),
    })),
    stubs: graph.stubs.map((stub) => ({ ...stub, ghostLabel: shortText(stub.ghostLabel) })),
    ghosts: graph.ghosts.map((ghost) => ({ ...ghost, label: shortText(ghost.label) })),
  };
}

/** A flow or sequence with its step, transition, frame and arm labels short. */
export function shortFlow<V extends Pick<SequenceView, "steps" | "frames">>(view: V): V {
  return {
    ...view,
    steps: view.steps.map((step) => ({
      ...step,
      label: shortText(step.label),
      ...(step.next
        ? {
            next: step.next.map((link) =>
              link.label !== undefined ? { ...link, label: shortText(link.label) } : link,
            ),
          }
        : {}),
    })),
    ...(view.frames
      ? {
          frames: view.frames.map((frame) => ({
            ...frame,
            label: shortText(frame.label),
            ...(frame.arms
              ? { arms: frame.arms.map((arm) => ({ ...arm, label: shortText(arm.label) })) }
              : {}),
          })),
        }
      : {}),
  };
}
