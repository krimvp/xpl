/**
 * The commands are language-agnostic: the same workflow works on the Python and Go fixtures. Nothing
 * here asserts on their symbols (the language packs are the indexer's business), only that files,
 * config keys and file-level anchors flow through index, outline, show, search, apply, validate, bundle.
 */
import { describe, expect, it } from "vitest";
import { parseBundle } from "@xpl/core";
import {
  copyFixture,
  invoke,
  readFile,
  readJson,
  writeViewerStub,
  xpl,
  xplJson,
} from "./helpers.js";

const CASES = [
  { fixture: "py-jobrunner", language: "python" },
  { fixture: "go-jobrunner", language: "go" },
  { fixture: "rs-jobrunner", language: "rust" },
];

interface OutlineNode {
  id: string;
  type: string;
  kind: string;
  children?: OutlineNode[];
}

function files(node: OutlineNode): OutlineNode[] {
  return [
    ...(node.type === "file" ? [node] : []),
    ...(node.children ?? []).flatMap((child) => files(child)),
  ];
}

describe.each(CASES)("$fixture", ({ fixture, language }) => {
  it("index, outline, show and search work", async () => {
    const dir = copyFixture(fixture);
    const indexed = await xplJson<any>(dir, "index", "--precise", "off");
    expect(indexed.code).toBe(0);
    expect(indexed.json.languages[language].files).toBeGreaterThan(3);
    expect(indexed.json.languages.yaml.files).toBe(1);

    const outline = await xplJson<{ tree: OutlineNode }>(dir, "outline", "--depth", "4");
    expect(outline.code).toBe(0);
    const sources = files(outline.json.tree).filter((f) => f.kind === language);
    expect(sources.length).toBeGreaterThan(3);

    // show a source file: offsets are line - 1
    const source = sources[0]!.id;
    const shown = await xpl(dir, "show", source);
    expect(shown.code).toBe(0);
    expect(shown.out.split("\n")[0]).toMatch(new RegExp(`^${source} \\(${language}\\) `));
    expect(shown.out.split("\n")[1]).toMatch(/^ *1 +0│ /);
    expect(shown.out.split("\n").length).toBeGreaterThan(5);

    // config keys are symbols in every fixture
    const search = await xpl(dir, "search", "retry:");
    expect(search.code).toBe(0);
    expect(search.out).toMatch(
      /^config\/default\.yaml:\d+ {2}sym:config\/default\.yaml#retry \+0 {2}retry:$/m,
    );
    const keys = await xpl(dir, "show", "config/default.yaml#retry");
    expect(keys.out).toContain("maxRetries");
  });

  it("file-level anchors validate; bundle embeds every file", async () => {
    const dir = copyFixture(fixture);
    await xpl(dir, "index", "--precise", "off");
    const outline = await xplJson<{ tree: OutlineNode }>(dir, "outline", "--depth", "4");
    const source = files(outline.json.tree)
      .find((f) => f.kind === language)!
      .id.replace(/^file:/, "");

    expect((await xpl(dir, "new", "demo")).code).toBe(0);
    const patch = {
      concepts: [
        {
          id: "concept:retry",
          label: "Retries",
          summary: "Where the retry policy is configured and implemented.",
          anchors: [
            { file: "config/default.yaml", symbol: "retry", role: "config" },
            { file: source, role: "definition" },
          ],
        },
      ],
      views: [
        {
          id: "view:overview",
          type: "graph",
          title: "Overview",
          include: [`file:${source}`, "file:config/default.yaml"],
        },
      ],
    };
    const applied = await invoke(["apply", "demo", "-"], {
      cwd: dir,
      stdin: JSON.stringify(patch),
    });
    expect(applied.code, applied.out + applied.err).toBe(0);
    const validated = await xpl(dir, "validate", "demo");
    expect(validated.code).toBe(0);
    expect(validated.out).toMatch(/^ok:/);
    expect((await xplJson<any>(dir, "status", "demo")).json.views[0].id).toBe("view:overview");

    const viewer = writeViewerStub();
    const bundled = await invoke(["bundle", "demo", "-o", "out.html", "--root", dir], {
      cwd: dir,
      env: { XPL_VIEWER_HTML: viewer },
    });
    expect(bundled.code).toBe(0);
    const match = /<script id="xpl-data" type="application\/json">([\s\S]*?)<\/script>/.exec(
      readFile(dir, "out.html"),
    );
    const data = parseBundle(match![1]!);
    expect(Object.keys(data.files)).toContain(source);
    expect(data.files["config/default.yaml"]).toBe(readFile(dir, "config/default.yaml"));
    expect(readJson(dir, ".explainer/demo.explainer.json").concepts).toHaveLength(1);
  });
});

