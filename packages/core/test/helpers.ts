/**
 * Test fixtures: build a `SymbolIndex` and a `getText` from inline file contents and declared
 * symbols / references. Hashes are computed with the real `hashText` / `sliceLines`, so anchors made
 * against a world resolve exactly like they would against a real index.
 */
import {
  hashText,
  IndexModel,
  makeAnchor,
  sliceLines,
  splitLines,
  EXPLAINER_SCHEMA,
  INDEX_SCHEMA,
  type Anchor,
  type AnchorInput,
  type Concept,
  type Edge,
  type Explainer,
  type FileLanguage,
  type GetText,
  type GraphView,
  type IndexedFile,
  type IndexedSymbol,
  type Node,
  type Provenance,
  type Reference,
  type SequenceView,
  type SymbolIndex,
} from "../src/index.js";

export interface FileDecl {
  path: string;
  /** Full text. Default: `lines` filler lines. */
  text?: string;
  lines?: number;
  language?: FileLanguage;
}

export interface SymbolDecl {
  /** `"<file>#<symbol path>"`. */
  id: string;
  kind?: IndexedSymbol["kind"];
  /** 1-based inclusive lines. */
  start: number;
  end: number;
  /** Parent symbol id; inferred from the path (`A.b` -> `A`) when that symbol is declared. */
  parent?: string;
}

export interface RefDecl {
  /** A symbol id, or a module scope `"<file>#"`. */
  from: string;
  to: string;
  kind?: Reference["kind"];
  line: number;
  endLine?: number;
  resolution?: Reference["resolution"];
}

export interface WorldDecl {
  commit?: string;
  files: FileDecl[];
  symbols?: SymbolDecl[];
  refs?: RefDecl[];
}

export interface World {
  index: SymbolIndex;
  model: IndexModel;
  /** Current file texts (mutable: replace an entry to simulate an edit, then rebuild the index). */
  texts: Record<string, string>;
  getText: GetText;
}

/** `total` lines; `overrides` sets given (1-based) lines, the rest are `// <n>` filler. */
export function textWith(total: number, overrides: Record<number, string> = {}): string {
  const lines: string[] = [];
  for (let n = 1; n <= total; n++) lines.push(overrides[n] ?? `// ${n}`);
  return lines.join("\n");
}

export function splitId(id: string): { file: string; path: string } {
  const at = id.indexOf("#");
  return { file: id.slice(0, at), path: id.slice(at + 1) };
}

export function makeWorld(decl: WorldDecl): World {
  const texts: Record<string, string> = {};
  const files: IndexedFile[] = decl.files.map((f) => {
    const text = f.text ?? textWith(f.lines ?? 10);
    texts[f.path] = text;
    return {
      path: f.path,
      language: f.language ?? "typescript",
      hash: hashText(text),
      lines: splitLines(text).length,
    };
  });
  const declared = new Set((decl.symbols ?? []).map((s) => s.id));
  const symbols: IndexedSymbol[] = (decl.symbols ?? []).map((s) => {
    const { file, path } = splitId(s.id);
    const inferredParent =
      path.includes(".") && declared.has(`${file}#${path.slice(0, path.lastIndexOf("."))}`)
        ? `${file}#${path.slice(0, path.lastIndexOf("."))}`
        : undefined;
    const parent = s.parent ?? inferredParent;
    const range = { startLine: s.start, endLine: s.end };
    return {
      id: s.id,
      file,
      path,
      kind: s.kind ?? (parent ? "method" : "function"),
      range,
      hash: hashText(sliceLines(texts[file]!, range)),
      ...(parent ? { parent } : {}),
    };
  });
  const refs: Reference[] = (decl.refs ?? []).map((r) => ({
    from: r.from,
    to: r.to,
    kind: r.kind ?? "call",
    site: { startLine: r.line, endLine: r.endLine ?? r.line, startCol: 5, endCol: 30 },
    resolution: r.resolution ?? "precise",
  }));
  const index: SymbolIndex = {
    schema: INDEX_SCHEMA,
    commit: decl.commit ?? "c1",
    tool: "test",
    languages: {},
    files,
    symbols,
    refs,
  };
  return { index, model: new IndexModel(index), texts, getText: (f) => texts[f] };
}

// ─── The job runner world (shaped like the handoff example) ─────────────────────────────────────

/** `Runner.dispatch` is lines 42-88 of runner.ts, as in the handoff example. */
export const RUNNER_TEXT = textWith(100, {
  42: "  async dispatch(): Promise<void> {",
  46: "      const job = await this.queue.pop();",
  60: "        result = await worker.run(",
  61: "          job, { timeoutMs: this.config.timeoutMs });",
  72: "      // Retry policy: exponential backoff up to maxRetries, then dead-letter.",
  73: "      const attempts = job.attempts + 1;",
  74: "      if (attempts <= this.config.retry.maxRetries) {",
  75: "        const backoff = backoffDelay(attempts, this.config.retry);",
  76: "        await this.queue.requeue(",
  77: "          job,",
  78: "          backoff);",
  79: "      } else {",
  80: "        await this.queue.deadLetter(job, result.error);",
  88: "  }",
});

