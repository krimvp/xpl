import { describe, expect, it } from "vitest";
import { indexFiles } from "./helpers.js";

describe("resource relationships", () => {
  it("links a loader to its JSON file with the enclosing symbol and source site", async () => {
    const { index } = await indexFiles({
      "src/config.ts":
        'import { readFileSync } from "node:fs";\nexport function load() {\n return JSON.parse(readFileSync(new URL("../config/default.json", import.meta.url), "utf8"));\n}',
      "config/default.json": '{"retry": 3}',
    });
    expect(index.resources).toEqual([
      expect.objectContaining({
        from: "src/config.ts#load",
        files: ["config/default.json"],
        kind: "loads",
        site: expect.objectContaining({ startLine: 3 }),
        resolution: "static",
      }),
    ]);
  });

  it("groups glob-loaded plugins and does not include unrelated files", async () => {
    const { index } = await indexFiles({
      "loader.py":
        'from pathlib import Path\ndef plugins():\n return list(Path("plugins").glob("*.py"))',
      "plugins/a.py": "x = 1",
      "plugins/b.py": "x = 2",
      "plugins/nested/c.py": "x = 3",
      "plugins/readme.txt": "not a plugin",
    });
    expect(index.resources).toEqual([
      expect.objectContaining({
        from: "loader.py#plugins",
        kind: "discovers",
        pattern: "plugins/*.py",
        files: ["plugins/a.py", "plugins/b.py"],
      }),
    ]);
  });

  it("handles file-relative Python paths and Go file reads", async () => {
    const { index } = await indexFiles({
      "src/loader.py":
        'from pathlib import Path\ndef load():\n return (Path(__file__).parent / "settings.json").read_text()',
      "src/settings.json": "{}",
      "main.go": 'package main\nimport "os"\nfunc load() { os.ReadFile("config.json") }',
      "config.json": "{}",
    });
    expect(index.resources).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ from: "src/loader.py#load", files: ["src/settings.json"] }),
        expect.objectContaining({ from: "main.go#load", files: ["config.json"] }),
      ]),
    );
  });

  it("ignores comments, arbitrary strings, dynamic paths and paths outside indexed files", async () => {
    const { index } = await indexFiles({
      "src/a.ts":
        'const text = "config.json";\n// readFile("config.json")\nfunction load(path: string) { return readFile(path); }\nreadFile("../outside.json");\nreadFile("/config.json");',
      "config.json": "{}",
    });
    expect(index.resources ?? []).toEqual([]);
  });

  it("links imported JSON and resolves file-relative JavaScript globs", async () => {
    const { index } = await indexFiles({
      "src/main.ts":
        'import config from "../config.json";\nconst plugins = import.meta.glob("./plugins/*.ts");',
      "config.json": "{}",
      "src/plugins/a.ts": "export const a = 1",
      "src/plugins/nested/b.ts": "export const b = 1",
    });
    expect(index.resources).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: "loads", files: ["config.json"] }),
        expect.objectContaining({
          kind: "discovers",
          pattern: "src/plugins/*.ts",
          files: ["src/plugins/a.ts"],
        }),
      ]),
    );
  });

  it("marks dynamic fallback paths as inferred and respects glob cwd", async () => {
    const { index } = await indexFiles({
      "main.ts":
        'loadConfig(process.argv[2] ?? new URL("./config.json", import.meta.url));\nglob("*.ts", { cwd: "plugins" });',
      "config.json": "{}",
      "plugins/a.ts": "export const a = 1",
      "other.ts": "export const other = 1",
    });
    expect(index.resources).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ resolution: "inferred", files: ["config.json"] }),
        expect.objectContaining({ pattern: "plugins/*.ts", files: ["plugins/a.ts"] }),
      ]),
    );
  });

  it("matches root globs without accidentally including nested files", async () => {
    const { index } = await indexFiles({
      "loader.py": 'list(Path(".").glob("*.py"))',
      "root.py": "x = 1",
      "nested/child.py": "x = 1",
    });
    expect(index.resources?.[0]?.files).toEqual(["loader.py", "root.py"]);
  });

  it("does not treat type-only JSON imports as runtime loads", async () => {
    const { index } = await indexFiles({
      "src/types.ts": 'import type config from "../config.json";',
      "config.json": "{}",
    });
    expect(index.resources ?? []).toEqual([]);
  });

  it("ignores absolute targets composed with relative base paths", async () => {
    const { index } = await indexFiles({
      "src/loader.ts": 'readFile(path.resolve("src", "/outside.json"));',
      "loader.py":
        '(Path("src") / "/outside.json").read_text()\nPath("src").joinpath("/outside.json").read_text()\nopen(os.path.join("src", "/outside.json"))',
      "src/outside.json": "{}",
    });
    expect(index.resources ?? []).toEqual([]);
  });

  it("does not invent precedence or plugin activation", async () => {
    const { index } = await indexFiles({
      "main.ts": 'readFile("defaults.json"); readFile("production.json");',
      "defaults.json": "{}",
      "production.json": "{}",
    });
    expect(index.resources?.map((resource) => resource.kind)).toEqual(["loads", "loads"]);
    expect(index.resources?.every((resource) => !("active" in resource))).toBe(true);
  });
});
