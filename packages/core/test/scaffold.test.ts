import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, utf8ToBytes } from "@noble/hashes/utils.js";
import { readdirSync, readFileSync } from "node:fs";
import { builtinModules } from "node:module";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { DEFAULT_EDGE_KINDS, EXPLAINER_SCHEMA, INDEX_SCHEMA } from "../src/index.js";
import { example } from "./types/example.explainer.js";

describe("@xpl/core scaffold", () => {
  it("exports the schema constants, and the handoff example uses them", () => {
    expect(INDEX_SCHEMA).toBe("code-explainer/index@0");
    expect(EXPLAINER_SCHEMA).toBe("code-explainer@0");
    expect(example.schema).toBe(EXPLAINER_SCHEMA);
    expect(DEFAULT_EDGE_KINDS).toEqual(["calls", "extends", "implements"]);
  });

  it("resolves @noble/hashes (the hashText building block)", () => {
    expect(bytesToHex(sha256(utf8ToBytes("abc")))).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
  });

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
