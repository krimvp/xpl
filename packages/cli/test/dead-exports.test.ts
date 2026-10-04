/**
 * No production export is kept alive by tests alone (test-audit: "dead production code whose only callers are
 * tests"). `noUnusedLocals` cannot see an export, and deleting a function's last caller leaves the function
 * behind with its tests still green. The check is lexical: an exported function, class, enum or constant
 * whose name appears nowhere in the sources of the packages (and the build scripts) but in its own
 * declaration and in barrel re-exports is dead.
 */
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

/** Exports that only tests use, on purpose: each is the one way a test reaches a real seam. */
const TEST_SEAMS: Record<string, string> = {
  unregisterProvider:
    "sets the real SCIP resolvers aside in build.test.ts (the IndexProvider seam)",
  gridLayoutOf: "the grid fallback of graphLayout without making dagre fail",
};

function sources(): { path: string; text: string }[] {
  const files: string[] = ["packages/cli/build.ts", "packages/viewer/vite.config.ts"];
  for (const pkg of ["core", "indexer", "cli", "viewer"]) {
    for (const name of readdirSync(join(ROOT, "packages", pkg, "src"), {
      recursive: true,
      encoding: "utf8",
    })) {
      if (/\.tsx?$/.test(name)) files.push(join("packages", pkg, "src", name));
    }
  }
  for (const name of readdirSync(join(ROOT, "packages/viewer/scripts"))) {
    if (name.endsWith(".ts")) files.push(join("packages/viewer/scripts", name));
  }
  return files.map((path) => ({ path, text: readFileSync(join(ROOT, path), "utf8") }));
}

/** Value exports declared in the sources, with the file that declares them. */
function declaredExports(
  files: { path: string; text: string }[],
): { name: string; path: string }[] {
  const found: { name: string; path: string }[] = [];
  for (const { path, text } of files) {
    for (const m of text.matchAll(
      /^export (?:declare )?(?:async )?(?:function\*?|const|let|class|enum|abstract class) ([A-Za-z_$][\w$]*)/gm,
    ))
      found.push({ name: m[1]!, path });
  }
  return found;
}

/** How often each identifier appears, barrel re-exports (`export { a, b } from "./x.js"`) left out. */
function identifierCounts(files: { path: string; text: string }[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const { text } of files) {
    const code = text.replace(/^export (?:type )?\{[^}]*\}(?: from [^;]+)?;/gm, "");
    for (const m of code.matchAll(/[A-Za-z_$][\w$]*/g))
      counts.set(m[0], (counts.get(m[0]) ?? 0) + 1);
  }
  return counts;
}

describe("production exports", () => {
  it("each one has a production use beyond its own declaration", () => {
    const files = sources();
    const counts = identifierCounts(files);
    const dead = declaredExports(files)
      .filter(({ name }) => (counts.get(name) ?? 0) <= 1 && !(name in TEST_SEAMS))
      .map(({ name, path }) => `${relative(ROOT, join(ROOT, path))}: ${name}`);
    expect(
      dead,
      "delete these and their tests, or list a deliberate test seam in TEST_SEAMS",
    ).toEqual([]);
  });

  it("each listed test seam is still exported and still unused in production", () => {
    const files = sources();
    const counts = identifierCounts(files);
    const declared = new Set(declaredExports(files).map((e) => e.name));
    expect(
      Object.keys(TEST_SEAMS).filter((name) => !declared.has(name) || counts.get(name)! > 1),
    ).toEqual([]);
  });
});
