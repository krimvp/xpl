import { beforeAll, describe, expect, it } from "vitest";
import { cloneDir, indexedFixture, invoke, PATCH_PATH, readJson, xpl } from "./helpers.js";

const EXPLAINER = ".explainer/demo.explainer.json";
const DISPATCH = "sym:src/runner.ts#Runner.dispatch";

let demo: string;
/** The demo explainer after the user rewrote the summary of Runner.dispatch and curated view:overview. */
let owned: string;

async function apply(dir: string, patch: object, ...flags: string[]) {
  return invoke(["apply", "demo", "-", ...flags], { cwd: dir, stdin: JSON.stringify(patch) });
}

beforeAll(async () => {
  const indexed = await indexedFixture();
  demo = cloneDir(indexed);
  expect((await xpl(demo, "new", "demo", "--title", "Job runner")).code).toBe(0);
  expect((await xpl(demo, "apply", "demo", PATCH_PATH)).code).toBe(0);

  owned = cloneDir(demo);
  const edit = await apply(
    owned,
    {
      nodes: [{ id: DISPATCH, summary: "Mine: the loop." }],
      views: [
        {
          id: "view:overview",
          type: "graph",
          include: [
            "grp:scheduling",
            "file:src/worker.ts",
            "file:src/metrics.ts",
            "file:src/bus.ts",
          ],
        },
      ],
    },
    "--actor",
    "user",
  );
  expect(edit.code, edit.out).toBe(0);
  const overview = readJson(owned, EXPLAINER).views.find((v: any) => v.id === "view:overview");
  expect(overview.provenance.userFields).toEqual(["include"]);
});

describe("apply when everything is protected", () => {
  const rewrite = {
    nodes: [{ id: DISPATCH, summary: "Claude's rewrite.", label: undefined }],
    views: [
      {
        id: "view:overview",
        type: "graph",
        include: ["grp:scheduling", "file:src/worker.ts"],
      },
    ],
  };

  it("exits 1 and names the protected ids and what to do", async () => {
    const dir = cloneDir(owned);
    const before = JSON.stringify(readJson(dir, EXPLAINER));
    const { code, out, err } = await apply(dir, rewrite);
    expect(code).toBe(1);
    expect(err).toBe("");
    expect(out).toContain(
      "nothing was applied to .explainer/demo.explainer.json (patch from stdin): everything this patch would change is owned by the user (skipped as protected): " +
        `${DISPATCH}, view:overview`,
    );
    // the individual warnings follow, then the advice
    expect(out).toContain(`summary of ${DISPATCH} was edited by the user and is kept as it is`);
    expect(out).toContain("include of view:overview was edited by the user and is kept as it is");
    expect(out).toContain("what to do:");
    expect(out).toContain("NEW view");
    expect(out).toContain("`includeAdd`");
    expect(out).toContain("ask the user");
    expect(out).not.toMatch(/^applied to/m);
    expect(JSON.stringify(readJson(dir, EXPLAINER))).toBe(before);
  });

  it("--json: ok false, no change, the ids, and an error string", async () => {
    const { code, out } = await apply(cloneDir(owned), rewrite, "--json");
    const json = JSON.parse(out);
    expect(code).toBe(1);
    expect(json).toMatchObject({
      ok: false,
      applied: false,
      changed: [],
      protectedIds: [DISPATCH, "view:overview"],
    });
    expect(json.error).toContain("everything this patch would change is owned by the user");
    expect(json.issues.filter((i: any) => i.code === "protected")).toHaveLength(2);
  });

  it("--dry-run says the same", async () => {
    const { code, out } = await apply(cloneDir(owned), rewrite, "--dry-run");
    expect(code).toBe(1);
    expect(out).toContain("nothing was applied");
  });

  it("covers user-authored elements, removal of an element that carries userFields, and includeRemove", async () => {
    const remove = await apply(cloneDir(owned), { remove: [DISPATCH] });
    expect(remove.code).toBe(1);
    expect(remove.out).toContain(
      `${DISPATCH} has fields edited by the user (summary); an llm patch cannot remove it (skipped)`,
    );
    const includeRemove = await apply(cloneDir(owned), {
      views: [{ id: "view:overview", type: "graph", includeRemove: ["file:src/bus.ts"] }],
    });
    expect(includeRemove.code).toBe(1);
    expect(includeRemove.out).toContain("includeRemove of view:overview was skipped");
    expect(includeRemove.out).toContain("owned by the user (skipped as protected): view:overview");
  });

  it("an actor user patch is not refused", async () => {
    const dir = cloneDir(owned);
    const { code, out } = await apply(dir, rewrite, "--actor", "user");
    expect(code).toBe(0);
    expect(out).toContain("applied to");
  });
});

