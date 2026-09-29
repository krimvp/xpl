/**
 * A small hand-made repo for the unit tests: three files, a handful of symbols and references, and an
 * explainer with a group, a stored edge, a concept, a graph view and a sequence view. No indexer, no disk.
 */
import {
  applyPatch,
  BUNDLE_SCHEMA,
  createExplainer,
  hashText,
  INDEX_SCHEMA,
  sliceLines,
  splitLines,
  type ExplainerPatch,
  type IndexedFile,
  type IndexedSymbol,
  type Reference,
  type SymbolIndex,
  type ViewerBundle,
} from "@xpl/core";

const lines = (n: number, overrides: Record<number, string> = {}) =>
  Array.from({ length: n }, (_, i) => overrides[i + 1] ?? `line ${i + 1};`).join("\n");

export const TEXTS: Record<string, string> = {
  "src/a.ts": lines(30, { 12: "this.b.go(1);", 25: "this.b.go(2);" }),
  "src/b.ts": lines(20),
  "config/c.yaml": lines(6),
};

const range = (startLine: number, endLine: number) => ({ startLine, endLine });

function symbol(
  file: string,
  path: string,
  kind: IndexedSymbol["kind"],
  start: number,
  end: number,
  parent?: string,
): IndexedSymbol {
  return {
    id: `${file}#${path}`,
    file,
    path,
    kind,
    range: range(start, end),
    hash: hashText(sliceLines(TEXTS[file]!, range(start, end))),
    ...(parent ? { parent } : {}),
  };
}

const ref = (
  from: string,
  to: string,
  kind: Reference["kind"],
  line: number,
  resolution: Reference["resolution"] = "precise",
): Reference => ({
  from,
  to,
  kind,
  site: { startLine: line, endLine: line, startCol: 1, endCol: 13 },
  resolution,
});

export function makeIndex(): SymbolIndex {
  const files: IndexedFile[] = Object.entries(TEXTS).map(([path, text]) => ({
    path,
    language: path.endsWith(".yaml") ? "yaml" : "typescript",
    hash: hashText(text),
    lines: splitLines(text).length,
  }));
  return {
    schema: INDEX_SCHEMA,
    commit: "t1",
    tool: "test",
    languages: {},
    files,
    symbols: [
      symbol("src/a.ts", "A", "class", 1, 30),
      symbol("src/a.ts", "A.run", "method", 5, 20, "src/a.ts#A"),
      symbol("src/a.ts", "A.stop", "method", 22, 28, "src/a.ts#A"),
      symbol("src/b.ts", "B", "class", 1, 20),
      symbol("src/b.ts", "B.go", "method", 3, 10, "src/b.ts#B"),
      symbol("config/c.yaml", "retry", "key", 2, 4),
    ],
    refs: [
      ref("src/a.ts#A.run", "src/b.ts#B.go", "call", 12),
      ref("src/a.ts#A.stop", "src/b.ts#B.go", "call", 25, "heuristic"),
      ref("src/a.ts#A.stop", "src/a.ts#A.run", "call", 26),
    ],
  };
}

/** Three steps: a graph view; a sequence view with `primary`; a code override that does not dim. */
export const TOUR = {
  id: "tour:demo",
  title: "Demo",
  steps: [
    { id: "t1", view: "view:overview", focus: ["grp:core"], note: "Start with the **core**." },
    {
      id: "t2",
      view: "view:flow",
      focus: ["flow:1", "concept:retry"],
      note: "How A reaches B.",
      editor: { primary: "src/b.ts" },
    },
    {
      id: "t3",
      view: "view:flow",
      focus: ["flow:2"],
      code: [{ file: "config/c.yaml", symbol: "retry", role: "config" as const }],
      editor: { dimOthers: false, hideFileTree: false },
    },
  ],
};

export const PATCH: ExplainerPatch = {
  nodes: [
    {
      id: "grp:core",
      kind: "group",
      label: "Core",
      summary: "A and B together.",
      members: ["file:src/a.ts", "file:src/b.ts"],
    },
  ],
  edges: [
    {
      id: "edge:notifies",
      from: "file:src/a.ts",
      to: "file:config/c.yaml",
      kind: "emits",
      label: "notifies",
      anchors: [
        { file: "src/a.ts", symbol: "A.run", span: { from: 7, to: 7 }, role: "call-site" },
        { file: "config/c.yaml", symbol: "retry", role: "config" },
      ],
    },
  ],
  concepts: [
    {
      id: "concept:retry",
      label: "Retry",
      summary: "Tries again.",
      anchors: [
        { file: "src/a.ts", symbol: "A.run", span: { from: 2, to: 4 }, role: "definition" },
        { file: "config/c.yaml", symbol: "retry", role: "config" },
      ],
      related: ["sym:src/a.ts#A.run", "file:src/b.ts"],
    },
  ],
  views: [
    {
      id: "view:overview",
      type: "graph",
      title: "Overview",
      scope: { root: "repo", depth: 1 },
      include: ["grp:core", "file:config/c.yaml"],
    },
    {
      id: "view:flow",
      type: "sequence",
      title: "Flow",
      scope: { root: "repo", depth: 2, question: "How does A reach B?" },
      participants: ["sym:src/a.ts#A.run", "file:src/b.ts"],
      steps: [
        {
          id: "flow:1",
          from: "sym:src/a.ts#A.run",
          to: "file:src/b.ts",
          label: "go(1)",
          kind: "call",
          anchors: [
            { file: "src/a.ts", symbol: "A.run", span: { from: 7, to: 7 }, role: "call-site" },
            { file: "src/b.ts", symbol: "B.go", role: "definition" },
          ],
        },
        {
          id: "flow:2",
          from: "file:src/b.ts",
          to: "sym:src/a.ts#A.run",
          label: "ok",
          kind: "return",
          anchors: [],
        },
      ],
    },
  ],
  tours: [TOUR],
};

export function makeBundle(extra: Partial<ViewerBundle> = {}): ViewerBundle {
  const index = makeIndex();
  const base = createExplainer({
    title: "Test repo",
    repoName: "acme/test",
    index,
    indexPath: ".explainer/index-t1.json",
  });
  const result = applyPatch(base, PATCH, index, (file) => TEXTS[file], { actor: "llm" });
  if (!result.ok) {
    throw new Error(`test explainer does not apply: ${JSON.stringify(result.issues, null, 1)}`);
  }
  return {
    schema: BUNDLE_SCHEMA,
    explainer: result.explainer,
    index,
    files: { ...TEXTS },
    ...extra,
  };
}
