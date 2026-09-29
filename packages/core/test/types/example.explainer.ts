import type { Explainer } from "../../src/schema.js";

/**
 * A small job runner. Shows: a group node, an explained symbol with a user-edited summary,
 * an llm edge static analysis can't see (event bus), a concept, a whole-repo graph view,
 * a question-driven sequence view with a retry loop, and a two-step tour.
 * Structural nodes and static edges (e.g. runner → queue calls) are NOT stored; the viewer
 * derives them from the index.
 */
export const example = {
  schema: "code-explainer@0",
  title: "Job runner",
  repo: { name: "acme/jobrunner", commit: "a1b2c3d" },
  index: { path: ".explainer/index-a1b2c3d.json", commit: "a1b2c3d" },

  nodes: [
    {
      id: "grp:scheduling",
      kind: "group",
      parent: "repo",
      label: "Scheduling",
      summary: "Decides which job runs next and hands it to a free worker.",
      members: ["file:src/runner.ts", "file:src/queue.ts"],
      anchors: [],
      provenance: { origin: "llm", commit: "a1b2c3d" },
    },
    {
      id: "sym:src/runner.ts#Runner.dispatch",
      kind: "symbol",
      parent: "file:src/runner.ts",
      label: "Runner.dispatch",
      summary: "The hot loop: pop, lease a worker, run, ack or requeue.",
      anchors: [
        {
          file: "src/runner.ts",
          symbol: "Runner.dispatch",
          role: "definition",
          hash: "sha256:3f1a9c",
          resolved: {
            commit: "a1b2c3d",
            range: { startLine: 42, endLine: 88 },
            status: "ok",
          },
        },
      ],
      provenance: { origin: "llm", userFields: ["summary"], commit: "a1b2c3d" },
    },
  ],

  edges: [
    {
      id: "edge:job-completed",
      from: "file:src/worker.ts",
      to: "file:src/metrics.ts",
      kind: "emits",
      label: "job.completed",
      summary: "Worker publishes on the event bus; metrics subscribes. Invisible to the call graph.",
      anchors: [
        { file: "src/worker.ts", symbol: "Worker.run", span: { from: 21, to: 21 }, role: "call-site", hash: "sha256:77c0de" },
        { file: "src/metrics.ts", symbol: "onJobCompleted", role: "definition", hash: "sha256:b41d02" },
      ],
      provenance: { origin: "llm", commit: "a1b2c3d" },
    },
  ],

  concepts: [
    {
      id: "concept:retry-policy",
      label: "Retry policy",
      summary: "Failed jobs are requeued with exponential backoff up to maxRetries, then dead-lettered.",
      anchors: [
        { file: "src/runner.ts", symbol: "Runner.dispatch", span: { from: 30, to: 41 }, role: "definition", hash: "sha256:9e0f11" },
        { file: "config/default.yaml", span: { from: 12, to: 15 }, role: "config", hash: "sha256:c3aa70" },
        { file: "test/retry.test.ts", role: "test", hash: "sha256:5d6e8f" },
      ],
      related: ["sym:src/runner.ts#Runner.dispatch", "file:src/queue.ts"],
      provenance: { origin: "user" },
    },
  ],

  views: [
    {
      id: "view:overview",
      type: "graph",
      title: "Overview",
      scope: { root: "repo", depth: 1 },
      include: ["grp:scheduling", "file:src/worker.ts", "file:src/metrics.ts"],
      provenance: { origin: "llm", commit: "a1b2c3d" },
    },
    {
      id: "view:dispatch",
      type: "sequence",
      title: "How a job is dispatched",
      scope: {
        root: "repo",
        depth: 3,
        question: "How does a job get from the queue to a worker?",
        entryPoints: ["src/runner.ts#Runner.dispatch"],
      },
      participants: [
        "sym:src/runner.ts#Runner.dispatch",
        "file:src/queue.ts",
        "file:src/worker.ts",
      ],
      steps: [
        {
          id: "dispatch:1",
          from: "sym:src/runner.ts#Runner.dispatch",
          to: "file:src/queue.ts",
          label: "pop()",
          kind: "call",
          anchors: [
            { file: "src/runner.ts", symbol: "Runner.dispatch", span: { from: 4, to: 4 }, role: "call-site", hash: "sha256:0a1b2c" },
            { file: "src/queue.ts", symbol: "Queue.pop", role: "definition", hash: "sha256:3d4e5f" },
          ],
        },
        {
          id: "dispatch:2",
          from: "sym:src/runner.ts#Runner.dispatch",
          to: "file:src/worker.ts",
          label: "run(job)",
          kind: "call",
          anchors: [
            { file: "src/runner.ts", symbol: "Runner.dispatch", span: { from: 18, to: 19 }, role: "call-site", hash: "sha256:6a7b8c" },
            { file: "src/worker.ts", symbol: "Worker.run", role: "definition", hash: "sha256:9d0e1f" },
          ],
        },
        {
          id: "dispatch:3",
          from: "sym:src/runner.ts#Runner.dispatch",
          to: "file:src/queue.ts",
          label: "requeue(job, backoff)",
          kind: "call",
          anchors: [
            { file: "src/runner.ts", symbol: "Runner.dispatch", span: { from: 34, to: 36 }, role: "call-site", hash: "sha256:2a3b4c" },
            { file: "src/queue.ts", symbol: "Queue.requeue", role: "definition", hash: "sha256:5d6e7f" },
          ],
        },
      ],
      frames: [
        { id: "frame:retry", kind: "loop", label: "until success or maxRetries", fromStep: "dispatch:2", toStep: "dispatch:3" },
      ],
      provenance: { origin: "llm", commit: "a1b2c3d" },
    },
  ],

  tours: [
    {
      id: "tour:intro",
      title: "Intro talk",
      steps: [
        {
          id: "t1",
          view: "view:overview",
          focus: ["grp:scheduling"],
          note: "Big picture first: scheduling is two files.",
        },
        {
          id: "t2",
          view: "view:dispatch",
          focus: ["dispatch:3", "concept:retry-policy"],
          note: "Where failures go: requeue with backoff.",
          editor: { primary: "src/runner.ts" },
        },
      ],
    },
  ],
} satisfies Explainer;
