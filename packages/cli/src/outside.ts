/**
 * What a project talks to outside its own code, found from its import lines: databases, caches, queues, file
 * stores, other systems' APIs (outbound), and the web server or command-line framework people reach it through
 * (inbound). `xpl draft repo` turns each into a box of the system map (`Node.role`), anchored at the import
 * lines, so every box points at the code that proves it.
 *
 * A match is a hint, not a fact: an import of `requests` says the code makes HTTP calls, not to whom. The draft
 * leaves a TODO for what the code must tell (which database, which API).
 */
import { posix } from "node:path";
import type { IndexModel, IndexedSymbol, NodeRole, TextCache } from "@xpl/core";

export interface OutsideKind {
  /** Slug of the box: `grp:<slug>`. Libraries for the same system share it (pg, psycopg, pgx -> postgres). */
  slug: string;
  label: string;
  role: NodeRole;
  tech: string;
  /** Inbound: people or programs reach the project through it (a web server, a CLI framework). */
  inbound?: boolean;
}

export interface OutsideSystem extends OutsideKind {
  /** Where the code imports it: file and 1-based line, in path order. */
  sites: { file: string; line: number; module: string }[];
}

type Family = "js" | "py" | "go" | "java";

/** Module names (or prefixes, ending in `/` or `.`) per language family, and what they stand for. */
interface Entry extends OutsideKind {
  js?: string[];
  py?: string[];
  go?: string[];
  java?: string[];
}

const POSTGRES: OutsideKind = {
  slug: "postgres",
  label: "PostgreSQL database",
  role: "database",
  tech: "PostgreSQL",
};
const SQL: OutsideKind = { slug: "database", label: "SQL database", role: "database", tech: "SQL" };

