import { describe, expect, it } from "vitest";
import { packFor, packForFile, tomlPack } from "../src/languages/index.js";
import { MAX_KEYS_PER_FILE } from "../src/languages/keys.js";
import { indexFiles, symbol, symbolLines } from "./helpers.js";

const src = (...lines: string[]): string => lines.join("\n") + "\n";

async function keys(file: string, source: string): Promise<string[]> {
  const { index } = await indexFiles({ [file]: source });
  return symbolLines(index, file);
}

describe("YAML symbols", () => {
  it("mapping keys are `key` symbols with dotted paths; a key spans its whole pair", async () => {
    const source = src(
      "# jobrunner config", // 1
      "", // 2
      "queue:", // 3
      "  name: default   # trailing comment", // 4
      "  maxPending: 1000", // 5
      "", // 6
      "# retry policy", // 7
      "retry:", // 8
      "  maxRetries: 3", // 9
      "  backoff:", // 10
      "    baseMs: 500", // 11
      "    maxMs: 30000", // 12
      "", // 13
      "flag: true", // 14
    );
    expect(await keys("config.yaml", source)).toEqual([
      "key queue 3-5",
      "key queue.name 4-4",
      "key queue.maxPending 5-5",
      "key retry 8-12",
      "key retry.maxRetries 9-9",
      "key retry.backoff 10-12",
      "key retry.backoff.baseMs 11-11",
      "key retry.backoff.maxMs 12-12",
      "key flag 14-14",
    ]);
  });

  it("sets parents to the enclosing key and excludes leading comments from ranges", async () => {
    const { index } = await indexFiles({
      "c.yaml": src("# about a", "a:", "  # about b", "  b: 1"),
    });
    expect(symbol(index, "c.yaml", "a")!.range).toEqual({ startLine: 2, endLine: 4 });
    expect(symbol(index, "c.yaml", "a.b")!.range).toEqual({ startLine: 4, endLine: 4 });
    expect(symbol(index, "c.yaml", "a.b")!.parent).toBe("c.yaml#a");
    expect(symbol(index, "c.yaml", "a")!.parent).toBeUndefined();
    expect(symbol(index, "c.yaml", "a")!.kind).toBe("key");
  });

  it("comment lines between blocks belong to the next key, not to the previous one", async () => {
    const source = src(
      "queue:", // 1
      "  a: 1", // 2
      "  # trailing inside queue", // 3
      "", // 4
      "# leading of retry", // 5
      "retry:", // 6
      "  b: 2", // 7
      "  # last comment", // 8
      "", // 9
      "flag: true", // 10
    );
    expect(await keys("c.yaml", source)).toEqual([
      "key queue 1-2",
      "key queue.a 2-2",
      "key retry 6-7",
      "key retry.b 7-7",
      "key flag 10-10",
    ]);
  });

  it("addresses sequence items by index; items themselves are not symbols", async () => {
    const source = src(
      "workers:", // 1
      "  - name: a", // 2
      "    count: 1", // 3
      "  - name: b", // 4
      "    tags:", // 5
      "      - x", // 6
      "      - y: 1", // 7
      "  - plain", // 8
      "matrix: [[1, 2], [3, {k: v}]]", // 9
    );
    const { index } = await indexFiles({ "c.yaml": source });
    expect(symbolLines(index, "c.yaml")).toEqual([
      "key workers 1-8",
      "key workers.0.name 2-2",
      "key workers.0.count 3-3",
      "key workers.1.name 4-4",
      "key workers.1.tags 5-7",
      "key workers.1.tags.1.y 7-7",
      "key matrix 9-9",
      "key matrix.1.1.k 9-9",
    ]);
    // the nearest key symbol is the parent (items are only path segments)
    expect(symbol(index, "c.yaml", "workers.1.tags.1.y")!.parent).toBe("c.yaml#workers.1.tags");
    expect(symbol(index, "c.yaml", "workers.0.name")!.parent).toBe("c.yaml#workers");
  });

  it("handles quoted keys, flow mappings, anchors, aliases, merge keys and block scalars", async () => {
    const source = src(
      "defaults: &defaults", // 1
      "  retries: 3", // 2
      "service:", // 3
      "  <<: *defaults", // 4
      '  "quoted key": 1', // 5
      "  'single': 2", // 6
      "  inline: {a: 1, b: {c: 2}}", // 7
      "  script: |", // 8
      "    echo one", // 9
      "    echo two", // 10
      "  ref: *defaults", // 11
      "  tagged: !!str 5", // 12
      "empty:", // 13
    );
    expect(await keys("c.yml", source)).toEqual([
      "key defaults 1-2",
      "key defaults.retries 2-2",
      "key service 3-12",
      "key service.quoted key 5-5",
      "key service.single 6-6",
      "key service.inline 7-7",
      "key service.inline.a 7-7",
      "key service.inline.b 7-7",
      "key service.inline.b.c 7-7",
      "key service.script 8-10",
      "key service.ref 11-11",
      "key service.tagged 12-12",
      "key empty 13-13",
    ]);
  });

  it("limits keys to depth 6", async () => {
    const source = src(
      "a:",
      "  b:",
      "    c:",
      "      d:",
      "        e:",
      "          f:",
      "            g:",
      "              h: 1",
    );
    const lines = await keys("deep.yaml", source);
    expect(lines.map((l) => l.split(" ")[1])).toEqual([
      "a",
      "a.b",
      "a.b.c",
      "a.b.c.d",
      "a.b.c.d.e",
      "a.b.c.d.e.f",
    ]);
  });

  it("counts key depth, not sequence indices", async () => {
    const source = src(
      "a:",
      "  - b:",
      "      - c:",
      "          d:",
      "            - e:",
      "                f:",
      "                  g: 1",
    );
    const paths = (await keys("d.yaml", source)).map((l) => l.split(" ")[1]);
    // keys: a, b, c, d, e, f => depth 6; g is depth 7 and dropped
    expect(paths).toEqual([
      "a",
      "a.0.b",
      "a.0.b.0.c",
      "a.0.b.0.c.d",
      "a.0.b.0.c.d.0.e",
      "a.0.b.0.c.d.0.e.f",
    ]);
  });

  it("numbers repeated keys and documents in a stream ~2, ~3", async () => {
    const source = src("a: 1", "a: 2", "---", "a: 3", "b:", "  a: 4");
    expect(await keys("multi.yaml", source)).toEqual([
      "key a 1-1",
      "key a~2 2-2",
      "key a~3 4-4",
      "key b 5-6",
      "key b.a 6-6",
    ]);
  });

  it("skips empty keys and tolerates syntax errors, empty files and comment-only files", async () => {
    expect(await keys("e.yaml", "")).toEqual([]);
    expect(await keys("c.yaml", "# just a comment\n")).toEqual([]);
    expect(await keys("bad.yaml", src("a: 1", "b: [unclosed", "c: 2"))).toContain("key a 1-1");
    expect(await keys("empty-key.yaml", src('"": 1', "ok: 2"))).toEqual(["key ok 2-2"]);
  });

  it("produces no reference sites, and the language summary says refs none", async () => {
    const { index } = await indexFiles({ "c.yaml": "a:\n  b: 1\n" });
    expect(index.refs).toEqual([]);
    expect(index.languages.yaml).toEqual({ files: 1, symbols: 2, refs: "none" });
  });

  it("caps the number of keys per file and warns", async () => {
    const lines = Array.from({ length: MAX_KEYS_PER_FILE + 50 }, (_, i) => `k${i}: ${i}`);
    const { index, warnings } = await indexFiles({ "big.yaml": lines.join("\n") + "\n" });
    expect(index.symbols).toHaveLength(MAX_KEYS_PER_FILE);
    expect(warnings.some((w) => w.startsWith("big.yaml: 50 keys beyond the first"))).toBe(true);
  });
});

