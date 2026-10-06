import { beforeAll, expect, it, vi } from "vitest";
import { existsSync, mkdirSync, readFileSync, symlinkSync, promises as filesystem } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { artifactIdentity, type Explainer } from "@xpl/core";
import { appendRequest, importRequests, readRequests } from "../src/requests.js";
import {
  applyStdin,
  cloneDir,
  fullIndex,
  git,
  indexedFixture,
  editFile,
  invoke,
  makeTempDir,
  readJson,
  writeFile,
  xpl,
  xplJson,
} from "./helpers.js";

const proposal = join(dirname(fileURLToPath(import.meta.url)), "fixtures/revision-proposal.json");
let demo: string;
beforeAll(async () => {
  demo = await indexedFixture();
  expect((await xpl(demo, "new", "demo", "--title", "Dispatch guide")).code).toBe(0);
  const initial = await applyStdin(demo, {
    nodes: [
      {
        id: "sym:src/runner.ts#Runner.dispatch",
        summary: "Dispatch runs a queued job.",
        anchors: [{ file: "src/runner.ts", symbol: "Runner.dispatch", role: "definition" }],
      },
      { id: "file:src/queue.ts", summary: "Queue holds pending jobs." },
    ],
    views: [
      {
        id: "view:dispatch",
        type: "graph",
        title: "Dispatch",
        scope: { root: "repo", depth: 1 },
        edgeKinds: [],
        stubs: { mode: "none" },
        include: ["sym:src/runner.ts#Runner.dispatch", "file:src/queue.ts"],
      },
    ],
  });
  expect(initial.code, initial.out + initial.err).toBe(0);
  expect(
    (
      await applyStdin(
        demo,
        {
          nodes: [{ id: "sym:src/runner.ts#Runner.dispatch", label: "My dispatch label" }],
        },
        "--actor",
        "user",
      )
    ).code,
  ).toBe(0);
  expect((await xpl(demo, "ready", "demo")).code).toBe(0);
});

async function reviewed(root: string) {
  await feedback(root, "correct-runner", "sym:src/runner.ts#Runner.dispatch");
  const selection = await xplJson(root, "revise", "demo", "--select", "correct-runner");
  expect(selection.code, selection.out).toBe(0);
  const run = selection.json.runId;
  const recorded = JSON.parse(readFileSync(proposal, "utf8")).slice(0, 1);
  const file = writeFile(makeTempDir(), "proposal.json", JSON.stringify(recorded));
  expect((await xpl(root, "revise", "demo", "--run", run, "--proposal", file)).code).toBe(0);
  const choices = writeFile(
    makeTempDir(),
    "decisions.json",
    JSON.stringify([{ id: "correct-runner", status: "addressed", reason: "Checked source." }]),
  );
  expect((await xpl(root, "revise", "demo", "--run", run, "--decisions", choices)).code).toBe(0);
  return run;
}

async function flowGuide() {
  const root = cloneDir(demo);
  const initial = await applyStdin(root, {
    views: [
      {
        id: "view:flow",
        type: "flow",
        title: "Dispatch flow",
        participants: ["sym:src/runner.ts#Runner.dispatch", "file:src/queue.ts"],
        steps: ["flow:1", "flow:2"].map((id) => ({
          id,
          from: "sym:src/runner.ts#Runner.dispatch",
          to: "file:src/queue.ts",
          kind: "call",
          label: "Take the next job",
          summary: "The runner takes a queued job.",
          anchors: [{ file: "src/runner.ts", symbol: "Runner.dispatch", role: "definition" }],
        })),
      },
    ],
    tours: [
      {
        id: "tour:reader",
        title: "Reading dispatch",
        summary: "Follow dispatch from a queued job to execution.",
        steps: ["flow:1", "sym:src/runner.ts#Runner.dispatch"].map((id) => ({
          id,
          view: "view:flow",
          focus: ["flow:1"],
          note: "The runner takes a queued job.",
        })),
      },
      {
        id: "tour:other",
        title: "Another reading",
        summary: "Compare a separate reading of dispatch.",
        steps: [
          {
            id: "tour:reader/flow:1",
            view: "view:flow",
            focus: ["flow:1"],
            note: "Keep this other reading.",
          },
        ],
      },
    ],
  });
  expect(initial.code, initial.out + initial.err).toBe(0);
  return root;
}