const CATALOG: readonly Entry[] = [
  // databases
  { ...POSTGRES, js: ["pg", "postgres", "pg-promise"], py: ["psycopg2", "psycopg", "asyncpg"] },
  { ...POSTGRES, go: ["github.com/jackc/pgx", "github.com/lib/pq"], java: ["org.postgresql"] },
  {
    slug: "mysql",
    label: "MySQL database",
    role: "database",
    tech: "MySQL",
    js: ["mysql", "mysql2"],
    py: ["pymysql", "mysql.connector", "MySQLdb", "aiomysql"],
    go: ["github.com/go-sql-driver/mysql"],
  },
  {
    slug: "sqlite",
    label: "SQLite database",
    role: "database",
    tech: "SQLite",
    js: ["sqlite3", "better-sqlite3", "sqlite"],
    py: ["sqlite3", "aiosqlite"],
    go: ["github.com/mattn/go-sqlite3", "modernc.org/sqlite"],
  },
  {
    slug: "mongodb",
    label: "MongoDB database",
    role: "database",
    tech: "MongoDB",
    js: ["mongodb", "mongoose"],
    py: ["pymongo", "motor"],
    go: ["go.mongodb.org/mongo-driver"],
  },
  {
    ...SQL,
    tech: "SQL (ORM)",
    js: ["@prisma/client", "typeorm", "sequelize", "knex", "drizzle-orm", "kysely"],
    py: ["sqlalchemy", "django.db", "peewee", "sqlmodel", "tortoise"],
    go: ["gorm.io/gorm", "github.com/jmoiron/sqlx", "entgo.io/ent"],
  },
  {
    ...SQL,
    go: ["database/sql"],
    java: [
      "java.sql",
      "javax.sql",
      "jakarta.persistence",
      "org.hibernate",
      "org.springframework.data.jpa",
    ],
  },
  {
    slug: "dynamodb",
    label: "DynamoDB table",
    role: "database",
    tech: "DynamoDB",
    js: ["@aws-sdk/client-dynamodb", "@aws-sdk/lib-dynamodb"],
  },
  {
    slug: "elasticsearch",
    label: "Search index",
    role: "database",
    tech: "Elasticsearch",
    js: ["@elastic/elasticsearch"],
    py: ["elasticsearch"],
    go: ["github.com/elastic/go-elasticsearch"],
  },
  // caches
  {
    slug: "redis",
    label: "Redis",
    role: "cache",
    tech: "Redis",
    js: ["redis", "ioredis", "@upstash/redis"],
    py: ["redis", "aioredis"],
    go: ["github.com/redis/go-redis", "github.com/go-redis/redis", "github.com/gomodule/redigo"],
    java: ["org.springframework.data.redis", "redis.clients.jedis", "io.lettuce.core"],
  },
  {
    slug: "memcached",
    label: "Memcached",
    role: "cache",
    tech: "Memcached",
    js: ["memjs"],
    py: ["pymemcache", "memcache"],
    go: ["github.com/bradfitz/gomemcache"],
  },
  // queues and event streams
  {
    slug: "kafka",
    label: "Kafka topics",
    role: "queue",
    tech: "Kafka",
    js: ["kafkajs"],
    py: ["kafka", "confluent_kafka", "aiokafka"],
    go: ["github.com/segmentio/kafka-go", "github.com/Shopify/sarama", "github.com/IBM/sarama"],
    java: ["org.apache.kafka", "org.springframework.kafka"],
  },
  {
    slug: "rabbitmq",
    label: "RabbitMQ queues",
    role: "queue",
    tech: "RabbitMQ",
    js: ["amqplib", "amqp-connection-manager"],
    py: ["pika", "aio_pika", "kombu"],
    go: ["github.com/rabbitmq/amqp091-go", "github.com/streadway/amqp"],
  },
  {
    slug: "sqs",
    label: "SQS queue",
    role: "queue",
    tech: "Amazon SQS",
    js: ["@aws-sdk/client-sqs"],
  },
  {
    slug: "job-queue",
    label: "Job queue",
    role: "queue",
    tech: "Redis queue",
    js: ["bullmq", "bull", "bee-queue"],
    py: ["celery", "rq", "dramatiq"],
  },
  {
    slug: "nats",
    label: "NATS",
    role: "queue",
    tech: "NATS",
    js: ["nats"],
    py: ["nats"],
    go: ["github.com/nats-io/nats.go"],
  },
  {
    slug: "pubsub",
    label: "Pub/Sub topics",
    role: "queue",
    tech: "Google Pub/Sub",
    js: ["@google-cloud/pubsub"],
    py: ["google.cloud.pubsub", "google.cloud.pubsub_v1"],
    go: ["cloud.google.com/go/pubsub"],
  },
  // file stores
  {
    slug: "object-storage",
    label: "File storage",
    role: "storage",
    tech: "Amazon S3",
    js: ["@aws-sdk/client-s3"],
    go: ["github.com/aws/aws-sdk-go-v2/service/s3"],
  },
  {
    slug: "object-storage",
    label: "File storage",
    role: "storage",
    tech: "Cloud Storage",
    js: ["@google-cloud/storage"],
    py: ["google.cloud.storage"],
    go: ["cloud.google.com/go/storage"],
  },
  {
    slug: "aws",
    label: "AWS services",
    role: "external",
    tech: "AWS SDK",
    js: ["aws-sdk"],
    py: ["boto3", "botocore", "aioboto3"],
    go: ["github.com/aws/aws-sdk-go"],
  },
  // other systems' APIs
  {
    slug: "http-api",
    label: "Outside HTTP API",
    role: "external",
    tech: "HTTP",
    js: ["axios", "node-fetch", "got", "undici", "ky", "superagent"],
    py: ["requests", "httpx", "aiohttp", "urllib3"],
    go: ["github.com/go-resty/resty"],
    java: [
      "java.net.http",
      "org.springframework.web.client",
      "org.springframework.web.reactive.function.client",
    ],
  },
  {
    slug: "grpc",
    label: "gRPC service",
    role: "external",
    tech: "gRPC",
    js: ["@grpc/grpc-js"],
    py: ["grpc"],
    go: ["google.golang.org/grpc"],
  },
  {
    slug: "stripe",
    label: "Stripe",
    role: "external",
    tech: "payments API",
    js: ["stripe"],
    py: ["stripe"],
    go: ["github.com/stripe/stripe-go"],
  },
  {
    slug: "twilio",
    label: "Twilio",
    role: "external",
    tech: "SMS API",
    js: ["twilio"],
    py: ["twilio"],
  },
  {
    slug: "sendgrid",
    label: "SendGrid",
    role: "external",
    tech: "email API",
    js: ["@sendgrid/mail"],
    py: ["sendgrid"],
  },
  {
    slug: "slack",
    label: "Slack",
    role: "external",
    tech: "Slack API",
    js: ["@slack/web-api", "@slack/bolt"],
    py: ["slack_sdk", "slack_bolt"],
    go: ["github.com/slack-go/slack"],
  },
  {
    slug: "openai",
    label: "OpenAI",
    role: "external",
    tech: "LLM API",
    js: ["openai"],
    py: ["openai"],
    go: ["github.com/sashabaranov/go-openai"],
  },
  {
    slug: "anthropic",
    label: "Claude API",
    role: "external",
    tech: "LLM API",
    js: ["@anthropic-ai/sdk"],
    py: ["anthropic"],
    go: ["github.com/anthropics/anthropic-sdk-go"],
  },
  {
    slug: "github-api",
    label: "GitHub",
    role: "external",
    tech: "GitHub API",
    js: ["@octokit/rest", "@octokit/core", "octokit"],
    py: ["github"],
    go: ["github.com/google/go-github"],
  },
  {
    slug: "sentry",
    label: "Sentry",
    role: "external",
    tech: "error tracking",
    js: ["@sentry/node"],
    py: ["sentry_sdk"],
    go: ["github.com/getsentry/sentry-go"],
  },
  // how people and programs reach the project
  {
    slug: "clients",
    label: "Clients",
    role: "person",
    tech: "HTTP",
    inbound: true,
    js: ["express", "fastify", "koa", "hono", "@nestjs/core", "@hapi/hapi", "restify", "next"],
    py: [
      "flask",
      "fastapi",
      "django",
      "starlette",
      "aiohttp.web",
      "tornado",
      "sanic",
      "bottle",
      "falcon",
    ],
    go: [
      "github.com/gin-gonic/gin",
      "github.com/labstack/echo",
      "github.com/go-chi/chi",
      "github.com/gorilla/mux",
      "github.com/gofiber/fiber",
    ],
    java: [
      "org.springframework.web.bind.annotation",
      "org.springframework.web.servlet",
      "org.springframework.boot.web",
    ],
  },
  {
    slug: "user",
    label: "User at the terminal",
    role: "person",
    tech: "command line",
    inbound: true,
    js: ["commander", "yargs", "cac", "meow", "oclif", "@oclif/core"],
    py: ["argparse", "click", "typer", "fire", "docopt"],
    go: ["github.com/spf13/cobra", "github.com/urfave/cli", "flag"],
  },
];