describe("JSON symbols", () => {
  it("object keys are `key` symbols spanning their `key: value` pair", async () => {
    const source = src(
      "{", // 1
      '  "name": "x",', // 2
      '  "scripts": {', // 3
      '    "build": "tsc",', // 4
      '    "test": "vitest"', // 5
      "  },", // 6
      '  "private": true', // 7
      "}", // 8
    );
    expect(await keys("package.json", source)).toEqual([
      "key name 2-2",
      "key scripts 3-6",
      "key scripts.build 4-4",
      "key scripts.test 5-5",
      "key private 7-7",
    ]);
  });

  it("addresses array items by index", async () => {
    const source = src(
      "{", // 1
      '  "items": [', // 2
      '    { "id": 1, "tags": ["a", { "deep": 1 }] },', // 3
      '    { "id": 2 }', // 4
      "  ],", // 5
      '  "matrix": [[1], [2, {"k": 3}]]', // 6
      "}", // 7
    );
    expect(await keys("data.json", source)).toEqual([
      "key items 2-5",
      "key items.0.id 3-3",
      "key items.0.tags 3-3",
      "key items.0.tags.1.deep 3-3",
      "key items.1.id 4-4",
      "key matrix 6-6",
      "key matrix.1.1.k 6-6",
    ]);
  });

  it("limits keys to depth 6", async () => {
    const source = '{"a":{"b":{"c":{"d":{"e":{"f":{"g":1}}}}}}}\n';
    const paths = (await keys("deep.json", source)).map((l) => l.split(" ")[1]);
    expect(paths).toEqual(["a", "a.b", "a.b.c", "a.b.c.d", "a.b.c.d.e", "a.b.c.d.e.f"]);
  });

  it("unescapes keys, tolerates comments and trailing commas, numbers duplicates, skips empty keys", async () => {
    const source = src(
      "{",
      "  // comment",
      '  "esc\\"aped": 1,',
      '  "dup": 1,',
      '  "dup": 2,',
      '  "": 3,',
      '  "with.dot": 4,',
      "}",
    );
    const paths = (await keys("c.json", source)).map((l) => l.split(" ")[1]);
    expect(paths).toEqual(['esc"aped', "dup", "dup~2", "with.dot"]);
  });

  it("handles scalar roots, empty objects and arrays, and empty files", async () => {
    expect(await keys("a.json", "42\n")).toEqual([]);
    expect(await keys("b.json", "{}\n")).toEqual([]);
    expect(await keys("c.json", "[]\n")).toEqual([]);
    expect(await keys("d.json", "")).toEqual([]);
    expect(await keys("e.json", '[{"a": 1}, {"a": 2}]\n')).toEqual(["key 0.a 1-1", "key 1.a 1-1"]);
  });

  it("caps the number of keys per file and warns", async () => {
    const body = Array.from({ length: MAX_KEYS_PER_FILE + 10 }, (_, i) => `"k${i}": ${i}`).join(
      ",\n",
    );
    const { index, warnings } = await indexFiles({ "big.json": `{\n${body}\n}\n` });
    expect(index.symbols).toHaveLength(MAX_KEYS_PER_FILE);
    expect(warnings.some((w) => w.startsWith("big.json: 10 keys beyond the first"))).toBe(true);
  });

  it("indexes json with references none", async () => {
    const { index } = await indexFiles({ "c.json": '{"a": {"b": 1}}\n' });
    expect(index.refs).toEqual([]);
    expect(index.languages.json).toEqual({ files: 1, symbols: 2, refs: "none" });
  });
});

