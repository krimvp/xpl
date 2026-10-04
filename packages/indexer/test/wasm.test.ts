import { describe, expect, it } from "vitest";
import { Parser } from "web-tree-sitter";
import {
  GRAMMAR_IDS,
  createParser,
  initParser,
  loadLanguage,
  resolvePackageWasm,
  resolveWasmFile,
  type GrammarId,
} from "../src/wasm.js";
import { GRAMMAR_WASM, RUNTIME_WASM } from "../src/wasm-files.js";

/** A snippet per grammar, its expected root node type, and node types the indexer will rely on. */
const SAMPLES: Record<GrammarId, { source: string; root: string; contains: string[] }> = {
  typescript: {
    source: "export class A {\n  m(): number {\n    return 1;\n  }\n}\n",
    root: "program",
    contains: ["class_declaration", "method_definition"],
  },
  tsx: {
    source: "const el = <div>{1}</div>;\n",
    root: "program",
    contains: ["jsx_element"],
  },
  python: {
    source: "class A:\n    def m(self):\n        return 1\n",
    root: "module",
    contains: ["class_definition", "function_definition"],
  },
  go: {
    source: "package main\n\nfunc main() {}\n",
    root: "source_file",
    contains: ["function_declaration"],
  },
  yaml: {
    source: "retry:\n  maxRetries: 3\n",
    root: "stream",
    contains: ["block_mapping_pair"],
  },
  json: {
    source: '{"retry": {"maxRetries": 3}}\n',
    root: "document",
    contains: ["pair"],
  },
  toml: {
    source: '[project.scripts]\nflask = "flask.cli:main"\n',
    root: "document",
    contains: ["table", "dotted_key", "pair"],
  },
};

describe("tree-sitter wasm grammars", () => {
  it("initParser is idempotent and shares one initialisation", async () => {
    const first = initParser();
    expect(initParser()).toBe(first);
    await Promise.all([first, initParser()]);
    await initParser();
  });

  it.each(GRAMMAR_IDS)("%s loads and parses into the expected tree", async (id) => {
    const sample = SAMPLES[id];
    const language = await loadLanguage(id);
    const parser = new Parser();
    parser.setLanguage(language);
    const tree = parser.parse(sample.source);
    try {
      expect(tree).not.toBeNull();
      const root = tree!.rootNode;
      expect(root.type).toBe(sample.root);
      expect(root.hasError).toBe(false);
      for (const type of sample.contains) {
        expect(root.descendantsOfType(type).length, `no ${type} node`).toBeGreaterThan(0);
      }
    } finally {
      tree?.delete();
      parser.delete();
    }
  });

  it("caches languages", async () => {
    const [a, b] = await Promise.all([loadLanguage("go"), loadLanguage("go")]);
    expect(a).toBe(b);
    expect(await loadLanguage("go")).toBe(a);
  });

  it("createParser returns a ready parser", async () => {
    const parser = await createParser("python");
    const tree = parser.parse("x = 1\n");
    try {
      expect(tree!.rootNode.type).toBe("module");
    } finally {
      tree?.delete();
      parser.delete();
    }
  });

  it("rejects unknown grammar ids", async () => {
    await expect(loadLanguage("rust" as GrammarId)).rejects.toThrow(/unknown grammar "rust"/);
  });

  it("reports positions as UTF-16 code units (JS string indices)", async () => {
    // An astral character (2 UTF-16 units, 4 UTF-8 bytes) and a BMP one (1 unit, 2 bytes) come first.
    const source = 'const s = "😀é"; const target = 1;';
    const parser = await createParser("typescript");
    const tree = parser.parse(source);
    try {
      const names = tree!.rootNode
        .descendantsOfType("variable_declarator")
        .map((declarator) => declarator.childForFieldName("name")!);
      const target = names.find((node) => node.text === "target")!;
      expect(target.startIndex).toBe(source.indexOf("target"));
      expect(target.startPosition).toEqual({ row: 0, column: source.indexOf("target") });
      expect(source.slice(target.startIndex, target.endIndex)).toBe("target");
    } finally {
      tree?.delete();
      parser.delete();
    }
  });

  it("finds every wasm file in node_modules by default", () => {
    for (const source of [RUNTIME_WASM, ...Object.values(GRAMMAR_WASM)]) {
      const path = resolveWasmFile(source);
      expect(path).toBe(resolvePackageWasm(source));
      expect(path.endsWith(source.file)).toBe(true);
    }
  });
});
