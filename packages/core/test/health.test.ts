import { describe, expect, it } from "vitest";
import { healthCheck, type HealthFinding, type HealthReport } from "../src/index.js";
import { makeWorld, textWith, type FileDecl, type RefDecl, type SymbolDecl } from "./helpers.js";

/**
 * Secret-shaped test values are put together from pieces, so this file does not itself hold a string that
 * a scanner (ours, or a host's push protection) would take for a real key.
 */
const k = (...parts: string[]) => parts.join("");
const AWS = k("AKIA", "Q3EGT5RL7NB2XW4Y");
const STRIPE_LIVE = k("sk_", "live_", "4eC39HqLyjWDarjtT1zdp7dc");
const STRIPE_TEST = k("sk_", "test_", "9xT2mQ7vLp4RzW8nK3bJ6hYd");
const GITHUB = k("ghp_", "A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8");
const SLACK = k("xox", "b-", "1234567890-0987654321-AbCdEfGhIjKlMnOp");
const GOOGLE = k("AIza", "SyD3x8Q2mN7vL5pR1tW9zK4bJ6hYcF0gE2a");
const SK_DASH = k("sk-", "proj-", "Zq8Lm3Np7Rt2Vx6Bc9Df4Gh1Jk5Mn0Pq");
const JWT = k(
  "eyJhbGciOiJIUzI1NiJ9",
  ".",
  "eyJzdWIiOiIxMjM0NTY3ODkwIn0",
  ".",
  "dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U",
);
const PASSWORD = k("Wq9", "zR4tLp2x!");
const URL_PASSWORD = k("Wq9", "zR4tLp2x");
const PEM = k("-----BEGIN RSA ", "PRIVATE KEY-----");
const VALUES = [AWS, STRIPE_LIVE, STRIPE_TEST, GITHUB, SLACK, GOOGLE, SK_DASH, JWT, PASSWORD];

function check(files: FileDecl[], refs: RefDecl[] = [], symbols: SymbolDecl[] = []): HealthReport {
  const world = makeWorld({ files, refs, symbols });
  return healthCheck(world.model, world.getText);
}

/** The fields a reader acts on, without the prose. */
function brief(findings: readonly HealthFinding[]) {
  return findings.map((f) => ({
    check: f.check,
    severity: f.severity,
    at: `${f.file}:${f.line}`,
    title: f.title,
    ...(f.hint !== undefined ? { hint: f.hint } : {}),
    ...(f.heuristic ? { heuristic: true } : {}),
  }));
}

/** Only the secret checks: a world's other files are entry points, so nothing reads as unused. */
const secretFindings = (report: HealthReport) =>
  brief(report.findings.filter((f) => f.check !== "unused-file"));