it.each([
  { selected: "flow:1", target: "flow:2", container: "view:flow", allowed: false },
  { selected: "flow:1", target: "flow:1", container: "view:flow", allowed: true },
  { selected: "view:flow", target: "flow:2", container: "view:flow", allowed: true },
  {
    selected: "sym:src/runner.ts#Runner.dispatch",
    target: "flow:2",
    container: "view:flow",
    include: "view:flow/flow:2",
    allowed: true,
  },
  { selected: "flow:1", target: "flow:1", container: "tour:reader", allowed: false },
  {
    selected: "sym:src/runner.ts#Runner.dispatch",
    target: "sym:src/runner.ts#Runner.dispatch",
    container: "tour:reader",
    allowed: false,
  },
  {
    selected: "flow:1",
    target: "flow:1",
    container: "tour:reader",
    include: "tour:reader/flow:1",
    allowed: true,
  },
  {
    selected: "flow:1",
    target: "tour:reader/flow:1",
    container: "tour:other",
    include: "tour:reader/flow:1",
    allowed: false,
  },
])(
  "bounds viewer feedback on $selected when changing $container/$target ($include)",
  async ({ selected, target, container, include, allowed }) => {
    const root = await flowGuide();
    const before = readJson<Explainer>(root, ".explainer/demo.explainer.json");
    const at = "2026-10-04T12:00:00.000Z";
    // The viewer records its open view even when the reader selects just one step.
    await importRequests(root, [
      {
        id: "viewer-request",
        kind: "correct",
        elementId: selected,
        at,
        context: artifactIdentity(before, fullIndex(root)),
        note: "Clarify which job the runner takes.",
        view: "view:flow",
        label:
          selected === "view:flow"
            ? "Dispatch flow"
            : selected.startsWith("sym:")
              ? "My dispatch label"
              : "Take the next job",
        range: { file: "src/runner.ts", fromLine: 20, toLine: 25, side: "head" },
        outcome: {
          revision: 0,
          status: "pending",
          reason: "Awaiting an explicit revision pass.",
          at,
        },
      },
    ]);
    const selection = await xplJson(
      root,
      "revise",
      "demo",
      "--select",
      "viewer-request",
      ...(include ? ["--include", include] : []),
    );
    expect(selection.code, selection.out).toBe(0);
    const run = selection.json.runId;
    const proposed = writeFile(
      makeTempDir(),
      "proposal.json",
      JSON.stringify([
        {
          id: "viewer-request",
          patch: {
            ...(container.startsWith("tour:")
              ? {
                  tours: [
                    {
                      id: container,
                      stepsUpdate: [{ id: target, note: "Read only the selected tour step." }],
                    },
                  ],
                }
              : {
                  views: [
                    {
                      id: "view:flow",
                      type: "flow",
                      ...(selected === "view:flow" ? { title: "Taking the oldest job" } : {}),
                      stepsUpdate: [
                        { id: target, summary: "The runner takes the oldest queued job." },
                      ],
                    },
                  ],
                }),
          },
        },
      ]),
    );
    const review = await xplJson(root, "revise", "demo", "--run", run, "--proposal", proposed);
    expect(review.code, review.out).toBe(allowed ? 0 : 1);
    if (!allowed) {
      expect(review.json.error).toContain(`changes ${container} outside its selected scope`);
      expect(readJson(root, ".explainer/demo.explainer.json")).toEqual(before);
      expect(readRequests(root).requests[0]!.outcome.status).toBe("pending");
      return;
    }
    const decisions = writeFile(
      makeTempDir(),
      "decisions.json",
      JSON.stringify([
        { id: "viewer-request", status: "addressed", reason: "Checked the selected explanation." },
      ]),
    );
    expect((await xpl(root, "revise", "demo", "--run", run, "--decisions", decisions)).code).toBe(
      0,
    );
    const accepted = await xplJson(root, "revise", "demo", "--run", run, "--accept");
    expect(accepted.code, accepted.out).toBe(0);
    const next = readJson<Explainer>(root, ".explainer/demo.explainer.json");
    const flow = next.views.find((v) => v.id === "view:flow")!;
    expect(flow.type).toBe("flow");
    if (flow.type !== "flow") throw new Error("Expected a flow view");
    expect(flow.steps.map((step) => [step.id, step.summary])).toEqual([
      [
        "flow:1",
        container === "view:flow" && target === "flow:1"
          ? "The runner takes the oldest queued job."
          : "The runner takes a queued job.",
      ],
      [
        "flow:2",
        container === "view:flow" && target === "flow:2"
          ? "The runner takes the oldest queued job."
          : "The runner takes a queued job.",
      ],
    ]);
    expect(flow.title).toBe(selected === "view:flow" ? "Taking the oldest job" : "Dispatch flow");
    expect(
      next.tours.map((tour) => [tour.id, tour.steps.map((step) => [step.id, step.note])]),
    ).toEqual([
      [
        "tour:reader",
        [
          [
            "flow:1",
            container === "tour:reader"
              ? "Read only the selected tour step."
              : "The runner takes a queued job.",
          ],
          ["sym:src/runner.ts#Runner.dispatch", "The runner takes a queued job."],
        ],
      ],
      ["tour:other", [["tour:reader/flow:1", "Keep this other reading."]]],
    ]);
  },
);

