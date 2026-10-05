import { describe, expect, it } from "vitest";
import { query, guideCatalog, pruneIndex, type Explainer } from "../src/index.js";
import { makeWorld } from "./helpers.js";

const guide: Explainer = {
  schema: "code-explainer@0",
  title: "How does retry work?",
  repo: { name: "jobs", commit: "old" },
  index: { path: ".explainer/index-old.json", commit: "old" },
  scope: { audience: "Queue maintainers" },
  nodes: [],
  edges: [],
  concepts: [
    {
      id: "concept:retry",
      label: "Retry policy",
      summary: "Requeue failed jobs",
      anchors: [],
      provenance: { origin: "llm" },
    },
  ],
  views: [
    {
      id: "view:retry",
      title: "Retry",
      type: "graph",
      scope: { root: "repo", depth: 3, question: "When do jobs return to the queue?" },
      include: [],
      provenance: { origin: "llm" },
    },
  ],
  tours: [
    {
      id: "tour:retry",
      title: "Retry lifecycle",
      summary: "Failures wait before requeue",
      steps: [
        {
          id: "retry-wait",
          view: "view:retry",
          focus: ["concept:retry"],
          note: "Wait with exponential backoff",
        },
      ],
    },
  ],
};

function world() {
  return makeWorld({
    files: [
      { path: "README.md", language: "text", text: "requeue" },
      { path: "config.yaml", language: "yaml", text: "requeue: true" },
      { path: "src/queue.ts", text: "// 🐈\r\n  requeue(job); requeue(other);\r\n" },
      { path: "src/hidden.ts", text: "hidden()" },
    ],
    symbols: [
      { id: "src/queue.ts#requeue", start: 2, end: 2 },
      { id: "src/hidden.ts#hidden", start: 1, end: 1 },
    ],
  });
}

