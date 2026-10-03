import type { Edge, NodeRole } from "./schema.js";

/** Value of `SymbolIndex.schema`. */
export const INDEX_SCHEMA = "code-explainer/index@0" as const;

/** Value of `Explainer.schema`. */
export const EXPLAINER_SCHEMA = "code-explainer@0" as const;

/**
 * Derived edge kinds a GraphView shows when its `edgeKinds` is omitted (ARCHITECTURE.md §2.7).
 * Stored edges are always shown, whatever their kind.
 */
export const DEFAULT_EDGE_KINDS: readonly Edge["kind"][] = ["calls", "extends", "implements"];

/**
 * Glob patterns (see glob.ts) that mark test code: Go, JS/TS and Python conventions, type tests included (tsd's
 * `test-d/` and `index.test-d.ts`, Vitest's `*.test-d.ts` and `*.spec-d.ts`). The CLI hides test doubles behind
 * them (`xpl refs`), and they are the suggested `GraphView.excludeFiles` of an overview.
 */
export const TEST_FILE_GLOBS: readonly string[] = [
  "**/*_test.go",
  "**/test/**",
  "**/tests/**",
  "**/__tests__/**",
  "**/*.test.*",
  "**/*.spec.*",
  "**/test-d/**",
  "**/*.test-d.*",
  "**/*.spec-d.*",
  "**/test_*.py",
  "**/*_test.py",
  "**/conftest.py",
];

/** Every `Node.role`, in the order the skill and the docs list them. */
export const NODE_ROLES: readonly NodeRole[] = [
  "person",
  "system",
  "service",
  "component",
  "database",
  "cache",
  "queue",
  "storage",
  "external",
];

/** Roles of boxes that stand for something outside the repo's code: a group with one of them may have no members. */
export const OUTSIDE_ROLES: readonly NodeRole[] = [
  "person",
  "system",
  "database",
  "cache",
  "queue",
  "storage",
  "external",
];
