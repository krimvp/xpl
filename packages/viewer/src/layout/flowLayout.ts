import ELKModule, { type ElkNode } from "elkjs/lib/elk.bundled.js";
import type { ProcessFlow } from "@xpl/core";

const ELK = ((ELKModule as unknown as { default?: unknown }).default ?? ELKModule) as new () => {
  layout(graph: ElkNode): Promise<ElkNode>;
};
const elk = new ELK();

export function layoutFlow(flow: ProcessFlow): Promise<ElkNode> {
  return elk.layout({
    id: "process",
    layoutOptions: {
      "elk.algorithm": "layered",
      "elk.direction": "DOWN",
      "elk.edgeRouting": "ORTHOGONAL",
      "elk.spacing.nodeNode": "70",
      "elk.layered.spacing.nodeNodeBetweenLayers": "85",
      "elk.padding": "[top=30,left=30,bottom=30,right=30]",
    },
    children: flow.stages.map(({ step, shape }) => ({
      id: step.id,
      width: shape === "decision" ? 340 : 290,
      height: shape === "decision" ? 160 : 108,
    })),
    edges: flow.transitions.map((edge) => ({
      id: edge.id,
      sources: [edge.from],
      targets: [edge.to],
      ...(edge.label
        ? {
            labels: [
              { text: edge.label, width: Math.min(300, edge.label.length * 8 + 20), height: 24 },
            ],
          }
        : {}),
    })),
  });
}

/**
 * The laid-out boxes of a flow, each with its stage. ELK answers after the render that asked for it: a
 * node the flow does not have (from the layout of another view, still on screen while the new one is
 * computed) is skipped, never drawn from a missing stage.
 */
export function placedStages(
  flow: ProcessFlow,
  layout: ElkNode,
): { node: ElkNode; stage: ProcessFlow["stages"][number] }[] {
  const stages = new Map(flow.stages.map((stage) => [stage.step.id, stage] as const));
  return (layout.children ?? []).flatMap((node) => {
    const stage = stages.get(node.id);
    return stage ? [{ node, stage }] : [];
  });
}