describe("query", () => {
  it("counts matching lines before limiting, with exact columns and enclosing-symbol offsets", () => {
    const w = world();
    const result = query(w.index, w.getText, { pattern: "requeue", kinds: ["source"], limit: 1 });
    expect(result.total).toBe(3);
    expect(result.matchedFiles).toBe(3);
    expect(result.hits).toEqual([
      {
        kind: "source",
        file: "src/queue.ts",
        line: 2,
        range: { startLine: 2, endLine: 2, startCol: 3, endCol: 9 },
        id: "sym:src/queue.ts#requeue",
        offset: 0,
        text: "requeue(job); requeue(other);",
      },
    ]);
    const page = query(w.index, w.getText, {
      pattern: "requeue",
      kinds: ["source"],
      limit: 1,
      offset: 1,
    });
    expect(page.total).toBe(3);
    expect(page.hits).toEqual([
      {
        kind: "source",
        file: "config.yaml",
        line: 1,
        range: { startLine: 1, endLine: 1, startCol: 1, endCol: 7 },
        id: "file:config.yaml",
        offset: 0,
        text: "requeue: true",
      },
    ]);
    expect(() => query(w.index, w.getText, { pattern: "requeue", offset: -1 })).toThrow(
      "the search offset must be a non-negative integer",
    );
    const all = query(w.index, w.getText, { pattern: "requeue", kinds: ["source"], limit: 0 });
    expect(all.hits.map((h) => (h.kind === "source" ? h.file : ""))).toEqual([
      "src/queue.ts",
      "config.yaml",
      "README.md",
    ]);
  });

  it("searches only supplied indexed text and reports pruned analysis independently from no matches", () => {
    const w = world();
    const index = pruneIndex(w.index, { files: ["src/queue.ts"] }).index;
    const result = query(index, (f) => (f === "src/queue.ts" ? w.texts[f] : undefined), {
      pattern: "hidden",
      kinds: ["source", "symbol"],
      textOrigin: "supplied",
    });
    expect(result.hits).toEqual([]);
    expect(result.scope).toMatchObject({
      commit: "c1",
      textOrigin: "supplied",
      indexedFiles: ["README.md", "config.yaml", "src/hidden.ts", "src/queue.ts"],
      searchedFiles: ["src/queue.ts"],
      unavailableFiles: ["src/hidden.ts", "config.yaml", "README.md"],
      symbols: { retained: 1, total: 2 },
      analysis: undefined,
    });
    expect(
      query(index, () => undefined, { pattern: "requeue", kinds: ["source"] }).scope.searchedFiles,
    ).toEqual([]);
    expect(
      query(index, w.getText, { pattern: "hidden", kinds: ["source", "symbol"] }).hits,
    ).toEqual([
      {
        kind: "source",
        file: "src/hidden.ts",
        line: 1,
        id: "file:src/hidden.ts",
        offset: 0,
        text: "hidden()",
        range: { startLine: 1, endLine: 1, startCol: 1, endCol: 6 },
      },
    ]);
  });

  it("retains failed and unsupported analysis when source search works or symbol search is empty", () => {
    const w = world();
    w.index.analysis = [
      {
        provider: "parser",
        capabilities: { symbols: "supported" },
        files: ["src/queue.ts"],
        results: [
          {
            capabilities: ["symbols"],
            status: "failed",
            analyzedFiles: [],
            limitations: ["Could not parse this file."],
          },
        ],
      },
    ];
    const result = query(w.index, w.getText, { pattern: "requeue", kinds: ["source"] });
    expect(result.total).toBe(3);
    expect(result.scope.analysis).toEqual(w.index.analysis);
    w.index.analysis[0]!.results[0]!.status = "unsupported";
    const empty = query(w.index, w.getText, { pattern: "missing", kinds: ["symbol"] });
    expect(empty.hits).toEqual([]);
    expect(empty.scope.analysis?.[0]?.results[0]?.status).toBe("unsupported");
  });

  it("returns exact retained symbol ranges and stable concept/tour/step destinations", () => {
    const w = world();
    const guides = [{ id: "retry-guide", explainer: guide }];
    const symbols = query(w.index, w.getText, { pattern: "requeue", kinds: ["symbol"] });
    expect(symbols.hits).toEqual([
      {
        kind: "symbol",
        id: "sym:src/queue.ts#requeue",
        file: "src/queue.ts",
        range: { startLine: 2, endLine: 2 },
        text: "requeue",
      },
    ]);
    const page = query(w.index, w.getText, {
      pattern: "requeue",
      ignoreCase: true,
      kinds: ["concept", "tour"],
      guides,
      limit: 1,
      offset: 1,
    });
    expect(page.total).toBe(2);
    expect(page.hits).toEqual([
      {
        kind: "tour",
        guide: "retry-guide",
        commit: "old",
        tour: "tour:retry",
        text: "Retry lifecycle\nFailures wait before requeue",
      },
    ]);
    const phrase = query(w.index, w.getText, {
      pattern: "EXPONENTIAL BACKOFF",
      ignoreCase: true,
      guides,
    });
    expect(phrase.hits).toEqual([
      {
        kind: "step",
        guide: "retry-guide",
        commit: "old",
        tour: "tour:retry",
        step: "retry-wait",
        stepIndex: 0,
        view: "view:retry",
        focus: ["concept:retry"],
        text: "Wait with exponential backoff",
      },
    ]);
    expect(
      query(w.index, w.getText, {
        pattern: "requeue",
        ignoreCase: true,
        kinds: ["concept", "tour"],
        guides,
      }).hits.map((h) => h.kind),
    ).toEqual(["concept", "tour"]);
  });

  it("honors scoped lines, regex, code-only, and UTF-16 columns without trimming source", () => {
    const w = makeWorld({ files: [{ path: "a.ts", text: "  🐈 REQUEUE\r\nrequeue\r\n" }] });
    const result = query(w.index, w.getText, {
      pattern: "requeue",
      regex: true,
      ignoreCase: true,
      codeOnly: true,
      scope: { hasFile: (f) => f === "a.ts", hasLine: (_f, line) => line === 1 },
    });
    expect(result.hits).toEqual([
      {
        kind: "source",
        file: "a.ts",
        line: 1,
        id: "file:a.ts",
        offset: 0,
        text: "🐈 REQUEUE",
        range: { startLine: 1, endLine: 1, startCol: 6, endCol: 12 },
      },
    ]);
    expect(() => query(w.index, w.getText, { pattern: "(", regex: true })).toThrow(
      "invalid regular expression",
    );
  });

  it("keeps literal lower-case substring semantics and maps expanded casing back to source columns", () => {
    const w = makeWorld({ files: [{ path: "a.ts", text: "ΟΣ\nİ requeue" }] });
    expect(
      query(w.index, w.getText, { pattern: "σ", ignoreCase: true, kinds: ["source"] }).hits,
    ).toEqual([]);
    expect(
      query(w.index, w.getText, { pattern: "REQUEUE", ignoreCase: true, kinds: ["source"] }).hits,
    ).toEqual([
      {
        kind: "source",
        file: "a.ts",
        line: 2,
        id: "file:a.ts",
        offset: 1,
        text: "İ requeue",
        range: { startLine: 2, endLine: 2, startCol: 3, endCol: 9 },
      },
    ]);
  });
});

it("catalogs recorded questions, audience and snapshot without inferring scope from filenames", () => {
  const catalog = guideCatalog([{ id: "random-name", explainer: guide }]);
  expect(catalog).toEqual([
    {
      id: "random-name",
      title: "How does retry work?",
      audience: "Queue maintainers",
      questions: ["When do jobs return to the queue?"],
      roots: ["repo"],
      commit: "old",
      indexCommit: "old",
      kind: "question",
    },
  ]);
});

it("catalogs repository, subsystem and change guides from their recorded scope", () => {
  const repo: Explainer = {
    ...guide,
    views: [{ ...guide.views[0]!, scope: { root: "repo", depth: 1 } }],
  };
  const subsystem: Explainer = {
    ...repo,
    views: [{ ...repo.views[0]!, scope: { root: "dir:src/queue", depth: 2 } }],
  };
  const change: Explainer = {
    ...subsystem,
    change: { base: "base-sha", head: "head-sha", files: [] },
  };
  expect(
    guideCatalog([
      { id: "a", explainer: repo },
      { id: "b", explainer: subsystem },
      { id: "c", explainer: change },
      { id: "d", explainer: { ...guide, views: [] } },
    ]).map((g) => ({ kind: g.kind, roots: g.roots, change: g.change })),
  ).toEqual([
    { kind: "repository", roots: ["repo"], change: undefined },
    { kind: "subsystem", roots: ["dir:src/queue"], change: undefined },
    { kind: "change", roots: ["dir:src/queue"], change: { base: "base-sha", head: "head-sha" } },
    { kind: "unknown", roots: [], change: undefined },
  ]);
});