describe("TOML symbols", () => {
  it("tables and pairs are `key` symbols; pyproject.toml's [project.scripts] flask is project.scripts.flask", async () => {
    const source = src(
      "[build-system]", // 1
      'requires = ["hatchling"]', // 2
      'build-backend = "hatchling.build"', // 3
      "", // 4
      "[project]", // 5
      'name = "flask"', // 6
      'version = "3.1.3"', // 7
      "dependencies = [", // 8
      '  "blinker>=1.9",   # events', // 9
      '  "click>=8.1",', // 10
      "]", // 11
      "", // 12
      "[project.scripts]", // 13
      'flask = "flask.cli:main"', // 14
      "", // 15
      "[tool.pytest.ini_options]", // 16
      'testpaths = ["tests"]', // 17
    );
    expect(await keys("pyproject.toml", source)).toEqual([
      "key build-system 1-3",
      "key build-system.requires 2-2",
      "key build-system.build-backend 3-3",
      "key project 5-11",
      "key project.name 6-6",
      "key project.version 7-7",
      "key project.dependencies 8-11",
      "key project.scripts 13-14",
      "key project.scripts.flask 14-14",
      "key tool.pytest.ini_options 16-17",
      "key tool.pytest.ini_options.testpaths 17-17",
    ]);
  });

  it("indexes the file as toml, with its own line in the language summary, and says refs none", async () => {
    const { index } = await indexFiles({
      "pyproject.toml": '[project]\nname = "x"\n',
      "Cargo.TOML": '[package]\nname = "y"\n',
      "README.md": "# hi\n",
    });
    expect(index.files.find((f) => f.path === "pyproject.toml")!.language).toBe("toml");
    expect(index.files.find((f) => f.path === "Cargo.TOML")!.language).toBe("toml");
    expect(index.files.find((f) => f.path === "README.md")!.language).toBe("text");
    expect(index.refs).toEqual([]);
    expect(index.languages.toml).toEqual({ files: 2, symbols: 4, refs: "none" });
    expect(index.languages.text).toEqual({ files: 1, symbols: 0, refs: "none" });
    expect(index.symbols.map((s) => s.id).sort()).toEqual([
      "Cargo.TOML#package",
      "Cargo.TOML#package.name",
      "pyproject.toml#project",
      "pyproject.toml#project.name",
    ]);
    expect(index.tool).toContain("tree-sitter-toml@0.7.0");
  });

  it("the pack is found by the toml language (and by nothing else)", () => {
    expect(packFor("toml")).toBe(tomlPack);
    expect(packForFile("a/pyproject.toml", "toml")).toBe(tomlPack);
    expect(tomlPack.languages).toEqual(["toml"]);
    expect(packFor("text")).toBeUndefined();
    // a text file is not TOML just because of its extension: the language table decides
    expect(packForFile("notes.toml", "text")).toBeUndefined();
  });

  it("pairs at the top of the file, dotted keys, quoted keys, inline tables and arrays of inline tables", async () => {
    const source = src(
      'title = "x"   # root pair', // 1
      "a.b.c = 1", // 2
      '"quoted key".x = 2', // 3
      "point = { x = 1, y = { z = 2 } }", // 4
      "list = [ { k = 1 }, [ { deep = 1 } ] ]", // 5
      "[t]", // 6
      "u.v = 3", // 7
    );
    expect(await keys("c.toml", source)).toEqual([
      "key title 1-1",
      "key a.b.c 2-2",
      "key quoted key.x 3-3",
      "key point 4-4",
      "key point.x 4-4",
      "key point.y 4-4",
      "key point.y.z 4-4",
      "key list 5-5",
      "key list.0.k 5-5",
      "key list.1.0.deep 5-5",
      "key t 6-7",
      "key t.u.v 7-7",
    ]);
  });

  it("arrays of tables address their elements by index; tables below belong to the latest element", async () => {
    const source = src(
      "[[fruits]]", // 1
      'name = "apple"', // 2
      "", // 3
      "[fruits.physical]", // 4
      'color = "red"', // 5
      "", // 6
      "[[fruits.varieties]]", // 7
      'name = "red delicious"', // 8
      "", // 9
      "[[fruits]]", // 10
      'name = "banana"', // 11
      "", // 12
      "[[fruits.varieties]]", // 13
      'name = "plantain"', // 14
    );
    expect(await keys("fruits.toml", source)).toEqual([
      "key fruits.0 1-2",
      "key fruits.0.name 2-2",
      "key fruits.0.physical 4-5",
      "key fruits.0.physical.color 5-5",
      "key fruits.0.varieties.0 7-8",
      "key fruits.0.varieties.0.name 8-8",
      "key fruits.1 10-11",
      "key fruits.1.name 11-11",
      "key fruits.1.varieties.0 13-14",
      "key fruits.1.varieties.0.name 14-14",
    ]);
  });

  it("[[tool.mypy.overrides]] elements are tool.mypy.overrides.0, .1 with their pairs", async () => {
    const source = src(
      "[[tool.mypy.overrides]]", // 1
      'module = ["a"]', // 2
      "ignore_missing_imports = true", // 3
      "[[tool.mypy.overrides]]", // 4
      'module = ["b"]', // 5
    );
    expect(await keys("pyproject.toml", source)).toEqual([
      "key tool.mypy.overrides.0 1-3",
      "key tool.mypy.overrides.0.module 2-2",
      "key tool.mypy.overrides.0.ignore_missing_imports 3-3",
      "key tool.mypy.overrides.1 4-5",
      "key tool.mypy.overrides.1.module 5-5",
    ]);
  });

  it("a table ends at its last pair: comments and blank lines after it belong to what follows", async () => {
    const source = src(
      "[a]", // 1
      "x = 1", // 2
      "# trailing of a", // 3
      "", // 4
      "# about b", // 5
      "[b]", // 6
      "y = 2   # trailing", // 7
      "", // 8
      "# end", // 9
      "[c]", // 10
    );
    expect(await keys("c.toml", source)).toEqual([
      "key a 1-2",
      "key a.x 2-2",
      "key b 6-7",
      "key b.y 7-7",
      "key c 10-10",
    ]);
  });

  it("a multi-line array or string is one pair; trailing comments and comment lines inside do not extend it", async () => {
    const source = src(
      "multi = [", // 1
      '  "a",', // 2
      '  "b", # c', // 3
      "]   # after", // 4
      'text = """', // 5
      "one", // 6
      "two", // 7
      '"""', // 8
      "after = 1", // 9
    );
    expect(await keys("c.toml", source)).toEqual([
      "key multi 1-4",
      "key text 5-8",
      "key after 9-9",
    ]);
  });

  it("sets parents to the enclosing table or inline table (tables have none: they do not nest by range)", async () => {
    const source = src("[project.scripts]", 'flask = "x"', "point = { y = { z = 2 } }", "[other]");
    const { index } = await indexFiles({ "c.toml": source });
    expect(symbol(index, "c.toml", "project.scripts")!.parent).toBeUndefined();
    expect(symbol(index, "c.toml", "project.scripts.flask")!.parent).toBe("c.toml#project.scripts");
    expect(symbol(index, "c.toml", "project.scripts.point.y.z")!.parent).toBe(
      "c.toml#project.scripts.point.y",
    );
    expect(symbol(index, "c.toml", "other")!.parent).toBeUndefined();
    expect(symbol(index, "c.toml", "project")).toBeUndefined(); // implied tables are not symbols
    expect(symbol(index, "c.toml", "project.scripts")!.kind).toBe("key");
  });

  it("limits keys to depth 6, counting keys and not the indices of arrays of tables", async () => {
    expect(
      (await keys("d.toml", src("[a.b.c.d.e.f]", "g = 1", "[a.b.c.d.e.f.g]", "h = 1"))).map(
        (l) => l.split(" ")[1],
      ),
    ).toEqual(["a.b.c.d.e.f"]);
    expect(
      (
        await keys("e.toml", src("[[a.b]]", "[[a.b.c]]", "[[a.b.c.d]]", "e.f = 1", "e.f.g = 2"))
      ).map((l) => l.split(" ")[1]),
    ).toEqual(["a.b.0", "a.b.0.c.0", "a.b.0.c.0.d.0", "a.b.0.c.0.d.0.e.f"]);
  });

  it("unescapes quoted keys, keeps dots inside them, numbers duplicates, tolerates errors and empty files", async () => {
    expect(await keys("e.toml", "")).toEqual([]);
    expect(await keys("c.toml", "# only a comment\n")).toEqual([]);
    const paths = (
      await keys("q.toml", src('"esc\\"aped" = 1', "'lit\\eral' = 2", "dup = 1", "dup = 2"))
    ).map((l) => l.split(" ")[1]);
    expect(paths).toEqual(['esc"aped', "lit\\eral", "dup", "dup~2"]);
    expect(await keys("bad.toml", src("a = 1", "b = [unclosed", "c = 2"))).toContain("key a 1-1");
  });

  it("caps the number of keys per file and warns", async () => {
    const lines = Array.from({ length: MAX_KEYS_PER_FILE + 20 }, (_, i) => `k${i} = ${i}`);
    const { index, warnings } = await indexFiles({ "big.toml": lines.join("\n") + "\n" });
    expect(index.symbols).toHaveLength(MAX_KEYS_PER_FILE);
    expect(warnings.some((w) => w.startsWith("big.toml: 20 keys beyond the first"))).toBe(true);
  });

  it("only files with the extension .toml are parsed as TOML", async () => {
    const { index } = await indexFiles({
      "Cargo.TOML": "[package]\nname = 'x'\n",
      "settings.toml.example": "[a]\nb = 1\n",
      toml: "[a]\nb = 1\n",
    });
    expect(symbolLines(index, "Cargo.TOML")).toEqual(["key package 1-2", "key package.name 2-2"]);
    expect(symbolLines(index, "settings.toml.example")).toEqual([]);
    expect(symbolLines(index, "toml")).toEqual([]);
  });
});
