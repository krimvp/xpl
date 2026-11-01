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
import { git, makeTempDir, writeFile, xpl, xplJson } from "./helpers.js";

interface DraftJson {
  notes: string[];
  patch: ExplainerPatch;
}

function shop(): string {
  const dir = makeTempDir("xpl-map-");
  writeFile(dir, "README.md", "# shop\n\nSells things.\n");
  writeFile(dir, "package.json", '{ "name": "shop" }\n');
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

async function draft(dir: string): Promise<DraftJson> {
  const out = join(makeTempDir("xpl-map-out-"), "map.json");
  const r = await xpl(dir, "draft", "map", "shop", "-o", out);
  expect(r.code, r.err + r.out).toBe(0);
  const json = await xplJson<DraftJson>(dir, "draft", "map", "shop");
  const applied = await xpl(dir, "apply", "shop", out);
  expect(applied.code, applied.out).toBe(0);
  expect(applied.out, "no warnings from apply").not.toContain("warning");
  const validated = await xpl(dir, "validate", "shop");
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
          ],
        ],
      ],
    );
    expect(notes).toEqual([
      "4 code files on 2 maps; 1 file left off (tests, examples, fixtures, docs and benchmarks)",
    ]);
    const lint = await xplJson<{ counts: Record<string, number> }>(dir, "lint", "shop");
    expect(Object.keys(lint.json.counts)).toEqual(["todo-left"]);
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
        ],
      ],
    ]);
    expect(notes).toEqual([
      "4 code files on 2 maps; 1 file left off (tests, examples, fixtures, docs and benchmarks)",
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

  it("is not the doc of the first declaration, nor code", () => {
    expect(header("/** Payload of a job. */\nexport interface Job {}")).toBeUndefined();
    expect(header("export function a() {}\n// later")).toBeUndefined();
  });
});
