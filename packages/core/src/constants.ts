import type { Edge } from "./schema.js";

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
 * Glob patterns (see glob.ts) that mark test code: Go, JS/TS and Python conventions. The CLI hides test
 * doubles behind them (`xpl refs`), and they are the suggested `GraphView.excludeFiles` of an overview.
 */
export const TEST_FILE_GLOBS: readonly string[] = [
  "**/*_test.go",
  "**/test/**",
  "**/tests/**",
  "**/__tests__/**",
  "**/*.test.*",
  "**/*.spec.*",
  "**/test_*.py",
  "**/*_test.py",
  "**/conftest.py",
];
