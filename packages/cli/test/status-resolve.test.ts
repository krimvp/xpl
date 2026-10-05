import { beforeAll, describe, expect, it } from "vitest";
import {
  applyStdin,
  cloneDir,
  editFile,
  indexedFixture,
  invoke,
  PATCH_PATH,
  readFile,
  readJson,
  xpl,
  xplJson,
} from "./helpers.js";

const EXPLAINER = ".explainer/demo.explainer.json";

let indexed: string;
let demo: string;

async function reindex(dir: string) {
  const result = await xpl(dir, "index", "--precise", "off");
  expect(result.code, result.err).toBe(0);
}

/** The skill's flow after the code changed: index, then resolve --write (status reads what that saved). */
async function regenerate(dir: string) {
  await reindex(dir);
  const result = await xpl(dir, "resolve", "demo", "--write");
  expect(result.code, result.err).toBe(0);
}

const REQUEUE_EDIT = (text: string) =>
  text.replace("await this.queue.requeue(", "await this.queue.requeueLater(");

it("keeps the pre-catalog status --all report for a guide with an empty title", async () => {
  const dir = await indexedFixture();
  expect((await xpl(dir, "new", "untitled", "--title", "")).code).toBe(0);
  const result = await xplJson<{ index: { commit: string }; guides: unknown[] }>(
    dir,
    "status",
    "--all",
  );
  expect(result.code).toBe(0);
  expect(result.json.guides).toEqual([
    {
      name: "untitled",
      path: ".explainer/untitled.explainer.json",
      title: "",
      attention: false,
      anchors: {
        total: 0,
        counts: { ok: 0, moved: 0, drifted: 0, missing: 0 },
        affected: [],
      },
      drifted: [],
      driftedOther: [],
      missing: [],
      broken: [],
      errors: [],
    },
  ]);
  expect((await xpl(dir, "status", "--all")).out).toBe(
    `repository guides: index ${result.json.index.commit}\nuntitled: unchanged prose; 0 moved, 0 drifted, 0 missing`,
  );
});

beforeAll(async () => {
  indexed = await indexedFixture();
  demo = cloneDir(indexed);
  expect((await xpl(demo, "new", "demo", "--title", "Job runner")).code).toBe(0);
  expect((await xpl(demo, "apply", "demo", PATCH_PATH)).code).toBe(0);
});

describe("xpl status: unexplained edges", () => {
  it("lists the ids of the static edges without a summary in the text too", async () => {
    const { out } = await xpl(demo, "status", "demo");
    expect(out).toContain(
      "edges: 2 shown; every stored edge is explained; 1 static without summary (optional): edge:calls:grp:scheduling->file:src/worker.ts",
    );
    // the same ids as --json, ready to become overlays
    const { json } = await xplJson<any>(demo, "status", "demo");
    const overview = json.views.find((v: any) => v.id === "view:overview");
    expect(overview.edges.unexplained.map((e: any) => e.id)).toEqual([
      "edge:calls:grp:scheduling->file:src/worker.ts",
    ]);
  });

  it("cuts a long list and says how many more there are", async () => {
    const dir = cloneDir(demo);
    // every file of src: many derived edges between them
    const all = [
      "file:src/bus.ts",
      "file:src/config.ts",
      "file:src/main.ts",
      "file:src/metrics.ts",
      "file:src/queue.ts",
      "file:src/runner.ts",
      "file:src/worker.ts",
    ];
    expect(
      (
        await applyStdin(dir, {
          views: [
            {
              id: "view:wide",
              type: "graph",
              title: "Wide",
              include: all,
              edgeKinds: ["calls", "imports", "references"],
            },
          ],
        })
      ).code,
    ).toBe(0);
    const { out } = await xpl(dir, "status", "demo");
    expect(out).toMatch(
      /static without summary \(optional\): (edge:\S+, ){8}\.\.\. \+\d+ more \(--json lists all\)/,
    );
  });
});