it("refuses a raw step removal when an earlier proposal moved that ID to another view", async () => {
  const root = await flowGuide();
  const initial = await applyStdin(root, {
    remove: ["tour:reader", "tour:other"],
    views: [
      {
        id: "view:other",
        type: "flow",
        title: "Another dispatch flow",
        participants: ["sym:src/runner.ts#Runner.dispatch", "file:src/queue.ts"],
        steps: [],
      },
    ],
  });
  expect(initial.code, initial.out + initial.err).toBe(0);
  const before = readJson<Explainer>(root, ".explainer/demo.explainer.json");
  const flow = before.views.find((v) => v.id === "view:flow")!;
  if (flow.type !== "flow") throw new Error("Expected a flow view");
  await feedback(root, "move-step", "view:other");
  const stepRequest = (await feedback(root, "remove-step", "flow:1")).request;
  // Normal viewer context qualifies flow:1 in its original owner at selection.
  await importRequests(root, [{ ...stepRequest, id: "viewer-remove-step", view: "view:flow" }]);
  const selection = await xplJson(
    root,
    "revise",
    "demo",
    "--select",
    "move-step,viewer-remove-step",
    "--include",
    "view:flow,flow:2",
  );
  expect(selection.code, selection.out).toBe(0);
  const ownRemoval = writeFile(
    makeTempDir(),
    "own-removal.json",
    JSON.stringify([{ id: "viewer-remove-step", patch: { remove: ["flow:2"] } }]),
  );
  const permitted = await xplJson(
    root,
    "revise",
    "demo",
    "--run",
    selection.json.runId,
    "--proposal",
    ownRemoval,
  );
  expect(permitted.code, permitted.out).toBe(0);
  expect(
    permitted.json.changes.find((c: any) => c.id === "view:flow").after.steps.map((s: any) => s.id),
  ).toEqual(["flow:1"]);
  const proposals = [
    {
      id: "move-step",
      patch: {
        views: [
          { id: "view:flow", type: "flow", steps: [flow.steps[1]] },
          { id: "view:other", type: "flow", steps: [flow.steps[0]] },
        ],
      },
    },
    { id: "viewer-remove-step", patch: { remove: ["flow:1"] } },
  ];
  const file = writeFile(makeTempDir(), "proposal.json", JSON.stringify(proposals));
  // Establish that the preceding move is independently valid before asserting the refusal.
  const moveOnly = writeFile(makeTempDir(), "move.json", JSON.stringify(proposals.slice(0, 1)));
  const moved = await xplJson(
    root,
    "revise",
    "demo",
    "--run",
    selection.json.runId,
    "--proposal",
    moveOnly,
  );
  expect(moved.code, moved.out).toBe(0);
  const refused = await xplJson(
    root,
    "revise",
    "demo",
    "--run",
    selection.json.runId,
    "--proposal",
    file,
  );
  expect(refused.code, refused.out).toBe(1);
  expect(refused.json.error).toMatch(/changes flow:1 outside its selected scope/);
  expect(readJson(root, ".explainer/demo.explainer.json")).toEqual(before);
  expect(readRequests(root).requests.map((r) => r.outcome.status)).toEqual([
    "pending",
    "pending",
    "pending",
  ]);
});

it("previews dependent proposals in order and accepts only a valid chosen batch", async () => {
  const root = await flowGuide();
  const before = readJson<Explainer>(root, ".explainer/demo.explainer.json");
  const flow = before.views.find((v) => v.id === "view:flow")!;
  if (flow.type !== "flow") throw new Error("Expected a flow view");
  await feedback(root, "add-step", flow.id);
  await feedback(root, "explain-step", flow.id);
  const selection = await xplJson(root, "revise", "demo", "--select", "add-step,explain-step");
  expect(selection.code, selection.out).toBe(0);
  const revise = (...args: string[]) =>
    xplJson(root, "revise", "demo", "--run", selection.json.runId, ...args);
  const batch = writeFile(
    makeTempDir(),
    "proposal.json",
    JSON.stringify([
      {
        id: "add-step",
        patch: {
          views: [
            {
              id: flow.id,
              type: "flow",
              steps: [
                ...flow.steps,
                { ...flow.steps[0], id: "flow:3", summary: "Take a queued job." },
              ],
            },
          ],
        },
      },
      {
        id: "explain-step",
        patch: {
          views: [
            {
              id: flow.id,
              type: "flow",
              stepsUpdate: [{ id: "flow:3", summary: "The queue supplies the next pending job." }],
            },
          ],
        },
      },
    ]),
  );
  const proposed = await revise("--proposal", batch);
  expect(proposed.code, proposed.out).toBe(0);
  expect(proposed.json.readiness.ready).toBe(true);
  expect(proposed.json.proposals.map((p: any) => [p.id, p.changes.map((c: any) => c.id)])).toEqual([
    ["add-step", ["view:flow"]],
    ["explain-step", ["view:flow"]],
  ]);
  expect(proposed.json.proposals[0].changes[0].before.steps.map((s: any) => s.id)).toEqual([
    "flow:1",
    "flow:2",
  ]);
  expect(proposed.json.proposals[0].changes[0].after.steps.map((s: any) => s.id)).toEqual([
    "flow:1",
    "flow:2",
    "flow:3",
  ]);
  expect(proposed.json.proposals[1].changes[0].before.steps[2].summary).toBe("Take a queued job.");
  expect(proposed.json.proposals[1].changes[0].after.steps[2].summary).toBe(
    "The queue supplies the next pending job.",
  );
  const choices = writeFile(
    makeTempDir(),
    "decisions.json",
    JSON.stringify([
      { id: "add-step", status: "rejected", reason: "Do not add this step." },
      { id: "explain-step", status: "addressed", reason: "Explain it." },
    ]),
  );
  const invalid = await revise("--decisions", choices);
  expect(invalid.code).toBe(1);
  expect(invalid.json.issues.map((i: any) => [i.code, i.message])).toEqual([
    ["unknown-id", "step flow:3 is not a step of view:flow (its steps: flow:1, flow:2)"],
  ]);
  writeFile(
    root,
    ".explainer/choices.json",
    JSON.stringify([
      { id: "add-step", status: "addressed", reason: "Add the step." },
      { id: "explain-step", status: "addressed", reason: "Explain it." },
    ]),
  );
  const reviewed = await revise("--decisions", ".explainer/choices.json");
  expect(reviewed.code, reviewed.out).toBe(0);
  expect((await revise("--accept")).code).toBe(0);
  const after = readJson<Explainer>(root, ".explainer/demo.explainer.json").views.find(
    (v) => v.id === flow.id,
  )!;
  if (after.type !== "flow") throw new Error("Expected a flow view");
  expect(after.steps.map((s) => [s.id, s.summary])).toEqual([
    ["flow:1", "The runner takes a queued job."],
    ["flow:2", "The runner takes a queued job."],
    ["flow:3", "The queue supplies the next pending job."],
  ]);
});

