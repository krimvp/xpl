/** The same mutation sequences run in vitest and the reproduce script, against whole clean indexes. */
import { deepStrictEqual } from "node:assert";
import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { BuildIndexResult } from "../packages/indexer/src/build.js";
import { buildIndex } from "../packages/indexer/src/index.js";
import { TypeScriptResolutionExperiment } from "../packages/indexer/src/resolve/typescript-experiment.js";

interface Mutation {
  name: string;
  files?: Record<string, string | null>;
  calls: Record<string, string[]>;
  fallback?: string;
}

interface Scenario {
  name: string;
  files: Record<string, string>;
  git?: boolean;
  mutations: Mutation[];
}

const alpha = "export class Alpha { run() {} }";
const beta = "export class Beta { run() {} }";

export const mutationScenarios: Scenario[] = [
  {
    name: "declarations-and-reexports",
    files: {
      "lib/a.ts": "export function Alpha() {}",
      "lib/b.ts": "export function Beta() {}",
      "barrel/index.ts": 'export { Alpha as run } from "../lib/a";',
      "app/caller.ts": 'import { run } from "../barrel"; export function caller() { run(); }',
      "isolated/a.ts": "export function alone() {}",
    },
    mutations: [
      { name: "baseline", calls: { "app/caller.ts#caller": ["lib/a.ts#Alpha"] } },
      { name: "unchanged", calls: { "app/caller.ts#caller": ["lib/a.ts#Alpha"] }, fallback: "" },
      {
        name: "remove-declaration",
        files: { "lib/a.ts": "export function Other() {}" },
        calls: { "app/caller.ts#caller": [] },
        fallback: "",
      },
      {
        name: "add-declaration",
        files: { "lib/a.ts": "export function Alpha() {}" },
        calls: { "app/caller.ts#caller": ["lib/a.ts#Alpha"] },
        fallback: "",
      },
      {
        name: "redirect-reexport",
        files: { "barrel/index.ts": 'export { Beta as run } from "../lib/b";' },
        calls: { "app/caller.ts#caller": ["lib/b.ts#Beta"] },
        fallback: "",
      },
      {
        name: "star-reexport",
        files: {
          "lib/a.ts": "export function run() {}",
          "barrel/index.ts": 'export * from "../lib/a";',
        },
        calls: { "app/caller.ts#caller": ["lib/a.ts#run"] },
        fallback: "",
      },
      {
        name: "cyclic-reexport",
        files: {
          "barrel/cycle.ts": 'export * from "./index";',
          "barrel/index.ts": 'export * from "./cycle"; export * from "../lib/a";',
        },
        calls: { "app/caller.ts#caller": ["lib/a.ts#run"] },
        fallback: "file discovery changed",
      },
      {
        name: "cycle-stale-edge",
        files: { "lib/a.ts": "export function Other() {}" },
        calls: { "app/caller.ts#caller": [] },
        fallback: "",
      },
    ],
  },
  {
    name: "types-and-inheritance",
    files: {
      "types/alpha.ts": alpha,
      "types/beta.ts": beta,
      "factory/index.ts":
        'import { Alpha } from "../types/alpha"; import { Beta } from "../types/beta"; export function create(): Alpha { throw 0; }',
      "child/index.ts":
        'import { Alpha } from "../types/alpha"; import { Beta } from "../types/beta"; export class Child extends Alpha {}',
      "app/caller.ts":
        'import { create } from "../factory"; export function caller() { const value = create(); value.run(); }',
      "app/child.ts":
        'import { Child } from "../child"; export function caller(value: Child) { value.run(); }',
      "isolated/a.ts": "export function alone() {}",
    },
    mutations: [
      {
        name: "baseline",
        calls: {
          "app/caller.ts#caller": ["factory/index.ts#create", "types/alpha.ts#Alpha.run"],
          "app/child.ts#caller": ["types/alpha.ts#Alpha.run"],
        },
      },
      {
        name: "return-type",
        files: {
          "factory/index.ts":
            'import { Alpha } from "../types/alpha"; import { Beta } from "../types/beta"; export function create(): Beta { throw 0; }',
        },
        calls: { "app/caller.ts#caller": ["factory/index.ts#create", "types/beta.ts#Beta.run"] },
        fallback: "",
      },
      {
        name: "base-class",
        files: {
          "child/index.ts":
            'import { Alpha } from "../types/alpha"; import { Beta } from "../types/beta"; export class Child extends Beta {}',
        },
        calls: { "app/child.ts#caller": ["types/beta.ts#Beta.run"] },
        fallback: "",
      },
      {
        name: "remove-inherited-method",
        files: { "types/beta.ts": "export class Beta { other() {} }" },
        calls: { "app/caller.ts#caller": ["factory/index.ts#create"], "app/child.ts#caller": [] },
        fallback: "",
      },
      {
        name: "restore-inherited-method",
        files: { "types/beta.ts": beta },
        calls: {
          "app/caller.ts#caller": ["factory/index.ts#create", "types/beta.ts#Beta.run"],
          "app/child.ts#caller": ["types/beta.ts#Beta.run"],
        },
        fallback: "",
      },
    ],
  },
  {
    name: "configuration",
    git: true,
    files: {
      ".gitignore": "ignored/\n",
      "ignored/paths.json": '{"compilerOptions":{"paths":{"@entry":["../lib/a.ts"]}}}',
      "tsconfig.json": '{"extends":"./ignored/paths.json"}',
      "lib/a.ts": "export function run() {}",
      "lib/b.ts": "export function run() {}",
      "app/caller.ts": 'import { run } from "@entry"; export function caller() { run(); }',
      "package.json": '{"name":"local","exports":"./lib/a.ts"}',
      "pkg/caller.ts": 'import { run } from "local"; export function caller() { run(); }',
    },
    mutations: [
      {
        name: "baseline",
        calls: {
          "app/caller.ts#caller": ["lib/a.ts#run"],
          "pkg/caller.ts#caller": ["lib/a.ts#run"],
        },
      },
      { name: "unchanged", calls: { "app/caller.ts#caller": ["lib/a.ts#run"] }, fallback: "" },
      {
        name: "ignored-extended-config",
        files: { "ignored/paths.json": '{"compilerOptions":{"paths":{"@entry":["../lib/b.ts"]}}}' },
        calls: { "app/caller.ts#caller": ["lib/b.ts#run"] },
        fallback: "configuration changed",
      },
      {
        name: "package-exports",
        files: { "package.json": '{"name":"local","exports":"./lib/b.ts"}' },
        calls: { "pkg/caller.ts#caller": ["lib/b.ts#run"] },
        fallback: "configuration changed",
      },
      {
        name: "remove-extended-config",
        files: { "ignored/paths.json": null },
        calls: { "app/caller.ts#caller": [] },
        fallback: "configuration changed",
      },
      {
        name: "restore-missing-config",
        files: { "ignored/paths.json": '{"compilerOptions":{"paths":{"@entry":["../lib/a.ts"]}}}' },
        calls: { "app/caller.ts#caller": ["lib/a.ts#run"] },
        fallback: "configuration changed",
      },
    ],
  },
  {
    name: "discovery-and-absent-targets",
    files: {
      "app/caller.ts": 'import { run } from "../late"; export function caller() { run(); }',
    },
    mutations: [
      { name: "baseline-unresolved", calls: { "app/caller.ts#caller": [] } },
      { name: "unchanged-unresolved", calls: { "app/caller.ts#caller": [] }, fallback: "" },
      {
        name: "add-target-file",
        files: { "late/index.ts": "export function run() {}" },
        calls: { "app/caller.ts#caller": ["late/index.ts#run"] },
        fallback: "file discovery changed",
      },
      {
        name: "add-preferred-module",
        files: { "late.ts": "export function run() {}" },
        calls: { "app/caller.ts#caller": ["late.ts#run"] },
        fallback: "file discovery changed",
      },
      {
        name: "remove-preferred-module",
        files: { "late.ts": null },
        calls: { "app/caller.ts#caller": ["late/index.ts#run"] },
        fallback: "file discovery changed",
      },
      {
        name: "rename-target",
        files: { "late/index.ts": null, "late/renamed.ts": "export function run() {}" },
        calls: { "app/caller.ts#caller": [] },
        fallback: "file discovery changed",
      },
      {
        name: "delete-target",
        files: { "late/renamed.ts": null },
        calls: { "app/caller.ts#caller": [] },
        fallback: "file discovery changed",
      },
    ],
  },
  {
    name: "name-candidates-without-import-edges",
    files: {
      "app/caller.ts": "export function caller() { ghost.run(); }",
      "app/types.ts": "export class Ghost { other() {} }",
      "isolated/a.ts": "export function alone() {}",
    },
    mutations: [
      { name: "baseline-unresolved", calls: { "app/caller.ts#caller": [] } },
      {
        name: "add-method",
        files: { "app/types.ts": "export class Ghost { run() {} }" },
        calls: { "app/caller.ts#caller": ["app/types.ts#Ghost.run"] },
        fallback: "",
      },
      {
        name: "ambiguous-candidate",
        files: { "app/other.ts": "export class Ghost { run() {} }" },
        calls: { "app/caller.ts#caller": [] },
        fallback: "file discovery changed",
      },
      {
        name: "remove-ambiguity",
        files: { "app/other.ts": null },
        calls: { "app/caller.ts#caller": ["app/types.ts#Ghost.run"] },
        fallback: "file discovery changed",
      },
      {
        name: "remove-method",
        files: { "app/types.ts": "export class Ghost { other() {} }" },
        calls: { "app/caller.ts#caller": [] },
        fallback: "",
      },
    ],
  },
  {
    name: "unknown-coverage-and-diagnostics",
    files: {
      "app/a.ts": "export function a() {}",
      "config.json": '{"limit":3}',
    },
    mutations: [
      { name: "baseline", calls: { "app/a.ts#a": [] } },
      {
        name: "add-go-inference",
        files: {
          "a.go":
            "package a\ntype Work interface { Run() }\ntype Runner struct{}\nfunc (Runner) Run() {}\n",
        },
        calls: { "app/a.ts#a": [] },
        fallback: "unsupported heuristic pack",
      },
      {
        name: "unknown-type-edit",
        files: {
          "a.go":
            "package a\ntype Work interface { Stop() }\ntype Runner struct{}\nfunc (Runner) Run() {}\n",
        },
        calls: { "app/a.ts#a": [] },
        fallback: "unsupported heuristic pack",
      },
      {
        name: "remove-unknown-pack",
        files: { "a.go": null },
        calls: { "app/a.ts#a": [] },
        fallback: "initial build",
      },
      {
        name: "syntax-recovery",
        files: { "app/a.ts": "export function a() {}\nfunction broken(\n" },
        calls: { "app/a.ts#a": [] },
        fallback: "",
      },
      { name: "reuse-diagnostics", calls: { "app/a.ts#a": [] }, fallback: "" },
    ],
  },
];