describe("xpl status: drift the user owns", () => {
  it("counts it in the total and again apart: `4 drifted (1 user-owned: ask the user)`", async () => {
    const dir = cloneDir(demo);
    // the user adds a concept of their own, anchored on the requeue call...
    const mine = await applyStdin(
      dir,
      {
        concepts: [
          {
            id: "concept:mine",
            label: "Mine",
            summary: "The user's note.",
            anchors: [
              {
                file: "src/runner.ts",
                symbol: "Runner.dispatch",
                find: "await this.queue.requeue(",
                role: "call-site",
              },
            ],
          },
        ],
      },
      "--actor",
      "user",
    );
    expect(mine.code, mine.out).toBe(0);
    // ...then the code changes under both the llm's and the user's anchors
    editFile(dir, "src/runner.ts", REQUEUE_EDIT);
    await regenerate(dir);
    const { out } = await xpl(dir, "status", "demo");
    // the dispatch overlay, retry-policy and dispatch:3 are the llm's; concept:mine is the user's
    expect(out).toMatch(
      /^to do: \d+ unexplained, 4 drifted \(1 user-owned: ask the user\), 0 missing anchors, 0 requests$/m,
    );
    const { json } = await xplJson<any>(dir, "status", "demo");
    expect(json.todo).toMatchObject({ drifted: 4, driftedUserOwned: 1 });
    expect(json.driftedOther.map((d: any) => d.elementId)).toEqual(["concept:mine"]);
  });

  it("an llm element whose anchors the user rewrote counts as user-owned too", async () => {
    const dir = cloneDir(demo);
    // the user re-anchors the retry-policy concept: `anchors` becomes one of its userFields
    const edit = await applyStdin(
      dir,
      {
        concepts: [
          {
            id: "concept:retry-policy",
            anchors: [
              {
                file: "src/runner.ts",
                symbol: "Runner.dispatch",
                find: "await this.queue.requeue(",
                role: "call-site",
              },
            ],
          },
        ],
      },
      "--actor",
      "user",
    );
    expect(edit.code, edit.out).toBe(0);
    expect(
      readJson(dir, EXPLAINER).concepts.find((c: any) => c.id === "concept:retry-policy").provenance
        .userFields,
    ).toEqual(["anchors"]);
    editFile(dir, "src/runner.ts", REQUEUE_EDIT);
    await regenerate(dir);
    const { json } = await xplJson<any>(dir, "status", "demo");
    // still an llm element in the report, but Claude cannot repair its anchors
    expect(json.drifted.map((d: any) => d.elementId)).toContain("concept:retry-policy");
    expect(json.todo).toMatchObject({ drifted: 3, driftedUserOwned: 1 });
    const { out } = await xpl(dir, "status", "demo");
    expect(out).toMatch(/, 3 drifted \(1 user-owned: ask the user\), /);
  });

  it("without user-owned drift the line reads as before", async () => {
    const clean = cloneDir(demo);
    editFile(clean, "src/runner.ts", REQUEUE_EDIT);
    await regenerate(clean);
    const { out } = await xpl(clean, "status", "demo");
    expect(out).toMatch(/^to do: \d+ unexplained, 3 drifted, 0 missing anchors, 0 requests$/m);
    expect(out).not.toContain("user-owned");
  });
});

describe("xpl status: drifted steps name their view", () => {
  it("status and resolve print `dispatch:3  (step in view:dispatch)`", async () => {
    const dir = cloneDir(demo);
    editFile(dir, "src/runner.ts", REQUEUE_EDIT);
    await regenerate(dir);
    for (const command of ["status", "resolve"]) {
      const { out } = await xpl(dir, command, "demo");
      expect(out, command).toContain("  dispatch:3  (step in view:dispatch)");
    }
    const { json } = await xplJson<any>(dir, "resolve", "demo");
    expect(json.drifted.find((d: any) => d.elementId === "dispatch:3").view).toBe("view:dispatch");
  });
});

