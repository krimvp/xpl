import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { hashText } from "@xpl/core";
import type { SymbolIndex } from "@xpl/core";
import { describe, expect, it } from "vitest";
import { encodeIndex } from "../../indexer/test/scip-encode.js";
import {
  bundleOf,
  invoke,
  makeTempDir,
  readFile,
  readJson,
  writeFile,
  writeViewerStub,
  xpl,
  xplJson,
} from "./helpers.js";

it("imports a manifest, queries symbols, checks an anchor and exports its source and coverage", async () => {
  const root = makeTempDir();
  const scratch = makeTempDir();
  const text = "class A {\n}\n";
  writeFile(root, "a.demo", text);
  const artifact = encodeIndex({
    tool: { name: "synthetic", version: "1" },
    documents: [
      {
        path: "a.demo",
        positionEncoding: 2,
        symbols: [{ symbol: "scip test demo 1 A#", kind: 7 }],
        occurrences: [
          {
            symbol: "scip test demo 1 A#",
            roles: 1,
            range: [0, 6, 7],
            enclosingRange: [0, 0, 1, 1],
          },
        ],
      },
    ],
  });
  writeFileSync(join(scratch, "index.scip"), artifact);
  const manifest = writeFile(
    scratch,
    "manifest.json",
    JSON.stringify({
      artifact: "index.scip",
      artifactSha256: createHash("sha256").update(artifact).digest("hex"),
      sourceHashes: { "a.demo": hashText(text) },
    }),
  );
  const imported = await xplJson<{ path: string }>(
    root,
    "index",
    "--scip",
    manifest,
    "--precise",
    "require",
  );
  expect(imported.code, imported.err).toBe(0);
  const index = readJson<SymbolIndex>(root, imported.json.path);
  expect((await xpl(root, "outline")).out).toContain("A");
  expect((await xpl(root, "show", "a.demo#A")).out).toContain("class A {");
  expect((await xpl(root, "new", "demo")).code).toBe(0);
  const patch = writeFile(
    scratch,
    "patch.json",
    JSON.stringify({
      nodes: [
        {
          id: "sym:a.demo#A",
          label: "A",
          summary: "A declaration.",
          anchors: [{ file: "a.demo", symbol: "A", role: "definition" }],
        },
      ],
    }),
  );
  expect((await xpl(root, "apply", "demo", patch)).code).toBe(0);
  expect((await xpl(root, "validate", "demo")).code).toBe(0);
  const exported = await invoke(
    ["bundle", "--draft", "demo", "-o", "demo.html", "--files", "all"],
    {
      cwd: root,
      env: { XPL_VIEWER_HTML: writeViewerStub() },
    },
  );
  expect(exported.code, exported.err).toBe(0);
  const bundle = bundleOf(readFile(root, "demo.html"));
  expect(bundle.files["a.demo"]).toBe(text);
  expect(bundle.index.symbols.map((s) => s.id)).toEqual(["a.demo#A"]);
  expect(bundle.index.analysis).toEqual(index.analysis);
});

describe.each(["auto", "require"])(
  "mixed Rust and artifact sources with --precise %s",
  (precise) => {
    it("retains syntax declarations in auto and rejects missing Rust precision in require", async () => {
      const root = makeTempDir();
      const scratch = makeTempDir();
      writeFile(root, "a.rs", "pub fn rust_entry() {}\n");
      writeFile(root, "a.demo", "class A {\n}\n");
      const artifact = encodeIndex({
        tool: { name: "synthetic", version: "1" },
        documents: [
          {
            path: "a.demo",
            text: "class A {\n}\n",
            positionEncoding: 2,
            symbols: [{ symbol: "scip test demo 1 A#", kind: 7 }],
            occurrences: [
              {
                symbol: "scip test demo 1 A#",
                roles: 1,
                range: [0, 6, 7],
                enclosingRange: [0, 0, 1, 1],
              },
            ],
          },
        ],
      });
      const path = join(scratch, "index.scip");
      writeFileSync(path, artifact);
      const result = await xplJson<{ path: string }>(
        root,
        "index",
        "--scip",
        path,
        "--precise",
        precise,
      );
      if (precise === "require") {
        expect(result.code, result.out + result.err).toBe(1);
        expect(result.json.error).toBe(
          "precise references are required but no usable precise relationship analysis was produced for: rust",
        );
        return;
      }
      expect(result.code, result.out + result.err).toBe(0);
      const index = readJson<SymbolIndex>(root, result.json.path);
      expect(index.symbols.map((s) => s.id)).toEqual(["a.demo#A", "a.rs#rust_entry"]);
      expect(index.languages.rust).toEqual({
        files: 1,
        symbols: 1,
        refs: "heuristic",
        tool: "tree-sitter-rust@0.24.0/query-v6",
      });
      expect(index.analysis!.find((r) => r.provider === "rust-tags")).toMatchObject({
        files: ["a.rs"],
        results: [
          { status: "partial", analyzedFiles: ["a.rs"] },
          { status: "partial", analyzedFiles: ["a.rs"] },
          { status: "unsupported", analyzedFiles: [] },
        ],
      });
    });
  },
);