export const JOBRUNNER: WorldDecl = {
  files: [
    { path: "src/runner.ts", text: RUNNER_TEXT },
    { path: "src/queue.ts", lines: 60 },
    { path: "src/worker.ts", lines: 40 },
    { path: "src/metrics.ts", lines: 20 },
    { path: "src/util/sleep.ts", lines: 5 },
    { path: "config/default.yaml", lines: 20, language: "yaml" },
    { path: "test/retry.test.ts", lines: 30 },
  ],
  symbols: [
    { id: "src/runner.ts#Runner", kind: "class", start: 10, end: 95 },
    { id: "src/runner.ts#Runner.start", start: 20, end: 28 },
    { id: "src/runner.ts#Runner.stop", start: 30, end: 40 },
    { id: "src/runner.ts#Runner.dispatch", start: 42, end: 88 },
    { id: "src/runner.ts#Runner.log", start: 90, end: 93 },
    { id: "src/runner.ts#backoffDelay", kind: "function", start: 97, end: 100 },
    { id: "src/queue.ts#Queue", kind: "class", start: 1, end: 58 },
    { id: "src/queue.ts#Queue.pop", start: 5, end: 15 },
    { id: "src/queue.ts#Queue.requeue", start: 17, end: 30 },
    { id: "src/queue.ts#Queue.ack", start: 32, end: 40 },
    { id: "src/queue.ts#Queue.deadLetter", start: 42, end: 55 },
    { id: "src/worker.ts#Worker", kind: "class", start: 1, end: 38 },
    { id: "src/worker.ts#Worker.run", start: 5, end: 36 },
    { id: "src/metrics.ts#onJobCompleted", kind: "function", start: 3, end: 15 },
    { id: "src/util/sleep.ts#sleep", kind: "function", start: 1, end: 5 },
    { id: "config/default.yaml#retry", kind: "key", start: 13, end: 16 },
    { id: "config/default.yaml#retry.maxRetries", kind: "key", start: 14, end: 14 },
    { id: "config/default.yaml#retry.backoffMs", kind: "key", start: 15, end: 15 },
  ],
  refs: [
    { from: "src/runner.ts#Runner.dispatch", to: "src/queue.ts#Queue.pop", line: 46 },
    {
      from: "src/runner.ts#Runner.dispatch",
      to: "src/worker.ts#Worker.run",
      line: 60,
      endLine: 61,
    },
    {
      from: "src/runner.ts#Runner.dispatch",
      to: "src/queue.ts#Queue.requeue",
      line: 76,
      endLine: 78,
    },
    { from: "src/runner.ts#Runner.dispatch", to: "src/queue.ts#Queue.ack", line: 68 },
    { from: "src/runner.ts#Runner.dispatch", to: "src/queue.ts#Queue.deadLetter", line: 80 },
    {
      from: "src/runner.ts#Runner.dispatch",
      to: "src/util/sleep.ts#sleep",
      line: 48,
      resolution: "heuristic",
    },
    { from: "src/runner.ts#Runner.dispatch", to: "src/runner.ts#backoffDelay", line: 75 },
    { from: "src/runner.ts#Runner.start", to: "src/runner.ts#Runner.dispatch", line: 22 },
    { from: "src/runner.ts#", to: "src/queue.ts#Queue", kind: "import", line: 2 },
    { from: "src/runner.ts#", to: "src/worker.ts#Worker", kind: "import", line: 3 },
    { from: "src/worker.ts#Worker.run", to: "src/util/sleep.ts#sleep", line: 20 },
    { from: "src/metrics.ts#onJobCompleted", to: "src/queue.ts#Queue", kind: "type-ref", line: 5 },
  ],
};

export function jobrunner(overrides: Partial<WorldDecl> = {}): World {
  return makeWorld({ ...JOBRUNNER, ...overrides });
}

// ─── Explainer builders ─────────────────────────────────────────────────────────────────────────

export const LLM: Provenance = { origin: "llm", commit: "c1" };
export const USER: Provenance = { origin: "user" };

export function emptyExplainer(over: Partial<Explainer> = {}): Explainer {
  return {
    schema: EXPLAINER_SCHEMA,
    title: "Test",
    repo: { name: "acme/jobrunner", commit: "c1" },
    index: { path: ".explainer/index-c1.json", commit: "c1" },
    nodes: [],
    edges: [],
    concepts: [],
    views: [],
    tours: [],
    ...over,
  };
}

/** A stored anchor made by `makeAnchor` (throws when the input is invalid). */
export function anchor(world: World, input: AnchorInput): Anchor {
  const made = makeAnchor(input, world.index, world.getText);
  if (!made.ok) throw new Error(`anchor(${JSON.stringify(input)}): ${made.error}`);
  return made.anchor;
}

export function group(id: string, members: string[], over: Partial<Node> = {}): Node {
  return {
    id,
    kind: "group",
    parent: "repo",
    label: id.replace(/^grp:/, ""),
    members,
    anchors: [],
    provenance: LLM,
    ...over,
  };
}

export function concept(id: string, anchors: Anchor[] = [], over: Partial<Concept> = {}): Concept {
  return { id, label: id.replace(/^concept:/, ""), anchors, provenance: LLM, ...over };
}

export function edge(
  id: string,
  from: string,
  to: string,
  anchors: Anchor[] = [],
  over: Partial<Edge> = {},
): Edge {
  return {
    id,
    from,
    to,
    kind: "emits",
    label: id.replace(/^edge:/, ""),
    anchors,
    provenance: LLM,
    ...over,
  };
}

export function graphView(id: string, include: string[], over: Partial<GraphView> = {}): GraphView {
  return {
    id,
    type: "graph",
    title: id,
    scope: { root: "repo", depth: 1 },
    include,
    provenance: LLM,
    ...over,
  };
}

export function sequenceView(
  id: string,
  participants: string[],
  steps: SequenceView["steps"],
  over: Partial<SequenceView> = {},
): SequenceView {
  return {
    id,
    type: "sequence",
    title: id,
    scope: { root: "repo", depth: 1 },
    participants,
    steps,
    provenance: LLM,
    ...over,
  };
}