it("retains the exact reviewed source and diff after acceptance and later source edits", async () => {
  const root = cloneDir(demo);
  const run = await reviewed(root);
  const review = await xplJson(root, "revise", "demo", "--run", run);
  expect((await xpl(root, "revise", "demo", "--run", run, "--accept")).code).toBe(0);
  editFile(
    root,
    "src/runner.ts",
    (text) => text + "\n// Later source, outside the accepted snapshot.\n",
  );
  const history = await xplJson(root, "revise", "demo", "--run", run);
  expect(history.code, history.out).toBe(0);
  expect(history.json.state).toBe("done");
  expect(history.json.changes).toEqual(review.json.changes);
  expect(history.json.source).toEqual(review.json.source);
});

it("prints skipped user-field warnings and readiness repair findings in plain reviews", async () => {
  const root = cloneDir(demo);
  await feedback(root, "correct-runner", "sym:src/runner.ts#Runner.dispatch");
  const selection = await xplJson(root, "revise", "demo", "--select", "correct-runner");
  expect(selection.code, selection.out).toBe(0);
  const recorded = JSON.parse(readFileSync(proposal, "utf8")).slice(0, 1);
  recorded[0].patch.nodes[0].summary = "TODO: explain how dispatch runs a job.";
  const file = writeFile(makeTempDir(), "proposal.json", JSON.stringify(recorded));
  const review = await xpl(
    root,
    "revise",
    "demo",
    "--run",
    selection.json.runId,
    "--proposal",
    file,
  );
  expect(review.code, review.out + review.err).toBe(0);
  expect
    .soft(review.out)
    .toContain(
      "warning nodes[0].label [sym:src/runner.ts#Runner.dispatch]: label of sym:src/runner.ts#Runner.dispatch was edited by the user and is kept as it is",
    );
  expect.soft(review.out).toContain("Not ready (workspace): 1 errors, 0 warnings.");
  expect
    .soft(review.out)
    .toContain(
      "error sym:src/runner.ts#Runner.dispatch.summary (todo-left): 1 TODO placeholder left: text nobody has written yet write what the TODO asks for, check it against the code, and remove the TODO",
    );
});

it("refuses a journal directory alias into source before writing generated artifacts", async () => {
  const root = cloneDir(demo);
  await feedback(root, "correct-runner", "sym:src/runner.ts#Runner.dispatch");
  mkdirSync(join(root, "generated-review"));
  symlinkSync(join(root, "generated-review"), join(root, ".explainer", "revisions"), "dir");
  const selection = await xplJson(root, "revise", "demo", "--select", "correct-runner");
  expect(selection.code, selection.out).toBe(1);
  expect(selection.json.error).toMatch(/aliases repository directory generated-review/);
  expect(await filesystem.readdir(join(root, "generated-review"))).toEqual([]);
  expect(readRequests(root).requests[0]!.outcome.status).toBe("pending");
});

it.each(["artifact", "source", "added-file"])(
  "refuses a changed %s after review, even with freshness skipping enabled",
  async (changed) => {
    const root = cloneDir(demo);
    const run = await reviewed(root);
    const requests = readRequests(root).requests;
    if (changed === "artifact") {
      expect(
        (
          await applyStdin(
            root,
            { nodes: [{ id: "file:src/queue.ts", summary: "Author's newer queue text." }] },
            "--actor",
            "user",
          )
        ).code,
      ).toBe(0);
    } else if (changed === "source") editFile(root, "src/runner.ts", (text) => "\n" + text);
    else writeFile(root, "src/added.ts", "export const added = 1;\n");
    const beforeAcceptance = readJson(root, ".explainer/demo.explainer.json");
    const refused = await invoke(["revise", "demo", "--run", run, "--accept", "--json"], {
      cwd: root,
      env: { XPL_SKIP_STALE_CHECK: "1" },
    });
    expect(refused.code, refused.out).toBe(1);
    expect(JSON.parse(refused.out).error).toMatch(
      /changed since review|does not match the working tree/,
    );
    expect(readJson(root, ".explainer/demo.explainer.json")).toEqual(beforeAcceptance);
    expect(readRequests(root).requests).toEqual(requests);
  },
);

