import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { hashText } from "@xpl/core";
import type { SymbolIndex } from "@xpl/core";
import { expect, it } from "vitest";
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
  const exported = await invoke(["bundle", "demo", "-o", "demo.html", "--files", "all"], {
    cwd: root,
    env: { XPL_VIEWER_HTML: writeViewerStub() },
  });
  expect(exported.code, exported.err).toBe(0);
  const bundle = bundleOf(readFile(root, "demo.html"));
  expect(bundle.files["a.demo"]).toBe(text);
  expect(bundle.index.symbols.map((s) => s.id)).toEqual(["a.demo#A"]);
  expect(bundle.index.analysis).toEqual(index.analysis);
});