describe("healthCheck: secrets written into code", () => {
  const config = [
    `const aws = "${AWS}";`,
    `stripe.setKey("${STRIPE_LIVE}");`,
    `const testKey = "${STRIPE_TEST}";`,
    `const gh = "${GITHUB}";`,
    `const slack = "${SLACK}";`,
    `const maps = "${GOOGLE}";`,
    `const ai = "${SK_DASH}";`,
    `const session = "${JWT}";`,
    `const dbPassword = "${PASSWORD}";`,
    `const url = "postgres://app:${URL_PASSWORD}@db.internal:5432/app";`,
    PEM,
    `const cache = "redis://:${URL_PASSWORD}@cache.internal:6379/0";`,
  ].join("\n");

  it("finds each key shape and secret assignment at its line, with a masked hint and never the value", () => {
    const report = check([{ path: "src/index.ts", text: config }]);
    expect(secretFindings(report)).toEqual([
      {
        check: "secret",
        severity: "high",
        at: "src/index.ts:1",
        title: "AWS access key",
        hint: "AKIA…",
      },
      {
        check: "secret",
        severity: "high",
        at: "src/index.ts:2",
        title: "Stripe live secret key",
        hint: "sk_l…",
      },
      {
        check: "secret",
        severity: "high",
        at: "src/index.ts:4",
        title: "GitHub token",
        hint: "ghp_…",
      },
      {
        check: "secret",
        severity: "high",
        at: "src/index.ts:5",
        title: "Slack token",
        hint: "xoxb…",
      },
      {
        check: "secret",
        severity: "high",
        at: "src/index.ts:6",
        title: "Google API key",
        hint: "AIza…",
      },
      {
        check: "secret",
        severity: "high",
        at: "src/index.ts:7",
        title: "Secret API key (sk-…)",
        hint: "sk-p…",
      },
      { check: "secret", severity: "high", at: "src/index.ts:11", title: "Private key" },
      {
        check: "secret",
        severity: "medium",
        at: "src/index.ts:3",
        title: "Stripe test secret key",
        hint: "sk_t…",
      },
      {
        check: "secret",
        severity: "medium",
        at: "src/index.ts:8",
        title: "JSON web token",
        hint: "eyJh…",
      },
      {
        check: "secret",
        severity: "medium",
        at: "src/index.ts:9",
        title: "Hardcoded secret in dbPassword",
        hint: "Wq9…",
      },
      {
        check: "secret",
        severity: "medium",
        at: "src/index.ts:10",
        title: "Password in a connection URL",
        hint: "Wq…",
      },
      {
        check: "secret",
        severity: "medium",
        at: "src/index.ts:12",
        title: "Password in a connection URL",
        hint: "Wq…",
      },
    ]);
    expect(report.counts).toEqual({ high: 7, medium: 5, low: 0 });
    // No field of any finding carries a value, only the hint.
    const json = JSON.stringify(report);
    for (const value of [...VALUES, URL_PASSWORD]) expect(json).not.toContain(value);
  });

  it("skips placeholders, environment lookups, labels and short values", () => {
    const text = [
      `const apiKey = "changeme";`,
      `const API_KEY = "<your key>";`,
      `const token = process.env.API_TOKEN;`,
      `password = os.environ["DB_PASSWORD"]`,
      `const secret = "xxxxxxxxxxxxxxxx";`,
      `const clientSecret = "your-client-secret-here";`,
      `const token = "password_reset";`,
      `const password = "hunter2";`,
      `const password = "Please enter a password";`,
      `const tokenizer = "${PASSWORD}";`,
      `export const STORAGE_TOKEN = "app.session.token.v2";`,
      `export const REFRESH_TOKEN = "refresh-token-v2";`,
      `const apiKey = "${k("sk-", "placeholder-xxxxxxxxxxxxxxxx")}";`,
      `const url = "postgres://user:password@localhost/db";`,
      `const aws = "${k("AKIA", "IOSFODNN7EXAMPLE")}";`,
      `if (password === "${PASSWORD}") return;`,
      `const password = "${PASSWORD}";`,
    ].join("\n");
    // Only the last line, the one real password, is reported.
    expect(secretFindings(check([{ path: "src/index.ts", text }]))).toEqual([
      {
        check: "secret",
        severity: "medium",
        at: "src/index.ts:17",
        title: "Hardcoded secret in password",
        hint: "Wq9…",
      },
    ]);
  });

  it("checks key shapes in tests, docs and fixtures one step lower, and skips the guesswork there", () => {
    const text = [`const aws = "${AWS}";`, `const password = "${PASSWORD}";`].join("\n");
    const report = check([
      { path: "src/worker.test.ts", text },
      { path: "docs/setup.md", text, language: "text" },
      { path: "fixtures/app/main.py", text, language: "python" },
    ]);
    expect(secretFindings(report)).toEqual([
      {
        check: "secret",
        severity: "medium",
        at: "docs/setup.md:1",
        title: "AWS access key in test or example code",
        hint: "AKIA…",
      },
      {
        check: "secret",
        severity: "medium",
        at: "fixtures/app/main.py:1",
        title: "AWS access key in test or example code",
        hint: "AKIA…",
      },
      {
        check: "secret",
        severity: "medium",
        at: "src/worker.test.ts:1",
        title: "AWS access key in test or example code",
        hint: "AKIA…",
      },
    ]);
  });

  it("reads unquoted values in config files", () => {
    const report = check([
      {
        path: "config/app.yaml",
        text: `db:\n  password: ${PASSWORD}\n  user: app`,
        language: "yaml",
      },
    ]);
    expect(secretFindings(report)).toEqual([
      {
        check: "secret",
        severity: "medium",
        at: "config/app.yaml:2",
        title: "Hardcoded secret in password",
        hint: "Wq9…",
      },
    ]);
  });
});

