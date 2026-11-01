/**
 * Tracing a box on a map: what it leads to (down the arrows) or what leads to it (up), as far as the map's own
 * arrows go. Only the arrows the map draws count: a stub to a box outside the view is not followed.
 */
import type { DerivedEdge, DerivedGraph } from "@xpl/core";
import { describe, expect, it } from "vitest";
import { reachOf } from "../src/derive.js";

const edge = (from: string, to: string): DerivedEdge => ({
  id: `e:${from}-${to}`,
  from,
  to,
  kind: "calls",
  count: 1,
  resolution: "precise",
  stored: false,
  anchors: [],
});

// main -> runner -> queue, runner -> worker -> bus, metrics -> bus, worker -> runner (a cycle)
const graph: DerivedGraph = {
  nodes: ["main", "runner", "queue", "worker", "bus", "metrics"].map((id) => ({
    id,
    label: id,
    kind: "file" as const,
    container: false,
  })),
  edges: [
    edge("main", "runner"),
    edge("runner", "queue"),
    edge("runner", "worker"),
    edge("worker", "bus"),
    edge("metrics", "bus"),
    edge("worker", "runner"),
  ],
  stubs: [
    {
      id: "stub:out:worker->ghost:x",
      from: "worker",
      to: "x",
      ghost: "x",
      direction: "out",
      kinds: ["calls"],
      count: 1,
      resolution: "precise",
    } as never,
  ],
  ghosts: [],
};

const sorted = (set: ReadonlySet<string>) => [...set].sort();

describe("reachOf", () => {
  it("follows the arrows down, through a cycle once, with the arrows it takes", () => {
    expect(sorted(reachOf(graph, "runner", "down"))).toEqual([
      "bus",
      "e:runner-queue",
      "e:runner-worker",
      "e:worker-bus",
      "e:worker-runner",
      "queue",
      "runner",
      "worker",
    ]);
  });

  it("follows them up to what leads to the box", () => {
    expect(sorted(reachOf(graph, "bus", "up"))).toEqual([
      "bus",
      "e:main-runner",
      "e:metrics-bus",
      "e:runner-worker",
      "e:worker-bus",
      "e:worker-runner",
      "main",
      "metrics",
      "runner",
      "worker",
    ]);
  });

  it("is the box alone when no arrow leaves it that way", () => {
    expect(sorted(reachOf(graph, "main", "up"))).toEqual(["main"]);
  });
});
