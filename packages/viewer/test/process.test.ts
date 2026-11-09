import { describe, expect, it } from "vitest";
import {
  applyPatch,
  codeFocus,
  collectAnchors,
  ExplainerModel,
  type GraphView,
  processFlow,
  relatedFiles,
  type SequenceView,
} from "@xpl/core";
import { makeBundle, TEXTS } from "./world.js";
import { workspaceMap, workspaceView } from "../src/workspace.js";
import { ViewerStore } from "../src/store.js";
import { mergeSameCards, readerCards, repeatsShownCode } from "../src/relatedCards.js";

describe("process flows and related files", () => {
  it("supports explicit decisions, labeled branches, terminal outcomes and code anchors", () => {
    const bundle = makeBundle();
    const original = bundle.explainer.views.find(
      (view) => view.type === "sequence",
    ) as SequenceView;
    const steps = [...original.steps, { ...original.steps[1]!, label: "Skipped" }].map(
      (step, index) => ({ ...step, id: `process:${index + 1}` }),
    );
    const patch = {
      views: [
        {
          ...original,
          id: "view:process",
          type: "flow" as const,
          steps: steps.map((step, index) => ({
            ...step,
            shape: index === 0 ? ("decision" as const) : ("terminal" as const),
            next:
              index === 0
                ? [
                    { step: steps[1]!.id, label: "yes" },
                    { step: steps[2]!.id, label: "no" },
                  ]
                : [],
          })),
        },
      ],
    };
    const result = applyPatch(bundle.explainer, patch, bundle.index, (file) => TEXTS[file], {
      actor: "user",
    });
    expect(result.ok, JSON.stringify(result.issues)).toBe(true);
    if (!result.ok) return;
    const model = new ExplainerModel(result.explainer, bundle.index);
    const view = model.view("view:process") as SequenceView;
    const flow = processFlow(view);
    expect(flow.projected).toBe(false);
    expect(flow.stages[0]?.shape).toBe("decision");
    expect(flow.transitions.map((edge) => edge.label)).toEqual(["yes", "no"]);
    expect(codeFocus([steps[0]!.id], model).length).toBeGreaterThan(0);
    expect(collectAnchors(result.explainer).some((entry) => entry.elementId === steps[0]!.id)).toBe(
      true,
    );
  });

  it("marks sequence projections as ordering rather than inferred execution", () => {
    const view = makeBundle().explainer.views.find(
      (item) => item.type === "sequence",
    ) as SequenceView;
    expect(processFlow(view).projected).toBe(true);
    expect(processFlow(view).transitions).toHaveLength(view.steps.length - 1);
  });

  it("keeps maps and flows focused on the selected topic", () => {
    const store = new ViewerStore(makeBundle());
    store.previewStep("tour:demo", 1);
    expect(workspaceView(store.getState(), "flow")?.id).toBe("view:flow");
    expect(workspaceMap(store.getState()).related.size).toBeGreaterThan(0);
  });

  it("keeps the visible map in place when selecting another component", () => {
    const bundle = makeBundle();
    (bundle.explainer.views[0] as GraphView).include = ["file:src/a.ts", "file:src/b.ts"];
    bundle.explainer.views.push({
      id: "view:detail",
      type: "graph",
      title: "Detail",
      scope: { root: "repo", depth: 2 },
      include: ["file:src/a.ts", "sym:src/a.ts#A.run", "sym:src/a.ts#A.stop"],
      provenance: { origin: "user" },
    });
    const store = new ViewerStore(bundle, { view: "view:flow", perspective: "guide" });
    store.select(["file:src/b.ts"]);
    store.setPerspective("map");
    expect(store.view()?.id).toBe("view:overview");
    store.select(["file:src/a.ts"]);
    expect(workspaceMap(store.getState()).view.id).toBe("view:overview");
  });

  it("honors explicit diagram choices without changing the selected topic", () => {
    const bundle = makeBundle();
    bundle.explainer.views.push({
      id: "view:other",
      type: "graph",
      title: "Other",
      scope: { root: "repo", depth: 1 },
      include: ["file:config/c.yaml"],
      provenance: { origin: "user" },
    });
    const store = new ViewerStore(bundle);
    store.previewStep("tour:demo", 0);
    store.setView("view:other");
    expect(workspaceView(store.getState(), "map")?.id).toBe("view:other");
    expect(store.getState().selection).toEqual(["grp:core"]);
  });

  it("shows evidence-backed configuration precedence from an anchored consumer", () => {
    const bundle = makeBundle();
    bundle.index = {
      ...bundle.index,
      files: [
        ...bundle.index.files,
        { path: "config/production.yaml", language: "yaml", hash: "production", lines: 1 },
      ],
    };
    bundle.explainer.edges.push({
      id: "edge:override",
      from: "file:config/production.yaml",
      to: "file:config/c.yaml",
      kind: "overrides",
      label: "Overrides defaults",
      summary: "The override replaces matching default keys.",
      anchors: [],
      provenance: { origin: "user" },
    });
    const links = relatedFiles(
      ["concept:retry"],
      new ExplainerModel(bundle.explainer, bundle.index),
    );
    expect(links.find((link) => link.kind === "overrides")).toMatchObject({
      files: ["config/production.yaml"],
      label: "Overridden by production.yaml",
      summary: "The override replaces matching default keys.",
      resolution: "annotated",
    });
  });

  it("a box that holds other code shows only the arrows drawn from or to it", () => {
    const bundle = makeBundle();
    bundle.index.resources = [
      {
        from: "src/a.ts#A.run",
        files: ["config/c.yaml"],
        kind: "loads",
        site: { startLine: 12, endLine: 12 },
        resolution: "inferred",
      },
    ];
    bundle.explainer.edges.push({
      id: "edge:core-reads",
      from: "grp:core",
      to: "file:config/c.yaml",
      kind: "loads",
      label: "Reads its settings",
      anchors: [],
      provenance: { origin: "user" },
    });
    // the box's own code links name a settings file: still no "Its settings are in" card on the box
    bundle.explainer.nodes.find((node) => node.id === "grp:core")!.anchors =
      bundle.explainer.concepts
        .find((concept) => concept.id === "concept:retry")!
        .anchors.filter((anchor) => anchor.role === "config");
    const model = new ExplainerModel(bundle.explainer, bundle.index);
    const ids = (links: { id: string }[]) => links.map((link) => link.id);
    // core holds A.run, which reads c.yaml: a fact about A.run, not about the whole box
    expect(ids(relatedFiles(["grp:core"], model))).toContain("resource:0");
    expect(ids(readerCards(["grp:core"], model, codeFocus(["grp:core"], model)))).toEqual([
      "edge:core-reads",
    ]);
    // with a box of code beside it, that one's cards come back, and the box adds its arrow
    const both = ["grp:core", "sym:src/a.ts#A.run"];
    expect(ids(readerCards(both, model, codeFocus(both, model)))).toEqual([
      "resource:0",
      "edge:core-reads",
    ]);
    // a step's own setting stays (its code links say so, not the box's)
    const step = [
      { file: "config/c.yaml", range: { startLine: 2, endLine: 4 }, role: "config" as const },
    ].map((range) => ({ ...range, elementId: "tour:demo/t3", status: "ok" as const }));
    expect(ids(readerCards(["grp:core"], model, step))).toEqual([
      "anchor:config:config/c.yaml",
      "edge:core-reads",
    ]);
  });

  it("leaves out a setting card for a file whose code the step already shows", () => {
    const model = new ExplainerModel(makeBundle().explainer, makeBundle().index);
    const focus = codeFocus(["concept:retry"], model);
    const config = relatedFiles(["concept:retry"], model).find(
      (link) => link.kind === "configuration",
    )!;
    expect(config.files).toEqual(["config/c.yaml"]);
    // config/c.yaml is shown only as the setting: the card is the way to it
    expect(repeatsShownCode(config, focus)).toBe(false);
    // the same file also shown as code (a definition there): the card would only repeat it
    const shown = [...focus, { ...focus[0]!, file: "config/c.yaml", role: "definition" as const }];
    expect(repeatsShownCode(config, shown)).toBe(true);
    // a card from an edge or the index says how the files connect: kept
    expect(repeatsShownCode({ ...config, id: "edge:x" }, shown)).toBe(false);
  });

  it("two links to the same file of the same kind are one card, with both places in the code", () => {
    const card = (id: string, line: number) => ({
      id,
      kind: "loads" as const,
      label: "package.json",
      files: ["package.json"],
      evidence: [{ file: "src/cli.ts", line }],
      resolution: "static" as const,
    });
    const other = { ...card("c", 9), label: "config.yaml", files: ["config.yaml"] };
    const merged = mergeSameCards([card("a", 3), other, card("b", 7), card("d", 3)]);
    expect(merged.map((link) => link.id)).toEqual(["a", "c"]);
    expect(merged[0]!.evidence).toEqual([
      { file: "src/cli.ts", line: 3 },
      { file: "src/cli.ts", line: 7 },
    ]);
  });

  it("does not truncate annotated file collections at the editor focus limit", () => {
    const bundle = makeBundle();
    const files = Array.from({ length: 40 }, (_, i) => ({
      path: `plugins/${i}.ts`,
      language: "typescript" as const,
      hash: String(i),
      lines: 1,
    }));
    bundle.index = { ...bundle.index, files: [...bundle.index.files, ...files] };
    bundle.explainer.edges.push({
      id: "edge:plugins",
      from: "sym:src/a.ts#A.run",
      to: "dir:plugins",
      kind: "discovers",
      label: "Discover plugins",
      anchors: [],
      provenance: { origin: "user" },
    });
    expect(
      relatedFiles(["sym:src/a.ts#A.run"], new ExplainerModel(bundle.explainer, bundle.index)).find(
        (link) => link.id === "edge:plugins",
      )?.files,
    ).toHaveLength(40);
  });

  it("shows configuration anchors and grouped resource files with their evidence", () => {
    const bundle = makeBundle();
    bundle.index.resources = [
      {
        from: "src/a.ts#A.run",
        files: ["src/b.ts", "config/c.yaml"],
        kind: "discovers",
        pattern: "plugins/*",
        site: { startLine: 12, endLine: 12 },
        resolution: "inferred",
      },
    ];
    const model = new ExplainerModel(bundle.explainer, bundle.index);
    const links = relatedFiles(["sym:src/a.ts#A.run"], model);
    expect(links[0]).toMatchObject({
      kind: "discovers",
      files: ["src/b.ts", "config/c.yaml"],
      resolution: "inferred",
      evidence: [{ file: "src/a.ts", line: 12 }],
    });
    const config = relatedFiles(["concept:retry"], model);
    expect(config.some((link) => link.files.includes("config/c.yaml"))).toBe(true);
    expect(relatedFiles(["sym:src/a.ts#A.stop"], model)).toEqual([]);
  });
});