describe("healthCheck: .env files and browser variables", () => {
  it("reports a committed .env file once, at its first secret, and a secret in a browser variable", () => {
    const env = [
      "# local settings",
      "PORT=3000",
      `DATABASE_PASSWORD=${PASSWORD}`,
      `NEXT_PUBLIC_STRIPE_SECRET=${STRIPE_LIVE}`,
      `VITE_MAPS_KEY=${GOOGLE}`,
      "NEXT_PUBLIC_SITE_URL=https://example.com",
    ].join("\n");
    const report = check([{ path: ".env", text: env, language: "text" }]);
    expect(secretFindings(report)).toEqual([
      {
        check: "env-file",
        severity: "high",
        at: ".env:3",
        title: "Committed .env file with secrets",
      },
      {
        check: "browser-secret",
        severity: "high",
        at: ".env:4",
        title: "Secret in browser variable NEXT_PUBLIC_STRIPE_SECRET",
        hint: "sk_l…",
      },
    ]);
    expect(JSON.stringify(report)).not.toContain(PASSWORD);
  });

  it("flags a browser variable named like a secret in code, and leaves public keys alone", () => {
    const text = [
      `  REACT_APP_PRIVATE_TOKEN: "${PASSWORD}",`,
      `  VITE_API_KEY: "${GOOGLE}",`,
      `  PUBLIC_ANON_KEY: "${JWT}",`,
    ].join("\n");
    expect(secretFindings(check([{ path: "src/index.ts", text }]))).toEqual([
      {
        check: "browser-secret",
        severity: "high",
        at: "src/index.ts:1",
        title: "Secret in browser variable REACT_APP_PRIVATE_TOKEN",
        hint: "Wq9…",
      },
    ]);
  });

  it("calls a .env file of settings and public browser keys medium, and skips example files", () => {
    const report = check([
      { path: "app/.env.local", text: `PORT=3000\nPUBLIC_ANON_KEY=${JWT}`, language: "text" },
      { path: ".env.example", text: `API_KEY=${PASSWORD}`, language: "text" },
      { path: ".env.production", text: "API_KEY=\n# none yet", language: "text" },
    ]);
    expect(secretFindings(report)).toEqual([
      {
        check: "env-file",
        severity: "medium",
        at: "app/.env.local:1",
        title: "Committed .env file",
      },
    ]);
  });
});

