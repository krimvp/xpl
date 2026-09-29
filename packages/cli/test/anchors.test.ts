import { beforeAll, describe, expect, it } from "vitest";
import { cloneDir, editFile, indexedFixture, invoke, PATCH_PATH, xpl, xplJson } from "./helpers.js";

const DISPATCH = "sym:src/runner.ts#Runner.dispatch";

let indexed: string;
let demo: string;

async function apply(dir: string, patch: object, ...flags: string[]) {
  return invoke(["apply", "demo", "-", ...flags], { cwd: dir, stdin: JSON.stringify(patch) });
}

beforeAll(async () => {
  indexed = await indexedFixture();
  demo = cloneDir(indexed);
  expect((await xpl(demo, "new", "demo", "--title", "Job runner")).code).toBe(0);
  expect((await xpl(demo, "apply", "demo", PATCH_PATH)).code).toBe(0);
});

describe("xpl anchors", () => {
  it("prints each anchor of a step with role, symbol, span, status, lines and the code with offsets", async () => {
    const { code, out } = await xpl(demo, "anchors", "demo", "dispatch:3");
    expect(code).toBe(0);
    expect(out.split("\n")).toEqual([
      "dispatch:3  (step in view:dispatch, llm)  2 anchors",
      "  1. call-site  src/runner.ts#Runner.dispatch +34..36  ok  lines 76-78",
      "     76 34│         await this.queue.requeue(",
      "     77 35│           job,",
      "     78 36│           backoff);",
      "  2. definition  src/queue.ts#Queue.requeue  ok  lines 87-90",
      "     87 0│   async requeue(job: Job, delayMs: number): Promise<void> {",
      "     88 1│     this.inflight.delete(job.id);",
      "     89 2│     this.ready.push({ ...job, attempts: job.attempts + 1, availableAt: Date.now() + delayMs });",
      "     90 3│   }",
      "",
      "2 anchors of 1 element: ok 2, moved 0, drifted 0, missing 0",
    ]);
  });

  it("without ids lists every element that has anchors: overlays, edges, concepts, steps", async () => {
    const { out } = await xpl(demo, "anchors", "demo");
    const headers = out.split("\n").filter((l) => /^\S/.test(l) && l.includes("anchor"));
    expect(headers).toEqual([
      `${DISPATCH}  (node, llm)  1 anchor`,
      "edge:job-completed  (edge, llm)  2 anchors",
      "concept:retry-policy  (concept, llm)  3 anchors",
      "dispatch:1  (step in view:dispatch, llm)  2 anchors",
      "dispatch:2  (step in view:dispatch, llm)  2 anchors",
      "dispatch:3  (step in view:dispatch, llm)  2 anchors",
      expect.stringMatching(/^12 anchors of 6 elements: ok 12, moved 0, drifted 0, missing 0$/),
    ]);
    // the retry concept: a span in the dispatch loop, a config block, a whole test file
    expect(out).toContain(
      "  1. definition  src/runner.ts#Runner.dispatch +30..41  ok  lines 72-83",
    );
    expect(out).toContain("  2. config  config/default.yaml +12..15  ok  lines 13-16");
    expect(out).toContain("  3. test  test/retry.test.ts  ok  lines 1-");
  });

  it("caps the code of an anchor to its head and its tail, and --full / --max-lines lift or move the cap", async () => {
    const capped = await xpl(demo, "anchors", "demo", DISPATCH);
    const lines = capped.out.split("\n");
    expect(lines[1]).toBe("  1. definition  src/runner.ts#Runner.dispatch  ok  lines 42-88");
    const code = (out: string) => out.split("\n").filter((l) => /^ {5}\d+ +\d+│/.test(l));
    expect(code(capped.out)).toHaveLength(12); // 8 from the start, 4 from the end
    expect(capped.out).toContain(
      "     ... 35 lines elided (50-84); --full shows all, or `xpl show src/runner.ts#Runner.dispatch --lines 50-84`",
    );
    // the end of the span is checkable: the last lines follow the elision, in order
    const shown = code(capped.out).map((l) => Number(/^ {5}(\d+) /.exec(l)![1]));
    expect(shown).toEqual([42, 43, 44, 45, 46, 47, 48, 49, 85, 86, 87, 88]);
    const at = lines.findIndex((l) => l.includes("lines elided"));
    expect(lines[at - 1]).toMatch(/^ {5}49 +7│/);
    expect(lines[at + 1]).toMatch(/^ {5}85 +43│/);
    expect(lines[at + 4]).toMatch(/^ {5}88 +46│ {3}\}$/);
    const full = await xpl(demo, "anchors", "demo", DISPATCH, "--full");
    expect(code(full.out)).toHaveLength(47);
    expect(full.out).not.toContain("elided");
    const three = await xpl(demo, "anchors", "demo", DISPATCH, "--max-lines", "3");
    expect(code(three.out).map((l) => Number(/^ {5}(\d+) /.exec(l)![1]))).toEqual([42, 43, 88]);
    const none = await xpl(demo, "anchors", "demo", DISPATCH, "--max-lines", "0");
    expect(code(none.out)).toHaveLength(47);
    const bad = await xpl(demo, "anchors", "demo", "--max-lines", "many");
    expect(bad.code).toBe(2);
    // --json keeps the head and the tail, and says which lines were cut
    const json = await xplJson<any>(demo, "anchors", "demo", DISPATCH);
    const anchor = json.json.elements[0].anchors[0];
    expect(anchor.lines.map((l: any) => l.line)).toEqual([
      42, 43, 44, 45, 46, 47, 48, 49, 85, 86, 87, 88,
    ]);
    expect(anchor).toMatchObject({ moreLines: 35, elided: { startLine: 50, endLine: 84 } });
  });

  it("takes a view (its steps), a tour (its steps' code), and the loose id forms", async () => {
    const view = await xpl(demo, "anchors", "demo", "view:dispatch");
    expect(view.out.match(/^dispatch:\d  /gm)).toEqual([
      "dispatch:1  ",
      "dispatch:2  ",
      "dispatch:3  ",
    ]);
    const loose = await xpl(demo, "anchors", "demo", "src/runner.ts#Runner.dispatch");
    expect(loose.out.split("\n")[0]).toBe(`${DISPATCH}  (node, llm)  1 anchor`);

    const dir = cloneDir(demo);
    expect(
      (
        await apply(dir, {
          tours: [
            {
              id: "tour:intro",
              steps: [
                {
                  id: "t1",
                  view: "view:overview",
                  focus: ["grp:scheduling"],
                  code: [
                    {
                      file: "src/runner.ts",
                      symbol: "Runner.dispatch",
                      find: "await this.queue.pop()",
                      role: "call-site",
                    },
                  ],
                },
                { id: "t2", view: "view:dispatch", focus: ["dispatch:3"] },
              ],
            },
          ],
        })
      ).code,
    ).toBe(0);
    const tour = await xpl(dir, "anchors", "demo", "tour:intro");
    expect(tour.out.split("\n").slice(0, 3)).toEqual([
      "tour:intro/t1  (tour-step, llm)  1 anchor",
      "  1. call-site  src/runner.ts#Runner.dispatch +4..4  ok  lines 46-46",
      "     46 4│       const job = await this.queue.pop();",
    ]);
    const step = await xpl(dir, "anchors", "demo", "tour:intro/t1");
    expect(step.out).toContain("tour:intro/t1  (tour-step, llm)");
  });

  it("a tour step without a code override shows the derived focus, marked as derived", async () => {
    const dir = cloneDir(demo);
    const steps = [
      { id: "t1", view: "view:dispatch", focus: ["dispatch:3"] },
      { id: "t2", view: "view:overview", focus: ["grp:scheduling"], note: "whole files" },
      { id: "t3", view: "view:dispatch", focus: ["concept:retry-policy", "concept:bare"] },
      { id: "t4", view: "view:overview", focus: [] },
      {
        id: "t5",
        view: "view:dispatch",
        focus: ["dispatch:1"],
        code: [
          {
            file: "src/runner.ts",
            symbol: "Runner.dispatch",
            find: "await this.queue.pop()",
            role: "call-site",
          },
        ],
      },
    ];
    expect(
      (
        await apply(dir, {
          concepts: [{ id: "concept:bare", label: "Bare" }],
          tours: [{ id: "tour:talk", title: "Talk", steps }],
        })
      ).code,
    ).toBe(0);

    // one step: what dispatch:3 focuses is its call site and the definition it calls
    const one = await xpl(dir, "anchors", "demo", "tour:talk/t1");
    expect(one.code).toBe(0);
    expect(one.out.split("\n")).toEqual([
      "tour:talk/t1  (tour step in view:dispatch, no code override: what its focus shows, derived)  2 ranges",
      "  1. call-site  src/runner.ts#Runner.dispatch +34..36  ok  lines 76-78  [derived from dispatch:3]",
      "     76 34│         await this.queue.requeue(",
      "     77 35│           job,",
      "     78 36│           backoff);",
      "  2. definition  src/queue.ts#Queue.requeue  ok  lines 87-90  [derived from dispatch:3]",
      "     87 0│   async requeue(job: Job, delayMs: number): Promise<void> {",
      "     88 1│     this.inflight.delete(job.id);",
      "     89 2│     this.ready.push({ ...job, attempts: job.attempts + 1, availableAt: Date.now() + delayMs });",
      "     90 3│   }",
      "",
      "2 derived ranges of 1 tour step without a code override (not stored anchors)",
    ]);

    // the whole tour: derived steps and the step with a code override, in the tour's order
    const tour = await xpl(dir, "anchors", "demo", "tour:talk");
    const headers = tour.out.split("\n").filter((l) => /^tour:/.test(l));
    expect(headers).toEqual([
      "tour:talk/t1  (tour step in view:dispatch, no code override: what its focus shows, derived)  2 ranges",
      "tour:talk/t2  (tour step in view:overview, no code override: what its focus shows, derived)  2 ranges",
      "tour:talk/t3  (tour step in view:dispatch, no code override: what its focus shows, derived)  3 ranges",
      "tour:talk/t4  (tour step in view:overview, no code override: what its focus shows, derived)  0 ranges",
      "tour:talk/t5  (tour-step, llm)  1 anchor",
    ]);
    // a group focuses the whole files of its members: capped like every anchor
    expect(tour.out).toContain(
      "  1. definition  src/runner.ts  ok  lines 1-111  [derived from grp:scheduling]",
    );
    expect(tour.out).toMatch(
      /lines elided \(9-107\); --full shows all, or `xpl show src\/runner\.ts --lines 9-107`/,
    );
    // a focus without code says so; an empty focus too
    expect(tour.out).toContain(
      "  no code for concept:bare: it has no anchors, or none that resolves",
    );
    expect(tour.out).toContain("  the focus is empty: this step shows no code");
    // stored and derived are counted apart
    expect(tour.out).toMatch(
      /^1 anchor of 1 element: ok 1, moved 0, drifted 0, missing 0; 7 derived ranges of 4 tour steps without a code override \(not stored anchors\)$/m,
    );

    // --json marks them too, and leaves them out of the anchor counts
    const json = await xplJson<any>(dir, "anchors", "demo", "tour:talk/t1");
    expect(json.json.anchors).toEqual({
      total: 0,
      counts: { ok: 0, moved: 0, drifted: 0, missing: 0 },
    });
    expect(json.json.elements[0]).toMatchObject({
      id: "tour:talk/t1",
      type: "tour-step",
      view: "view:dispatch",
      derived: true,
      focus: ["dispatch:3"],
    });
    expect(json.json.elements[0].anchors[0]).toMatchObject({
      derived: true,
      from: "dispatch:3",
      role: "call-site",
      where: "src/runner.ts#Runner.dispatch +34..36",
      range: { startLine: 76, endLine: 78 },
    });
    const noCode = await xplJson<any>(dir, "anchors", "demo", "tour:talk/t3");
    expect(noCode.json.elements[0].noCode).toEqual(["concept:bare"]);
    // a step with a code override is the stored anchors, as before
    const stored = await xpl(dir, "anchors", "demo", "tour:talk/t5");
    expect(stored.out).toContain("tour:talk/t5  (tour-step, llm)  1 anchor");
    expect(stored.out).not.toContain("derived");
    // a tour that does not exist gets the closest one
    const unknown = await xpl(dir, "anchors", "demo", "tour:tal");
    expect(unknown.code).toBe(1);
    expect(unknown.err).toContain("Did you mean: tour:talk");
  });

  it("does not elide a line or two: that would be no saving", async () => {
    // concept:retry-policy's first anchor is 12 lines (72-83)
    const fits = await xpl(demo, "anchors", "demo", "concept:retry-policy", "--max-lines", "10");
    const first = fits.out.slice(0, fits.out.indexOf("  2. config"));
    expect(first).not.toContain("elided");
    expect(first.match(/^ {5}\d+ +\d+│/gm)).toHaveLength(12);
    const cut = await xpl(demo, "anchors", "demo", "concept:retry-policy", "--max-lines", "9");
    expect(cut.out).toContain("... 3 lines elided (78-80);");
  });

  it("--max-lines 2 keeps the start, and says how many lines follow", async () => {
    const { out } = await xpl(demo, "anchors", "demo", DISPATCH, "--max-lines", "2");
    const lines = out.split("\n");
    expect(lines[2]).toMatch(/^ {5}42 0│/);
    expect(lines[3]).toMatch(/^ {5}43 1│/);
    expect(lines[4]).toBe(
      "     ... 45 lines elided (44-88); --full shows all, or `xpl show src/runner.ts#Runner.dispatch --lines 44-88`",
    );
  });

  it("says so for elements that exist but have no stored anchors, and fails for unknown ones", async () => {
    const bare = await xpl(
      demo,
      "anchors",
      "demo",
      "sym:src/runner.ts#Runner.start",
      "file:src/bus.ts",
    );
    expect(bare.code).toBe(0);
    expect(bare.out).toContain("sym:src/runner.ts#Runner.start  (node)  no stored anchors");
    expect(bare.out).toContain("file:src/bus.ts  (node)  no stored anchors");
    const graph = await xpl(demo, "anchors", "demo", "view:overview");
    expect(graph.out).toContain(
      "view:overview  (graph view)  no stored anchors: a graph view has no anchors",
    );

    const unknown = await xpl(demo, "anchors", "demo", "concept:retry");
    expect(unknown.code).toBe(1);
    expect(unknown.err).toContain('no element "concept:retry" in demo');
    expect(unknown.err).toContain("Did you mean: concept:retry-policy?");
    const nothing = await xpl(demo, "anchors", "demo", "zzz");
    expect(nothing.code).toBe(1);
    expect(nothing.err).toContain("without ids lists every element with anchors");
  });

  it("an explainer without anchors says so", async () => {
    const dir = cloneDir(indexed);
    await xpl(dir, "new", "empty");
    const { code, out } = await xpl(dir, "anchors", "empty");
    expect(code).toBe(0);
    expect(out).toBe(".explainer/empty.explainer.json has no anchors yet");
  });

  it("--json gives the elements, their anchors and the lines with offsets", async () => {
    const { code, json } = await xplJson<any>(demo, "anchors", "demo", "dispatch:3");
    expect(code).toBe(0);
    expect(json).toMatchObject({
      path: ".explainer/demo.explainer.json",
      maxLines: 12,
      anchors: { total: 2, counts: { ok: 2, moved: 0, drifted: 0, missing: 0 } },
    });
    expect(json.elements).toHaveLength(1);
    expect(json.elements[0]).toMatchObject({
      id: "dispatch:3",
      type: "step",
      view: "view:dispatch",
      origin: "llm",
    });
    expect(json.elements[0].anchors[0]).toMatchObject({
      path: "views[1].steps[2].anchors[0]",
      role: "call-site",
      file: "src/runner.ts",
      symbol: "Runner.dispatch",
      span: { from: 34, to: 36 },
      where: "src/runner.ts#Runner.dispatch +34..36",
      status: "ok",
      range: { startLine: 76, endLine: 78 },
      lines: [
        { line: 76, offset: 34, text: "        await this.queue.requeue(" },
        { line: 77, offset: 35, text: "          job," },
        { line: 78, offset: 36, text: "          backoff);" },
      ],
    });
    const capped = await xplJson<any>(demo, "anchors", "demo", DISPATCH, "--max-lines", "2");
    expect(capped.json.elements[0].anchors[0]).toMatchObject({ moreLines: 45 });
    expect(capped.json.elements[0].anchors[0].lines).toHaveLength(2);
    const missing = await xplJson<any>(demo, "anchors", "demo", "zzz");
    expect(missing.code).toBe(1);
    expect(missing.json.ok).toBe(false);
  });
});

