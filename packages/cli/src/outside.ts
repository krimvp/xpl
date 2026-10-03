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

/** The modules a file imports, each with its 1-based line. */
export function importsOf(
  lines: readonly string[],
  family: Family,
): { module: string; line: number }[] {
  const out: { module: string; line: number }[] = [];
  let goBlock = false;
  lines.forEach((text, i) => {
    const line = i + 1;
    if (family === "js") {
      if (/^\s*(?:\/\/|\*)/.test(text)) return;
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
  const files = model.files
    .map((f) => f.path)
    .filter(isCode)
    .sort();
  for (const file of files) {
    const family = FAMILY[model.file(file)?.language ?? ""];
    const lines = family ? texts.lines(file) : undefined;
    if (!family || !lines) continue;
    for (const { module, line } of importsOf(lines, family)) {
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
