/**
 * `xpl apply` as the skill uses it after real-repo trials: fixing one step without resending them all, seeing every
 * error of a patch in one run, ids that say what they were probably meant to be, spans on blank lines, and which
 * stream says what.
 */
import { beforeAll, describe, expect, it } from "vitest";
import {
  cloneDir,
  indexedFixture,
  invoke,
  PATCH_PATH,
  readJson,
  writeFile,
  xpl,
} from "./helpers.js";

const EXPLAINER = ".explainer/demo.explainer.json";

let demo: string;

async function apply(dir: string, patch: unknown, ...flags: string[]) {
  return invoke(["apply", "demo", "-", ...flags], { cwd: dir, stdin: JSON.stringify(patch) });
}

beforeAll(async () => {
  const indexed = await indexedFixture();
  demo = cloneDir(indexed);
  expect((await xpl(demo, "new", "demo", "--title", "Job runner")).code).toBe(0);
  expect((await xpl(demo, "apply", "demo", PATCH_PATH)).code).toBe(0);
});

describe("xpl apply: stepsUpdate", () => {
  it("fixes one step's summary and names the step in `changed`", async () => {
    const dir = cloneDir(demo);
    const before = readJson(dir, EXPLAINER).views.find((v: any) => v.id === "view:dispatch");
    const r = await apply(dir, {
      views: [
        {
          id: "view:dispatch",
          type: "sequence",
          stepsUpdate: [{ id: "dispatch:2", summary: "Leases a worker and runs one attempt." }],
        },
      ],
    });
    expect(r.code, r.out).toBe(0);
    expect(r.out).toBe(
      [
        "applied to .explainer/demo.explainer.json (actor llm): 2 ids changed",
        "changed:",
        "  view:dispatch",
        "  dispatch:2",
      ].join("\n"),
    );
    const after = readJson(dir, EXPLAINER).views.find((v: any) => v.id === "view:dispatch");
    expect(after.steps[1].summary).toBe("Leases a worker and runs one attempt.");
    expect(after.steps[0]).toEqual(before.steps[0]);
    expect(after.steps[2]).toEqual(before.steps[2]);
    expect(after.frames).toEqual(before.frames);
    // the same update again changes nothing
    const again = await apply(dir, {
      views: [
        {
          id: "view:dispatch",
          type: "sequence",
          stepsUpdate: [{ id: "dispatch:2", summary: "Leases a worker and runs one attempt." }],
        },
      ],
    });
    expect(again.out).toContain("no changes");
  });

  it("an unknown step id is a rejection that names the steps, on stdout, exit 1", async () => {
    const dir = cloneDir(demo);
    const r = await apply(dir, {
      views: [
        {
          id: "view:dispatch",
          type: "sequence",
          stepsUpdate: [{ id: "dispatch:9", summary: "x" }],
        },
      ],
    });
    expect(r.code).toBe(1);
    expect(r.err).toBe("");
    expect(r.out).toContain("rejected: 1 error, nothing was applied");
    expect(r.out).toContain(
      "error   views[0].stepsUpdate[0].id [view:dispatch]: step dispatch:9 is not a step of view:dispatch (its steps: dispatch:1, dispatch:2, dispatch:3)",
    );
  });

  it("is skipped like steps when the user edited them: protected, and exit 1 when that is all", async () => {
    const dir = cloneDir(demo);
    // the user rewrites a step's summary (through the viewer, or --actor user)
    expect(
      (
        await apply(
          dir,
          {
            views: [
              {
                id: "view:dispatch",
                type: "sequence",
                stepsUpdate: [{ id: "dispatch:1", summary: "Mine." }],
              },
            ],
          },
          "--actor",
          "user",
        )
      ).code,
    ).toBe(0);
    const view = readJson(dir, EXPLAINER).views.find((v: any) => v.id === "view:dispatch");
    expect(view.provenance.userFields).toEqual(["steps"]);
    const r = await apply(dir, {
      views: [
        {
          id: "view:dispatch",
          type: "sequence",
          stepsUpdate: [{ id: "dispatch:1", summary: "Claude's." }],
        },
      ],
    });
    expect(r.code).toBe(1);
    expect(r.out).toContain("nothing was applied");
    expect(r.out).toContain("view:dispatch");
    expect(
      readJson(dir, EXPLAINER).views.find((v: any) => v.id === "view:dispatch").steps[0].summary,
    ).toBe("Mine.");
  });
});