const FAMILY: Record<string, Family> = {
  typescript: "js",
  tsx: "js",
  javascript: "js",
  python: "py",
  go: "go",
  java: "java",
};

/** `module` is `name`, or inside it (`name/sub` for js and go, `name.sub` for python and Java). */
function within(module: string, name: string, family: Family): boolean {
  if (module === name) return true;
  const sep = family === "py" || family === "java" ? "." : "/";
  return module.startsWith(name + sep);
}

function lookup(module: string, family: Family): OutsideKind | undefined {
  // a relative import is the project's own code
  if (module.startsWith(".") || module.startsWith("/")) return undefined;
  // `node:http` is Node's own; aiohttp.web is a server even though aiohttp is a client: the longest name wins
  let best: { entry: Entry; length: number } | undefined;
  for (const entry of CATALOG) {
    for (const name of entry[family] ?? []) {
      if (within(module, name, family) && (!best || name.length > best.length))
        best = { entry, length: name.length };
    }
  }
  if (!best) return undefined;
  const { js: _js, py: _py, go: _go, java: _java, ...kind } = best.entry;
  return kind;
}

const JS_IMPORTS = [
  /^\s*import\s+(?:type\s+)?[^'"]*?\sfrom\s*['"]([^'"]+)['"]/,
  /^\s*import\s*['"]([^'"]+)['"]/,
  /^\s*export\s+[^'"]*?\sfrom\s*['"]([^'"]+)['"]/,
  /\brequire\(\s*['"]([^'"]+)['"]\s*\)/,
  /\bimport\(\s*['"]([^'"]+)['"]\s*\)/,
];
const PY_IMPORT = /^\s*import\s+([\w.]+(?:\s*,\s*[\w.]+)*)/;
const PY_FROM = /^\s*from\s+([\w.]+)\s+import\b/;
const GO_SPEC = /^\s*(?:[\w.]+\s+)?"([^"]+)"/;
const JAVA_IMPORT = /^\s*import\s+(?:static\s+)?([\w.]+)(?:\.\*)?\s*;/;

/**
 * Each line with its comments blanked out: from `//` to the end of the line, and block comments across lines. Quoted
 * strings on one line are kept whole, so a glob in a string opens no comment. A JSDoc `@example` that shows
 * `import ky from 'ky'` is documentation, not an import.
 */
function withoutComments(lines: readonly string[]): string[] {
  let block = false;
  return lines.map((text) => {
    let out = "";
    let quote: string | undefined;
    for (let i = 0; i < text.length; i++) {
      const c = text[i]!;
      if (block) {
        if (c === "*" && text[i + 1] === "/") {
          block = false;
          i++;
        }
        continue;
      }
      if (quote) {
        out += c;
        if (c === "\\") out += text[++i] ?? "";
        else if (c === quote) quote = undefined;
        continue;
      }
      if (c === "/" && text[i + 1] === "/") break;
      if (c === "/" && text[i + 1] === "*") {
        block = true;
        i++;
        continue;
      }
      if (c === '"' || c === "'" || c === "`") quote = c;
      out += c;
    }
    return out;
  });
}