it("accepts a source-location-only move with an empty patch and byte-identical prose", async () => {
  const root = cloneDir(demo);
  const before = readJson<Explainer>(root, ".explainer/demo.explainer.json");
  await feedback(root, "move", "sym:src/runner.ts#Runner.dispatch");
  editFile(root, "src/runner.ts", (text) => "\n\n" + text);
  expect((await xpl(root, "index", "--precise", "off")).code).toBe(0);
  const selection = await xplJson(root, "revise", "demo", "--select", "move");
  expect(selection.code, selection.out).toBe(0);
  expect(selection.json.resolve.counts).toMatchObject({ moved: 1, drifted: 0, missing: 0 });
  const run = selection.json.runId;
  const patch = writeFile(makeTempDir(), "move.json", JSON.stringify([{ id: "move", patch: {} }]));
  expect((await xpl(root, "revise", "demo", "--run", run, "--proposal", patch)).code).toBe(0);
  const decisions = (reconciliation?: string) =>
    writeFile(
      makeTempDir(),
      "decisions.json",
      JSON.stringify([
        {
          id: "move",
          status: "addressed",
          reason: "Same code moved two lines.",
          ...(reconciliation ? { reconciliation } : {}),
        },
      ]),
    );
  const unreconciled = await xplJson(
    root,
    "revise",
    "demo",
    "--run",
    run,
    "--decisions",
    decisions(),
  );
  expect(unreconciled.code).toBe(1);
  expect(unreconciled.json.error).toMatch(/outdated context/);
  expect(
    (
      await xpl(
        root,
        "revise",
        "demo",
        "--run",
        run,
        "--decisions",
        decisions("Only blank lines were added; the anchor text is identical."),
      )
    ).code,
  ).toBe(0);
  expect((await xpl(root, "revise", "demo", "--run", run, "--accept")).code).toBe(0);
  const next = readJson<Explainer>(root, ".explainer/demo.explainer.json");
  expect(next.nodes.map((n) => [n.id, n.summary, n.label, n.provenance])).toEqual(
    before.nodes.map((n) => [n.id, n.summary, n.label, n.provenance]),
  );
  expect(next.views).toEqual(before.views);
  expect(next.nodes[0]!.anchors[0]!.resolved!.range.startLine).toBe(
    before.nodes[0]!.anchors[0]!.resolved!.range.startLine + 2,
  );
  expect((await xpl(root, "ready", "demo")).code).toBe(0);
});

it.each(["artifact", "outcomes", "receipt"])(
  "recovers interruption at %s publication without applying or recording twice",
  async (boundary) => {
    const root = cloneDir(demo);
    const run = await reviewed(root);
    const before = readJson(root, ".explainer/demo.explainer.json");
    const originalRename = filesystem.rename;
    let interrupted = false;
    const rename = vi.spyOn(filesystem, "rename").mockImplementation(async (from, to) => {
      const destination = String(to);
      const content = JSON.parse(readFileSync(String(from), "utf8"));
      const stop =
        !interrupted &&
        ((boundary === "artifact" && destination.endsWith("demo.explainer.json")) ||
          (boundary === "outcomes" && destination.endsWith("requests.json")) ||
          (boundary === "receipt" && destination.endsWith("run.json") && content.state === "done"));
      if (stop) {
        if (boundary === "artifact") {
          expect(
            existsSync(join(root, ".explainer", "requests.json.lock")),
            "artifact publication also holds the selected-outcome lock",
          ).toBe(true);
        }
        interrupted = true;
        throw new Error(`Interrupted ${boundary} publication`);
      }
      return originalRename(from, to);
    });
    syncBuiltinESMExports();
    try {
      const failed = await xplJson(root, "revise", "demo", "--run", run, "--accept");
      expect(failed.code, failed.out).toBe(1);
      expect(failed.json.error).toBe(`Interrupted ${boundary} publication`);
      expect(readRequests(root).requests[0]!.outcome.revision).toBe(boundary === "receipt" ? 1 : 0);
      if (boundary === "artifact")
        expect(readJson(root, ".explainer/demo.explainer.json")).toEqual(before);
    } finally {
      rename.mockRestore();
      syncBuiltinESMExports();
    }
    const added = (await feedback(root, "during-retry", "file:src/queue.ts")).request;
    const completed = await xplJson(root, "revise", "demo", "--run", run, "--accept");
    expect(completed.code, completed.out).toBe(0);
    expect(completed.json.state).toBe("done");
    expect(readJson(root, completed.json.previousArtifact)).toEqual(before);
    const after = readJson(root, ".explainer/demo.explainer.json");
    const outcomes = readRequests(root).requests;
    expect(outcomes.map((r) => [r.id, r.outcome.status, r.outcome.revision])).toEqual([
      ["correct-runner", "addressed", 1],
      ["during-retry", "pending", 0],
    ]);
    expect(outcomes[1]).toEqual(added);
    expect((await xpl(root, "revise", "demo", "--run", run, "--accept")).code).toBe(0);
    expect(readJson(root, ".explainer/demo.explainer.json")).toEqual(after);
    expect(readRequests(root).requests).toEqual(outcomes);
  },
);

