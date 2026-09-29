import { describe, expect, it } from "vitest";
import {
  TEST_FILE_GLOBS,
  globMatcher,
  globToRegExp,
  matchesAnyGlob,
  matchesGlob,
} from "../src/index.js";

describe("matchesGlob", () => {
  it("* stays inside one path segment, ? is one character", () => {
    expect(matchesGlob("src/a.ts", "src/*.ts")).toBe(true);
    expect(matchesGlob("src/deep/a.ts", "src/*.ts")).toBe(false);
    expect(matchesGlob("src/a.ts", "src/?.ts")).toBe(true);
    expect(matchesGlob("src/ab.ts", "src/?.ts")).toBe(false);
    expect(matchesGlob("src/.ts", "src/?.ts")).toBe(false);
    expect(matchesGlob("src/a/b.ts", "src/?/b.ts")).toBe(true);
    expect(matchesGlob("src//b.ts", "src/?/b.ts")).toBe(false); // ? never matches a slash
  });

  it("** crosses directories; a leading **/ also matches zero directories", () => {
    expect(matchesGlob("a.test.ts", "**/*.test.*")).toBe(true);
    expect(matchesGlob("src/a.test.ts", "**/*.test.*")).toBe(true);
    expect(matchesGlob("src/deep/er/a.test.tsx", "**/*.test.*")).toBe(true);
    expect(matchesGlob("src/a.ts", "**/*.test.*")).toBe(false);
    expect(matchesGlob("src/a/b/c.ts", "src/**")).toBe(true);
    expect(matchesGlob("src/a.ts", "src/**")).toBe(true);
    expect(matchesGlob("lib/a.ts", "src/**")).toBe(false);
    expect(matchesGlob("src/a/z.ts", "src/**/z.ts")).toBe(true);
    expect(matchesGlob("src/z.ts", "src/**/z.ts")).toBe(true);
    expect(matchesGlob("src/a/b/z.ts", "src/**/z.ts")).toBe(true);
    expect(matchesGlob("src/z.tsx", "src/**/z.ts")).toBe(false);
    expect(matchesGlob("abc", "a**c")).toBe(true); // ** inside a name is a plain any-run
  });

  it("**/dir/** matches whole directories only", () => {
    expect(matchesGlob("test/a.ts", "**/test/**")).toBe(true);
    expect(matchesGlob("pkg/test/deep/a.ts", "**/test/**")).toBe(true);
    expect(matchesGlob("contest/a.ts", "**/test/**")).toBe(false);
    expect(matchesGlob("pkg/latest/a.ts", "**/test/**")).toBe(false);
    expect(matchesGlob("pkg/test.ts", "**/test/**")).toBe(false);
  });

  it("a pattern without a slash also matches the file name at any depth", () => {
    expect(matchesGlob("internal/runner/retry_test.go", "*_test.go")).toBe(true);
    expect(matchesGlob("retry_test.go", "*_test.go")).toBe(true);
    expect(matchesGlob("internal/runner/retry_test.go.bak", "*_test.go")).toBe(false);
    // with a slash it is anchored to the whole path
    expect(matchesGlob("internal/runner/retry_test.go", "runner/*_test.go")).toBe(false);
    expect(matchesGlob("runner/retry_test.go", "runner/*_test.go")).toBe(true);
  });

  it("escapes regular-expression characters and is case-sensitive", () => {
    expect(matchesGlob("src/a+b(1).ts", "src/a+b(1).ts")).toBe(true);
    expect(matchesGlob("src/aab(1).ts", "src/a+b(1).ts")).toBe(false);
    expect(matchesGlob("src/a.ts", "src/a.ts")).toBe(true);
    expect(matchesGlob("src/aXts", "src/a.ts")).toBe(false); // the dot is literal
    expect(matchesGlob("src/A.ts", "src/a.ts")).toBe(false);
    expect(matchesGlob("src/[a].ts", "src/[a].ts")).toBe(true); // no character classes
    expect(matchesGlob("src/a.ts", "src/[a].ts")).toBe(false);
    expect(matchesGlob("src/$x^.ts", "src/$x^.ts")).toBe(true);
  });

  it("an empty pattern matches nothing", () => {
    expect(matchesGlob("a", "")).toBe(false);
    expect(matchesAnyGlob("a", [])).toBe(false);
  });

  it("globToRegExp is memoised", () => {
    expect(globToRegExp("x/**")).toBe(globToRegExp("x/**"));
  });
});

describe("globMatcher", () => {
  it("returns undefined without a usable pattern, else a predicate over all patterns", () => {
    expect(globMatcher(undefined)).toBeUndefined();
    expect(globMatcher([])).toBeUndefined();
    expect(globMatcher(["", 3 as never])).toBeUndefined();
    const m = globMatcher(["**/*_test.go", "docs/**"])!;
    expect(m("a/b_test.go")).toBe(true);
    expect(m("docs/x/y.md")).toBe(true);
    expect(m("a/b.go")).toBe(false);
  });
});

describe("TEST_FILE_GLOBS", () => {
  const isTest = (path: string) => matchesAnyGlob(path, TEST_FILE_GLOBS);

  it("recognises the test files of Go, TS/JS and Python", () => {
    for (const path of [
      "internal/runner/retry_test.go",
      "test/retry.test.ts",
      "src/queue.test.ts",
      "src/queue.spec.js",
      "packages/core/test/helpers.ts",
      "pkg/tests/unit/x.py",
      "jobrunner/test_retry.py",
      "tests/test_retry.py",
      "src/__tests__/a.tsx",
      "tests/conftest.py",
      "conftest.py",
    ]) {
      expect(isTest(path), path).toBe(true);
    }
  });

  it("leaves production code alone", () => {
    for (const path of [
      "src/runner.ts",
      "internal/runner/runner.go",
      "jobrunner/queue.py",
      "src/latest.ts",
      "src/contest/a.ts",
      "docs/testing.md",
      "internal/testdata_loader.go",
    ]) {
      expect(isTest(path), path).toBe(false);
    }
  });
});