/** Python lines inside a triple-quoted string (a docstring that shows `>>> import x`) blanked out. */
function withoutDocstrings(lines: readonly string[]): string[] {
  let open: string | undefined;
  return lines.map((text) => {
    const inside = open !== undefined;
    for (const m of text.matchAll(/"""|'''/g)) {
      if (open === undefined) open = m[0];
      else if (open === m[0]) open = undefined;
    }
    return inside ? "" : text;
  });
}

/** The modules a file imports, each with its 1-based line. Imports inside comments and docstrings do not count. */
export function importsOf(
  source: readonly string[],
  family: Family,
): { module: string; line: number }[] {
  const out: { module: string; line: number }[] = [];
  const lines = family === "py" ? withoutDocstrings(source) : withoutComments(source);
  let goBlock = false;
  lines.forEach((text, i) => {
    const line = i + 1;
    if (family === "js") {
      for (const re of JS_IMPORTS) {
        const m = re.exec(text);
        if (m) {
          out.push({ module: m[1]!, line });
          return;
        }
      }
    } else if (family === "py") {
      const from = PY_FROM.exec(text);
      if (from) out.push({ module: from[1]!, line });
      else {
        const plain = PY_IMPORT.exec(text);
        if (plain) for (const name of plain[1]!.split(",")) out.push({ module: name.trim(), line });
      }
    } else if (family === "java") {
      const imported = JAVA_IMPORT.exec(text);
      if (imported) out.push({ module: imported[1]!, line });
    } else {
      if (goBlock) {
        if (/^\s*\)/.test(text)) goBlock = false;
        else {
          const m = GO_SPEC.exec(text);
          if (m) out.push({ module: m[1]!, line });
        }
      } else if (/^\s*import\s*\(\s*$/.test(text)) goBlock = true;
      else {
        const m = /^\s*import\s+(?:[\w.]+\s+)?"([^"]+)"/.exec(text);
        if (m) out.push({ module: m[1]!, line });
      }
    }
  });
  return out;
}

/**
 * A standard-library web server: the modules that serve HTTP, and the call that starts the server. The import alone
 * proves nothing (`net/http` is also a client), so a file counts only when it also starts a server.
 */
const SERVER_STARTS: Partial<Record<Family, { modules: readonly string[]; start: RegExp }>> = {
  go: {
    modules: ["net/http"],
    start: /\.(?:ListenAndServe|ListenAndServeTLS|Serve|ServeTLS)\s*\(/,
  },
  js: {
    modules: ["http", "https", "http2", "node:http", "node:https", "node:http2"],
    start: /\bcreateServer\s*\(/,
  },
  py: {
    modules: ["http.server", "wsgiref.simple_server", "socketserver"],
    start: /\b(?:serve_forever|make_server|(?:Threading)?HTTPServer)\s*\(/,
  },
};

const CLIENTS = CATALOG.find((entry) => entry.slug === "clients")!;
const USER = CATALOG.find((entry) => entry.slug === "user")!;

/** The first line of `lines` (comments blanked) that starts a standard-library web server, with what it called. */
function serverStart(
  lines: readonly string[],
  family: Family,
): { line: number; module: string } | undefined {
  const server = SERVER_STARTS[family];
  if (!server || !importsOf(lines, family).some((i) => server.modules.includes(i.module)))
    return undefined;
  const code = family === "py" ? withoutDocstrings(lines) : withoutComments(lines);
  for (const [i, text] of code.entries()) {
    const m = server.start.exec(text);
    if (m) return { line: i + 1, module: m[0].replace(/^[.\s]+|[\s(]+$/g, "") };
  }
  return undefined;
}

/**
 * The outside systems the code files import, by slug, most used first (then by name). `isCode` says which files
 * count (not tests, examples or docs). At most `maxSites` sites per system are kept, in path order. A file that
 * starts a standard-library web server (`http.ListenAndServe`, `createServer`, `serve_forever`) adds the inbound
 * Clients, at the line that starts it.
 */
export function findOutsideSystems(
  model: IndexModel,
  texts: TextCache,
  isCode: (path: string) => boolean,
  maxSites = 6,
): OutsideSystem[] {
  const found = new Map<string, OutsideSystem & { files: Set<string> }>();
  const own = ownModules(model, texts);
  const files = model.files
    .map((f) => f.path)
    .filter(isCode)
    .sort();
  for (const file of files) {
    const family = FAMILY[model.file(file)?.language ?? ""];
    const lines = family ? texts.lines(file) : undefined;
    if (!family || !lines) continue;
    for (const { module, line } of importsOf(lines, family)) {
      // a package importing itself (chi's middleware imports chi) is not an outside system
      if (own.some((name) => within(module, name, family))) continue;
      const kind = lookup(module, family);
      if (!kind) continue;
      // A CLI dependency alone can be a helper in a framework/library. Require a command definition
      // or parser entry point before suggesting a terminal user; the resulting role is still a hint.
      if (
        kind.slug === "user" &&
        !lines.some((source) =>
          /(?:\b(?:ArgumentParser|Typer|Fire)\s*\(|@(?:[\w.]+\.)?(?:command|group)\b|\.(?:parse_args|parseArgs|Execute|execute|command|add_command)\s*\(|\bcobra\.Command\s*\{)/.test(
            source,
          ),
        )
      )
        continue;
      let system = found.get(kind.slug);
      if (!system) {
        system = { ...kind, sites: [], files: new Set() };
        found.set(kind.slug, system);
      } else if (system.tech !== kind.tech && !system.tech.includes(kind.tech)) {
        // pg and an ORM both say "a database": keep both names
        system.tech = `${system.tech}, ${kind.tech}`;
      }
      system.files.add(file);
      if (system.sites.length < maxSites && !system.sites.some((s) => s.file === file))
        system.sites.push({ file, line, module });
    }
    const start = found.has(CLIENTS.slug) ? undefined : serverStart(lines, family);
    if (start) {
      const { js: _js, py: _py, go: _go, java: _java, ...kind } = CLIENTS;
      found.set(kind.slug, { ...kind, sites: [{ file, ...start }], files: new Set([file]) });
    }
  }
  // A package.json `bin` is a command run at the terminal, whatever parses its arguments (`node:util` `parseArgs` is
  // no import of a framework); a JS program has no `main` an Operator could start. A library's bin is a secondary tool.
  const program =
    found.has(USER.slug) || declaredLibrary(model, texts)
      ? undefined
      : declaredEntry(model, texts, isCode, ["bin"]);
  if (program) {
    const { js: _js, py: _py, go: _go, java: _java, ...kind } = USER;
    const module = program.how.replace(/^the /, "");
    // where the declared file calls the function the program starts at, and that function (the declared file can be
    // too small to be a part of a map: a `main.ts` that only calls `run`)
    const call = model
      .refsFrom(model.moduleScopeId(program.file))
      .find((r) => r.kind === "call" && r.to === program.symbol.id);
    const { file, range } = program.symbol;
    const sites = [
      ...(call && file !== program.file
        ? [{ file: program.file, line: call.site.startLine, module }]
        : []),
      { file, line: range.startLine, module },
    ];
    found.set(kind.slug, { ...kind, sites, files: new Set(sites.map((s) => s.file)) });
  }
  return [...found.values()]
    .sort((a, b) => b.files.size - a.files.size || a.label.localeCompare(b.label))
    .map(({ files: _files, ...system }) => system);
}

/** Manifest files that name a package, at any depth (a monorepo has one per package). */
const MANIFESTS = /(?:^|\/)(?:package\.json|pyproject\.toml|go\.mod|pom\.xml)$/;

/**
 * The module names the repository's own code is imported by: the `name` of each package.json, the name in each
 * pyproject.toml and the top-level Python packages (folders with an `__init__.py`), the `module` of each go.mod.
 * An import of one of them is the project itself, or another package of the same repository.
 */
export function ownModules(model: IndexModel, texts: TextCache): string[] {
  const names = new Set<string>();
  const paths = model.files.map((f) => f.path);
  for (const path of paths.filter((p) => MANIFESTS.test(p))) {
    const text = texts.text(path);
    if (text === undefined) continue;
    if (path.endsWith("package.json")) {
      try {
        const name = (JSON.parse(text) as { name?: unknown }).name;
        if (typeof name === "string" && name !== "") names.add(name);
      } catch {
        // not JSON: no name
      }
    } else if (path.endsWith("pyproject.toml")) {
      const name = /^\s*name\s*=\s*["']([^"']+)["']/m.exec(text)?.[1];
      if (name) names.add(name.replace(/[-.]/g, "_").toLowerCase());
    } else if (path.endsWith("pom.xml")) {
      // A parent POM names a dependency, not this project's Java package.
      const project = text.replace(/<parent\b[^>]*>[\s\S]*?<\/parent>/g, "");
      const groupId = /<groupId>\s*([^<\s]+)\s*<\/groupId>/.exec(project)?.[1];
      if (groupId) names.add(groupId);
    } else {
      const module = /^\s*module\s+(\S+)/m.exec(text)?.[1];
      if (module) names.add(module);
    }
  }
  const inits = new Set(
    paths
      .filter((p) => p === "__init__.py" || p.endsWith("/__init__.py"))
      .map((p) => p.slice(0, Math.max(0, p.length - "/__init__.py".length))),
  );
  for (const dir of inits) {
    if (dir === "") continue;
    const slash = dir.lastIndexOf("/");
    if (!inits.has(dir.slice(0, Math.max(0, slash)))) names.add(dir.slice(slash + 1));
  }
  // Java packages, not source directories, define the namespace. The common prefix excludes this
  // repository's own imports in a multi-module project such as Spring Framework.
  const javaPackages = paths
    .filter((path) => path.endsWith(".java") && !/(?:^|\/)src\/test\//.test(path))
    .map(
      (path) =>
        /^\s*package\s+([\w.]+)\s*;/m.exec(
          withoutComments((texts.text(path) ?? "").split("\n")).join("\n"),
        )?.[1],
    )
    .filter((name): name is string => name !== undefined);
  if (javaPackages.length > 0) {
    const parts = javaPackages[0]!.split(".");
    for (const name of javaPackages.slice(1)) {
      const next = name.split(".");
      while (parts.length > 0 && parts.some((part, i) => part !== next[i])) parts.pop();
    }
    if (parts.length >= 2) names.add(parts.join("."));
  }
  return [...names];
}

/**
 * Is the project a library: it has package metadata, and nothing in it is a program people run (no `bin` or `start`
 * script in package.json, no scripts in pyproject.toml or setup.py, no `__main__.py`, no Go `package main`, no script with a
 * `#!` line among the code files)? A library's main user is the code of an app that calls it.
 */
export function isLibrary(
  model: IndexModel,
  texts: TextCache,
  codeFiles: readonly string[],
): boolean {
  const root = model.dirChildren("").files;
  const text = (file: string) => (root.includes(file) ? texts.text(file) : undefined);
  const pkg = text("package.json");
  const pyproject = text("pyproject.toml");
  const setup = text("setup.py");
  const gomod = text("go.mod");
  if ([pkg, pyproject, setup, gomod].every((t) => t === undefined)) return false;
  // Frameworks and libraries can ship secondary CLI tools. Their declared purpose takes precedence
  // over those entry points when drafting the primary application-facing relationship.
  if (declaredLibrary(model, texts)) return true;
  if (pkg !== undefined) {
    try {
      const json = JSON.parse(pkg) as { bin?: unknown; scripts?: { start?: unknown } };
      if (json.bin !== undefined || json.scripts?.start !== undefined) return false;
    } catch {
      return false;
    }
  }
  const scripts = /^\s*\[(?:project\.(?:gui-)?scripts|tool\.poetry\.scripts)\]/m;
  if (pyproject !== undefined && scripts.test(pyproject)) return false;
  if (setup !== undefined && /entry_points|scripts\s*=/.test(setup)) return false;
  for (const file of codeFiles) {
    if (file === "__main__.py" || file.endsWith("/__main__.py")) return false;
    const head = texts.lines(file)?.slice(0, 40) ?? [];
    if (head[0]?.startsWith("#!")) return false;
    const go = model.file(file)?.language === "go";
    if (go && head.some((line) => /^package main\b/.test(line))) return false;
  }
  return true;
}

/** A declared primary purpose can coexist with a secondary command-line tool. */
export function declaredLibrary(model: IndexModel, texts: TextCache): boolean {
  const readme = model.dirChildren("").files.find((file) => /^readme(?:\.[a-z]+)?$/i.test(file));
  return Boolean(
    readme &&
    /\b(?:is|a|an)\s+(?:(?:small|simple|lightweight|web|application|WSGI|HTTP|Python|TypeScript|JavaScript|Go|client|routing)\s+){0,6}(?:library|framework)\b/i.test(
      (texts.text(readme) ?? "").slice(0, 2000),
    ),
  );
}

/**
 * The first line of a README code block that imports the project (`import ky from 'ky'`, `from itsdangerous import
 * ...`, a Go import path), 1-based, and the names the block uses from there on, in order (`ky`, `post`, ...);
 * undefined when no block does. It shows what the code of an app writes.
 */
export function readmeUsage(
  lines: readonly string[],
  own: readonly string[],
): { line: number; names: string[] } | undefined {
  let start: number | undefined;
  for (let i = 0; i < lines.length; i++) {
    if (!/^\s*(?:```|~~~)/.test(lines[i]!)) continue;
    if (start === undefined) {
      start = i + 1;
      continue;
    }
    const block = lines.slice(start, i);
    for (const family of ["js", "py", "go", "java"] as const) {
      const hit = importsOf(block, family).find(({ module }) =>
        own.some((name) => within(module, name, family)),
      );
      if (hit) {
        // the code after the import, without its strings (a URL, an import path)
        const rest = block
          .slice(hit.line - 1)
          .join("\n")
          .replace(/(["'`])(?:\\.|(?!\1).)*\1/g, "");
        const names = [...new Set(rest.match(/[A-Za-z_]\w*/g) ?? [])];
        return { line: start + hit.line, names };
      }
    }
    start = undefined;
  }
  return undefined;
}

/**
 * The folders that hold the packages of a JS/TS monorepo: the parents of the `dir/*` patterns of the root
 * `pnpm-workspace.yaml` (`packages:`) and of the root package.json's `workspaces` (an array, or `{packages}`).
 * `packages/*` gives `packages`; a pattern that names one package, or a negation, gives nothing.
 */
export function workspaceParents(texts: TextCache): string[] {
  const patterns: string[] = [];
  const pnpm = texts.text("pnpm-workspace.yaml");
  if (pnpm !== undefined) {
    let inPackages = false;
    for (const line of pnpm.split("\n")) {
      if (/^packages\s*:/.test(line)) inPackages = true;
      else if (/^\S/.test(line)) inPackages = false;
      else if (inPackages) {
        const item = /^\s*-\s*["']?([^"'#]+?)["']?\s*(?:#.*)?$/.exec(line)?.[1];
        if (item) patterns.push(item);
      }
    }
  }
  const pkg = texts.text("package.json");
  if (pkg !== undefined) {
    try {
      const workspaces = (JSON.parse(pkg) as { workspaces?: unknown }).workspaces;
      const list = Array.isArray(workspaces)
        ? workspaces
        : (workspaces as { packages?: unknown } | undefined)?.packages;
      if (Array.isArray(list)) for (const p of list) if (typeof p === "string") patterns.push(p);
    } catch {
      // not JSON: no workspaces
    }
  }
  const parents = new Set<string>();
  for (const pattern of patterns) {
    const m = /^(?:\.\/)?([^!*][^*]*?)\/\*{1,2}$/.exec(pattern.trim());
    if (m) parents.add(m[1]!);
  }
  return [...parents].sort();
}

// ─── Where the project says it starts ───────────────────────────────────────────────────────────

/**
 * The manifest fields that declare an entry: a program people run (`bin`, Python scripts), or the API of a library
 * (`exports`, `main`).
 */
export type DeclaredKey = "bin" | "[project.scripts]" | "exports" | "main";

/** An entry a manifest declares: the source file it names, the function it names (Python scripts), and where. */
interface Declared {
  file: string;
  name?: string;
  key: DeclaredKey;
  /** Where it is declared, for a note: "the `bin` of `packages/cli/package.json`". */
  how: string;
}

/** An entry a manifest declares, as the indexed function or method a path starts at. */
export interface DeclaredEntry extends Declared {
  symbol: IndexedSymbol;
}

/** Folders of build output; their source is in `src/` or `source/`. */
const BUILT = /^(?:dist|build|out|lib|esm|cjs|distribution)$/;
const SOURCE_DIRS = ["src", "source"];
const SOURCE_EXT = [".ts", ".tsx", ".mts", ".cts", ".js", ".mjs", ".cjs", ".jsx"];

/**
 * The indexed code file a manifest path names: the file itself, or, for build output (`dist/node/index.js`), the
 * source it is built from (`src/node/index.ts`), else the package's `src/main`, `src/cli` or `src/index` (a bundle,
 * `dist/xpl.mjs`, built from `src/main.ts`).
 */
function sourceOf(
  model: IndexModel,
  isCode: (path: string) => boolean,
  dir: string,
  path: string,
): string | undefined {
  const inDir = (rel: string) => (dir === "" ? rel : `${dir}/${rel}`);
  const rel = posix.normalize(path).replace(/^\.\//, "");
  if (model.hasFile(inDir(rel))) return isCode(inDir(rel)) ? inDir(rel) : undefined;
  const parts = rel.split("/");
  const at = parts.findIndex((part) => BUILT.test(part));
  if (at === -1) return undefined;
  const candidates: string[] = [];
  for (const src of SOURCE_DIRS) {
    const base = [...parts.slice(0, at), src, ...parts.slice(at + 1)]
      .join("/")
      .replace(/\.[cm]?jsx?$/, "");
    for (const ext of SOURCE_EXT) candidates.push(base + ext, `${base}/index${ext}`);
  }
  for (const src of SOURCE_DIRS)
    for (const name of ["main", "cli", "index"])
      for (const ext of SOURCE_EXT) candidates.push(`${src}/${name}${ext}`);
  return candidates.map(inDir).find((file) => model.hasFile(file) && isCode(file));
}

/** The path of the package itself in an `exports` value: a string, `"."`, or the first condition but `types`. */
function exportPath(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const entries = Object.entries(value as Record<string, unknown>);
  const own = entries.find(([key]) => key === ".");
  if (own) return exportPath(own[1]);
  for (const [key, inner] of entries) {
    if (key.startsWith(".") || key === "types") continue;
    const found = exportPath(inner);
    if (found) return found;
  }
  return undefined;
}

const PY_SCRIPTS = /^\s*\[(?:project\.scripts|tool\.poetry\.scripts)\]\s*\n((?:(?!\s*\[).*\n?)*)/m;

/**
 * The entries the manifests declare, as indexed code files (`isCode`), package by package, the package with the
 * most code first: a package.json's `bin`, then `exports["."]`, then `main` (`index.js` by default); a
 * pyproject.toml's `[project.scripts]` (`flask = "flask.cli:main"`).
 */
function declaredFiles(
  model: IndexModel,
  texts: TextCache,
  isCode: (path: string) => boolean,
): Declared[] {
  const packages: { size: number; entries: Declared[] }[] = [];
  for (const manifest of model.files.map((f) => f.path)) {
    if (!/(?:^|\/)(?:package\.json|pyproject\.toml)$/.test(manifest)) continue;
    const text = texts.text(manifest);
    if (text === undefined) continue;
    const dir = manifest.includes("/") ? manifest.slice(0, manifest.lastIndexOf("/")) : "";
    const entries: Declared[] = [];
    const add = (path: unknown, key: DeclaredKey, name?: string) => {
      const file = typeof path === "string" ? sourceOf(model, isCode, dir, path) : undefined;
      if (file && !entries.some((e) => e.file === file && e.name === name))
        entries.push({
          file,
          key,
          how: `the \`${key}\` of \`${manifest}\``,
          ...(name ? { name } : {}),
        });
    };
    if (manifest.endsWith("package.json")) {
      let json: { bin?: unknown; exports?: unknown; main?: unknown };
      try {
        json = JSON.parse(text) as typeof json;
      } catch {
        continue;
      }
      const bins =
        json.bin && typeof json.bin === "object"
          ? Object.values(json.bin as Record<string, unknown>)
          : [json.bin];
      for (const bin of bins) add(bin, "bin");
      add(exportPath(json.exports), "exports");
      add(json.main ?? "index.js", "main");
    } else {
      const table = PY_SCRIPTS.exec(text)?.[1] ?? "";
      for (const m of table.matchAll(/^\s*[\w.-]+\s*=\s*["']([\w.]+):([\w.]+)["']/gm)) {
        const module = m[1]!.replace(/\./g, "/");
        for (const file of [`${module}.py`, `${module}/__init__.py`]) {
          add(file, "[project.scripts]", m[2]);
          add(`src/${file}`, "[project.scripts]", m[2]);
        }
      }
    }
    if (entries.length > 0)
      packages.push({ size: model.filesUnder(dir).filter(isCode).length, entries });
  }
  return packages.sort((a, b) => b.size - a.size).flatMap((p) => p.entries);
}

/** The calls between functions and methods of code files; a closure's calls are its enclosing function's. */
function callGraph(model: IndexModel, isCode: (path: string) => boolean): Map<string, Set<string>> {
  const owner = (id: string): string => {
    let sym = model.symbol(id);
    while (sym && sym.kind === "function" && model.parentSymbol(sym.id)?.kind === "function")
      sym = model.parentSymbol(sym.id);
    return sym?.id ?? id;
  };
  const graph = new Map<string, Set<string>>();
  for (const ref of model.refs) {
    if (ref.kind !== "call") continue;
    const to = model.symbol(ref.to);
    const fromFile = model.fileOfSymbolId(ref.from);
    if (!to || !fromFile || !isCode(fromFile) || !isCode(to.file)) continue;
    const from = owner(ref.from);
    if (from === to.id) continue;
    let set = graph.get(from);
    if (!set) graph.set(from, (set = new Set()));
    set.add(to.id);
  }
  return graph;
}

/** How many functions `id` reaches through calls. */
function reach(graph: ReadonlyMap<string, ReadonlySet<string>>, id: string): number {
  const seen = new Set([id]);
  const queue = [id];
  while (queue.length > 0)
    for (const next of graph.get(queue.pop()!) ?? [])
      if (!seen.has(next)) (seen.add(next), queue.push(next));
  return seen.size - 1;
}

const callable = (sym: IndexedSymbol | undefined): sym is IndexedSymbol =>
  sym !== undefined && (sym.kind === "function" || sym.kind === "method");

/**
 * The function a declared file starts at: the one the manifest names, else the file's `main`, else, of the functions
 * its module scope calls or re-exports and its own top-level functions, the one that reaches the most code. A file
 * with none of those that loads another file (`module.exports = require('./lib/express')`) starts in that file.
 */
function startOf(
  model: IndexModel,
  isCode: (path: string) => boolean,
  graph: ReadonlyMap<string, ReadonlySet<string>>,
  file: string,
  name: string | undefined,
  depth = 0,
): IndexedSymbol | undefined {
  if (name !== undefined) {
    const named = model.symbolAt(file, name);
    return callable(named) ? named : undefined;
  }
  const own = model.topLevelSymbols(file).filter(callable);
  const main = own.find((s) => s.kind === "function" && s.path === "main");
  if (main) return main;
  const scope = model.refsFrom(model.moduleScopeId(file));
  const used = (kind: string) =>
    scope
      .filter((r) => r.kind === kind)
      .map((r) => model.symbol(r.to))
      .filter((s): s is IndexedSymbol => callable(s) && isCode(s.file));
  let best: { sym: IndexedSymbol; reach: number } | undefined;
  for (const sym of new Set([...used("call"), ...used("import"), ...own])) {
    const n = reach(graph, sym.id);
    if (!best || n > best.reach) best = { sym, reach: n };
  }
  if (best || depth >= 3) return best?.sym;
  for (const ref of scope) {
    const next = ref.kind === "import" ? model.fileOfSymbolId(ref.to) : undefined;
    if (!next || !model.isModuleScope(ref.to) || !isCode(next)) continue;
    const found = startOf(model, isCode, graph, next, undefined, depth + 1);
    if (found) return found;
  }
  return undefined;
}

/**
 * Where the project says it starts, as a function: of the entries its manifests declare (`declaredFiles`), the first
 * whose function reaches other code, else the first with a function. Only entries of the given `keys` count (a
 * library's `bin` is a secondary tool). Undefined when no manifest declares an indexed entry.
 */
export function declaredEntry(
  model: IndexModel,
  texts: TextCache,
  isCode: (path: string) => boolean,
  keys: readonly DeclaredKey[],
): DeclaredEntry | undefined {
  const entries = declaredFiles(model, texts, isCode).filter((e) => keys.includes(e.key));
  if (entries.length === 0) return undefined;
  const graph = callGraph(model, isCode);
  let first: DeclaredEntry | undefined;
  for (const entry of entries) {
    const symbol = startOf(model, isCode, graph, entry.file, entry.name);
    if (!symbol) continue;
    const found = { ...entry, symbol };
    if (reach(graph, symbol.id) > 0) return found;
    first ??= found;
  }
  return first;
}