it.each(["remove", "reanchor"] as const)(
  "keeps missing anchors pending until an explicit author %s decision",
  async (action) => {
    const root = cloneDir(demo);
    const initial = await applyStdin(root, {
      concepts: [
        {
          id: "concept:ack",
          label: "Acknowledgement",
          summary: "Acknowledgement removes the in-flight job.",
          anchors: [{ file: "src/queue.ts", symbol: "Queue.ack", role: "definition" }],
        },
      ],
    });
    expect(initial.code, initial.out).toBe(0);
    await feedback(root, "missing-ack", "concept:ack");
    const before = readJson(root, ".explainer/demo.explainer.json");
    editFile(root, "src/queue.ts", (text) => text.replace("async ack(", "async complete("));
    expect((await xpl(root, "index", "--precise", "off")).code).toBe(0);
    const selection = await xplJson(root, "revise", "demo", "--select", "missing-ack");
    expect(selection.code).toBe(0);
    expect(selection.json.resolve.missing.map((m: any) => m.elementId)).toEqual(["concept:ack"]);
    const run = selection.json.runId;
    const scratch = makeTempDir();
    const noop = writeFile(
      scratch,
      "noop.json",
      JSON.stringify([{ id: "missing-ack", patch: {} }]),
    );
    const choose = (missing?: unknown[]) =>
      writeFile(
        scratch,
        "decisions.json",
        JSON.stringify([
          {
            id: "missing-ack",
            status: "addressed",
            reason: "Remove vanished evidence explicitly.",
            reconciliation: "The method was renamed; this concept is no longer source-linked.",
            ...(missing ? { missing } : {}),
          },
        ]),
      );
    expect((await xpl(root, "revise", "demo", "--run", run, "--proposal", noop)).code).toBe(0);
    const preview = await xplJson(root, "revise", "demo", "--run", run, "--decisions", choose());
    expect(preview.json.readiness.ready).toBe(false);
    const blocked = await xplJson(root, "revise", "demo", "--run", run, "--accept");
    expect(blocked.code).toBe(1);
    expect(blocked.json.error).toMatch(/not ready/);
    expect(readRequests(root).requests[0]!.outcome.status).toBe("pending");
    const remove = writeFile(
      scratch,
      "remove.json",
      JSON.stringify([
        {
          id: "missing-ack",
          patch: {
            concepts: [
              {
                id: "concept:ack",
                anchors:
                  action === "remove"
                    ? []
                    : [{ file: "src/queue.ts", symbol: "Queue.complete", role: "definition" }],
              },
            ],
          },
        },
      ]),
    );
    expect((await xpl(root, "revise", "demo", "--run", run, "--proposal", remove)).code).toBe(0);
    const implicit = await xplJson(root, "revise", "demo", "--run", run, "--decisions", choose());
    expect(implicit.code).toBe(1);
    expect(implicit.json.error).toMatch(/missing anchor.*explicitly/);
    expect(readJson(root, ".explainer/demo.explainer.json")).toEqual(before);
    const explicit = await xplJson(
      root,
      "revise",
      "demo",
      "--run",
      run,
      "--decisions",
      choose([{ id: "concept:ack", action }]),
    );
    expect(explicit.code, explicit.out).toBe(0);
    expect((await xpl(root, "revise", "demo", "--run", run, "--accept")).code).toBe(0);
    expect(readJson(root, ".explainer/demo.explainer.json").concepts[0]).toMatchObject({
      summary: "Acknowledgement removes the in-flight job.",
    });
    const repaired = readJson<Explainer>(root, ".explainer/demo.explainer.json").concepts[0]!
      .anchors;
    if (action === "remove") expect(repaired).toEqual([]);
    else
      expect(repaired.map((a) => [a.file, a.symbol, a.resolved?.status])).toEqual([
        ["src/queue.ts", "Queue.complete", "ok"],
      ]);
    expect(readRequests(root).requests[0]!.outcome).toMatchObject({
      status: "addressed",
      revision: 1,
    });
  },
);