it("Rust symbols can be outlined, shown, anchored and exported with their support limits", async () => {
  const dir = copyFixture("rs-jobrunner");
  const indexed = await xpl(dir, "index", "--precise", "off");
  expect(indexed.code).toBe(0);
  expect(indexed.out).toContain("rust: named symbols, full declaration ranges, nesting partial");
  const outlined = await xpl(dir, "outline", "--under", "src/runner.rs", "--depth", "4");
  expect(outlined.code).toBe(0);
  expect(outlined.out).toContain("impl Runner<Q>.dispatch");
  const shown = await xpl(dir, "show", "sym:src/runner.rs#impl Runner<Q>.dispatch");
  expect(shown.code).toBe(0);
  expect(shown.out.split("\n")[0]).toContain("(method) src/runner.rs:65-101");
  expect(shown.out).toMatch(/^ *65 +0│ +pub fn dispatch\(&mut self\) \{$/m);
  expect((await xpl(dir, "new", "rust")).code).toBe(0);
  const applied = await invoke(["apply", "rust", "-"], {
    cwd: dir,
    stdin: JSON.stringify({
      concepts: [
        {
          id: "concept:dispatch",
          label: "Dispatch",
          summary: "Runs queued jobs and retries failed attempts.",
          anchors: [
            { file: "src/runner.rs", symbol: "impl Runner<Q>.dispatch", role: "definition" },
          ],
        },
      ],
      views: [
        {
          id: "view:rust",
          type: "graph",
          title: "Dispatch",
          include: ["sym:src/runner.rs#impl Runner<Q>.dispatch"],
        },
      ],
    }),
  });
  expect(applied.code, applied.out + applied.err).toBe(0);
  expect((await xpl(dir, "validate", "rust")).code).toBe(0);
  const anchors = await xpl(dir, "anchors", "rust", "concept:dispatch");
  expect(anchors.code).toBe(0);
  expect(anchors.out).toContain("src/runner.rs");
  const bundled = await invoke(["bundle", "rust", "-o", "rust.html"], {
    cwd: dir,
    env: { XPL_VIEWER_HTML: writeViewerStub() },
  });
  expect(bundled.code, bundled.out + bundled.err).toBe(0);
  const data = parseBundle(
    /<script id="xpl-data" type="application\/json">([\s\S]*?)<\/script>/.exec(
      readFile(dir, "rust.html"),
    )![1]!,
  );
  expect(data.files["src/runner.rs"]).toBe(readFile(dir, "src/runner.rs"));
  expect(
    data.index.symbols.find((s) => s.id === "src/runner.rs#impl Runner<Q>.dispatch"),
  ).toMatchObject({
    range: { startLine: 65, endLine: 101 },
    parent: "src/runner.rs#impl Runner<Q>",
  });
  expect(data.index.languages.rust).toEqual({ files: 9, symbols: 82, refs: "none" });
  expect(
    data.index.analysis?.find(
      (r) => r.provider === "rust-tags" && r.files.includes("src/runner.rs"),
    )?.results,
  ).toMatchObject([
    { status: "partial", analyzedFiles: expect.arrayContaining(["src/runner.rs"]) },
    { status: "unsupported", analyzedFiles: [] },
  ]);
});