describe("xpl apply: one wave of errors", () => {
  const badPatch = {
    tours: [
      {
        id: "tour:talk",
        title: "Talk",
        steps: [
          {
            id: "t1",
            view: "view:dispatch",
            focus: ["dispatch:1"],
            code: [
              {
                file: "src/runner.ts",
                symbol: "Runner.dispatch",
                span: { from: 0, to: 999 },
                role: "usage",
              },
            ],
          },
          { id: "t2", view: "view:dispatch", focus: ["dispatch:9"] },
        ],
      },
    ],
    concepts: [{ id: "concept:x", label: "X", related: ["concept:retry"] }],
  };

  it("shows a bad span, a bad focus and a bad related id in one rejection", async () => {
    const dir = cloneDir(demo);
    const r = await apply(dir, badPatch);
    expect(r.code).toBe(1);
    expect(r.out).toContain("rejected: 3 errors, nothing was applied");
    const errors = r.out.split("\n").filter((l) => l.startsWith("error"));
    expect(errors).toHaveLength(3);
    // what could not be built first (the span), then what the merged result gets wrong, in explainer order
    expect(errors[0]).toContain("tours[0].steps[0].code[0]");
    expect(errors[0]).toContain("outside");
    expect(errors[1]).toContain("concepts[0].related[0]");
    expect(errors[1]).toContain("Did you mean: concept:retry-policy?");
    expect(errors[2]).toContain("tours[0].steps[1].focus[0]");
    expect(errors[2]).toContain("no step dispatch:9 in view:dispatch (its steps: dispatch:1");
    // nothing was written
    expect(readJson(dir, EXPLAINER).tours.map((t: any) => t.id)).toEqual(["tour:intro"]);
    expect(readJson(dir, EXPLAINER).concepts.map((c: any) => c.id)).not.toContain("concept:x");
    // the same in JSON: every issue, each with its code
    const json = await apply(dir, badPatch, "--json");
    const parsed = JSON.parse(json.out);
    expect(parsed).toMatchObject({
      ok: false,
      applied: false,
      error: expect.stringContaining("3 errors"),
    });
    expect(parsed.issues.map((i: any) => i.code)).toEqual([
      "anchor-invalid",
      "unknown-id",
      "unknown-id",
    ]);
  });
});

describe("xpl apply: spans on blank lines", () => {
  it("applies, and warns that a span ending or starting on a blank line is probably off by one", async () => {
    const dir = cloneDir(demo);
    // Runner.dispatch: offsets 38..40 are `deadLetter(...)`, a closing brace and a blank line (file line 85)
    const shown = await xpl(dir, "show", "src/runner.ts#Runner.dispatch", "--lines", "80-86");
    expect(shown.out).toMatch(/\n85 43│\s*\n/);
    const r = await apply(dir, {
      concepts: [
        {
          id: "concept:tail",
          label: "Tail",
          anchors: [
            {
              file: "src/runner.ts",
              symbol: "Runner.dispatch",
              span: { from: 40, to: 43 },
              role: "definition",
            },
          ],
        },
      ],
    });
    expect(r.code, r.out).toBe(0);
    expect(r.out).toContain("applied to");
    expect(r.out).toContain("issues (0 errors, 1 warning):");
    expect(r.out).toMatch(
      /warning concepts\[0\]\.anchors\[0\] \[concept:tail\]: span src\/runner\.ts#Runner\.dispatch \+40\.\.43 ends on a blank line \(line 85\): probably off by one, the code in it ends at line 84 \(offset 42\)/,
    );
    // the anchor is stored as written: the warning is advice, not a change
    const stored = readJson(dir, EXPLAINER).concepts.find((c: any) => c.id === "concept:tail");
    expect(stored.anchors[0].span).toEqual({ from: 40, to: 43 });
  });

  it("stays quiet for spans on code", async () => {
    const dir = cloneDir(demo);
    const r = await apply(dir, {
      concepts: [
        {
          id: "concept:ok",
          label: "Ok",
          anchors: [
            {
              file: "src/runner.ts",
              symbol: "Runner.dispatch",
              span: { from: 34, to: 36 },
              role: "call-site",
            },
          ],
        },
      ],
    });
    expect(r.out).not.toContain("warning");
  });
});