describe("apply with some of the patch protected", () => {
  const mixed = {
    nodes: [{ id: DISPATCH, summary: "Claude's rewrite.", detail: "Claude's longer text." }],
    concepts: [{ id: "concept:new", label: "New", summary: "Something new." }],
  };

  it("stays exit 0, and ends with the skipped ids", async () => {
    const dir = cloneDir(owned);
    const { code, out } = await apply(dir, mixed);
    expect(code).toBe(0);
    const lines = out.split("\n");
    expect(lines[0]).toBe("applied to .explainer/demo.explainer.json (actor llm): 2 ids changed");
    expect(out).toContain("issues (0 errors, 1 warning):");
    // the last thing printed is the summary of what was left alone
    const last = lines[lines.length - 1]!;
    expect(last).toMatch(/^skipped as protected \(sym:src\/runner\.ts#Runner\.dispatch\): /);
    expect(last).toContain("not an error and not something to work around");
    expect(last).toContain("includeAdd");
    // and what was allowed did happen
    const explainer = readJson(dir, EXPLAINER);
    expect(explainer.nodes.find((n: any) => n.id === DISPATCH)).toMatchObject({
      summary: "Mine: the loop.",
      detail: "Claude's longer text.",
    });
    expect(explainer.concepts.map((c: any) => c.id)).toContain("concept:new");
  });

  it("--json lists the ids too", async () => {
    const { code, out } = await apply(cloneDir(owned), mixed, "--json");
    const json = JSON.parse(out);
    expect(code).toBe(0);
    expect(json).toMatchObject({ ok: true, applied: true, protectedIds: [DISPATCH] });
  });

  it("no summary line when nothing was protected; a plain no-op is still exit 0", async () => {
    const dir = cloneDir(demo);
    const fine = await apply(dir, { concepts: [{ id: "concept:x", label: "X" }] });
    expect(fine.code).toBe(0);
    expect(fine.out).not.toContain("skipped as protected");
    const noop = await apply(dir, { concepts: [{ id: "concept:x", label: "X" }] });
    expect(noop.code).toBe(0);
    expect(noop.out).toContain("no changes");
  });
});

describe("includeAdd grows a view the user curated", () => {
  it("applies, exits 0, keeps the user's ownership of include", async () => {
    const dir = cloneDir(owned);
    const { code, out } = await apply(dir, {
      views: [
        {
          id: "view:overview",
          type: "graph",
          includeAdd: ["file:src/queue.ts", "file:src/bus.ts"],
        },
      ],
    });
    expect(code).toBe(0);
    expect(out).toContain("applied to .explainer/demo.explainer.json (actor llm): 1 id changed");
    expect(out).not.toContain("protected");
    const overview = readJson(dir, EXPLAINER).views.find((v: any) => v.id === "view:overview");
    expect(overview.include).toEqual([
      "grp:scheduling",
      "file:src/worker.ts",
      "file:src/metrics.ts",
      "file:src/bus.ts",
      "file:src/queue.ts",
    ]);
    expect(overview.provenance.userFields).toEqual(["include"]);
    expect("includeAdd" in overview).toBe(false);
  });

  it("an unknown id in includeAdd is rejected with its place in the patch", async () => {
    const { code, out } = await apply(cloneDir(demo), {
      views: [{ id: "view:overview", type: "graph", includeAdd: ["file:src/nope.ts"] }],
    });
    expect(code).toBe(1);
    expect(out).toContain("views[0].includeAdd[0] [view:overview]");
  });
});

describe("xpl apply --help", () => {
  it("summarises the patch format and points at the skill's reference, not at the source", async () => {
    for (const argv of [
      ["apply", "--help"],
      ["help", "apply"],
    ]) {
      const { code, out } = await invoke(argv);
      expect(code).toBe(0);
      for (const text of [
        "Usage: xpl apply <explainer> <patch.json|-> [--actor llm|user] [--dry-run]",
        '"title"?, "nodes"?, "edges"?, "concepts"?, "views"?, "tours"?, "remove"?',
        '"symbol"?: "Runner.dispatch"',
        '"find"?',
        "definition|call-site|usage|config|test",
        "arrays and objects replace wholesale",
        "null",
        "includeAdd / includeRemove",
        "excludeFiles",
        "protected",
        "reference/patch-format.md in the",
        "code-explainer skill",
        "Exit codes",
        "--dry-run",
      ]) {
        expect(out, text).toContain(text);
      }
      expect(out).not.toContain("packages/core");
      expect(out).not.toContain("patch.ts");
      // compact: the summary fits on a screen
      expect(out.split("\n").length).toBeLessThan(60);
    }
  });
});