describe("xpl status: broken references", () => {
  let dir: string;
  beforeAll(async () => {
    dir = cloneDir(demo);
    expect(
      (
        await applyStdin(dir, {
          nodes: [
            { id: "sym:src/queue.ts#Queue.pop", summary: "Takes the next job." },
            {
              id: "grp:core",
              label: "Core",
              members: ["sym:src/queue.ts#Queue.pop", "file:src/bus.ts"],
            },
          ],
          concepts: [
            {
              id: "concept:queueing",
              label: "Queueing",
              summary: "Jobs wait in the queue.",
              related: ["sym:src/queue.ts#Queue.pop"],
            },
          ],
          views: [
            {
              id: "view:parts",
              type: "graph",
              title: "Parts",
              include: ["grp:core", "sym:src/queue.ts#Queue.pop", "file:src/runner.ts"],
            },
          ],
        })
      ).code,
    ).toBe(0);
    // the pop method is deleted: an overlay, a group member, an include entry and a related id vanish
    editFile(dir, "src/queue.ts", (text) => text.replace("async pop(", "async take("));
    await regenerate(dir);
  });

  it("lists the ids that vanished from the index, with where they are used", async () => {
    const { out } = await xpl(dir, "status", "demo");
    expect(out).toMatch(
      /^to do: \d+ unexplained, \d+ drifted.*, \d+ missing anchors, 0 requests, 4 broken references$/m,
    );
    const section = out.slice(out.indexOf("broken references ("));
    expect(section).toContain("broken references (4): ids that no longer exist in the index");
    expect(section).toContain("`includeRemove` drops a stale include entry");
    for (const where of [
      "nodes[2].id [sym:src/queue.ts#Queue.pop]", // the overlay of the deleted symbol
      "nodes[3].members[0] [grp:core]",
      "concepts[1].related[0] [concept:queueing]",
      "views[2].include[1] [view:parts]",
    ]) {
      expect(section, where).toContain(where);
    }
    // each says what it could not find and offers the id form of the candidates
    expect(section).toContain('symbol "Queue.pop" not found in src/queue.ts');
    expect(section).toContain("sym:src/queue.ts#Queue.take");
  });

  it("--json has them as issues, and todo.broken counts them", async () => {
    const { json } = await xplJson<any>(dir, "status", "demo");
    expect(json.todo.broken).toBe(json.broken.length);
    expect(json.broken.length).toBe(4);
    expect(json.broken.every((i: any) => i.code === "unknown-id")).toBe(true);
    expect(json.broken.map((i: any) => i.path)).toEqual(
      expect.arrayContaining(["views[2].include[1]", "concepts[1].related[0]"]),
    );
  });

  it("a repaired explainer has none, and the to-do line does not mention them", async () => {
    const fixed = cloneDir(dir);
    const patch = {
      remove: ["sym:src/queue.ts#Queue.pop"],
      nodes: [{ id: "grp:core", members: ["file:src/bus.ts"] }],
      concepts: [{ id: "concept:queueing", related: null }],
      views: [{ id: "view:parts", type: "graph", includeRemove: ["sym:src/queue.ts#Queue.pop"] }],
    };
    const applied = await applyStdin(fixed, patch);
    expect(applied.code, applied.out).toBe(0);
    const { out } = await xpl(fixed, "status", "demo");
    expect(out).not.toContain("broken references");
    expect(out).not.toMatch(/broken reference/);
  });
});