describe("xpl anchors after the code changed", () => {
  it("shows the moved code at its new lines once resolve --write has stored the move", async () => {
    const dir = cloneDir(demo);
    editFile(dir, "src/runner.ts", (text) =>
      text.replace(
        "  async dispatch(): Promise<void> {",
        "  // one\n  // two\n  // three\n  async dispatch(): Promise<void> {",
      ),
    );
    const indexed = await xplJson<any>(dir, "index", "--precise", "off");
    expect(indexed.code).toBe(0);
    // the skill's flow: index, resolve --write, then look
    expect((await xpl(dir, "resolve", "demo", "--write")).code).toBe(0);
    const { out } = await xpl(dir, "anchors", "demo", "dispatch:3");
    const lines = out.split("\n");
    // (`resolve --write` stored the move, so it reads ok: same text, and the lines match the cache)
    expect(lines[1]).toBe("  1. call-site  src/runner.ts#Runner.dispatch +34..36  ok  lines 79-81");
    expect(lines[2]).toBe("     79 34│         await this.queue.requeue(");
    expect(out).not.toContain("still says");
  });

  it("says when the explainer file's cached lines are out of date (another index was given)", async () => {
    const dir = cloneDir(demo);
    editFile(dir, "src/runner.ts", (text) =>
      text.replace(
        "  async dispatch(): Promise<void> {",
        "  // one\n  // two\n  // three\n  async dispatch(): Promise<void> {",
      ),
    );
    const indexed = await xplJson<any>(dir, "index", "--precise", "off");
    // the explainer is still bound to the old index; look at the new one without saving anything
    const { out } = await xpl(dir, "anchors", "demo", "dispatch:3", "--index", indexed.json.path);
    const lines = out.split("\n");
    expect(lines[1]).toBe(
      "  1. call-site  src/runner.ts#Runner.dispatch +34..36  moved  lines 79-81",
    );
    expect(lines[2]).toBe(
      "     (the explainer file still says ok, lines 76-78: run `xpl resolve demo --write`)",
    );
    expect(lines[3]).toBe("     79 34│         await this.queue.requeue(");
  });

  it("a drifted span shows the code where it used to sit, marked approximate, with the reason", async () => {
    const dir = cloneDir(demo);
    editFile(dir, "src/runner.ts", (text) =>
      text.replace("await this.queue.requeue(", "await this.queue.requeueLater("),
    );
    expect((await xpl(dir, "index", "--precise", "off")).code).toBe(0);
    expect((await xpl(dir, "resolve", "demo", "--write")).code).toBe(0);
    const { out } = await xpl(dir, "anchors", "demo", "dispatch:3");
    const lines = out.split("\n");
    expect(lines[1]).toBe(
      "  1. call-site  src/runner.ts#Runner.dispatch +34..36  drifted  lines 76-78",
    );
    expect(lines[2]).toContain("(approximate: the text changed");
    expect(lines[3]).toContain("text of src/runner.ts#Runner.dispatch +34..36 changed");
    expect(lines[4]).toBe("     76 34│         await this.queue.requeueLater(");
    expect(out).toContain("drifted 1, missing 0");
  });

  it("a missing anchor has its reason (with where the code went) and no code", async () => {
    const dir = cloneDir(demo);
    editFile(dir, "src/runner.ts", (text) => text.replace("async dispatch(", "async run("));
    expect((await xpl(dir, "index", "--precise", "off")).code).toBe(0);
    expect((await xpl(dir, "resolve", "demo", "--write")).code).toBe(0);
    const { out } = await xpl(dir, "anchors", "demo", "dispatch:3", DISPATCH);
    const step = out.slice(0, out.indexOf(`${DISPATCH}  (node`));
    const first = step.slice(step.indexOf("1. call-site"), step.indexOf("2. definition"));
    expect(first).not.toMatch(/^ {5}\d+ +\d+│/m);
    expect(step).toContain(
      "1. call-site  src/runner.ts#Runner.dispatch +34..36  missing  last known lines 76-78",
    );
    // the span's text is found in the renamed method, at the same offsets
    expect(step).toContain(
      'the anchored lines now sit in sym:src/runner.ts#Runner.run (anchor: file: "src/runner.ts", symbol: "Runner.run", span: {from: 34, to: 36})',
    );
    // the whole-symbol overlay finds its rename by size
    const overlay = out.slice(out.indexOf(`${DISPATCH}  (node`));
    expect(overlay).toContain("missing  last known lines 42-88");
    expect(overlay).toContain(
      'did you mean sym:src/runner.ts#Runner.run (anchor: file: "src/runner.ts", symbol: "Runner.run")',
    );
  });

  it("marks anchors the user owns", async () => {
    const dir = cloneDir(demo);
    expect(
      (
        await apply(
          dir,
          {
            concepts: [
              {
                id: "concept:retry-policy",
                anchors: [{ file: "src/runner.ts", symbol: "Runner.dispatch", role: "definition" }],
              },
              {
                id: "concept:mine",
                label: "Mine",
                anchors: [{ file: "src/bus.ts", role: "usage" }],
              },
            ],
          },
          "--actor",
          "user",
        )
      ).code,
    ).toBe(0);
    const { out } = await xpl(dir, "anchors", "demo", "concept:retry-policy", "concept:mine");
    expect(out).toContain(
      "concept:retry-policy  (concept, llm, anchors owned by the user)  1 anchor",
    );
    expect(out).toContain("concept:mine  (concept, user)  1 anchor");
  });
});
