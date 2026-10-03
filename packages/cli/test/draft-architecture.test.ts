/**
 * `xpl draft repo` on projects that talk to the outside world: the system map shows the service, who reaches it and
 * what it relies on (found from the import lines), each service box opens the map of its inside, and the arrows to
 * the outside systems carry the import line as evidence at both ends. The draft applies and validates as it is.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { ExplainerPatch, GraphView } from "@xpl/core";
import { importsOf } from "../src/outside.js";
import { makeTempDir, writeFile, xpl, xplJson } from "./helpers.js";

interface DraftJson {
  notes: string[];
  patch: ExplainerPatch;
}

async function drafted(dir: string): Promise<{ patch: ExplainerPatch; notes: string[] }> {
  expect((await xpl(dir, "index", "--precise", "off")).code).toBe(0);
  expect((await xpl(dir, "new", "shop")).code).toBe(0);
  const out = join(makeTempDir("xpl-arch-out-"), "draft.json");
  const r = await xpl(dir, "draft", "repo", "shop", "-o", out);
  expect(r.code, r.err + r.out).toBe(0);
  const json = await xplJson<DraftJson>(dir, "draft", "repo", "shop");
  const patch = JSON.parse(readFileSync(out, "utf8")) as ExplainerPatch;
  const applied = await xpl(dir, "apply", "shop", out);
  expect(applied.code, applied.out).toBe(0);
  expect(applied.out, "no warnings from apply").not.toContain("warning");
  const validated = await xpl(dir, "validate", "shop");
  expect(validated.out).toMatch(/no errors, no warnings$/);
  const lint = await xplJson<{ counts: Record<string, number> }>(dir, "lint", "shop");
  expect(Object.keys(lint.json.counts)).toEqual(["todo-left"]);
  return { patch, notes: json.json.notes };
}

const graph = (patch: ExplainerPatch, id: string) =>
  patch.views!.find((v) => v.id === id) as GraphView | undefined;

describe("xpl draft repo: one service and what it relies on", () => {
  const dir = makeTempDir("xpl-arch-");
  writeFile(dir, "README.md", "# shop\n\nA small web shop that takes orders and payments.\n");
  writeFile(dir, "package.json", '{ "name": "shop", "description": "A small web shop" }\n');
  writeFile(
    dir,
    "src/server.ts",
    'import express from "express";\nimport { placeOrder } from "./orders/place.js";\n\nexport function start() {\n  const app = express();\n  app.post("/orders", (req, res) => res.json(placeOrder(req.body)));\n  return app;\n}\n',
  );
  writeFile(
    dir,
    "src/orders/place.ts",
    'import { saveOrder } from "../db/orders.js";\nimport { charge } from "../payments/charge.js";\n\nexport function placeOrder(order: { id: string; total: number }) {\n  charge(order.total);\n  return saveOrder(order);\n}\n',
  );
  writeFile(
    dir,
    "src/db/orders.ts",
    'import { Pool } from "pg";\nimport Redis from "ioredis";\n\nconst pool = new Pool();\nconst cache = new Redis();\n\nexport function saveOrder(order: { id: string }) {\n  cache.del(order.id);\n  return pool.query("insert into orders values ($1)", [order.id]);\n}\n',
  );
  writeFile(
    dir,
    "src/payments/charge.ts",
    'import Stripe from "stripe";\n\nconst stripe = new Stripe("key");\n\nexport function charge(total: number) {\n  return stripe.charges.create({ amount: total });\n}\n',
  );
  writeFile(
    dir,
    "src/payments/charge.test.ts",
    'import { charge } from "./charge.js";\ncharge(1);\n',
  );

  it("draws the system map, the inside of the service, and an arrow from each part to what it uses", async () => {
    const { patch, notes } = await drafted(dir);
    const system = graph(patch, "view:system")!;
    expect(system.include).toEqual([
      "grp:clients",
      "grp:shop",
      "grp:postgres",
      "grp:redis",
      "grp:stripe",
    ]);
    const node = (id: string) => patch.nodes!.find((n) => n.id === id)!;
    expect(node("grp:shop")).toMatchObject({
      role: "service",
      tech: "TypeScript",
      opens: "view:overview",
    });
    expect(node("grp:postgres")).toMatchObject({ role: "database", tech: "PostgreSQL" });
    // an outside system is not code of the repo: no members, its anchors are its code
    expect(node("grp:postgres").members).toBeUndefined();
    expect(node("grp:redis")).toMatchObject({ role: "cache", tech: "Redis" });
    expect(node("grp:stripe")).toMatchObject({ role: "external" });
    expect(node("grp:clients")).toMatchObject({ role: "person", tech: "HTTP" });
    // anchored at the import line, never at a test
    expect(node("grp:postgres").anchors).toEqual([
      { file: "src/db/orders.ts", span: { from: 0, to: 0 }, role: "usage" },
    ]);

    const inside = graph(patch, "view:overview")!;
    expect(inside.include).toEqual(
      expect.arrayContaining([
        "dir:src/db",
        "dir:src/orders",
        "dir:src/payments",
        "file:src/server.ts",
      ]),
    );
    expect(inside.include).toEqual(
      expect.arrayContaining(["grp:postgres", "grp:stripe", "grp:clients"]),
    );
    const edges = patch.edges!.map((e) => `${e.from} -> ${e.to}`);
    expect(edges).toEqual(
      expect.arrayContaining([
        "dir:src/db -> grp:postgres",
        "dir:src/db -> grp:redis",
        "dir:src/payments -> grp:stripe",
        "grp:clients -> file:src/server.ts",
      ]),
    );
    // the tour: the big picture, what it relies on, then down one level
    const steps = patch.tours![0]!.steps!;
    expect(steps.map((s) => s.view).slice(0, 3)).toEqual([
      "view:system",
      "view:system",
      "view:overview",
    ]);
    expect(steps[1]!.focus).toEqual(["grp:postgres", "grp:redis", "grp:stripe"]);
    expect(notes.join("\n")).toContain("PostgreSQL database (PostgreSQL)");
  });
});

describe("xpl draft repo: several services", () => {
  const dir = makeTempDir("xpl-arch-multi-");
  writeFile(dir, "README.md", "# shop\n\nTwo services: an API and a worker.\n");
  writeFile(
    dir,
    "services/api/main.py",
    "import flask\nfrom api.routes import register\n\n\ndef main():\n    app = flask.Flask('api')\n    register(app)\n    return app\n",
  );
  writeFile(
    dir,
    "services/api/routes.py",
    "import psycopg2\n\n\ndef register(app):\n    conn = psycopg2.connect('')\n    return conn\n",
  );
  writeFile(
    dir,
    "services/worker/main.py",
    "from celery import Celery\n\n\ndef main():\n    return Celery('worker')\n",
  );
  writeFile(dir, "services/worker/jobs.py", "def send_mail(to):\n    return to\n");

  it("gives each service a box that opens its own map", async () => {
    const { patch } = await drafted(dir);
    const system = graph(patch, "view:system")!;
    expect(system.include).toEqual(
      expect.arrayContaining([
        "dir:services/api",
        "dir:services/worker",
        "grp:postgres",
        "grp:job-queue",
      ]),
    );
    const api = patch.nodes!.find((n) => n.id === "dir:services/api")!;
    expect(api).toMatchObject({ role: "service", tech: "Python", opens: "view:api-inside" });
    expect(graph(patch, "view:api-inside")!.include).toEqual(
      expect.arrayContaining([
        "file:services/api/main.py",
        "file:services/api/routes.py",
        "grp:postgres",
      ]),
    );
    expect(graph(patch, "view:worker-inside")!.include).toContain("grp:job-queue");
  });
});

describe("importsOf", () => {
  it("reads the imports of each language, not the code around them", () => {
    expect(
      importsOf(
        [
          'import { a } from "./a.js";',
          'import type { B } from "pg";',
          'const x = require("ioredis");',
          '// import nothing from "stripe";',
          'export * from "kafkajs";',
        ],
        "js",
      ).map((i) => i.module),
    ).toEqual(["./a.js", "pg", "ioredis", "kafkajs"]);
    expect(
      importsOf(
        ["import os, requests", "from sqlalchemy.orm import Session", "x = 'import y'"],
        "py",
      ).map((i) => i.module),
    ).toEqual(["os", "requests", "sqlalchemy.orm"]);
    expect(
      importsOf(
        [
          "package main",
          "import (",
          '\t"fmt"',
          '\tpgx "github.com/jackc/pgx/v5"',
          ")",
          'import "flag"',
        ],
        "go",
      ).map((i) => `${i.module}@${i.line}`),
    ).toEqual(["fmt@3", "github.com/jackc/pgx/v5@4", "flag@6"]);
  });
});
