// Kept in its own file: it changes process-wide wasm settings and initialises the runtime itself.
import { copyFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Parser } from "web-tree-sitter";
import {
  GRAMMAR_IDS,
  GRAMMAR_WASM,
  RUNTIME_WASM,
  allWasmSources,
  getWasmDir,
  initParser,
  loadLanguage,
  resolvePackageWasm,
  resolveWasmFile,
  setWasmDir,
} from "../src/wasm.js";

describe("wasm directory override", () => {
  let fullDir: string;
  let emptyDir: string;
  const savedEnv = process.env.XPL_WASM_DIR;

  beforeAll(() => {
    fullDir = mkdtempSync(join(tmpdir(), "xpl-wasm-full-"));
    emptyDir = mkdtempSync(join(tmpdir(), "xpl-wasm-empty-"));
    for (const source of allWasmSources()) {
      copyFileSync(resolvePackageWasm(source), join(fullDir, source.file));
    }
  });

  afterAll(() => {
    setWasmDir(undefined);
    if (savedEnv === undefined) delete process.env.XPL_WASM_DIR;
    else process.env.XPL_WASM_DIR = savedEnv;
    rmSync(fullDir, { recursive: true, force: true });
    rmSync(emptyDir, { recursive: true, force: true });
  });

  it("XPL_WASM_DIR redirects resolution; setWasmDir wins over it", () => {
    setWasmDir(undefined);
    process.env.XPL_WASM_DIR = fullDir;
    expect(getWasmDir()).toBe(fullDir);
    expect(resolveWasmFile(GRAMMAR_WASM.go)).toBe(join(fullDir, "tree-sitter-go.wasm"));
    setWasmDir(emptyDir);
    expect(getWasmDir()).toBe(emptyDir);
    expect(resolveWasmFile(RUNTIME_WASM)).toBe(join(emptyDir, "web-tree-sitter.wasm"));
    setWasmDir(undefined);
    delete process.env.XPL_WASM_DIR;
    expect(getWasmDir()).toBeUndefined();
  });

  it("fails clearly when the directory lacks a file, and can be retried afterwards", async () => {
    setWasmDir(emptyDir);
    await expect(initParser()).rejects.toThrow(/wasm file not found: .*web-tree-sitter\.wasm/);
    // A failed init is not cached: pointing at a complete directory now works.
    setWasmDir(fullDir);
    await initParser();
    setWasmDir(emptyDir);
    await expect(loadLanguage("go")).rejects.toThrow(/wasm file not found: .*tree-sitter-go\.wasm/);
    setWasmDir(fullDir);
    await loadLanguage("go");
  });

  it("initialises and loads every grammar from the copied directory", async () => {
    setWasmDir(fullDir);
    await initParser();
    for (const id of GRAMMAR_IDS) {
      const parser = new Parser();
      parser.setLanguage(await loadLanguage(id));
      const tree = parser.parse(id === "json" ? "{}" : "x");
      try {
        expect(tree).not.toBeNull();
      } finally {
        tree?.delete();
        parser.delete();
      }
    }
  });
});
