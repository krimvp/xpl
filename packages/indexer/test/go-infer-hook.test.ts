/**
 * The framework side of `LanguagePack.inferRefs` (types.ts, build.ts), driven through the Go pack: what the hook
 * is given and what the framework does with what it returns.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { goPack } from "../src/index.js";
import type { InferRefsInput, InferredRef } from "../src/languages/types.js";
import { isGoFileData } from "../src/languages/go/signature.js";
import { indexFiles } from "./helpers.js";

afterEach(() => {
  vi.restoreAllMocks();
});

const src = (...lines: string[]): string => lines.join("\n") + "\n";

const files = {
  "a.go": src("package p", "func A() { B() }", "func B() {}"),
  "b.go": src("package p", "type T struct{}", "func (T) M() {}"),
  "x.ts": "export function f() { g(); }\nfunction g() {}\n",
};

describe("inferRefs hook: what the pack is given", () => {
  it("is called once per build with the pack's files, every symbol and the resolved references", async () => {
    const spy = vi.spyOn(goPack, "inferRefs").mockImplementation(() => []);
    await indexFiles(files);
    expect(spy).toHaveBeenCalledTimes(1);
    const input: InferRefsInput = spy.mock.calls[0]![0];
    // only the Go files, in build (path) order, with what `extract` returned
    expect(input.files.map((f) => f.path)).toEqual(["a.go", "b.go"]);
    expect(input.files.every((f) => f.pack === goPack && f.language === "go")).toBe(true);
    expect(input.files[0]!.sites.some((s) => s.name === "B")).toBe(true);
    // pack-private data comes back untouched
    expect(input.files.every((f) => isGoFileData(f.data))).toBe(true);
    // symbols of every language, with a lookup over them
    expect(input.entries.map((e) => e.symbol.file)).toContain("x.ts");
    expect(input.lookup.get("a.go#A")).toBeDefined();
    expect(input.repo.files.has("x.ts")).toBe(true);
    // the references of every language the heuristic resolver produced
    expect(input.refs.map((r) => `${r.from} -> ${r.to}`)).toEqual(
      expect.arrayContaining(["a.go#A -> a.go#B", "x.ts#f -> x.ts#g"]),
    );
  });

  it("is not called when the repository has no file of the pack", async () => {
    const spy = vi.spyOn(goPack, "inferRefs").mockImplementation(() => []);
    await indexFiles({ "x.ts": files["x.ts"] });
    expect(spy).not.toHaveBeenCalled();
  });

  it("is not called for a language whose references are not derived at all", async () => {
    const spy = vi.spyOn(goPack, "inferRefs").mockImplementation(() => []);
    // the Go files are filtered out of the build: the pack has nothing to infer from
    await indexFiles(files, { languages: ["typescript"] });
    expect(spy).not.toHaveBeenCalled();
  });
});

describe("inferRefs hook: what happens to the result", () => {
  it("references are marked heuristic; self-references and duplicates (of each other and of resolved ones) are dropped", async () => {
    let existing: InferredRef | undefined;
    vi.spyOn(goPack, "inferRefs").mockImplementation((input) => {
      existing = input.refs.find((r) => r.from === "a.go#A")!;
      const fresh: InferredRef = {
        from: "b.go#T",
        to: "a.go#B",
        kind: "implements",
        site: { startLine: 2, startCol: 6, endLine: 2, endCol: 6 },
      };
      return [
        fresh,
        { ...fresh, site: { ...fresh.site } }, // the same ref again
        { ...fresh, to: "b.go#T" }, // a self-reference
        { from: existing.from, to: existing.to, kind: existing.kind, site: existing.site }, // already there
      ];
    });
    const { index } = await indexFiles(files);
    const implemented = index.refs.filter((r) => r.kind === "implements");
    expect(implemented).toEqual([
      {
        from: "b.go#T",
        to: "a.go#B",
        kind: "implements",
        site: { startLine: 2, startCol: 6, endLine: 2, endCol: 6 },
        resolution: "heuristic",
      },
    ]);
    expect(index.refs.filter((r) => r.from === "a.go#A" && r.to === "a.go#B")).toHaveLength(1);
  });

  it("inferred references are sorted in with the others", async () => {
    vi.spyOn(goPack, "inferRefs").mockImplementation(() => [
      { from: "a.go#B", to: "a.go#A", kind: "implements", site: { startLine: 1, endLine: 1 } },
    ]);
    const { index } = await indexFiles(files);
    const goRefs = index.refs.filter((r) => r.from.startsWith("a.go#"));
    const lines = goRefs.map((r) => r.site.startLine);
    expect(lines).toEqual([...lines].sort((a, b) => a - b));
    expect(goRefs[0]).toMatchObject({ kind: "implements", from: "a.go#B" });
  });

  it("a pack without the hook is untouched", async () => {
    const original = goPack.inferRefs;
    try {
      (goPack as { inferRefs?: typeof original }).inferRefs = undefined;
      const { index } = await indexFiles(files);
      expect(index.refs.some((r) => r.kind === "implements")).toBe(false);
      expect(index.refs.some((r) => r.from === "a.go#A" && r.to === "a.go#B")).toBe(true);
    } finally {
      goPack.inferRefs = original;
    }
  });
});
