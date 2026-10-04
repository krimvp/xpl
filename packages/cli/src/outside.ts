/**
 * What a project talks to outside its own code, found from its import lines: databases, caches, queues, file
 * stores, other systems' APIs (outbound), and the web server or command-line framework people reach it through
 * (inbound). `xpl draft repo` turns each into a box of the system map (`Node.role`), anchored at the import
 * lines, so every box points at the code that proves it.
 *
 * A match is a hint, not a fact: an import of `requests` says the code makes HTTP calls, not to whom. The draft
 * leaves a TODO for what the code must tell (which database, which API).
 */
import type { IndexModel, NodeRole, TextCache } from "@xpl/core";

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

type Family = "js" | "py" | "go";

/** Module names (or prefixes, ending in `/` or `.`) per language family, and what they stand for. */
interface Entry extends OutsideKind {
  js?: string[];
  py?: string[];
  go?: string[];
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
  { ...POSTGRES, go: ["github.com/jackc/pgx", "github.com/lib/pq"] },
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
  { ...SQL, go: ["database/sql"] },
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
};

/** `module` is `name`, or inside it (`name/sub` for js and go, `name.sub` for python). */
function within(module: string, name: string, family: Family): boolean {
  if (module === name) return true;
  const sep = family === "py" ? "." : "/";
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
  const { js: _js, py: _py, go: _go, ...kind } = best.entry;
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
 * The outside systems the code files import, by slug, most used first (then by name). `isCode` says which files
 * count (not tests, examples or docs). At most `maxSites` sites per system are kept, in path order.
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
  }
  return [...found.values()]
    .sort((a, b) => b.files.size - a.files.size || a.label.localeCompare(b.label))
    .map(({ files: _files, ...system }) => system);
}

/** Manifest files that name a package, at any depth (a monorepo has one per package). */
const MANIFESTS = /(?:^|\/)(?:package\.json|pyproject\.toml|go\.mod)$/;

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
    for (const family of ["js", "py", "go"] as const) {
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
