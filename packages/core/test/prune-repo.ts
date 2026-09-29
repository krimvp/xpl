/**
 * A synthetic repository with an explainer, larger and less tidy than the job runner world: `pruneIndex` is
 * checked on it (core's `prune.test.ts`) and so is the index an `xpl bundle` embeds (the CLI's
 * `bundle-prune.test.ts`). Deterministic: the same options always make the same repository.
 *
 *   - `packages` packages of `filesPerPackage` files each, plus `packages/big` with `bigFiles` files (more than
 *     the 50 files the viewer focuses for a directory), tests, a config file, a README;
 *   - per source file an interface (every third), a class with three methods and a nested class, functions and
 *     variables; references of every kind between them (calls, reads, writes, type references, imports from
 *     module scopes, extends, implements), most within a package, some across, some heuristic;
 *   - an explainer with groups (nested, with files, symbols and a directory as members), graph views of a
 *     directory that exceeds the focus cap, of groups, of nested symbols, with `excludeFiles`, `hidden`,
 *     every stub policy and edge kinds, a sequence view, stored edges (an overlay of a derived edge, an llm
 *     edge), concepts, anchors, and tours that focus derived edges no view draws and symbols no view includes.
 */
import {
  collectAnchors,
  deriveGraph,
  ExplainerModel,
  type Explainer,
  type Node,
  type Reference,
  type SequenceView,
  type Tour,
} from "@xpl/core";
import {
  anchor,
  concept,
  edge,
  emptyExplainer,
  graphView,
  group,
  makeWorld,
  sequenceView,
  type FileDecl,
  type RefDecl,
  type SymbolDecl,
  type World,
} from "./helpers.js";

export interface SyntheticOptions {
  seed?: number;
  /** Ordinary packages `p0..p<n-1>` (at least 5: the explainer names `p0` to `p4`). */
  packages?: number;
  filesPerPackage?: number;
  /** Files of `packages/big/src`: above 50, the directory has files the viewer does not focus. */
  bigFiles?: number;
}

export interface SyntheticRepo {
  world: World;
  explainer: Explainer;
  /** The files of every anchor of the explainer: the least a bundle embeds. */
  anchorFiles: string[];
}

