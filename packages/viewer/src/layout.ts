import ELK, { type ElkNode } from "elkjs/lib/elk.bundled.js";

export interface DemoLayout {
  nodes: { id: string; x: number; y: number }[];
  width: number;
  height: number;
}

const elk = new ELK();

/**
 * One tiny layered layout (a -> b -> c), only here to prove that elkjs bundles into the single
 * file and runs in the browser. `elk.bundled.js` embeds the ELK worker, so no separate file is needed.
 */
export async function layoutDemo(): Promise<DemoLayout> {
  const graph: ElkNode = {
    id: "root",
    layoutOptions: { "elk.algorithm": "layered", "elk.direction": "RIGHT" },
    children: [
      { id: "a", width: 60, height: 30 },
      { id: "b", width: 60, height: 30 },
      { id: "c", width: 60, height: 30 },
    ],
    edges: [
      { id: "a-b", sources: ["a"], targets: ["b"] },
      { id: "b-c", sources: ["b"], targets: ["c"] },
    ],
  };
  const result = await elk.layout(graph);
  return {
    nodes: (result.children ?? []).map((node) => ({ id: node.id, x: node.x ?? 0, y: node.y ?? 0 })),
    width: result.width ?? 0,
    height: result.height ?? 0,
  };
}