it("shows the original base source for a renamed file in a change revision review", async () => {
  const root = cloneDir(demo);
  const originalSource = readFileSync(join(root, "src/queue.ts"), "utf8");
  git(root, "init", "-b", "main");
  git(root, "add", ".");
  git(root, "commit", "-m", "base");
  const base = git(root, "rev-parse", "HEAD");
  git(root, "mv", "src/queue.ts", "src/jobs.ts");
  git(root, "commit", "-m", "rename queue");
  expect((await xpl(root, "index", "--precise", "off")).code).toBe(0);
  expect((await xpl(root, "new", "historical", "--title", "Queue move")).code).toBe(0);
  expect((await xpl(root, "change", "historical", `${base}..HEAD`)).code).toBe(0);
  const patch = writeFile(
    makeTempDir(),
    "guide.json",
    JSON.stringify({
      nodes: [{ id: "file:src/jobs.ts", summary: "Queue holds pending jobs." }],
      concepts: [
        {
          id: "concept:before-queue",
          label: "Previous queue",
          summary: "The queue interface stayed the same when its file moved.",
          anchors: [
            { file: "src/jobs.ts", at: "base", find: "export interface Job {", role: "definition" },
          ],
        },
      ],
      views: [
        {
          id: "view:queue",
          type: "graph",
          title: "Queue file move",
          scope: { root: "repo", depth: 1 },
          include: ["file:src/jobs.ts"],
          edgeKinds: [],
          stubs: { mode: "none" },
        },
      ],
    }),
  );
  const applied = await xpl(root, "apply", "historical", patch);
  expect(applied.code, applied.out + applied.err).toBe(0);
  const ready = await xplJson(root, "ready", "historical");
  expect(ready.code, ready.out).toBe(0);
  await appendRequest(root, {
    id: "base-request",
    elementId: "concept:before-queue",
    explainer: "historical",
    kind: "explain",
    context: ready.json.identity,
    range: { file: "src/jobs.ts", fromLine: 1, toLine: 3, side: "base" },
  });
  const selected = await xplJson(root, "revise", "historical", "--select", "base-request");
  expect(selected.code, selected.out).toBe(0);
  expect(
    selected.json.source.find((s: any) => s.file === "src/jobs.ts" && s.side === "base").text,
  ).toBe(originalSource);
});

it("refuses unrelated edits and incomplete next artifacts without losing retryable feedback", async () => {
  const root = cloneDir(demo);
  await feedback(root, "correct-runner", "sym:src/runner.ts#Runner.dispatch");
  const selection = await xplJson(root, "revise", "demo", "--select", "correct-runner");
  const run = selection.json.runId;
  const before = readJson(root, ".explainer/demo.explainer.json");
  const outside = writeFile(
    makeTempDir(),
    "outside.json",
    JSON.stringify([
      {
        id: "correct-runner",
        patch: {
          nodes: [{ id: "file:src/queue.ts", summary: "Unrelated replacement." }],
        },
      },
    ]),
  );
  const rejected = await xplJson(root, "revise", "demo", "--run", run, "--proposal", outside);
  expect(rejected.code).toBe(1);
  expect(rejected.json.error).toMatch(/outside its selected scope/);
  const unfinished = writeFile(
    makeTempDir(),
    "unfinished.json",
    JSON.stringify([
      {
        id: "correct-runner",
        patch: {
          nodes: [{ id: "sym:src/runner.ts#Runner.dispatch", summary: "TODO: explain dispatch" }],
        },
      },
    ]),
  );
  expect((await xpl(root, "revise", "demo", "--run", run, "--proposal", unfinished)).code).toBe(0);
  const decisions = writeFile(
    makeTempDir(),
    "decisions.json",
    JSON.stringify([
      { id: "correct-runner", status: "addressed", reason: "Inspect completion blocker." },
    ]),
  );
  const preview = await xplJson(root, "revise", "demo", "--run", run, "--decisions", decisions);
  expect(
    preview.json.readiness.findings
      .filter((f: any) => f.severity === "error")
      .map((f: any) => f.code),
  ).toEqual(["todo-left"]);
  const refused = await xplJson(root, "revise", "demo", "--run", run, "--accept");
  expect(refused.code).toBe(1);
  expect(refused.json.error).toMatch(/not ready/);
  expect(readJson(root, ".explainer/demo.explainer.json")).toEqual(before);
  expect(readRequests(root).requests[0]!.outcome.status).toBe("pending");
});

async function feedback(root: string, id: string, elementId: string) {
  return appendRequest(root, {
    id,
    elementId,
    kind: "correct",
    explainer: "demo",
    note: "Explain this code.",
    context: artifactIdentity(
      readJson<Explainer>(root, ".explainer/demo.explainer.json"),
      fullIndex(root),
    ),
    range: { file: "src/runner.ts", fromLine: 20, toLine: 25, side: "head" },
  });
}