describe("healthCheck: large and possibly unused files", () => {
  it("flags code files over 1,000 lines, not config", () => {
    const report = check([
      { path: "src/index.ts", lines: 1001 },
      { path: "src/main.ts", lines: 1000 },
      { path: "data/big.yaml", lines: 5000, language: "yaml" },
    ]);
    expect(brief(report.findings)).toEqual([
      {
        check: "large-file",
        severity: "low",
        at: "src/index.ts:1",
        title: "Very large file (1001 lines)",
      },
    ]);
  });

  it("calls a code file nothing else references possibly unused, unless it is an entry point, test or config", () => {
    const paths = [
      "src/main.ts",
      "src/queue.ts",
      "src/orphan.ts",
      "src/self.ts",
      "src/queue.test.ts",
      "scripts/release.ts",
      "vite.config.ts",
      "src/types.d.ts",
    ];
    const report = check(
      [
        ...paths.map((path) => ({ path })),
        { path: "src/reexports.ts" },
        { path: "README.md", language: "text" as const },
      ],
      [
        { from: "src/main.ts#", to: "src/queue.ts#", kind: "import", line: 1 },
        { from: "src/self.ts#", to: "src/self.ts#run", kind: "call", line: 1 },
      ],
      paths.map((path) => ({ id: `${path}#run`, start: 2, end: 3 })),
    );
    expect(brief(report.findings)).toEqual([
      {
        check: "unused-file",
        severity: "low",
        at: "src/orphan.ts:1",
        title: "Possibly unused file",
        heuristic: true,
      },
      {
        check: "unused-file",
        severity: "low",
        at: "src/self.ts:1",
        title: "Possibly unused file",
        heuristic: true,
      },
    ]);
  });

  it("cannot tell, and says so, for a file whose language's analysis does not follow imports", () => {
    const world = makeWorld({
      files: [
        { path: "src/runner.rs", language: "rust" },
        { path: "src/queue.rs", language: "rust" },
        { path: "src/orphan.ts" },
      ],
      refs: [{ from: "src/runner.rs#run", to: "src/queue.rs#push", kind: "call", line: 2 }],
      symbols: [
        { id: "src/runner.rs#run", start: 2, end: 3 },
        { id: "src/queue.rs#push", start: 2, end: 3 },
        { id: "src/orphan.ts#run", start: 2, end: 3 },
      ],
    });
    world.index.analysis = [
      {
        provider: "rust-tags",
        capabilities: { call: "partial" },
        files: ["src/runner.rs", "src/queue.rs"],
        results: [
          {
            capabilities: ["call"],
            status: "partial",
            analyzedFiles: ["src/runner.rs", "src/queue.rs"],
            limitations: [],
          },
          { capabilities: ["import"], status: "unsupported", analyzedFiles: [], limitations: [] },
        ],
      },
      {
        provider: "typescript",
        capabilities: { import: "partial" },
        files: ["src/orphan.ts"],
        results: [
          {
            capabilities: ["call", "import"],
            status: "partial",
            analyzedFiles: ["src/orphan.ts"],
            limitations: [],
          },
        ],
      },
    ];
    const report = healthCheck(world.model, world.getText);
    expect(brief(report.findings)).toEqual([
      {
        check: "unused-file",
        severity: "low",
        at: "src/orphan.ts:1",
        title: "Possibly unused file",
        heuristic: true,
      },
    ]);
    expect(report.notes).toEqual([
      "rust: the index does not follow imports, so xpl cannot tell whether 1 file is unused.",
    ]);
  });

  it("skips the unused check, with a note, when the index has no references", () => {
    const report = check(
      [{ path: "src/orphan.ts" }],
      [],
      [{ id: "src/orphan.ts#run", start: 2, end: 3 }],
    );
    expect(report.findings).toEqual([]);
    expect(report.notes).toEqual([
      "The index has no references, so the check for possibly unused files was skipped.",
    ]);
  });
});

describe("healthCheck: the report", () => {
  it("orders findings by severity, then file and line, and counts the files it read", () => {
    const report = check(
      [
        { path: "src/main.ts", text: textWith(1200, { 7: `const k = "${STRIPE_TEST}";` }) },
        { path: "src/a.ts", text: `const k = "${AWS}";` },
      ],
      [{ from: "src/main.ts#", to: "src/a.ts#", kind: "import", line: 1 }],
    );
    expect(brief(report.findings).map((f) => `${f.severity} ${f.at} ${f.check}`)).toEqual([
      "high src/a.ts:1 secret",
      "medium src/main.ts:7 secret",
      "low src/main.ts:1 large-file",
    ]);
    expect(report.files).toBe(2);
  });
});