describe("xpl status: stale derived-edge overlays", () => {
  const OVERLAY = "edge:calls:grp:scheduling->file:src/worker.ts";

  it("warns about an overlay that no graph view derives any more", async () => {
    const dir = cloneDir(demo);
    // label the derived edge, then make the view show something else at its end
    expect(
      (
        await applyStdin(dir, {
          edges: [
            {
              id: OVERLAY,
              label: "run(job)",
              summary: "The runner hands each job to the worker.",
              anchors: [
                {
                  file: "src/runner.ts",
                  symbol: "Runner.dispatch",
                  span: { from: 18, to: 19 },
                  role: "call-site",
                },
                { file: "src/worker.ts", symbol: "Worker.run", role: "definition" },
              ],
            },
          ],
        })
      ).code,
    ).toBe(0);
    const before = await xpl(dir, "status", "demo");
    expect(before.out).not.toContain("stale edge overlays");

    const moved = await applyStdin(dir, {
      views: [
        {
          id: "view:overview",
          type: "graph",
          include: ["grp:scheduling", "sym:src/worker.ts#Worker", "file:src/metrics.ts"],
        },
      ],
    });
    expect(moved.code, moved.out).toBe(0);
    const { out } = await xpl(dir, "status", "demo");
    expect(out).toContain("warning: stale edge overlays (1):");
    expect(out).toContain(`  ${OVERLAY}`);
    expect(out).toContain("Re-create them on the current ids");
    const { json } = await xplJson<any>(dir, "status", "demo");
    expect(json.staleOverlays).toEqual([OVERLAY]);
    // the current id of that edge is listed for the view, ready for a new overlay
    const overview = json.views.find((v: any) => v.id === "view:overview");
    expect(overview.edges.unexplained.map((e: any) => e.id)).toContain(
      "edge:calls:grp:scheduling->sym:src/worker.ts#Worker",
    );
  });

  it("an overlay on a hidden edge is not stale: hiding is the user's choice", async () => {
    const dir = cloneDir(demo);
    expect(
      (
        await applyStdin(dir, {
          edges: [
            {
              id: OVERLAY,
              label: "run(job)",
              anchors: [
                {
                  file: "src/runner.ts",
                  symbol: "Runner.dispatch",
                  span: { from: 18, to: 19 },
                  role: "call-site",
                },
                { file: "src/worker.ts", symbol: "Worker.run", role: "definition" },
              ],
            },
          ],
          views: [{ id: "view:overview", type: "graph", hidden: [OVERLAY] }],
        })
      ).code,
    ).toBe(0);
    const { json } = await xplJson<any>(dir, "status", "demo");
    expect(json.staleOverlays).toEqual([]);
  });

  it("an explainer without derived-edge overlays has no such section", async () => {
    const { out } = await xpl(demo, "status", "demo");
    expect(out).not.toContain("stale edge overlays");
    const { json } = await xplJson<any>(demo, "status", "demo");
    expect(json.staleOverlays).toEqual([]);
  });
});

describe("a renamed symbol: Runner.dispatch becomes Runner.run", () => {
  let dir: string;
  beforeAll(async () => {
    dir = cloneDir(demo);
    editFile(dir, "src/runner.ts", (text) => text.replace("async dispatch(", "async run("));
    await regenerate(dir);
  });

  it("resolve, validate and status all suggest Runner.run, as an id and as anchor fields", async () => {
    const both =
      'sym:src/runner.ts#Runner.run (anchor: file: "src/runner.ts", symbol: "Runner.run"';
    // the anchor of the overlay is a whole symbol: found by its size
    const resolve = await xpl(dir, "resolve", "demo");
    expect(resolve.out).toContain(`did you mean ${both})`);
    // the anchors that were spans: found by their text, with the offsets they have in Runner.run
    expect(resolve.out).toContain(
      `the anchored lines now sit in ${both}, span: {from: 34, to: 36})`,
    );
    const validate = await xpl(dir, "validate", "demo");
    expect(validate.code).toBe(1);
    expect(validate.out).toContain(both);
    // the ids that pointed at the old symbol (participants, step ends, the overlay) get the id form
    const status = await xpl(dir, "status", "demo");
    expect(status.out).toContain("broken references");
    expect(status.out).toContain("Did you mean: sym:src/runner.ts#Runner.run?");
    expect(status.out).toContain(both);
    // and it is the first candidate everywhere
    const { json } = await xplJson<any>(dir, "status", "demo");
    for (const issue of json.broken) expect(issue.message, issue.path).toContain("Runner.run");
  });

  it("the patch that follows the rename is accepted, and the same patch with the old name is not", async () => {
    const stale = await applyStdin(cloneDir(dir), {
      concepts: [
        {
          id: "concept:retry-policy",
          anchors: [
            {
              file: "src/runner.ts",
              symbol: "Runner.dispatch",
              find: "await this.queue.requeue(",
              role: "call-site",
            },
          ],
        },
      ],
    });
    expect(stale.code).toBe(1);
    expect(stale.out).toContain('symbol "Runner.dispatch" not found in src/runner.ts');
    expect(stale.out).toContain("Did you mean: sym:src/runner.ts#Runner.run (anchor: file:");
    const fixed = await applyStdin(cloneDir(dir), {
      concepts: [
        {
          id: "concept:retry-policy",
          anchors: [
            {
              file: "src/runner.ts",
              symbol: "Runner.run",
              find: "await this.queue.requeue(",
              role: "call-site",
            },
          ],
          // the concept was touched, so the ids it holds must be right too
          related: ["sym:src/runner.ts#Runner.run", "file:src/queue.ts"],
        },
      ],
    });
    expect(fixed.code, fixed.out).toBe(0);
  });
});