it("reviews recorded proposals and commits only accepted requests while retaining user edits and prior artifacts", async () => {
  const root = cloneDir(demo);
  const before = readJson<Explainer>(root, ".explainer/demo.explainer.json");
  await feedback(root, "correct-runner", "sym:src/runner.ts#Runner.dispatch");
  await feedback(root, "expand-queue", "file:src/queue.ts");
  const unselected = (await feedback(root, "unselected", "file:src/queue.ts")).request;
  const selected = await xplJson(root, "revise", "demo", "--select", "correct-runner,expand-queue");
  expect(selected.code, selected.out).toBe(0);
  const run = selected.json.runId;
  const reviewed = await xplJson(root, "revise", "demo", "--run", run, "--proposal", proposal);
  expect(reviewed.code, reviewed.out).toBe(0);
  expect(
    reviewed.json.changes.find((c: any) => c.id === "sym:src/runner.ts#Runner.dispatch"),
  ).toMatchObject({
    before: { summary: "Dispatch runs a queued job.", label: "My dispatch label" },
    after: {
      summary: "Dispatch leases a worker, runs the job and requeues failures.",
      label: "My dispatch label",
    },
  });
  expect(reviewed.json.source.find((s: any) => s.file === "src/runner.ts").text).toContain(
    "async dispatch",
  );
  expect(readJson(root, ".explainer/demo.explainer.json")).toEqual(before);
  const decisions = writeFile(
    makeTempDir(),
    "decisions.json",
    JSON.stringify([
      { id: "correct-runner", status: "addressed", reason: "Checked dispatch against source." },
      { id: "expand-queue", status: "rejected", reason: "Keep the shorter queue explanation." },
    ]),
  );
  const decisionReview = await xplJson(
    root,
    "revise",
    "demo",
    "--run",
    run,
    "--decisions",
    decisions,
  );
  expect(decisionReview.code, decisionReview.out).toBe(0);
  expect(decisionReview.json.readiness.ready).toBe(true);
  expect(readRequests(root).requests.map((r) => r.outcome.status)).toEqual([
    "pending",
    "pending",
    "pending",
  ]);
  const added = (await feedback(root, "added-during-review", "file:src/queue.ts")).request;
  const accepted = await xplJson(root, "revise", "demo", "--run", run, "--accept");
  expect(accepted.code, accepted.out).toBe(0);
  const next = readJson<Explainer>(root, ".explainer/demo.explainer.json");
  expect(next.nodes.find((n) => n.id === "sym:src/runner.ts#Runner.dispatch")).toMatchObject({
    summary: "Dispatch leases a worker, runs the job and requeues failures.",
    label: "My dispatch label",
    provenance: { userFields: ["label"] },
  });
  expect(next.nodes.find((n) => n.id === "file:src/queue.ts")).toEqual(
    before.nodes.find((n) => n.id === "file:src/queue.ts"),
  );
  expect(readJson(root, accepted.json.previousArtifact)).toEqual(before);
  const requests = readRequests(root).requests;
  expect(requests.map((r) => [r.id, r.outcome.status, r.outcome.revision])).toEqual([
    ["correct-runner", "addressed", 1],
    ["expand-queue", "rejected", 1],
    ["unselected", "pending", 0],
    ["added-during-review", "pending", 0],
  ]);
  expect(requests[2]).toEqual(unselected);
  expect(requests[3]).toEqual(added);
  expect((await xpl(root, "revise", "demo", "--run", run, "--accept")).code).toBe(0);
  expect(readRequests(root).requests).toEqual(requests);
});

it("a later accepted revision preserves author text and repaired evidence while adding unedited detail", async () => {
  const root = cloneDir(demo);
  const id = "sym:src/runner.ts#Runner.dispatch";
  expect(
    (
      await applyStdin(
        root,
        {
          nodes: [
            {
              id,
              summary: "The author checked this queue dispatch.",
              anchors: [
                {
                  file: "src/runner.ts",
                  symbol: "Runner.dispatch",
                  span: { from: 0, to: 1 },
                  role: "definition",
                },
              ],
            },
          ],
        },
        "--actor",
        "user",
      )
    ).code,
  ).toBe(0);
  const saved = readJson<Explainer>(root, ".explainer/demo.explainer.json").nodes.find(
    (n) => n.id === id,
  )!;
  await feedback(root, "repair-followup", id);
  const selected = await xplJson(root, "revise", "demo", "--select", "repair-followup");
  expect(selected.code, selected.out).toBe(0);
  const run = selected.json.runId;
  const file = writeFile(
    makeTempDir(),
    "proposal.json",
    JSON.stringify([
      {
        id: "repair-followup",
        patch: {
          nodes: [
            {
              id,
              summary: "Generated replacement.",
              anchors: [{ file: "not-present.ts", role: "usage" }],
              detail: "Dispatch also leases a worker.",
            },
          ],
        },
      },
    ]),
  );
  const preview = await xplJson(root, "revise", "demo", "--run", run, "--proposal", file);
  expect(preview.code, preview.out).toBe(0);
  const decisions = writeFile(
    makeTempDir(),
    "decisions.json",
    JSON.stringify([
      {
        id: "repair-followup",
        status: "addressed",
        reason: "Added the lease detail and kept author evidence.",
      },
    ]),
  );
  const decided = await xpl(root, "revise", "demo", "--run", run, "--decisions", decisions);
  expect(decided.code, decided.out + decided.err).toBe(0);
  const accepted = await xpl(root, "revise", "demo", "--run", run, "--accept");
  expect(accepted.code, accepted.out + accepted.err).toBe(0);
  expect(
    readJson<Explainer>(root, ".explainer/demo.explainer.json").nodes.find((n) => n.id === id),
  ).toMatchObject({
    label: "My dispatch label",
    summary: "The author checked this queue dispatch.",
    anchors: saved.anchors,
    detail: "Dispatch also leases a worker.",
    provenance: { userFields: ["label", "summary", "anchors"] },
  });
});