export function mutate(root: string, files: Record<string, string | null>): void {
  for (const [path, text] of Object.entries(files)) {
    const target = join(root, path);
    if (text === null) rmSync(target, { force: true });
    else {
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, text);
    }
  }
}

/** JSON serialization matches #16's whole-index comparison; no saved index field is excluded. */
export function checkedSnapshot(result: BuildIndexResult): unknown {
  return JSON.parse(JSON.stringify({ index: result.index, warnings: result.warnings }));
}

export async function runMutationSequence(root: string, scenario: Scenario) {
  mutate(root, scenario.files);
  if (scenario.git) execFileSync("git", ["init", "-q"], { cwd: root });
  const experiment = new TypeScriptResolutionExperiment();
  const rows = [];
  for (const mutation of scenario.mutations) {
    mutate(root, mutation.files ?? {});
    const incremental = await buildIndex({
      root,
      precise: "off",
      experimentalResolution: experiment,
    });
    const clean = await buildIndex({ root, precise: "off", cache: false });
    deepStrictEqual(
      checkedSnapshot(incremental),
      checkedSnapshot(clean),
      `${scenario.name}/${mutation.name}: whole index and warnings`,
    );
    for (const [from, targets] of Object.entries(mutation.calls))
      deepStrictEqual(
        incremental.index.refs.filter((r) => r.kind === "call" && r.from === from).map((r) => r.to),
        targets,
        `${scenario.name}/${mutation.name}: ${from}`,
      );
    if (mutation.fallback !== undefined)
      deepStrictEqual(
        experiment.report.fallback,
        mutation.fallback,
        `${scenario.name}/${mutation.name}: fallback`,
      );
    rows.push({ scenario: scenario.name, mutation: mutation.name, ...experiment.report });
  }
  return rows;
}
