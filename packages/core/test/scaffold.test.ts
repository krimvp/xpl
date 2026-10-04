import { readdirSync, readFileSync } from "node:fs";
import { builtinModules } from "node:module";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

describe("@xpl/core", () => {
  it("stays browser-safe: src imports no Node builtins (ARCHITECTURE.md section 1)", () => {
    const srcDir = fileURLToPath(new URL("../src/", import.meta.url));
    const builtins = new Set(builtinModules);
    const files = readdirSync(srcDir, { recursive: true, encoding: "utf8" }).filter((name) =>
      name.endsWith(".ts"),
    );
    expect(files).toContain("schema.ts");
    for (const file of files) {
      const source = readFileSync(join(srcDir, file), "utf8");
      const specifiers = [...source.matchAll(/(?:from|import)\s*\(?\s*["']([^"']+)["']/g)].map(
        (match) => match[1]!,
      );
      for (const specifier of specifiers) {
        const bare = specifier.replace(/^node:/, "");
        expect(
          specifier.startsWith("node:") || builtins.has(bare),
          `${file} imports the Node builtin "${specifier}"`,
        ).toBe(false);
      }
    }
  });
});
