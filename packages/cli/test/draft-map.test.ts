/**
 * `xpl draft map`: the quick map of a whole project. Every code file outside tests gets a box with a name and a
 * one-sentence summary to write, and the TODO carries what the index knows about the file; every folder is a box that
 * opens the map of its own files. Run again after the code changed, it drafts only what is new and drops what is
 * gone, keeping the text already written. With a change recorded, it adds a tour of the changed files.
 */
import { readFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import type { ExplainerPatch, GraphView, PatchGraphView } from "@xpl/core";
import { headerComment } from "../src/draft-map.js";
import { copyFixture, git, makeTempDir, writeFile, xpl, xplJson } from "./helpers.js";

interface DraftJson {
  notes: string[];
  patch: ExplainerPatch;
}

function shop(): string {
  const dir = makeTempDir("xpl-map-");
  writeFile(dir, "README.md", "# shop\n\nSells things.\n");
  writeFile(dir, "package.json", '{ "name": "shop" }\n');
  // a file off the map (docs) that is not code: the note on files with no box leaves it out
  writeFile(dir, "docs/notes.txt", "Notes.\n");
  writeFile(
    dir,
    "src/main.ts",
    '// Starts the shop.\nimport { placeOrder } from "./orders/place";\n\nexport function main(): void {\n  placeOrder();\n}\n',
  );
  writeFile(
    dir,
    "src/orders/place.ts",
    'import { charge } from "../payments/stripe";\n\nexport function placeOrder(): number {\n  return charge(10);\n}\n',
  );
  writeFile(dir, "src/orders/cancel.ts", "export function cancelOrder(): void {}\n");
  writeFile(
    dir,
    "src/payments/stripe.ts",
    "/** Charges a card. */\n\nexport function charge(amount: number): number {\n  return amount;\n}\n",
  );
  writeFile(
    dir,
    "src/orders/place.test.ts",
    'import { placeOrder } from "./place";\n\nexport function check(): void {\n  placeOrder();\n}\n',
  );
  return dir;
}

async function draft(dir: string, guide = "shop"): Promise<DraftJson> {
  const out = join(makeTempDir("xpl-map-out-"), "map.json");
  const r = await xpl(dir, "draft", "map", guide, "-o", out);
  expect(r.code, r.err + r.out).toBe(0);
  const json = await xplJson<DraftJson>(dir, "draft", "map", guide);
  const applied = await xpl(dir, "apply", guide, out);
  expect(applied.code, applied.out).toBe(0);
  expect(applied.out, "no warnings from apply").not.toContain("warning");
  const validated = await xpl(dir, "validate", guide);
  expect(validated.out).toMatch(/no errors, no warnings$/);
  return { patch: JSON.parse(readFileSync(out, "utf8")) as ExplainerPatch, notes: json.json.notes };
}

const view = (patch: ExplainerPatch, id: string) =>
  patch.views?.find((v) => v.id === id) as (GraphView & PatchGraphView) | undefined;
const node = (patch: ExplainerPatch, id: string) => patch.nodes?.find((n) => n.id === id);

describe("xpl draft map", () => {
  it("maps every code file outside tests, one map per folder, with what the index knows in each TODO", async () => {
    const dir = shop();
    expect((await xpl(dir, "index", "--precise", "off")).code).toBe(0);
    expect((await xpl(dir, "new", "shop")).code).toBe(0);
    const { patch, notes } = await draft(dir);

    // the top level is below src (it holds all the code); a folder of one file is that file
    expect(view(patch, "view:map")?.include).toEqual([
      "dir:src/orders",
      "file:src/main.ts",
      "file:src/payments/stripe.ts",
    ]);
    expect(view(patch, "view:map")?.boxText).toBe("summary");
    expect(view(patch, "view:map-src-orders")?.include).toEqual([
      "file:src/orders/cancel.ts",
      "file:src/orders/place.ts",
    ]);
    expect(node(patch, "dir:src/orders")).toEqual({
      id: "dir:src/orders",
      label: "TODO: 1-3 plain words for this part (now: orders)",
      summary:
        "TODO: one plain sentence: what this part does for the project (2 files: `cancel.ts` and `place.ts`).",
      opens: "view:map-src-orders",
    });
    expect(node(patch, "file:src/orders/place.ts")).toEqual({
      id: "file:src/orders/place.ts",
      label: "TODO: 2-5 plain words for this file (now: place.ts)",
      summary:
        "TODO: one plain sentence: what this file does for the project (defines `placeOrder`; used by `main.ts`; uses `stripe.ts`).",
    });
    expect(node(patch, "file:src/payments/stripe.ts")?.summary).toBe(
      'TODO: one plain sentence: what this file does for the project (header: "Charges a card."; defines `charge`; used by `place.ts`).',
    );
    expect(node(patch, "file:src/orders/place.test.ts")).toBeUndefined();
    // the start tour: the top map with the README's description, then each top folder at its most used file
    expect(patch.tours?.map((t) => [t.id, t.steps?.map((s) => [s.view, s.focus, s.code])])).toEqual(
      [
        [
          "tour:map",
          [
            [
              "view:map",
              ["dir:src/orders", "file:src/main.ts", "file:src/payments/stripe.ts"],
              [{ file: "README.md", span: { from: 2, to: 2 }, role: "usage" }],
            ],
            [
              "view:map",
              ["dir:src/orders"],
              [{ file: "src/orders/place.ts", symbol: "placeOrder", role: "definition" }],
            ],
            // the last step: where a newcomer starts reading, at the entry file's `main`
            [
              "view:map",
              ["file:src/main.ts"],
              [{ file: "src/main.ts", symbol: "main", role: "definition" }],
            ],
          ],
        ],
      ],
    );
    expect(patch.tours?.[0]?.steps?.at(-1)?.note).toBe(
      "### Where to go next: TODO: where a newcomer starts reading, as a plain statement\n\nTODO: why to start at `src/main.ts`: what runs first and which parts it calls.",
    );
    expect(notes).toEqual([
      "4 code files on 2 maps; 1 file left off (tests, examples, fixtures, docs, benchmarks, playgrounds, templates, demos and sandboxes); 2 files that are not code have no box: `README.md` and `package.json`",
    ]);
    const lint = await xplJson<{ counts: Record<string, number> }>(dir, "lint", "shop");
    expect(Object.keys(lint.json.counts)).toEqual(["todo-left"]);
  });

  it("starts a newcomer at the shallowest file with a `main` function, else at the shallowest entry name", async () => {
    const lastCode = async (entry: string) => {
      const dir = makeTempDir("xpl-map-entry-");
      writeFile(
        dir,
        "src/index.ts",
        'import { run } from "../tools/run/start";\n\nexport function boot(): void {\n  run();\n}\n',
      );
      writeFile(
        dir,
        "tools/run/start.ts",
        `export function run(): void {}\n\nexport function ${entry}(): void {\n  run();\n}\n`,
      );
      writeFile(
        dir,
        "src/cli/sub/main.ts",
        `import { boot } from "../../index";\n\nexport function ${entry}(): void {\n  boot();\n}\n`,
      );
      expect((await xpl(dir, "index", "--precise", "off")).code).toBe(0);
      expect((await xpl(dir, "new", "m")).code).toBe(0);
      const json = await xplJson<DraftJson>(dir, "draft", "map", "m");
      expect(json.code, json.out).toBe(0);
      return json.json.patch.tours?.[0]?.steps?.at(-1)?.code;
    };
    // a `main` beats an entry name, and the shallower `main` beats the deeper one
    expect(await lastCode("main")).toEqual([
      { file: "tools/run/start.ts", symbol: "main", role: "definition" },
    ]);
    // no `main` anywhere: the shallowest entry name, at its first definition
    expect(await lastCode("go")).toEqual([
      { file: "src/index.ts", symbol: "boot", role: "definition" },
    ]);
  });

  it("starts a Java newcomer at the class with `static void main`", async () => {
    const dir = copyFixture("java-jobrunner");
    expect((await xpl(dir, "index", "--precise", "off")).code).toBe(0);
    expect((await xpl(dir, "new", "m")).code).toBe(0);
    const json = await xplJson<DraftJson>(dir, "draft", "map", "m");
    expect(json.code, json.out).toBe(0);
    expect(json.json.patch.tours?.[0]?.steps?.at(-1)?.code).toEqual([
      { file: "src/main/java/jobrunner/Main.java", symbol: "Main.main", role: "definition" },
    ]);
    expect(json.json.notes.join("\n")).not.toContain("no entry file found");
  });

  it("shows the requests of the screen code to the server routes as an arrow between their folders", async () => {
    const dir = makeTempDir("xpl-map-");
    writeFile(
      dir,
      "web/orders.ts",
      'export function loadOrders() {\n  return fetch("/api/orders");\n}\n',
    );
    writeFile(dir, "web/main.ts", 'import { loadOrders } from "./orders";\nloadOrders();\n');
    writeFile(
      dir,
      "server/orders.ts",
      "export function listOrders(req, res) {\n  res.json([]);\n}\n",
    );
    writeFile(
      dir,
      "server/app.ts",
      'import express from "express";\nimport { listOrders } from "./orders";\nconst app = express();\napp.get("/api/orders", listOrders);\n',
    );
    expect((await xpl(dir, "index", "--precise", "off")).code).toBe(0);
    expect((await xpl(dir, "new", "shop")).code).toBe(0);
    const { patch } = await draft(dir);

    expect(view(patch, "view:map")?.include).toEqual(["dir:server", "dir:web"]);
    const { json } = await xplJson<any>(dir, "status", "shop");
    const map = json.views.find((v: any) => v.id === "view:map");
    expect(map.edges.unexplained.map((e: any) => e.id)).toEqual([
      "edge:requests:dir:web->dir:server",
    ]);
  });

  it("leaves off files that define and use nothing, such as a package's docstring-only __init__.py", async () => {
    const dir = makeTempDir("xpl-map-");
    writeFile(dir, "app/__init__.py", '"""The app package."""\n');
    writeFile(dir, "app/routes/__init__.py", '"""API routes package."""\n');
    writeFile(dir, "app/routes/orders.py", "def list_orders():\n    return []\n");
    writeFile(dir, "app/routes/users.py", "def list_users():\n    return []\n");
    writeFile(dir, "app/main.py", "from app.routes.orders import list_orders\n\nlist_orders()\n");
    expect((await xpl(dir, "index", "--precise", "off")).code).toBe(0);
    expect((await xpl(dir, "new", "shop")).code).toBe(0);
    const { patch, notes } = await draft(dir);

    expect(view(patch, "view:map")?.include).toEqual(["dir:app/routes", "file:app/main.py"]);
    expect(view(patch, "view:map-app-routes")?.include).toEqual([
      "file:app/routes/orders.py",
      "file:app/routes/users.py",
    ]);
    expect(notes).toEqual([
      "3 code files on 2 maps; 0 files left off (tests, examples, fixtures, docs, benchmarks, playgrounds, templates, demos and sandboxes); 2 empty files left off (they define and use nothing)",
    ]);
  });

  it("run again, drafts only new files and drops the boxes of files that are gone", async () => {
    const dir = shop();
    expect((await xpl(dir, "index", "--precise", "off")).code).toBe(0);
    expect((await xpl(dir, "new", "shop")).code).toBe(0);
    await draft(dir);

    rmSync(join(dir, "src/orders/cancel.ts"));
    writeFile(dir, "src/orders/refund.ts", "export function refund(): void {}\n");
    expect((await xpl(dir, "index", "--precise", "off")).code).toBe(0);
    const resolved = await xpl(dir, "resolve", "shop", "--write");
    expect(resolved.code, resolved.out + resolved.err).toBe(0);
    const { patch } = await draft(dir);

    expect(patch.views).toEqual([
      {
        id: "view:map-src-orders",
        type: "graph",
        includeAdd: ["file:src/orders/refund.ts"],
        includeRemove: ["file:src/orders/cancel.ts"],
      },
    ]);
    expect(patch.nodes).toEqual([
      {
        id: "file:src/orders/refund.ts",
        label: "TODO: 2-5 plain words for this file (now: refund.ts)",
        summary:
          "TODO: one plain sentence: what this file does for the project (defines `refund`).",
      },
    ]);
    expect(patch.remove).toEqual(["file:src/orders/cancel.ts"]);
    expect(patch.tours).toBeUndefined();
  });

  it("run again, carries the written name and sentence of a moved file to its new path", async () => {
    const dir = shop();
    git(dir, "init", "-q", "-b", "main");
    git(dir, "add", "-A");
    git(dir, "commit", "-q", "-m", "base");
    expect((await xpl(dir, "index", "--precise", "off")).code).toBe(0);
    expect((await xpl(dir, "new", "shop")).code).toBe(0);
    await draft(dir);
    const written = join(makeTempDir("xpl-map-text-"), "text.json");
    writeFile(
      dirname(written),
      "text.json",
      JSON.stringify({
        nodes: [
          {
            id: "file:src/orders/place.ts",
            label: "Place an order",
            summary: "Charges the card for a new order.",
          },
        ],
      }),
    );
    expect((await xpl(dir, "apply", "shop", written)).code).toBe(0);

    git(dir, "mv", "src/orders/place.ts", "src/orders/checkout.ts");
    writeFile(
      dir,
      "src/main.ts",
      readFileSync(join(dir, "src/main.ts"), "utf8").replace("./orders/place", "./orders/checkout"),
    );
    git(dir, "commit", "-q", "-am", "rename");
    expect((await xpl(dir, "index", "--precise", "off")).code).toBe(0);
    expect((await xpl(dir, "resolve", "shop", "--write")).code).toBe(0);
    const { patch, notes } = await draft(dir);

    expect(patch.nodes).toEqual([
      {
        id: "file:src/orders/checkout.ts",
        label: "Place an order",
        summary: "Charges the card for a new order.",
      },
    ]);
    expect(patch.remove).toEqual(["file:src/orders/place.ts"]);
    // the start tour's step for the folder shows its code at the new path
    expect(patch.tours?.map((t) => [t.id, t.steps?.map((step) => [step.id, step.code])])).toEqual([
      [
        "tour:map",
        [
          ["t1", [{ file: "README.md", span: { from: 2, to: 2 }, role: "usage" }]],
          ["t2", [{ file: "src/orders/checkout.ts", symbol: "placeOrder", role: "definition" }]],
          ["t3", [{ file: "src/main.ts", symbol: "main", role: "definition" }]],
        ],
      ],
    ]);
    expect(notes).toEqual([
      "4 code files on 2 maps; 1 file left off (tests, examples, fixtures, docs, benchmarks, playgrounds, templates, demos and sandboxes); 2 files that are not code have no box: `README.md` and `package.json`",
      "1 moved file keeps its text: src/orders/place.ts -> src/orders/checkout.ts",
    ]);
  });

  it("with a change recorded, adds a tour of the changed files on their folder's map", async () => {
    const dir = shop();
    git(dir, "init", "-q", "-b", "main");
    git(dir, "add", "-A");
    git(dir, "commit", "-q", "-m", "base");
    writeFile(
      dir,
      "src/orders/place.ts",
      'import { charge } from "../payments/stripe";\n\nexport function placeOrder(): number {\n  return charge(20);\n}\n',
    );
    writeFile(dir, "src/orders/refund.ts", "export function refund(): void {}\n");
    git(dir, "add", "-A");
    git(dir, "commit", "-q", "-m", "head");
    const head = git(dir, "rev-parse", "--short=7", "HEAD");
    expect((await xpl(dir, "index", "--precise", "off")).code).toBe(0);
    expect((await xpl(dir, "new", "shop")).code).toBe(0);
    expect((await xpl(dir, "change", "shop", "HEAD~1..HEAD")).code).toBe(0);
    const { patch } = await draft(dir);

    const tour = patch.tours?.find((t) => t.id === `tour:changes-${head}`);
    expect(tour?.summary).toBe(
      "TODO: what was asked for, in the words of whoever asked. TODO: what was done and where it stands; name anything deleted.",
    );
    expect(tour?.steps).toEqual([
      {
        id: "t1",
        view: "view:map-src-orders",
        focus: ["file:src/orders/place.ts"],
        note: "### TODO: what changed in this file, as a plain statement\n\nTODO: what changed here and how it serves what was asked, in one or two plain sentences (changed: `placeOrder`).",
        code: [
          {
            file: "src/orders/place.ts",
            symbol: "placeOrder",
            span: { from: 1, to: 1 },
            role: "definition",
          },
        ],
        editor: { primary: "src/orders/place.ts" },
      },
      {
        id: "t2",
        view: "view:map-src-orders",
        focus: ["file:src/orders/refund.ts"],
        note: "### TODO: what this new file is for, as a plain statement\n\nTODO: what it does and how it serves what was asked, in one or two plain sentences (new: `refund`).",
        code: [{ file: "src/orders/refund.ts", symbol: "refund", role: "definition" }],
        editor: { primary: "src/orders/refund.ts" },
      },
    ]);
  });
});

describe("headerComment", () => {
  const header = (text: string) => headerComment(text.split("\n"));

  it("reads the first sentence of a comment that opens the file", () => {
    expect(header("// Starts the shop. Reads the config first.\nimport x from 'y';")).toBe(
      "Starts the shop.",
    );
    expect(header("// Package queue holds the jobs.\npackage queue")).toBe(
      "Package queue holds the jobs.",
    );
    expect(header('#!/usr/bin/env python\n"""Command line of the runner."""\n\nimport sys')).toBe(
      "Command line of the runner.",
    );
    expect(header("/**\n * Text helpers.\n * @module text\n */\n\nexport const a = 1;")).toBe(
      "Text helpers.",
    );
  });

  it("skips a license or banner comment and reads the comment after it", () => {
    // ky's source/index.ts opens with a preserved banner, then an import
    expect(header("/*! MIT License © Sindre Sorhus */\n\nimport {Ky} from './core/Ky.js';")).toBe(
      undefined,
    );
    // a `/*!` banner without a license word is a banner too
    expect(
      header("/*! Tiny HTTP client based on fetch. */\n\nimport {Ky} from './core/Ky.js';"),
    ).toBe(undefined);
    expect(
      header(
        "// Copyright 2024 The Authors.\n// SPDX-License-Identifier: Apache-2.0\n\n// Package queue holds the jobs.\npackage queue",
      ),
    ).toBe("Package queue holds the jobs.");
    expect(
      header('# Licensed under the MIT license.\n\n"""Retries failed jobs."""\nimport x'),
    ).toBe("Retries failed jobs.");
    // the word alone is no banner
    expect(header("// Checks the license field of a package.\nimport x from 'y';")).toBe(
      "Checks the license field of a package.",
    );
  });

  it("is not the doc of the first declaration, nor code", () => {
    expect(header("/** Payload of a job. */\nexport interface Job {}")).toBeUndefined();
    expect(header("export function a() {}\n// later")).toBeUndefined();
  });
});

describe("xpl draft map on a crowded folder", () => {
  /** Two chains of 16 files each in one folder: a1 -> a2 -> ... -> a16 and b1 -> ... -> b16. */
  function crowded(): string {
    const dir = makeTempDir("xpl-map-crowded-");
    writeFile(dir, "package.json", '{ "name": "big" }\n');
    for (const team of ["a", "b"]) {
      for (let i = 1; i <= 16; i++) {
        const next = i < 16 ? `import { ${team}${i + 1} } from "./${team}${i + 1}";\n\n` : "";
        const body = i < 16 ? `  return ${team}${i + 1}() + 1;` : "  return 1;";
        writeFile(
          dir,
          `src/${team}${i}.ts`,
          `${next}export function ${team}${i}(): number {\n${body}\n}\n`,
        );
      }
    }
    return dir;
  }

  it("groups files that use each other; each group is a box that opens the map of its files", async () => {
    const dir = crowded();
    expect((await xpl(dir, "index", "--precise", "off")).code).toBe(0);
    expect((await xpl(dir, "new", "big")).code).toBe(0);
    const { patch, notes } = await draft(dir, "big");
    const groups = patch.nodes!.filter((n) => n.id.startsWith("grp:"));
    // every file is in a group of at most 8 files of one chain
    expect(groups.map((g) => g.members!.length).reduce((a, b) => a + b, 0)).toBe(32);
    for (const g of groups) {
      expect(g.members!.length).toBeLessThanOrEqual(8);
      expect(new Set(g.members!.map((m) => m.slice("file:src/".length)[0])).size).toBe(1);
      expect(g.label).toMatch(/^TODO: 1-3 plain words for what these files do together/);
      expect(view(patch, g.opens!)?.include).toEqual(g.members);
    }
    // the folder's map shows the groups, not their files
    expect(view(patch, "view:map")?.include).toEqual(groups.map((g) => g.id));
    expect(notes).toEqual([
      "32 code files on 5 maps; 0 files left off (tests, examples, fixtures, docs, benchmarks, playgrounds, templates, demos and sandboxes); 1 file that is not code has no box: `package.json`",
      "no entry file found (no `main` function and no file with an entry name such as main, index, app or cli): the start tour has no step on where to start reading; add one if the project has a clear first file",
      "crowded maps get groups of files that use each other (the top: 4 groups of 32 files): name each group, or remove the ones that are not one job",
    ]);
  });

  it("run again, keeps the group maps and drops the files that are gone from them", async () => {
    const dir = crowded();
    expect((await xpl(dir, "index", "--precise", "off")).code).toBe(0);
    expect((await xpl(dir, "new", "big")).code).toBe(0);
    const first = (await draft(dir, "big")).patch;
    const group = first.nodes!.find((n) => n.members?.includes("file:src/a16.ts"))!;

    rmSync(join(dir, "src/a16.ts"));
    writeFile(dir, "src/a15.ts", "export function a15(): number {\n  return 1;\n}\n");
    writeFile(dir, "src/c1.ts", "export function c1(): number {\n  return 1;\n}\n");
    expect((await xpl(dir, "index", "--precise", "off")).code).toBe(0);
    expect((await xpl(dir, "resolve", "big", "--write")).code).toBe(0);
    const { patch } = await draft(dir, "big");

    expect(patch.views).toEqual([
      { id: "view:map", type: "graph", includeAdd: ["file:src/c1.ts"] },
      { id: group.opens, type: "graph", includeRemove: ["file:src/a16.ts"] },
    ]);
    expect(patch.nodes?.find((n) => n.id === group.id)).toEqual({
      id: group.id,
      members: group.members!.filter((m) => m !== "file:src/a16.ts"),
    });
    expect(patch.remove).toEqual(["file:src/a16.ts"]);
  });
});

describe("xpl draft map: a folder too dense for boxes and arrows", () => {
  it("opens a map of more than 12 boxes as a dependency matrix, and says so; 12 stay boxes", async () => {
    const dir = makeTempDir("xpl-map-matrix-");
    writeFile(dir, "package.json", '{ "name": "dense" }\n');
    for (let i = 1; i <= 13; i++) {
      writeFile(dir, `src/big/f${i}.ts`, `export function f${i}(): number {\n  return ${i};\n}\n`);
    }
    for (let i = 1; i <= 12; i++) {
      writeFile(
        dir,
        `src/small/g${i}.ts`,
        `export function g${i}(): number {\n  return ${i};\n}\n`,
      );
    }
    expect((await xpl(dir, "index", "--precise", "off")).code).toBe(0);
    expect((await xpl(dir, "new", "dense")).code).toBe(0);
    const { patch, notes } = await draft(dir, "dense");
    const render = (folder: string) =>
      (patch.views!.find((v) => v.scope?.root === `dir:${folder}`) as GraphView).render;
    expect(render("src/big")).toBe("matrix");
    expect(render("src/small")).toBeUndefined();
    expect(notes.join("\n")).toContain('open as a dependency matrix (`render: "matrix"`');
  });
});