/** mulberry32: a small seeded generator. */
function random(seed: number): () => number {
  let state = seed | 0;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface Source {
  path: string;
  /** Name suffix of its symbols. */
  name: string;
  pkg: string;
  callables: string[];
  variables: string[];
  types: string[];
  cls: string;
  iface?: string;
}

const LINES = 100;

function sourceSymbols(file: Source, out: SymbolDecl[]): void {
  const { path, name } = file;
  const id = (symbol: string) => `${path}#${symbol}`;
  if (file.iface) out.push({ id: id(file.iface), kind: "interface", start: 1, end: 4 });
  out.push({ id: id(file.cls), kind: "class", start: 6, end: 45 });
  for (const [i, [start, end]] of [
    [8, 15],
    [17, 25],
    [27, 35],
  ].entries()) {
    out.push({ id: id(`${file.cls}.m${i}`), kind: "method", start: start!, end: end! });
    file.callables.push(id(`${file.cls}.m${i}`));
  }
  out.push({ id: id(`${file.cls}.Inner`), kind: "class", start: 38, end: 44 });
  out.push({ id: id(`${file.cls}.Inner.run`), kind: "method", start: 40, end: 42 });
  file.callables.push(id(`${file.cls}.Inner.run`));
  for (const [i, [start, end]] of [
    [50, 58],
    [60, 70],
  ].entries()) {
    out.push({ id: id(`fn${name}${"AB"[i]}`), kind: "function", start: start!, end: end! });
    file.callables.push(id(`fn${name}${"AB"[i]}`));
  }
  for (const [i, line] of [72, 74].entries()) {
    out.push({
      id: id(i === 0 ? `CONST_${name}` : `state${name}`),
      kind: "variable",
      start: line!,
      end: line!,
    });
    file.variables.push(id(i === 0 ? `CONST_${name}` : `state${name}`));
  }
  file.types.push(id(file.cls), ...(file.iface ? [id(file.iface)] : []));
}

export function syntheticRepo(options: SyntheticOptions = {}): SyntheticRepo {
  const rand = random(options.seed ?? 7);
  const packages = Math.max(5, options.packages ?? 6);
  const perPackage = Math.max(8, options.filesPerPackage ?? 8);
  const bigFiles = Math.max(56, options.bigFiles ?? 60);
  const pick = <T>(list: readonly T[]): T => list[Math.floor(rand() * list.length)]!;

  // ─── Files and symbols ────────────────────────────────────────────────────────────────────────
  const files: FileDecl[] = [];
  const symbols: SymbolDecl[] = [];
  const sources: Source[] = [];
  const byPackage = new Map<string, Source[]>();
  const addSource = (pkg: string, dir: string, prefix: string, k: number) => {
    const name = `${pkg}_${k}`;
    const source: Source = {
      path: `packages/${dir}/src/${prefix}${k}.ts`,
      name,
      pkg,
      callables: [],
      variables: [],
      types: [],
      cls: `C${name}`,
      ...(k % 3 === 0 ? { iface: `I${name}` } : {}),
    };
    files.push({ path: source.path, lines: LINES });
    sourceSymbols(source, symbols);
    sources.push(source);
    byPackage.set(pkg, [...(byPackage.get(pkg) ?? []), source]);
  };
  for (let p = 0; p < packages; p++) {
    for (let k = 0; k < perPackage; k++) addSource(`p${p}`, `p${p}`, "f", k);
  }
  for (let k = 0; k < bigFiles; k++) addSource("big", "big", "g", k);
  const tests: { path: string; pkg: string; fn: string }[] = [];
  for (let p = 0; p < packages; p++) {
    for (let k = 0; k < 2; k++) {
      const path = `packages/p${p}/test/t${k}.test.ts`;
      files.push({ path, lines: 30 });
      symbols.push({ id: `${path}#test${k}`, kind: "function", start: 3, end: 20 });
      tests.push({ path, pkg: `p${p}`, fn: `${path}#test${k}` });
    }
  }
  files.push(
    { path: "README.md", lines: 12, language: "text" },
    { path: "package.json", lines: 8, language: "json" },
    { path: "config/app.yaml", lines: 10, language: "yaml" },
  );
  symbols.push(
    { id: "config/app.yaml#server", kind: "key", start: 1, end: 3 },
    { id: "config/app.yaml#server.port", kind: "key", start: 2, end: 2 },
    { id: "config/app.yaml#server.host", kind: "key", start: 3, end: 3 },
  );

  // ─── References ───────────────────────────────────────────────────────────────────────────────
  const refs: RefDecl[] = [];
  const range = new Map(symbols.map((s) => [s.id, s]));
  const lineIn = (id: string): number => {
    const s = range.get(id)!;
    return s.start + Math.floor(rand() * (s.end - s.start + 1));
  };
  const sourceIn = (pkg: string): Source => pick(byPackage.get(pkg)!);
  const otherPackage = (pkg: string): string =>
    pick([...byPackage.keys()].filter((name) => name !== pkg));
  for (const file of sources) {
    for (const from of file.callables) {
      const count = 1 + Math.floor(rand() * 4);
      for (let i = 0; i < count; i++) {
        const target = sourceIn(rand() < 0.7 ? file.pkg : otherPackage(file.pkg));
        const dice = rand();
        let kind: Reference["kind"] = "call";
        let to = pick(target.callables);
        if (dice >= 0.55 && dice < 0.75) {
          kind = "read";
          to = pick(target.variables);
        } else if (dice >= 0.75 && dice < 0.88) {
          kind = "type-ref";
          to = pick(target.types);
        } else if (dice >= 0.88 && dice < 0.94) {
          kind = "write";
          to = pick(target.variables);
        }
        if (to === from) continue;
        refs.push({
          from,
          to,
          kind,
          line: lineIn(from),
          resolution: rand() < 0.1 ? "heuristic" : "precise",
        });
      }
    }
    // imports from the module scope, whole modules and single symbols
    const imports = 1 + Math.floor(rand() * 4);
    for (let i = 0; i < imports; i++) {
      const target = sourceIn(rand() < 0.7 ? file.pkg : otherPackage(file.pkg));
      if (target === file) continue;
      refs.push({
        from: `${file.path}#`,
        to: rand() < 0.5 ? `${target.path}#` : pick(target.types),
        kind: "import",
        line: 1 + (i % 3),
      });
    }
    if (rand() < 0.15) {
      const target = sourceIn(file.pkg);
      refs.push({ from: `${file.path}#`, to: pick(target.callables), kind: "call", line: 90 });
    }
    if (file.iface) {
      refs.push({
        from: `${file.path}#${file.cls}`,
        to: `${file.path}#${file.iface}`,
        kind: "implements",
        line: 6,
      });
    }
    if (rand() < 0.2) {
      const target = sourceIn(file.pkg);
      if (target !== file) {
        refs.push({
          from: `${file.path}#${file.cls}`,
          to: `${target.path}#${target.cls}`,
          kind: "extends",
          line: 6,
        });
      }
    }
  }
  for (const test of tests) {
    const count = 2 + Math.floor(rand() * 3);
    for (let i = 0; i < count; i++) {
      const target = sourceIn(test.pkg);
      refs.push({ from: test.fn, to: pick(target.callables), kind: "call", line: 5 + i });
    }
    refs.push({ from: test.fn, to: pick(sourceIn(test.pkg).variables), kind: "read", line: 15 });
  }
  // a story the explainer tells (calls between named files, so that the derived edges have code behind them)
  const at = (pkg: string, k: number): Source => byPackage.get(pkg)![k]!;
  const story: [Source, Source][] = [
    [at("p0", 0), at("p1", 1)],
    [at("p3", 1), at("p3", 2)],
    [at("p4", 3), at("p1", 1)],
    [at("p2", 2), at("big", 5)],
  ];
  for (const [from, to] of story) {
    refs.push({ from: from.callables[0]!, to: to.callables[1]!, kind: "call", line: 10 });
    refs.push({ from: from.callables[3]!, to: to.callables[4]!, kind: "call", line: 41 });
  }

  const world = makeWorld({ commit: "synthetic", files, symbols, refs });

  // ─── The explainer ────────────────────────────────────────────────────────────────────────────
  const file = (pkg: string, k: number) => `file:${at(pkg, k).path}`;
  const sym = (pkg: string, k: number, symbol: string) => `sym:${at(pkg, k).path}#${symbol}`;
  const nodes: Node[] = [
    group("grp:core", [file("p0", 0), sym("p1", 1, at("p1", 1).cls), "grp:nested"]),
    group("grp:nested", [file("p2", 2), sym("p3", 0, at("p3", 0).callables[4]!.split("#")[1]!)]),
    group("grp:tests", ["dir:packages/p1/test"]),
    // an overlay whose anchors point elsewhere: the node's own file is not what its code focus shows
    {
      id: file("p4", 3),
      kind: "file",
      parent: "dir:packages/p4/src",
      label: "Four three",
      summary: "The fourth package's fourth file.",
      anchors: [
        anchor(world, { file: at("p0", 2).path, symbol: at("p0", 2).cls, role: "definition" }),
      ],
      provenance: { origin: "llm", commit: "synthetic" },
    },
    {
      id: sym("big", 55, at("big", 55).cls),
      kind: "symbol",
      parent: file("big", 55),
      label: "Big class",
      anchors: [
        anchor(world, { file: at("big", 54).path, symbol: at("big", 54).cls, role: "usage" }),
      ],
      provenance: { origin: "llm", commit: "synthetic" },
    },
  ];

  const overviewInclude = [
    "dir:packages/p0/src",
    "dir:packages/big/src",
    "grp:core",
    file("p4", 3),
  ];
  const flow: SequenceView = sequenceView(
    "view:flow",
    [sym("p0", 0, at("p0", 0).cls), file("p1", 1), "dir:packages/p2/src"],
    [
      {
        id: "flow:1",
        from: sym("p0", 0, at("p0", 0).cls),
        to: file("p1", 1),
        label: "call",
        kind: "call",
        anchors: [
          anchor(world, {
            file: at("p0", 0).path,
            symbol: at("p0", 0).callables[0]!.split("#")[1]!,
            role: "call-site",
          }),
          anchor(world, {
            file: at("p1", 1).path,
            symbol: at("p1", 1).callables[1]!.split("#")[1]!,
            role: "definition",
          }),
        ],
      },
      {
        id: "flow:2",
        from: file("p1", 1),
        to: "dir:packages/p2/src",
        label: "then",
        kind: "async",
        anchors: [],
      },
    ],
  );
  const explainerOf = (hidden: string[]): Explainer => {
    const views = [
      graphView("view:overview", overviewInclude, {
        excludeFiles: ["**/test/**"],
        ...(hidden.length > 0 ? { hidden } : {}),
      }),
      graphView("view:detail", [
        file("p1", 1),
        sym("p1", 1, at("p1", 1).cls),
        sym("p1", 1, `${at("p1", 1).cls}.m0`),
        sym("p2", 2, at("p2", 2).callables[4]!.split("#")[1]!),
        sym("p3", 0, `${at("p3", 0).cls}.Inner.run`),
      ]),
      graphView("view:everything-else", [file("p3", 4)], { stubs: { mode: "all" } }),
      graphView("view:quiet", ["dir:packages/p2/test", file("p2", 5)], {
        stubs: { mode: "none" },
        edgeKinds: ["calls", "imports", "reads"],
      }),
      graphView("view:few", [file("p4", 0), file("p4", 1)], {
        stubs: { mode: "top", max: 2 },
        excludeFiles: ["packages/p0/**"],
        edgeKinds: ["calls", "references", "writes", "extends", "implements"],
      }),
      flow,
    ];
    const tours: Tour[] = [
      {
        id: "tour:walk",
        title: "A walk",
        steps: [
          {
            id: "t1",
            view: "view:overview",
            focus: [file("p4", 3), "grp:core"],
            note: "Start here.",
          },
          {
            id: "t2",
            view: "view:overview",
            // a derived edge that no view draws: its code is computed from the references between the two files
            focus: [`edge:calls:${file("p3", 1)}->${file("p3", 2)}`],
            note: "An edge nobody drew.",
          },
          {
            id: "t3",
            view: "view:detail",
            // a symbol that no view includes
            focus: [sym("p3", 6, `${at("p3", 6).cls}.m1`), "concept:one"],
            editor: { primary: at("p3", 6).path },
          },
          {
            id: "t4",
            view: "view:flow",
            focus: ["flow:1", "flow:2"],
            code: [
              anchor(world, { file: at("p2", 1).path, symbol: at("p2", 1).cls, role: "usage" }),
            ],
          },
        ],
      },
    ];
    return emptyExplainer({
      title: "Synthetic",
      nodes,
      edges: [
        edge(
          `edge:calls:${file("p0", 0)}->${file("p1", 1)}`,
          file("p0", 0),
          file("p1", 1),
          [
            anchor(world, {
              file: at("p0", 0).path,
              symbol: at("p0", 0).callables[0]!.split("#")[1]!,
              role: "call-site",
            }),
            anchor(world, {
              file: at("p1", 1).path,
              symbol: at("p1", 1).callables[1]!.split("#")[1]!,
              role: "definition",
            }),
          ],
          { kind: "calls", label: "starts" },
        ),
        edge(
          "edge:wires",
          sym("p1", 1, `${at("p1", 1).cls}.m0`),
          sym("p4", 3, at("p4", 3).cls),
          [
            anchor(world, {
              file: at("p1", 1).path,
              symbol: `${at("p1", 1).cls}.m0`,
              role: "call-site",
            }),
            anchor(world, { file: at("p4", 3).path, symbol: at("p4", 3).cls, role: "definition" }),
          ],
          { kind: "emits", label: "wires" },
        ),
      ],
      concepts: [
        concept(
          "concept:one",
          [anchor(world, { file: at("p0", 3).path, symbol: at("p0", 3).cls, role: "definition" })],
          { related: [file("p4", 3), "grp:core", "flow:1"] },
        ),
      ],
      views,
      tours,
    });
  };

  // `hidden` names ids that only exist once the view is derived: one derived edge, one ghost, one stub
  const model = new ExplainerModel(explainerOf([]), world.model);
  const overviewView = model.view("view:overview");
  if (overviewView?.type !== "graph") throw new Error("the overview is a graph view");
  const overview = deriveGraph(overviewView, model);
  const hidden = [overview.edges[1]?.id, overview.ghosts[0]?.id, overview.stubs[2]?.id].filter(
    (id): id is string => typeof id === "string",
  );
  const explainer = explainerOf(hidden);

  const anchorFiles = new Set(collectAnchors(explainer).map((site) => site.anchor.file));
  return { world, explainer, anchorFiles: [...anchorFiles].sort() };
}