describe("xpl apply: which stream says what", () => {
  it("`xpl help apply` documents it", async () => {
    const { code, out } = await invoke(["help", "apply"]);
    expect(code).toBe(0);
    expect(out).toContain("Output streams:");
    expect(out).toContain("stdout");
    expect(out).toContain("stderr");
    expect(out).toContain("rejected: N errors");
    expect(out).toContain("stepsUpdate");
    expect(out).toContain("One pass:");
    const viaFlag = await invoke(["apply", "--help"]);
    expect(viaFlag.out).toBe(out);
  });

  it("a rejection is on stdout (exit 1, nothing on stderr); the result of a valid patch too", async () => {
    const dir = cloneDir(demo);
    const rejected = await apply(dir, { concepts: [{ id: "concept:x" }] });
    expect(rejected.code).toBe(1);
    expect(rejected.err).toBe("");
    expect(rejected.out).toMatch(/^rejected: 1 error, nothing was applied/);
    const applied = await apply(dir, { concepts: [{ id: "concept:x", label: "X" }] });
    expect(applied.code).toBe(0);
    expect(applied.err).toBe("");
    expect(applied.out).toMatch(/^applied to /);
  });

  it("fatal errors are on stderr as `error: ...` with an empty stdout", async () => {
    const dir = cloneDir(demo);
    writeFile(dir, "broken.json", '{"concepts": [');
    const invalid = await invoke(["apply", "demo", "broken.json"], { cwd: dir });
    expect(invalid.code).toBe(1);
    expect(invalid.out).toBe("");
    expect(invalid.err).toMatch(/^error: patch broken\.json is not valid JSON/);
    const missing = await invoke(["apply", "demo", "nope.json"], { cwd: dir });
    expect(missing.code).toBe(1);
    expect(missing.out).toBe("");
    expect(missing.err).toMatch(/^error: cannot read patch file/);
    const noExplainer = await invoke(["apply", "nope", "broken.json"], { cwd: dir });
    expect(noExplainer.code).toBe(1);
    expect(noExplainer.out).toBe("");
    expect(noExplainer.err).toMatch(/^error: no explainer "nope"/);
    const usage = await invoke(["apply", "demo"], { cwd: dir });
    expect(usage.code).toBe(2);
    expect(usage.out).toBe("");
    expect(usage.err).toContain("error: missing <patch.json|->");
  });

  it("with --json everything, fatal errors included, is one object on stdout", async () => {
    const dir = cloneDir(demo);
    writeFile(dir, "broken.json", "{");
    const fatal = await invoke(["apply", "demo", "broken.json", "--json"], { cwd: dir });
    expect(fatal.code).toBe(1);
    expect(fatal.err).toBe("");
    expect(JSON.parse(fatal.out)).toMatchObject({
      ok: false,
      error: expect.stringContaining("not valid JSON"),
    });
    const rejected = await apply(dir, { concepts: [{ id: "concept:x" }] }, "--json");
    expect(rejected.code).toBe(1);
    expect(rejected.err).toBe("");
    expect(JSON.parse(rejected.out)).toMatchObject({ ok: false, applied: false });
  });
});
