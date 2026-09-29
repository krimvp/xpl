import { readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import {
  cloneDir,
  editFile,
  indexedFixture,
  invoke,
  makeTempDir,
  PATCH_PATH,
  readFile,
  readJson,
  writeFile,
  xpl,
  xplJson,
} from "./helpers.js";

let indexed: string;
let demo: string;

beforeAll(async () => {
  indexed = await indexedFixture();
  // an explainer with the handoff example applied
  demo = cloneDir(indexed);
  expect((await xpl(demo, "new", "demo", "--title", "Job runner")).code).toBe(0);
  const applied = await xpl(demo, "apply", "demo", PATCH_PATH);
  expect(applied.err).toBe("");
  expect(applied.code).toBe(0);
});

const EXPLAINER = ".explainer/demo.explainer.json";

describe("xpl new", () => {
  it("creates an empty explainer bound to the index", async () => {
    const dir = cloneDir(indexed);
    const { code, out } = await xpl(dir, "new", "job-runner");
    expect(code).toBe(0);
    expect(out).toContain("created .explainer/job-runner.explainer.json");
    expect(out).toContain('title "Job runner"');
    expect(out).toContain("xpl apply job-runner patch.json");
    const explainer = readJson(dir, ".explainer/job-runner.explainer.json");
    expect(explainer).toMatchObject({
      schema: "code-explainer@0",
      title: "Job runner",
      nodes: [],
      edges: [],
      concepts: [],
      views: [],
      tours: [],
    });
    expect(explainer.index.path).toMatch(/^\.explainer\/index-wt-[0-9a-f]{10}\.json$/);
    expect(explainer.index.commit).toBe(explainer.repo.commit);
    expect(explainer.repo.name).toBeTruthy();
  });

  it("--title sets the title; --json describes the file", async () => {
    const dir = cloneDir(indexed);
    const { code, json } = await xplJson(dir, "new", "second", "--title", "How retries work");
    expect(code).toBe(0);
    expect(json).toMatchObject({
      path: ".explainer/second.explainer.json",
      name: "second",
      title: "How retries work",
    });
    expect(readJson(dir, ".explainer/second.explainer.json").title).toBe("How retries work");
  });

  it("refuses to overwrite an existing explainer", async () => {
    const dir = cloneDir(demo);
    const before = readFile(dir, EXPLAINER);
    const { code, err } = await xpl(dir, "new", "demo");
    expect(code).toBe(1);
    expect(err).toContain("already exists");
    expect(err).toContain("not overwriting");
    expect(readFile(dir, EXPLAINER)).toBe(before);
    // the .explainer.json spelling is the same name
    expect((await xpl(dir, "new", "demo.explainer.json")).code).toBe(1);
  });

  it("rejects names that are not file-name safe", async () => {
    const dir = cloneDir(indexed);
    for (const name of ["../evil", "a/b", ".hidden", "sp ace"]) {
      const { code, err } = await xpl(dir, "new", name);
      expect(code, name).toBe(2);
      expect(err).toContain("invalid explainer name");
    }
  });

  it("needs an index and says how to build one", async () => {
    const { code, err } = await xpl(makeTempDir(), "new", "x");
    expect(code).toBe(1);
    expect(err).toContain("xpl index");
  });
});

describe("xpl apply", () => {
  it("applies the handoff example (Appendix B) and validate is clean", async () => {
    const dir = cloneDir(indexed);
    await xpl(dir, "new", "demo");
    const applied = await xpl(dir, "apply", "demo", PATCH_PATH);
    expect(applied.code).toBe(0);
    expect(applied.err).toBe("");
    expect(applied.out).toContain(
      "applied to .explainer/demo.explainer.json (actor llm): 8 ids changed",
    );
    for (const id of [
      "grp:scheduling",
      "sym:src/runner.ts#Runner.dispatch",
      "edge:job-completed",
      "concept:retry-policy",
      "view:overview",
      "view:dispatch",
      "tour:intro",
      "title", // "Demo" (the default) -> "Job runner"
    ]) {
      expect(applied.out).toContain(`  ${id}`);
    }

    const validated = await xpl(dir, "validate", "demo");
    expect(validated.code).toBe(0);
    expect(validated.out).toMatch(/^ok: .*no errors, no warnings$/);
    expect(validated.err).toBe("");

    const explainer = readJson(dir, EXPLAINER);
    expect(explainer.title).toBe("Job runner");
    expect(explainer.views.map((v: any) => v.id)).toEqual(["view:overview", "view:dispatch"]);
    // anchors got their hashes and resolved ranges from the index: dispatch:3's call site is lines 76-78
    const step = explainer.views[1].steps.find((s: any) => s.id === "dispatch:3");
    expect(step.anchors[0]).toMatchObject({
      file: "src/runner.ts",
      symbol: "Runner.dispatch",
      span: { from: 34, to: 36 },
      role: "call-site",
      resolved: { status: "ok", range: { startLine: 76, endLine: 78 } },
    });
    expect(step.anchors[0].hash).toMatch(/^sha256:[0-9a-f]{12}$/);
    // new elements are llm-owned, stamped with the index commit
    expect(explainer.concepts[0].provenance).toEqual({
      origin: "llm",
      commit: explainer.index.commit,
    });
  });

  it("applying the same patch again changes nothing", async () => {
    const dir = cloneDir(demo);
    const before = readFile(dir, EXPLAINER);
    const { code, out } = await xpl(dir, "apply", "demo", PATCH_PATH);
    expect(code).toBe(0);
    expect(out).toContain("no changes");
    expect(readFile(dir, EXPLAINER)).toBe(before);
  });

  it("rejects a bad symbol, prints the suggestion and path, and writes nothing", async () => {
    const dir = cloneDir(demo);
    const before = readFile(dir, EXPLAINER);
    const patch = {
      concepts: [
        {
          id: "concept:oops",
          label: "Oops",
          summary: "Anchors a symbol that does not exist.",
          anchors: [{ file: "src/runner.ts", symbol: "Runner.dispach", role: "definition" }],
        },
      ],
    };
    const { code, out, err } = await invoke(["apply", "demo", "-"], {
      cwd: dir,
      stdin: JSON.stringify(patch),
    });
    expect(code).toBe(1);
    expect(err).toBe("");
    expect(out).toContain(
      "rejected: 1 error, nothing was applied to .explainer/demo.explainer.json",
    );
    expect(out).toContain("concepts[0].anchors[0]");
    expect(out).toContain('symbol "Runner.dispach" not found in src/runner.ts');
    expect(out).toContain("Did you mean: src/runner.ts#Runner.dispatch?");
    expect(readFile(dir, EXPLAINER)).toBe(before);
  });

  it("--json describes a rejection as data", async () => {
    const dir = cloneDir(demo);
    const patch = { nodes: [{ id: "sym:src/queue.ts#Queue.pup", label: "x" }] };
    const { code, out } = await invoke(["apply", "demo", "-", "--json"], {
      cwd: dir,
      stdin: JSON.stringify(patch),
    });
    const json = JSON.parse(out);
    expect(code).toBe(1);
    expect(json.ok).toBe(false);
    expect(json.applied).toBe(false);
    expect(json.error).toBe("patch rejected: 1 error, nothing applied");
    expect(json.issues[0]).toMatchObject({ severity: "error", path: "nodes[0].id" });
  });

  it("--dry-run checks the patch and writes nothing", async () => {
    const dir = cloneDir(indexed);
    await xpl(dir, "new", "demo");
    const before = readFile(dir, EXPLAINER);
    const { code, out } = await xpl(dir, "apply", "demo", PATCH_PATH, "--dry-run");
    expect(code).toBe(0);
    expect(out).toContain("dry run: the patch is valid and would change 8 ids");
    expect(readFile(dir, EXPLAINER)).toBe(before);
    const bad = await invoke(["apply", "demo", "-", "--dry-run"], {
      cwd: dir,
      stdin: JSON.stringify({ edges: [{ id: "edge:x" }] }),
    });
    expect(bad.code).toBe(1);
    expect(bad.out).toContain("needs");
  });

  it("reads the patch from stdin with `-`, and explains JSON syntax errors", async () => {
    const dir = cloneDir(indexed);
    await xpl(dir, "new", "demo");
    const ok = await invoke(["apply", "demo", "-"], {
      cwd: dir,
      stdin: JSON.stringify({ title: "From stdin" }),
    });
    expect(ok.code).toBe(0);
    expect(readJson(dir, EXPLAINER).title).toBe("From stdin");

    const broken = await invoke(["apply", "demo", "-"], { cwd: dir, stdin: '{"nodes": [' });
    expect(broken.code).toBe(1);
    expect(broken.err).toContain("the patch on stdin is not valid JSON");

    writeFile(dir, "bad.json", "{ nodes: [] }");
    const file = await xpl(dir, "apply", "demo", "bad.json");
    expect(file.code).toBe(1);
    expect(file.err).toContain("patch bad.json is not valid JSON");

    const missing = await xpl(dir, "apply", "demo", "nope.json");
    expect(missing.code).toBe(1);
    expect(missing.err).toContain("cannot read patch file");
  });

  it("names the explainers that exist when the name is wrong", async () => {
    const { code, err } = await xpl(demo, "apply", "demmo", PATCH_PATH);
    expect(code).toBe(1);
    expect(err).toContain('no explainer "demmo"');
    expect(err).toContain("Existing explainers: demo");
  });

  it("finds the explainer by name, file name or path", async () => {
    for (const ref of [
      "demo",
      "demo.explainer.json",
      ".explainer/demo.explainer.json",
      join(demo, EXPLAINER),
    ]) {
      const { code } = await xpl(demo, "validate", ref);
      expect(code, ref).toBe(0);
    }
  });

  it("--actor user marks new elements as user-authored; llm patches then leave them alone", async () => {
    const dir = cloneDir(demo);
    const mine = {
      concepts: [
        {
          id: "concept:mine",
          label: "Mine",
          summary: "Written by the user.",
          anchors: [{ file: "src/queue.ts", symbol: "Queue.requeue", role: "definition" }],
        },
      ],
    };
    expect(
      (
        await invoke(["apply", "demo", "-", "--actor", "user"], {
          cwd: dir,
          stdin: JSON.stringify(mine),
        })
      ).code,
    ).toBe(0);
    const concept = readJson(dir, EXPLAINER).concepts.find((c: any) => c.id === "concept:mine");
    expect(concept.provenance.origin).toBe("user");

    const overwrite = { concepts: [{ id: "concept:mine", label: "Changed by llm" }] };
    const { code, out } = await invoke(["apply", "demo", "-"], {
      cwd: dir,
      stdin: JSON.stringify(overwrite),
    });
    expect(code).toBe(0);
    expect(out).toContain("no changes");
    expect(out).toContain("concept:mine is user-authored; an llm patch cannot modify it (skipped)");
    expect(readJson(dir, EXPLAINER).concepts.find((c: any) => c.id === "concept:mine").label).toBe(
      "Mine",
    );
    expect((await xpl(dir, "apply", "demo", PATCH_PATH, "--actor", "root")).code).toBe(2);
  });

  it("supports find anchors and remove", async () => {
    const dir = cloneDir(demo);
    const patch = {
      concepts: [
        {
          id: "concept:emit",
          label: "Emit",
          summary: "Where the event is published.",
          anchors: [
            {
              file: "src/worker.ts",
              symbol: "Worker.run",
              find: 'this.bus.emit("job.completed"',
              role: "call-site",
            },
          ],
        },
      ],
      remove: ["tour:intro"],
    };
    const { code } = await invoke(["apply", "demo", "-"], {
      cwd: dir,
      stdin: JSON.stringify(patch),
    });
    expect(code).toBe(0);
    const explainer = readJson(dir, EXPLAINER);
    expect(explainer.concepts.find((c: any) => c.id === "concept:emit").anchors[0].span).toEqual({
      from: 21,
      to: 21,
    });
    expect(explainer.tours).toEqual([]);
  });
});

describe("broken explainer files", () => {
  it("are reported with what is wrong, for every explainer command", async () => {
    const dir = cloneDir(indexed);
    writeFile(dir, ".explainer/junk.explainer.json", "{ nope");
    writeFile(dir, ".explainer/empty.explainer.json", "{}");
    writeFile(dir, ".explainer/list.explainer.json", "[1, 2]");
    for (const command of ["validate", "status", "resolve", "bundle"]) {
      const extra = command === "bundle" ? ["-o", "x.html"] : [];
      const junk = await xpl(dir, command, "junk", ...extra);
      expect(junk.code, command).toBe(1);
      expect(junk.err, command).toContain("junk.explainer.json is not valid JSON");
    }
    const list = await xpl(dir, "validate", "list");
    expect(list.code).toBe(1);
    expect(list.err).toContain("does not contain a JSON object");
    // valid JSON that is not an explainer: validate says so, apply refuses to touch it
    const empty = await xpl(dir, "validate", "empty");
    expect(empty.code).toBe(1);
    expect(empty.out).toContain('schema must be "code-explainer@0"');
    const apply = await invoke(["apply", "empty", "-"], { cwd: dir, stdin: "{}" });
    expect(apply.code).toBe(1);
    expect(apply.out).toContain("repair the file first");
    expect(readFile(dir, ".explainer/empty.explainer.json")).toBe("{}");
  });
});

describe("xpl validate", () => {
  it("--json reports errors and warnings as data", async () => {
    const { code, json } = await xplJson<any>(demo, "validate", "demo");
    expect(code).toBe(0);
    expect(json).toMatchObject({ ok: true, mode: "strict", errors: 0, warnings: 0, issues: [] });
  });

  it("fails (exit 1) on drifted anchors in strict mode, passes with warnings when --lenient", async () => {
    const dir = cloneDir(demo);
    editFile(dir, "src/runner.ts", (text) =>
      text.replace("await this.queue.requeue(", "await this.queue.requeueLater("),
    );
    expect((await xpl(dir, "index", "--precise", "off")).code).toBe(0);
    expect((await xpl(dir, "resolve", "demo", "--write")).code).toBe(0);

    const strict = await xpl(dir, "validate", "demo");
    expect(strict.code).toBe(1);
    expect(strict.out).toMatch(/\(strict, index wt-[0-9a-f]+\): [1-9]\d* errors?, 0 warnings/);
    expect(strict.out).toContain("drifted");
    expect(strict.out).toContain("anchor src/runner.ts#Runner.dispatch +34..36 drifted");

    const lenient = await xpl(dir, "validate", "demo", "--lenient");
    expect(lenient.code).toBe(0);
    expect(lenient.out).toMatch(/0 errors, [1-9]\d* warnings?/);
  });
});

describe("xpl resolve", () => {
  it("reports moved anchors after lines were inserted above the symbol, and --write saves them", async () => {
    const dir = cloneDir(demo);
    editFile(dir, "src/runner.ts", (text) =>
      text.replace(
        "  async dispatch(): Promise<void> {",
        "  // one\n  // two\n  // three\n  async dispatch(): Promise<void> {",
      ),
    );
    expect((await xpl(dir, "index", "--precise", "off")).code).toBe(0);

    const dry = await xpl(dir, "resolve", "demo");
    expect(dry.code).toBe(0);
    expect(dry.out).toMatch(/anchors: 12 \(ok 7, moved 5, drifted 0, missing 0\)/);
    expect(dry.out).toContain("not written: pass --write");
    expect(readJson(dir, EXPLAINER).views[1].steps[2].anchors[0].resolved.range).toEqual({
      startLine: 76,
      endLine: 78,
    });

    const written = await xpl(dir, "resolve", "demo", "--write");
    expect(written.code).toBe(0);
    expect(written.out).toContain("written: .explainer/demo.explainer.json");
    const explainer = readJson(dir, EXPLAINER);
    // the requeue call is now 3 lines lower; its span (relative to the symbol) did not change
    const anchor = explainer.views[1].steps[2].anchors[0];
    expect(anchor.span).toEqual({ from: 34, to: 36 });
    expect(anchor.resolved).toMatchObject({
      status: "moved",
      range: { startLine: 79, endLine: 81 },
    });
    expect(explainer.index.commit).toBe(readJson(dir, explainer.index.path).commit);
    expect(explainer.repo.commit).toBe(explainer.index.commit);

    const validated = await xpl(dir, "validate", "demo");
    expect(validated.code).toBe(0);
    expect(validated.out).toMatch(/^ok:/);
  });

  it("lists drifted llm elements with their anchor details when the code changed", async () => {
    const dir = cloneDir(demo);
    editFile(dir, "src/runner.ts", (text) =>
      text.replace("await this.queue.requeue(", "await this.queue.requeueLater("),
    );
    expect((await xpl(dir, "index", "--precise", "off")).code).toBe(0);

    const { code, out } = await xpl(dir, "resolve", "demo");
    expect(code).toBe(0);
    expect(out).toMatch(/anchors: 12 \(ok \d+, moved 0, drifted [1-9]\d*, missing 0\)/);
    expect(out).toContain("drifted llm elements to re-explain");
    // the step whose call site was edited, with the anchor as it was written
    expect(out).toContain("dispatch:3  (step)");
    expect(out).toContain(
      "views[1].steps[2].anchors[0]  src/runner.ts#Runner.dispatch +34..36 [call-site]",
    );
    expect(out).toContain("now at lines 76-78");
    // the retry concept covers that code too, and the whole-symbol overlay on dispatch
    expect(out).toContain("concept:retry-policy  (concept)");
    expect(out).toContain("sym:src/runner.ts#Runner.dispatch  (node)");
    // other anchors are fine
    expect(out).not.toContain("dispatch:1  (step)");
    expect(out).not.toContain("missing anchors");

    const json = await xplJson<any>(dir, "resolve", "demo");
    expect(json.json.counts.drifted).toBeGreaterThan(0);
    expect(json.json.drifted.map((d: any) => d.elementId)).toEqual(
      expect.arrayContaining(["dispatch:3", "concept:retry-policy"]),
    );
    expect(json.json.written).toBe(false);
  });

  it("surfaces missing anchors with the reason, and never drops them", async () => {
    const dir = cloneDir(demo);
    editFile(dir, "src/queue.ts", (text) => text.replace("async pop(", "async take("));
    expect((await xpl(dir, "index", "--precise", "off")).code).toBe(0);
    const { code, out } = await xpl(dir, "resolve", "demo", "--write");
    expect(code).toBe(0);
    expect(out).toMatch(/missing anchors \(1\): fix or drop them explicitly/);
    expect(out).toContain(
      "dispatch:1  views[1].steps[0].anchors[1]  src/queue.ts#Queue.pop [definition]",
    );
    expect(out).toContain("symbol Queue.pop is not in src/queue.ts");
    // still in the file, marked missing
    const anchor = readJson(dir, EXPLAINER).views[1].steps[0].anchors[1];
    expect(anchor.symbol).toBe("Queue.pop");
    expect(anchor.resolved.status).toBe("missing");
  });

  it("uses the newest index, not the explainer's old one", async () => {
    const dir = cloneDir(demo);
    const oldPath = readJson(dir, EXPLAINER).index.path;
    editFile(dir, "src/runner.ts", (text) => `// header\n${text}`);
    expect((await xpl(dir, "index", "--precise", "off")).code).toBe(0);
    const { json } = await xplJson<any>(dir, "resolve", "demo");
    expect(json.index.path).not.toBe(oldPath);
    expect(json.index.commit).toMatch(/^wt-/);
    expect(json.moved).toBeGreaterThan(0);
  });
});

describe("xpl status", () => {
  it("lists visible elements without a summary, per view", async () => {
    const { code, out } = await xpl(demo, "status", "demo");
    expect(code).toBe(0);
    expect(out).toMatch(
      /^\.explainer\/demo\.explainer\.json: index wt-[0-9a-f]+, 2 views, 1 concept$/m,
    );
    expect(out).toContain("view:overview (graph): Overview");
    expect(out).toContain(
      "nodes without summary (2 of 3): file:src/metrics.ts, file:src/worker.ts",
    );
    expect(out).toContain("every stored edge is explained");
    expect(out).toContain("view:dispatch (sequence): How a job is dispatched");
    expect(out).toContain("steps without summary (3 of 3): dispatch:1, dispatch:2, dispatch:3");
    expect(out).toMatch(/^to do: 7 unexplained, 0 drifted, 0 missing anchors, 0 requests$/m);
  });

  it("shrinks as summaries are added", async () => {
    const dir = cloneDir(demo);
    const patch = {
      nodes: [
        { id: "file:src/worker.ts", summary: "Runs one attempt of a job." },
        { id: "file:src/metrics.ts", summary: "Counts completed jobs." },
      ],
      views: [
        {
          id: "view:dispatch",
          type: "sequence",
          steps: (readJson(dir, EXPLAINER).views[1].steps as any[]).map((s) => ({
            ...s,
            summary: `step ${s.id}`,
          })),
        },
      ],
    };
    const applied = await invoke(["apply", "demo", "-"], {
      cwd: dir,
      stdin: JSON.stringify(patch),
    });
    expect(applied.code, applied.out).toBe(0);
    const { json } = await xplJson<any>(dir, "status", "demo");
    const overview = json.views.find((v: any) => v.id === "view:overview");
    expect(overview.nodes.unexplained).toEqual([]);
    const dispatch = json.views.find((v: any) => v.id === "view:dispatch");
    expect(dispatch.steps.unexplained).toEqual([]);
    // still to do: the two participants of the sequence view that are files without summary (queue, runner's symbol has one)
    expect(json.todo.unexplained).toBe(dispatch.nodes.unexplained.length);
  });

  it("includes drifted llm elements, missing anchors and queued requests", async () => {
    const dir = cloneDir(demo);
    editFile(dir, "src/runner.ts", (text) =>
      text.replace("await this.queue.requeue(", "await this.queue.requeueLater("),
    );
    editFile(dir, "src/queue.ts", (text) => text.replace("async pop(", "async take("));
    expect((await xpl(dir, "index", "--precise", "off")).code).toBe(0);
    expect((await xpl(dir, "resolve", "demo", "--write")).code).toBe(0);
    writeFile(
      dir,
      ".explainer/requests.json",
      JSON.stringify([
        {
          elementId: "sym:src/runner.ts#Runner.dispatch",
          note: "why a loop?",
          at: "2026-01-01T00:00:00.000Z",
          explainer: "demo",
        },
        { elementId: "file:src/bus.ts", at: "2026-01-02T00:00:00.000Z", explainer: "other" },
      ]),
    );
    const { code, out } = await xpl(dir, "status", "demo");
    expect(code).toBe(0);
    expect(out).toMatch(/to do: \d+ unexplained, [1-9]\d* drifted, 1 missing anchors, 1 request$/m);
    expect(out).toContain("drifted llm elements to re-explain");
    expect(out).toContain("missing anchors (1)");
    expect(out).toContain(
      '2026-01-01T00:00:00.000Z  sym:src/runner.ts#Runner.dispatch  "why a loop?"',
    );
    expect(out).not.toContain("file:src/bus.ts"); // meant for another explainer
    const { json } = await xplJson<any>(dir, "status", "demo");
    expect(json.requests).toHaveLength(1);
    expect(json.missing[0].elementId).toBe("dispatch:1");
    expect(json.todo).toMatchObject({ missing: 1, requests: 1 });
  });

  it("warns about an unreadable request queue instead of failing", async () => {
    const dir = cloneDir(demo);
    writeFile(dir, ".explainer/requests.json", "{ not json");
    const { code, err } = await xpl(dir, "status", "demo");
    expect(code).toBe(0);
    expect(err).toContain("is not a valid request queue");
    expect(readFileSync(join(dir, ".explainer/requests.json"), "utf8")).toBe("{ not json");
  });
});
