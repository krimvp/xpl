import { describe, expect, it } from "vitest";
import { explainerFileName, serializeExplainer, withViewFields } from "../src/edits.js";
import { makeBundle } from "./world.js";

describe("withViewFields", () => {
  const explainer = makeBundle().explainer;

  it("changes the fields of one view, leaves the input and the other views alone", () => {
    const next = withViewFields(explainer, "view:overview", { include: ["grp:core"] });
    expect(next).not.toBe(explainer);
    const before = explainer.views.find((v) => v.id === "view:overview")!;
    const after = next.views.find((v) => v.id === "view:overview")!;
    expect(before.type === "graph" && before.include).toEqual(["grp:core", "file:config/c.yaml"]);
    expect(after.type === "graph" && after.include).toEqual(["grp:core"]);
    expect(next.views.find((v) => v.id === "view:flow")).toBe(
      explainer.views.find((v) => v.id === "view:flow"),
    );
  });

  it("marks the changed fields as edited by the user, like applyPatch does for a user actor", () => {
    const once = withViewFields(explainer, "view:overview", { include: ["grp:core"] });
    const twice = withViewFields(once, "view:overview", { edgeKinds: ["calls"], include: [] });
    const view = twice.views.find((v) => v.id === "view:overview")!;
    expect(view.provenance).toEqual({
      origin: "llm",
      commit: "t1",
      userFields: ["include", "edgeKinds"],
    });
  });

  it("does not add userFields to a view the user made", () => {
    const owned = {
      ...explainer,
      views: explainer.views.map((v) =>
        v.id === "view:overview" ? { ...v, provenance: { origin: "user" as const } } : v,
      ),
    };
    const next = withViewFields(owned, "view:overview", { include: [] });
    expect(next.views.find((v) => v.id === "view:overview")!.provenance).toEqual({
      origin: "user",
    });
  });

  it("is a no-op without fields", () => {
    expect(withViewFields(explainer, "view:overview", {})).toBe(explainer);
  });
});

describe("export", () => {
  it("names the file after the repo and ends the JSON with a newline", () => {
    const explainer = makeBundle().explainer;
    expect(explainerFileName(explainer)).toBe("test.explainer.json");
    expect(
      explainerFileName({ ...explainer, repo: { ...explainer.repo, name: "" }, title: "A b/c" }),
    ).toBe("c.explainer.json");
    expect(
      explainerFileName({ ...explainer, repo: { ...explainer.repo, name: "" }, title: "" }),
    ).toBe("explainer.explainer.json");
    const text = serializeExplainer(explainer);
    expect(text.endsWith("}\n")).toBe(true);
    expect(JSON.parse(text)).toEqual(explainer);
  });
});
