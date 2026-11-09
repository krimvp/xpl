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
import { copyFixture, makeTempDir, writeFile, xpl, xplJson } from "./helpers.js";

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
  // every text `ready` requires has a TODO to write: none is left empty once the TODOs are written
  const ready = await xplJson<{ findings: { code: string; elementId: string; field: string }[] }>(
    dir,
    "ready",
    "shop",
  );
  expect(ready.json.findings.filter((f) => f.code === "required-content")).toEqual([]);
  return { patch, notes: json.json.notes };
}

const graph = (patch: ExplainerPatch, id: string) =>
  patch.views!.find((v) => v.id === id) as GraphView | undefined;

describe("xpl draft repo: one service and what it relies on", () => {
  it("shows Spring clients and PostgreSQL from Java imports", async () => {
    const project = makeTempDir("xpl-java-shop-");
    writeFile(project, "README.md", "# shop\n\nA Java web application.\n");
    writeFile(
      project,
      "pom.xml",
      "<project><parent><groupId>org.springframework.boot</groupId></parent><groupId>dev.shop</groupId></project>\n",
    );
    writeFile(
      project,
      "src/main/java/dev/shop/OrderController.java",
      "package dev.shop;\nimport org.springframework.boot.web.servlet.ServletRegistrationBean;\nimport org.postgresql.ds.PGSimpleDataSource;\nimport dev.shop.OrderStore;\nclass OrderController { ServletRegistrationBean<?> servlet; PGSimpleDataSource db; OrderStore store; }\n",
    );
    writeFile(
      project,
      "src/main/java/dev/shop/OrderStore.java",
      "package dev.shop; class OrderStore {}\n",
    );
    const { patch } = await drafted(project);
    const service = patch.nodes!.find((node) => node.role === "service")!;
    expect(graph(patch, "view:system")?.include).toEqual([
      "grp:clients",
      service.id,
      "grp:postgres",
    ]);
    expect(service.tech).toBe("Java");
    expect(patch.nodes?.find((node) => node.id === "grp:postgres")?.anchors).toEqual([
      {
        file: "src/main/java/dev/shop/OrderController.java",
        span: { from: 2, to: 2 },
        role: "usage",
      },
    ]);
  });

  it("asks whether an imported integration is on the default path in the saved patch", async () => {
    const project = makeTempDir("xpl-optional-integration-");
    writeFile(project, "README.md", "# worker\n\nProcesses jobs.\n");
    writeFile(
      project,
      "src/worker.py",
      "def process(job, archive=False):\n    if archive:\n        import boto3\n        boto3.client('s3').put_object(Bucket='jobs', Key=job)\n    return job\n",
    );
    const { patch } = await drafted(project);
    const outside = patch.tours![0]!.steps!.find((step) => step.focus.includes("grp:aws"));
    expect(outside?.note).toContain(
      "for each imported system, whether the default runtime path uses it or it is an optional integration",
    );
  });

  it("treats a declared framework as the system and does not infer a terminal user from a helper import", async () => {
    const framework = makeTempDir("xpl-framework-");
    writeFile(
      framework,
      "README.md",
      "# Flask\n\nA web application framework.\n\n```python\nfrom flask import Flask\napp = Flask(__name__)\n```\n",
    );
    writeFile(
      framework,
      "pyproject.toml",
      '[project]\nname = "flask"\n[project.scripts]\nflask = "flask.cli:main"\n',
    );
    writeFile(framework, "src/flask/__init__.py", "from .app import Flask\n");
    writeFile(
      framework,
      "src/flask/app.py",
      "class Flask:\n    def __init__(self, name):\n        self.name = name\n",
    );
    writeFile(
      framework,
      "src/flask/cli.py",
      'import click\ndef helper():\n    return click.style("message")\n',
    );
    const { patch, notes } = await drafted(framework);
    expect(patch.nodes!.find((n) => n.label === "flask")?.role).toBe("system");
    expect(patch.nodes!.map((n) => n.id)).not.toContain("grp:user");
    expect(patch.nodes!.map((n) => n.id)).toContain("grp:your-app");
    expect(notes.some((n) => n.startsWith("the draft guesses the kind of project"))).toBe(true);
    expect(patch.tours![0]!.steps!.map((step) => step.note).join("\n")).not.toContain(
      "default runtime path",
    );
  });
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

    // the parts are the components of the service
    expect(node("dir:src/db")).toMatchObject({ role: "component" });
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

describe("xpl draft repo: a program without a web or command-line framework", () => {
  it("adds who starts it at its main function and the settings file it loads, each anchored", async () => {
    const { patch, notes } = await drafted(copyFixture("ts-jobrunner"));
    const service = patch.nodes!.find((node) => node.role === "service")!;
    expect(graph(patch, "view:system")?.include).toEqual([
      "grp:operator",
      service.id,
      "grp:settings",
    ]);
    const node = (id: string) => patch.nodes!.find((n) => n.id === id)!;
    expect(node("grp:operator")).toMatchObject({ role: "person" });
    expect(node("grp:operator").anchors).toEqual([
      { file: "src/main.ts", symbol: "main", role: "definition" },
    ]);
    expect(node("grp:settings")).toMatchObject({ role: "storage", tech: "YAML" });
    // the file itself, and the line of the code that loads it (never a test)
    expect(node("grp:settings").anchors).toEqual([
      { file: "config/default.yaml", role: "config" },
      { file: "src/main.ts", span: { from: 39, to: 39 }, role: "usage" },
    ]);
    const edges = patch.edges!.map((e) => `${e.from} -> ${e.to}`);
    expect(edges).toEqual(
      expect.arrayContaining([
        "grp:operator -> file:src/main.ts",
        "file:src/main.ts -> grp:settings",
      ]),
    );
    // code at both ends: where it is read, and the file read
    expect(patch.edges!.find((e) => e.to === "grp:settings")?.anchors).toEqual([
      { file: "src/main.ts", span: { from: 39, to: 39 }, role: "usage" },
      { file: "config/default.yaml", role: "config" },
    ]);
    expect(notes).toContain(
      "settings files the code loads (from the index): `config/default.yaml`; check that the code reads each at run time",
    );
  });

  it("two parts that each load their own settings file: each arrow ends on a file the box anchors", async () => {
    const dir = makeTempDir("xpl-arch-settings-");
    writeFile(
      dir,
      "package.json",
      '{"name":"root","private":true,"workspaces":["api","worker"]}\n',
    );
    for (const app of ["api", "worker"]) {
      writeFile(dir, `${app}/package.json`, `{"name":"${app}"}\n`);
      writeFile(dir, `${app}/config/${app}.yaml`, "port: 1\n");
      writeFile(
        dir,
        `${app}/src/main.ts`,
        [
          'import { readFileSync } from "node:fs";',
          "",
          "export function main(): void {",
          `  const text = readFileSync(new URL("../config/${app}.yaml", import.meta.url), "utf8");`,
          "  console.log(text);",
          "}",
          "",
          "main();",
          "",
        ].join("\n"),
      );
    }
    // `drafted` applies and validates the draft: before, the second arrow had code only at its start
    const { patch } = await drafted(dir);
    const settings = patch.edges!.filter((e) => e.to === "grp:settings");
    expect(settings.map((e) => e.anchors!.map((a) => a.file))).toEqual([
      ["api/src/main.ts", "api/config/api.yaml"],
      ["worker/src/main.ts", "worker/config/worker.yaml"],
    ]);
  });
});

describe("xpl draft repo: who starts the program", () => {
  it("a Go server on net/http gets Clients at its ListenAndServe call, not an Operator", async () => {
    const dir = makeTempDir("xpl-arch-nethttp-");
    writeFile(dir, "go.mod", "module example.com/api\n\ngo 1.22\n");
    writeFile(
      dir,
      "main.go",
      [
        "package main",
        "",
        'import "net/http"',
        "",
        "func main() {",
        '\thttp.HandleFunc("/orders", orders)',
        '\thttp.ListenAndServe(":8080", nil)',
        "}",
        "",
      ].join("\n"),
    );
    writeFile(
      dir,
      "orders.go",
      'package main\n\nimport "net/http"\n\nfunc orders(w http.ResponseWriter, r *http.Request) {\n\tw.WriteHeader(200)\n}\n',
    );
    const { patch } = await drafted(dir);
    const ids = patch.nodes!.map((n) => n.id);
    expect(ids).not.toContain("grp:operator");
    const clients = patch.nodes!.find((n) => n.id === "grp:clients")!;
    expect(clients).toMatchObject({ role: "person", tech: "HTTP" });
    expect(clients.anchors).toEqual([{ file: "main.go", span: { from: 6, to: 6 }, role: "usage" }]);
    expect(graph(patch, "view:system")!.include).toContain("grp:clients");
  });

  it("a Node server on node:http and a Python one on http.server count as servers too", async () => {
    const node = makeTempDir("xpl-arch-nodehttp-");
    writeFile(node, "package.json", '{ "name": "api", "private": true }\n');
    writeFile(
      node,
      "src/server.ts",
      'import { createServer } from "node:http";\nimport { handle } from "./handle.js";\n\nexport function main() {\n  createServer(handle).listen(8080);\n}\n',
    );
    writeFile(
      node,
      "src/handle.ts",
      "export function handle(req: unknown, res: unknown) {\n  return [req, res];\n}\n",
    );
    const ts = await drafted(node);
    expect(ts.patch.nodes!.find((n) => n.id === "grp:clients")!.anchors).toEqual([
      { file: "src/server.ts", span: { from: 4, to: 4 }, role: "usage" },
    ]);
    const py = makeTempDir("xpl-arch-pyhttp-");
    writeFile(
      py,
      "app/main.py",
      "from http.server import HTTPServer\nfrom app.handler import Handler\n\n\ndef main():\n    HTTPServer(('', 8080), Handler).serve_forever()\n",
    );
    writeFile(py, "app/handler.py", "class Handler:\n    def do_GET(self):\n        return 200\n");
    const python = await drafted(py);
    expect(python.patch.nodes!.map((n) => n.id)).toContain("grp:clients");
    expect(python.patch.nodes!.map((n) => n.id)).not.toContain("grp:operator");
  });

  it("a net/http import without a server start is a client: the Operator stays", async () => {
    const dir = makeTempDir("xpl-arch-httpclient-");
    writeFile(dir, "go.mod", "module example.com/fetch\n\ngo 1.22\n");
    writeFile(
      dir,
      "main.go",
      'package main\n\nimport "net/http"\n\nfunc main() {\n\tfetch("https://example.com")\n}\n',
    );
    writeFile(
      dir,
      "fetch.go",
      'package main\n\nimport "net/http"\n\nfunc fetch(url string) {\n\thttp.Get(url)\n}\n',
    );
    const { patch } = await drafted(dir);
    const ids = patch.nodes!.map((n) => n.id);
    expect(ids).toContain("grp:operator");
    expect(ids).not.toContain("grp:clients");
  });

  it("Go: a settings file named by a literal path, part steps at the functions other parts call, room for the path", async () => {
    const dir = copyFixture("go-jobrunner");
    const { patch, notes } = await drafted(dir);
    // `path := "config/default.yaml"` in main: no read call takes the literal, but the file is the settings
    expect(graph(patch, "view:system")?.include).toEqual([
      "grp:operator",
      "grp:jobrunner",
      "grp:settings",
    ]);
    expect(patch.nodes!.find((n) => n.id === "grp:settings")?.anchors).toEqual([
      { file: "config/default.yaml", role: "config" },
      { file: "cmd/jobrunner/main.go", span: { from: 21, to: 21 }, role: "usage" },
    ]);
    expect(patch.edges!.map((e) => `${e.from} -> ${e.to}`)).toContain(
      "dir:cmd/jobrunner -> grp:settings",
    );
    expect(notes).toContain(
      "settings files the code names in a string (no call that loads them found): `config/default.yaml`; check that the code reads each at run time",
    );
    // a part's step shows what the other parts call (Runner.Dispatch, config.Load), not its first types
    const steps = patch.tours![0]!.steps!;
    const codeOf = (box: string) =>
      steps.find((s) => s.focus.includes(box))?.code?.map((a) => a.symbol);
    expect(codeOf("dir:internal/runner")).toContain("Runner.Dispatch");
    expect(codeOf("dir:internal/config")).toContain("Load");
    // 2 of the 9 steps are left for the main path and its risks; the notes say how to fill them
    expect(steps.length).toBeLessThanOrEqual(7);
    expect(notes).toContain(
      "room is left for 2 more steps (9 at most), the main path and its risks: run `xpl draft path shop sym:cmd/jobrunner/main.go#run` and copy the steps you keep",
    );
    // a path drafted next numbers its steps after the tour already there, so they can be copied over
    const path = await xplJson<DraftJson>(
      dir,
      "draft",
      "path",
      "shop",
      "sym:cmd/jobrunner/main.go#run",
    );
    const taken = new Set(steps.map((s) => s.id));
    const ids = path.json.patch.tours![0]!.steps!.map((s) => s.id);
    expect(ids.filter((id) => taken.has(id))).toEqual([]);
    expect(ids[0]).toBe(`t${steps.length + 1}`);
  });

  it("finds Java's main method on its class", async () => {
    const { patch } = await drafted(copyFixture("java-jobrunner"));
    const operator = patch.nodes!.find((n) => n.id === "grp:operator")!;
    expect(operator.anchors).toEqual([
      { file: "src/main/java/jobrunner/Main.java", symbol: "Main.main", role: "definition" },
    ]);
  });

  it("several programs under cmd/: an arrow from the Operator to each, and the shared code on their maps", async () => {
    const dir = makeTempDir("xpl-arch-cmds-");
    writeFile(dir, "go.mod", "module example.com/shop\n\ngo 1.22\n");
    const main = (name: string, call: string) =>
      [
        "package main",
        "",
        'import "example.com/shop/internal/store"',
        "",
        "func main() {",
        `\ts := store.Open("${name}")`,
        `\t${call}(s)`,
        "}",
        "",
        `func ${call}(s *store.Store) {`,
        "\ts.Put(1)",
        "\ts.Put(2)",
        "}",
        "",
      ].join("\n");
    writeFile(dir, "cmd/api/main.go", main("api", "serve"));
    writeFile(
      dir,
      "cmd/api/routes.go",
      "package main\n\nfunc routes() []string {\n\treturn nil\n}\n",
    );
    writeFile(dir, "cmd/worker/main.go", main("worker", "work"));
    writeFile(dir, "cmd/worker/jobs.go", "package main\n\nfunc jobs() []int {\n\treturn nil\n}\n");
    writeFile(
      dir,
      "internal/store/store.go",
      "package store\n\ntype Store struct{ n int }\n\nfunc Open(name string) *Store {\n\treturn &Store{}\n}\n\nfunc (s *Store) Put(v int) {\n\ts.n += v\n}\n",
    );
    const { patch } = await drafted(dir);
    const arrows = patch.edges!.filter((e) => e.from === "grp:operator");
    expect(arrows.map((e) => e.to).sort()).toEqual([
      "file:cmd/api/main.go",
      "file:cmd/worker/main.go",
    ]);
    expect(graph(patch, "view:api-inside")!.include).toContain("dir:internal/store");
    expect(graph(patch, "view:worker-inside")!.include).toContain("dir:internal/store");
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

describe("xpl draft repo: a library", () => {
  const dir = makeTempDir("xpl-arch-lib-");
  writeFile(
    dir,
    "README.md",
    "# fetchy\n\nA tiny HTTP client.\n\n## Usage\n\n```js\nimport fetchy from 'fetchy';\n\nconst body = await fetchy.get('https://example.com');\n```\n",
  );
  writeFile(dir, "package.json", '{ "name": "fetchy", "description": "A tiny HTTP client" }\n');
  writeFile(
    dir,
    "source/index.ts",
    [
      'import { request } from "./core/request.js";',
      "",
      "/**",
      "Makes requests.",
      "",
      "@example",
      "```",
      "import fetchy from 'fetchy';",
      "import axios from 'axios';",
      "```",
      "*/",
      "export function create(prefix: string) {",
      "  return { get: (url: string) => request(prefix + url) };",
      "}",
      'export const fetchy = create("");',
      "export default fetchy;",
      "",
    ].join("\n"),
  );
  writeFile(
    dir,
    "source/core/request.ts",
    'import { retry } from "../utils/retry.js";\n\n// import got from "got";\nexport function request(url: string) {\n  return parse(retry(() => fetch(url)));\n}\nfunction parse(response: unknown) {\n  return response;\n}\n',
  );
  writeFile(
    dir,
    "source/utils/retry.ts",
    "/* const glob = 'src/**' */\nexport function retry<T>(run: () => T): T {\n  return run();\n}\n",
  );
  writeFile(dir, "source/errors/http.ts", "export class HTTPError extends Error {}\n");
  writeFile(
    dir,
    "test-d/get.ts",
    "import fetchy from 'fetchy';\nimport got from 'got';\nexport const x = fetchy.get('a');\nexport const y = got;\n",
  );
  writeFile(dir, "source/index.test-d.ts", "import fetchy from './index.js';\nfetchy.get('a');\n");

  it("draws Your app calling it, and no outside system from doc comments, type tests or itself", async () => {
    const { patch, notes } = await drafted(dir);
    const system = graph(patch, "view:system")!;
    expect(system.include).toEqual(["grp:your-app", "grp:fetchy"]);
    // the library is the system; the app that calls it is outside the repo
    expect(patch.nodes!.find((n) => n.id === "grp:fetchy")).toMatchObject({ role: "system" });
    const app = patch.nodes!.find((n) => n.id === "grp:your-app")!;
    expect(app).toMatchObject({ label: "Your app", role: "external", tech: "your app" });
    // anchored at the README line that imports the library
    expect(app.anchors).toEqual([{ file: "README.md", span: { from: 7, to: 7 }, role: "usage" }]);
    const edge = patch.edges!.find((e) => e.from === "grp:your-app")!;
    expect(edge).toMatchObject({ to: "grp:fetchy", kind: "calls" });
    // the other end: what the README calls, a top-level symbol of the library
    expect(edge.anchors![1]).toMatchObject({ file: "source/index.ts", symbol: "fetchy" });
    expect(notes.join("\n")).toContain('"Your app" stands for the code that calls it');
    expect(notes.join("\n")).not.toContain("outside systems found");
    // the main path starts where the request goes (create only builds the client that hands it on)
    expect(notes.join("\n")).toContain(
      "run `xpl draft path shop sym:source/core/request.ts#request`",
    );
    // the last step shows where that path starts, not every file of the library
    const last = patch.tours![0]!.steps!.at(-1)!;
    expect(last.note).toMatch(/^### Where to go next/);
    expect(last.code).toEqual([
      expect.objectContaining({ file: "source/core/request.ts", symbol: "request" }),
    ]);
    // type tests are tests: no box, and the maps leave them out
    const inside = graph(patch, "view:overview")!;
    expect(inside.include!.some((id) => id.includes("test-d"))).toBe(false);
    expect(inside.excludeFiles).toEqual(expect.arrayContaining(["**/test-d/**", "**/*.test-d.*"]));
  });
});

describe("importsOf", () => {
  it("skips imports inside comments and docstrings", () => {
    expect(
      importsOf(
        [
          "/**",
          "@example",
          "import ky from 'ky';",
          " * import pg from 'pg';",
          "*/",
          'const glob = "src/**/*.ts";',
          'import Redis from "ioredis";',
          'import stripe from "stripe"; /* import got from "got"',
          'import axios from "axios";',
          "*/ export {};",
          "// import mysql from 'mysql';",
        ],
        "js",
      ).map((i) => `${i.module}@${i.line}`),
    ).toEqual(["ioredis@7", "stripe@8"]);
    expect(
      importsOf(
        ['"""Sign data.', "", ">>> import requests", "import redis", '"""', "import psycopg2"],
        "py",
      ).map((i) => i.module),
    ).toEqual(["psycopg2"]);
    expect(
      importsOf(["/*", 'import "github.com/lib/pq"', "*/", 'import "flag"'], "go").map(
        (i) => i.module,
      ),
    ).toEqual(["flag"]);
  });

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

describe("xpl draft repo: a library with its programs in cmd/", () => {
  it("is one project whose parts include the programs, when they hold less than half of the code", async () => {
    const dir = makeTempDir("xpl-arch-lib-");
    writeFile(dir, "go.mod", "module example.com/lib\n\ngo 1.22\n");
    for (const pkg of ["parse", "eval", "format", "walk"]) {
      for (const file of ["a", "b", "c"]) {
        writeFile(
          dir,
          `${pkg}/${file}.go`,
          `package ${pkg}\n\nfunc ${file.toUpperCase()}() int { return 1 }\n`,
        );
      }
    }
    for (const tool of ["fmt", "check"]) {
      writeFile(
        dir,
        `cmd/${tool}/main.go`,
        'package main\n\nimport "example.com/lib/parse"\n\nfunc main() { parse.A() }\n',
      );
    }
    const { patch, notes } = await drafted(dir);
    expect(notes).toContainEqual(
      expect.stringMatching(
        /^2 programs under `cmd` hold 2 of 14 code files: drafted as one project/,
      ),
    );
    expect(graph(patch, "view:overview")?.include).toEqual(
      expect.arrayContaining(["dir:cmd", "dir:parse", "dir:eval", "dir:format", "dir:walk"]),
    );
  });
});

describe("xpl draft repo: monorepos and one big package", () => {
  it("a pnpm workspace's packages are one box each, and benchmarks and fixtures are no part", async () => {
    const dir = makeTempDir("xpl-arch-mono-");
    writeFile(dir, "package.json", '{ "name": "mono", "private": true }\n');
    writeFile(dir, "pnpm-workspace.yaml", "packages:\n  - 'packages/*'\n  - \"tools/*\" # tools\n");
    for (const pkg of ["core", "dom", "server", "shared"]) {
      writeFile(dir, `packages/${pkg}/package.json`, `{ "name": "@mono/${pkg}" }\n`);
      writeFile(
        dir,
        `packages/${pkg}/src/index.ts`,
        `export function ${pkg}(): number { return 1; }\n`,
      );
    }
    writeFile(dir, "packages/bench/run.ts", "export function bench(): void {}\n");
    writeFile(dir, "packages/core/fixtures/db.ts", 'import pg from "pg";\nexport const db = pg;\n');
    writeFile(dir, "tools/release/main.ts", "export function release(): void {}\n");
    writeFile(dir, "rollup.config.js", "export default {};\n");
    writeFile(dir, "scripts/build.js", "export function build() {}\n");
    const { patch, notes } = await drafted(dir);
    const include = graph(patch, "view:overview")?.include ?? [];
    expect(include).toEqual(
      expect.arrayContaining([
        "dir:packages/core/src",
        "dir:packages/dom/src",
        "dir:packages/server/src",
        "dir:packages/shared/src",
        "dir:tools/release",
      ]),
    );
    expect(include.join(" ")).not.toMatch(/bench|fixtures|grp:postgres/);
    expect(notes.join("\n")).not.toContain("PostgreSQL");
  });

  it("a folder with most of the code is opened, whatever is around it", async () => {
    const dir = makeTempDir("xpl-arch-big-");
    writeFile(dir, "setup.py", "from setuptools import setup\nsetup()\n");
    writeFile(dir, "bin/run.py", "def main():\n    return 1\n");
    writeFile(dir, "release/tag.py", "def tag():\n    return 1\n");
    writeFile(dir, "tools/lint.py", "def lint():\n    return 1\n");
    writeFile(dir, "ci/check.py", "def check():\n    return 1\n");
    writeFile(dir, "isympy.py", "def shell():\n    return 1\n");
    writeFile(dir, "lib/__init__.py", "");
    for (const sub of ["core", "polys", "matrices", "printing", "sets"]) {
      writeFile(dir, `lib/${sub}/__init__.py`, "");
      for (const f of ["a", "b", "c"])
        writeFile(dir, `lib/${sub}/${f}.py`, `def ${f}():\n    return 1\n`);
    }
    const { patch } = await drafted(dir);
    expect(graph(patch, "view:overview")?.include).toEqual(
      expect.arrayContaining([
        "dir:lib/core",
        "dir:lib/polys",
        "dir:lib/matrices",
        "dir:lib/printing",
        "dir:lib/sets",
      ]),
    );
  });
});

it("drafts Rust code into a repository map labeled Rust", async () => {
  const { patch } = await drafted(copyFixture("rs-jobrunner"));
  expect(
    patch.nodes!.filter((n) => n.role === "service").map(({ tech, opens }) => ({ tech, opens })),
  ).toEqual([{ tech: "Rust", opens: "view:overview" }]);
  expect(graph(patch, "view:overview")!.include).toEqual([
    "file:src/bus.rs",
    "file:src/config.rs",
    "file:src/main.rs",
    "file:src/metrics.rs",
    "file:src/queue.rs",
    "file:src/runner.rs",
    "file:src/worker.rs",
  ]);
});

it("Ruby has no references: the draft does not send the author to `xpl draft path`, which says why it cannot draw", async () => {
  const dir = copyFixture("rb-jobrunner");
  const { notes } = await drafted(dir);
  expect(notes.filter((n) => n.includes("draft path"))).toEqual([
    "room is left for 2 more steps (9 at most), the main path and its risks: the index has no references for ruby, so `xpl draft path` cannot draw it; write those steps from `xpl show`",
  ]);
  const path = await xpl(
    dir,
    "draft",
    "path",
    "shop",
    "sym:lib/jobrunner/runner.rb#Jobrunner.Runner.drain",
  );
  expect(path.code).toBe(1);
  expect(path.err).toContain(
    "ruby: the index has no references for this language, so there is no call to draw; write the steps by hand from `xpl show lib/jobrunner/runner.rb`",
  );
});