describe("xpl resolve --write on a stale index", () => {
  let dir: string;
  beforeAll(async () => {
    dir = cloneDir(demo);
    // the tree changes after the index was built
    editFile(dir, "src/runner.ts", (text) => `// a header line\n${text}`);
  });

  it("refuses, says to run `xpl index` first, and writes nothing", async () => {
    const before = readFile(dir, EXPLAINER);
    const { code, err, out } = await xpl(dir, "resolve", "demo", "--write");
    expect(code).toBe(1);
    expect(out).toBe("");
    expect(err).toContain("error: refusing to write .explainer/demo.explainer.json");
    expect(err).toContain("does not match the working tree");
    expect(err).toContain("1 changed (src/runner.ts)");
    expect(err).toContain("run `xpl index` first, then `xpl resolve demo --write` again");
    expect(err).toContain("--allow-stale");
    expect(readFile(dir, EXPLAINER)).toBe(before);
  });

  it("--json: the error and the stale head", async () => {
    const { code, out } = await invoke(["resolve", "demo", "--write", "--json"], { cwd: dir });
    const json = JSON.parse(out);
    expect(code).toBe(1);
    expect(json.ok).toBe(false);
    expect(json.error).toContain("run `xpl index` first");
    expect(json.stale).toContain("does not match the working tree");
  });

  it("a report without --write still works, with the usual warning", async () => {
    const { code, out, err } = await xpl(dir, "resolve", "demo");
    expect(code).toBe(0);
    expect(out).toContain("not written: pass --write");
    expect(err).toContain("warning: index");
    expect(err).toContain("does not match the working tree");
  });

  it("--allow-stale writes anyway (and still warns)", async () => {
    const copy = cloneDir(dir);
    const { code, out, err } = await xpl(copy, "resolve", "demo", "--write", "--allow-stale");
    expect(code).toBe(0);
    expect(out).toContain("written: .explainer/demo.explainer.json");
    expect(err).toContain("does not match the working tree");
  });

  it("after `xpl index` the write goes through, with no warning", async () => {
    const copy = cloneDir(dir);
    await reindex(copy);
    const { code, out, err } = await xpl(copy, "resolve", "demo", "--write");
    expect(code, err).toBe(0);
    expect(out).toContain("written: .explainer/demo.explainer.json");
    expect(err).toBe("");
    expect(readJson(copy, EXPLAINER).index.commit).toBe(
      readJson(copy, readJson(copy, EXPLAINER).index.path).commit,
    );
  });

  it("XPL_SKIP_STALE_CHECK=1 skips the check, and so the refusal", async () => {
    const copy = cloneDir(dir);
    const { code } = await invoke(["resolve", "demo", "--write"], {
      cwd: copy,
      env: { XPL_SKIP_STALE_CHECK: "1" },
    });
    expect(code).toBe(0);
  });

  it("`xpl resolve --help` documents the refusal and the override", async () => {
    const { out } = await invoke(["resolve", "--help"]);
    expect(out).toContain("--allow-stale");
    expect(out).toContain("refuses (exit 1)");
  });
});
