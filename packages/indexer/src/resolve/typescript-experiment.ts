/**
 * Off-default TypeScript-pack investigation. Retains plain references in one process, never on disk.
 * Bump SEMANTIC_REVISION when resolver/module rules change independently of the extraction key.
 * Imports, re-exports and same-directory candidates form a conservative dependency graph. Discovery
 * and configuration changes invalidate the project, including unresolved sites with no existing edge.
 * Every lookup table, pack inference, resource pass and external provider still runs fresh.
 */
import { posix } from "node:path";
import { performance } from "node:perf_hooks";
import type { Reference } from "@xpl/core";
import { typescriptPack } from "../languages/index.js";
import type { RepoView } from "../languages/types.js";
import type { ProviderSource } from "../providers.js";
import { resolveHeuristic, type ResolverInput } from "./heuristic.js";

const SEMANTIC_REVISION = 1;

interface Snapshot {
  root: string;
  discovery: string;
  configuration: string;
  reads: string[];
  identities: Map<string, string>;
  dependents: Map<string, Set<string>>;
  refs: Map<string, Reference[]>;
}

export interface InvalidationReport {
  resolvedFiles: string[];
  reusedFiles: string[];
  /** Empty when dependency coverage allows reuse; otherwise the project-wide fallback reason. */
  fallback: string;
  dependencyEdges: number;
  bookkeepingMs: number;
  resolutionMs: number;
}

export class TypeScriptResolutionExperiment {
  report: InvalidationReport = {
    resolvedFiles: [],
    reusedFiles: [],
    fallback: "initial build",
    dependencyEdges: 0,
    bookkeepingMs: 0,
    resolutionMs: 0,
  };
  private previous?: Snapshot;

  resolve(
    input: ResolverInput,
    sources: readonly ProviderSource[],
    extractionIdentities: ReadonlyMap<string, string>,
  ): Reference[] {
    const started = performance.now();
    const paths = input.files.map((f) => f.path).sort();
    const unsupported = input.files.some((f) => f.pack !== typescriptPack);
    const unavailable = sources
      .filter((s) => typescriptPack.languages.includes(s.language))
      .some((s) => !paths.includes(s.path) || !extractionIdentities.has(s.path));
    if (unsupported || unavailable) {
      this.previous = undefined;
      const resolutionStarted = performance.now();
      const refs = resolveHeuristic(input);
      const resolutionMs = performance.now() - resolutionStarted;
      this.report = {
        resolvedFiles: paths,
        reusedFiles: [],
        fallback: unsupported ? "unsupported heuristic pack" : "extraction identity unavailable",
        dependencyEdges: 0,
        bookkeepingMs: performance.now() - started - resolutionMs,
        resolutionMs,
      };
      return refs;
    }

    // Module resolution can read ignored/unindexed configs and observe missing ones. Re-read both.
    const reads = new Map<string, string | undefined>();
    const repo: RepoView = {
      root: input.repo.root,
      files: input.repo.files,
      filesInDir: (dir) => input.repo.filesInDir(dir),
      readText: (path) => {
        const text = input.repo.readText(path);
        reads.set(path, text);
        return text;
      },
    };
    for (const path of this.previous?.reads ?? []) repo.readText(path);
    const dependents = new Map(paths.map((path) => [path, new Set<string>()]));
    const byDir = new Map<string, string[]>();
    for (const path of paths) {
      const dir = posix.dirname(path);
      const peers = byDir.get(dir) ?? [];
      peers.push(path);
      byDir.set(dir, peers);
    }
    let dependencyEdges = 0;
    for (const file of input.files) {
      const dependencies = new Set(byDir.get(posix.dirname(file.path)));
      const modules = new Set([
        ...file.imports.map((b) => b.module),
        ...file.exports.flatMap((e) => (e.module === undefined ? [] : [e.module])),
        ...file.sites.filter((s) => s.kind === "import").map((s) => s.name),
      ]);
      for (const spec of modules)
        for (const target of file.pack.resolveModule(spec, file.path, repo))
          dependencies.add(target);
      dependencies.delete(file.path);
      for (const dependency of dependencies) {
        // Non-code targets are covered by the project configuration signature below.
        const callers = dependents.get(dependency);
        if (!callers) continue;
        callers.add(file.path);
        dependencyEdges++;
      }
    }

    const entries = new Map<string, (typeof input.entries)[number][]>();
    for (const entry of input.entries) {
      const list = entries.get(entry.symbol.file) ?? [];
      list.push(entry);
      entries.set(entry.symbol.file, list);
    }
    const identities = new Map(
      paths.map((path) => [
        path,
        JSON.stringify([SEMANTIC_REVISION, extractionIdentities.get(path), entries.get(path)]),
      ]),
    );
    const discovery = JSON.stringify(sources.map((s) => [s.path, s.language]));
    const configuration = JSON.stringify([
      sources.filter((s) => !typescriptPack.languages.includes(s.language)),
      [...reads].sort(([a], [b]) => a.localeCompare(b)),
    ]);
    const previous = this.previous;
    const fallback = !previous
      ? "initial build"
      : previous.root !== repo.root
        ? "repository changed"
        : previous.discovery !== discovery
          ? "file discovery changed"
          : previous.configuration !== configuration
            ? "configuration changed"
            : "";
    const dirty = new Set(
      paths.filter((path) => fallback || previous?.identities.get(path) !== identities.get(path)),
    );
    // Traverse old and new dependencies: a removed import must also retire its previous facts.
    for (const path of dirty) {
      for (const callers of [previous?.dependents.get(path), dependents.get(path)])
        for (const caller of callers ?? []) dirty.add(caller);
    }
    const resolutionStarted = performance.now();
    const fresh = resolveHeuristic({ ...input, repo, resolveFiles: dirty });
    const resolutionMs = performance.now() - resolutionStarted;
    const refs = new Map(paths.map((path) => [path, [] as Reference[]]));
    for (const ref of fresh) refs.get(ref.from.slice(0, ref.from.indexOf("#")))!.push(ref);
    for (const path of paths) if (!dirty.has(path)) refs.set(path, previous!.refs.get(path)!);
    this.previous = {
      root: repo.root,
      discovery,
      configuration,
      reads: [...reads.keys()],
      identities,
      dependents,
      refs,
    };
    const result = [...refs.values()].flat();
    this.report = {
      resolvedFiles: paths.filter((path) => dirty.has(path)),
      reusedFiles: paths.filter((path) => !dirty.has(path)),
      fallback,
      dependencyEdges,
      bookkeepingMs: performance.now() - started - resolutionMs,
      resolutionMs,
    };
    return result;
  }
}
