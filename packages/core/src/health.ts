/**
 * Health check (ARCHITECTURE.md §4.8): a quick list of classic problems in code nobody reads line by line, each
 * at a file and a line, with a severity, a plain explanation and a short fix. `xpl health` prints it.
 *
 * - `secret`: well-known key shapes, private key headers, JSON web tokens and connection URLs with a password,
 *   and literal values assigned to names like `password`, `secret`, `api_key` or `token` (long enough, mixed
 *   characters, not a placeholder or an environment lookup). A finding carries a masked `hint` (at most the first
 *   4 characters, then `…`), never the value.
 * - `browser-secret`: a variable with a prefix that build tools ship to the browser (`NEXT_PUBLIC_`, `VITE_`,
 *   `REACT_APP_`, `PUBLIC_`) holding a server key shape, or named like a secret (`SECRET`, `PRIVATE`,
 *   `PASSWORD`, `SERVICE_ROLE`). Browser keys that are public by design (`AIza…`, tokens without such a name)
 *   are left alone there.
 * - `env-file`: an indexed `.env` or `.env.<name>` file with values (example and template files excepted).
 * - `large-file`: a code file over `HEALTH_LARGE_FILE_LINES` lines.
 * - `unused-file`: a code file with symbols that no other file references (by the index) and that is not an
 *   entry point (`ENTRY_STEMS`, `ENTRY_DIRS`, or a `main` its text declares: `ENTRY_TEXT`), a test, a config
 *   file or a type declaration file. Marked `heuristic`; skipped when the index has no references or is
 *   pruned. A file without symbols (a list of re-exports, say) is never reported: imports through it resolve
 *   to the symbols it re-exports. Nor is a file whose language's analysis does not follow imports: a note says
 *   how many files xpl cannot tell about.
 *
 * Tests, fixtures, docs and examples (`SAMPLE_GLOBS`) hold fake secrets far more often than real ones: there,
 * key shapes are reported one severity lower and the guessing checks (assignments, tokens, URLs, `.env`, browser
 * variables) are skipped. The files are the index's, so its ignore rules apply. Pure: text comes through `GetText`.
 */
import { toTextCache, type GetText, type TextCache } from "./anchors.js";
import { TEST_FILE_GLOBS } from "./constants.js";
import { matchesAnyGlob } from "./glob.js";
import { asIndexModel, baseName, type IndexModel } from "./index-model.js";
import { CODE_LANGUAGES } from "./languages.js";
import type { FilePath, IndexedFile, SymbolIndex } from "./schema.js";
import { cmp } from "./util.js";

export type HealthSeverity = "high" | "medium" | "low";
export type HealthCheckKind =
  "secret" | "browser-secret" | "env-file" | "large-file" | "unused-file";

export interface HealthFinding {
  check: HealthCheckKind;
  severity: HealthSeverity;
  file: FilePath;
  /** 1-based. */
  line: number;
  /** One line, never the secret value. */
  title: string;
  explanation: string;
  fix: string;
  /** For a secret: at most its first 4 characters, then `…`. */
  hint?: string;
  /** Set when the finding is a guess from incomplete facts (`unused-file`). */
  heuristic?: true;
}

export interface HealthReport {
  /** By severity (high first), then file and line. */
  findings: HealthFinding[];
  counts: Record<HealthSeverity, number>;
  /** Files whose text was read. */
  files: number;
  /** Checks that could not run, and why. */
  notes: string[];
}

/** Code files longer than this are reported as `large-file`. */
export const HEALTH_LARGE_FILE_LINES = 1000;

const SEVERITIES: readonly HealthSeverity[] = ["high", "medium", "low"];

/** Test code, fixtures, docs and examples: fake secrets dominate there. */
const SAMPLE_GLOBS: readonly string[] = [
  ...TEST_FILE_GLOBS,
  "**/fixtures/**",
  "**/__fixtures__/**",
  "**/testdata/**",
  "**/e2e/**",
  "**/docs/**",
  "**/examples/**",
  "**/example/**",
  "*.md",
  "*.mdx",
  "*.rst",
  "*.example",
  "*.sample",
  "*.template",
  "*.dist",
];

// ─── Explanations ───────────────────────────────────────────────────────────────────────────────

const LEAK = {
  explanation:
    "A key written into the code works for anyone who can read the code or its history, and code gets copied, shared and published.",
  fix: "Revoke the key and make a new one, then read it from an environment variable or a secret store, never from the code.",
};
const GUESS = {
  explanation:
    "This looks like a password or key written into the code. Anyone who can read the code can use it.",
  fix: "If it is real, change it and read it from an environment variable or a secret store instead.",
};
const SAMPLE = {
  explanation:
    "This file looks like test or example code, where keys are usually fake, but this one has the shape of a real key.",
  fix: "Check whether it is real. If it is, revoke it; use an obviously fake value in tests and examples.",
};
const BROWSER = {
  explanation:
    "Variables with this prefix are copied into the code sent to every visitor's browser, so this secret is public.",
  fix: "Revoke the key, keep it only on the server under a name without the public prefix, and call the service from server code.",
};
const ENV_SECRETS = {
  explanation:
    ".env files hold local settings and secrets, and are meant to stay on one machine. This one is in the project's files, so its values are shared with everyone who gets the code.",
  fix: "Add .env files to .gitignore, remove this one from the repository, change the secrets in it, and commit a .env.example with empty values instead.",
};
const ENV_SETTINGS = {
  explanation:
    ".env files are meant to stay on one machine. This one holds only settings now, but secrets usually end up in it later.",
  fix: "Add .env files to .gitignore, remove this one from the repository, and commit a .env.example instead.",
};
const LARGE = {
  explanation:
    "AI assistants and people both make more mistakes in very long files: changes land in the wrong place and the file is hard to review.",
  fix: "Split it into smaller files by what each part does.",
};
const UNUSED = {
  explanation:
    "Nothing else in the project refers to this file, so it may be left over. This is a guess from the index: code loaded by name, by a framework or from outside the project is not seen.",
  fix: "Check whether anything still uses it, and delete it if nothing does.",
};

// ─── Secrets ────────────────────────────────────────────────────────────────────────────────────

interface KeyShape {
  re: RegExp;
  title: string;
  severity: HealthSeverity;
  /** Server-only: a browser variable must never hold one (browser keys that are public by design are not). */
  server: boolean;
}

const KEY_SHAPES: readonly KeyShape[] = [
  { re: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/, title: "AWS access key", severity: "high", server: true },
  {
    re: /\b(?:sk|rk)_live_[0-9A-Za-z]{10,}/,
    title: "Stripe live secret key",
    severity: "high",
    server: true,
  },
  {
    re: /\b(?:sk|rk)_test_[0-9A-Za-z]{10,}/,
    title: "Stripe test secret key",
    severity: "medium",
    server: true,
  },
  {
    re: /\b(?:ghp|gho|ghu|ghs|ghr)_[0-9A-Za-z]{36,}|\bgithub_pat_[0-9A-Za-z_]{22,}/,
    title: "GitHub token",
    severity: "high",
    server: true,
  },
  { re: /\bxox[abposr]-[0-9A-Za-z-]{10,}/, title: "Slack token", severity: "high", server: true },
  {
    re: /\bAIza[0-9A-Za-z_-]{35}(?![0-9A-Za-z_-])/,
    title: "Google API key",
    severity: "high",
    server: false,
  },
  {
    re: /\bsk-[0-9A-Za-z_-]{20,}/,
    title: "Secret API key (sk-…)",
    severity: "high",
    server: true,
  },
  {
    re: /-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY-----/,
    title: "Private key",
    severity: "high",
    server: true,
  },
];

const JWT =
  /(?:[:=]|=>)\s*["'`]?(eyJ[0-9A-Za-z_-]{10,}\.eyJ[0-9A-Za-z_-]{10,}\.[0-9A-Za-z_-]{10,})/;
/*
 * The name and scheme patterns below are linear in the line. Each starts only where a run of name (or scheme)
 * characters starts (the lookbehind), skips the run's leading digits, dots and dashes, and takes the rest of
 * the run whole (`(?=(…))\N`, an atomic group), so a match is tried once per run. Without that, a run of
 * 80,000 letters in a generated file was tried at each letter and scanned to its end each time: seconds per line.
 */
/** `scheme://user:password@host`. */
const URL_PASSWORD =
  /(?<![\w+.-])[+.-]*[a-z](?=([a-z0-9+.-]*))\1:\/\/([^\s:@/"'`]*):([^\s@/"'`]+)@[^\s"'`]/i;
/** `name = "value"`, `name: 'value'`, `"name": "value"`, `name := "value"`, `'name' => 'value'`. */
const QUOTED_ASSIGNMENT =
  /(?:(["'])|(?<![\w$.-])[\d.-]*)(?=([A-Za-z_$][\w$.-]*))\2\1\s*(?::=|=>|(?<![=!<>])=(?![=>])|:)\s*(["'`])([^"'`\n]*)\3/g;
/** The same in config files, where a value may be unquoted. */
const BARE_ASSIGNMENT =
  /(?:(["'])|(?<![\w$.-])[\d.-]*)(?=([A-Za-z_$][\w$.-]*))\2\1\s*(?::=|(?<![=!<>])=(?![=>])|:)[ \t]*["'`]?([^\s"'`#,;]+)/g;
/** Name endings that say "this holds a secret" (lower case, `_` and `-` removed). */
const SECRET_NAME_ENDINGS = [
  "password",
  "passwd",
  "pwd",
  "secret",
  "secretkey",
  "apikey",
  "accesskey",
  "authkey",
  "privatekey",
  "token",
];
/** Prefixes of the variables that build tools copy into the code sent to the browser. */
const BROWSER_PREFIX = "(?:NEXT_PUBLIC|VITE|REACT_APP|PUBLIC)_";
const BROWSER_VARIABLE = new RegExp(
  `\\b(${BROWSER_PREFIX}[A-Z0-9_]*)["']?\\s*[:=]\\s*["'\`]?([^\\s"'\`#,;]*)`,
);
const BROWSER_NAME = new RegExp(`^${BROWSER_PREFIX}`);
const BROWSER_SECRET_NAME = /SECRET|PRIVATE|PASSWORD|PASSWD|SERVICE_ROLE/;
const ENV_LINE = /^\s*(?:export\s+)?([A-Za-z_][\w.-]*)\s*=\s*(.*)$/;
const ENV_SECRET_NAME = /KEY|SECRET|TOKEN|PASS|PWD|PRIVATE|CREDENTIAL|AUTH|DSN/i;
const PLACEHOLDER_PARTS = [
  "xxx",
  "changeme",
  "change_me",
  "change-me",
  "your",
  "example",
  "placeholder",
  "dummy",
  "sample",
  "redacted",
  "todo",
  "fixme",
  "replace",
  "insert",
  "<",
  ">",
  "${",
  "{{",
  "%(",
  "process.env",
  "environ",
  "getenv",
  "***",
  "...",
  "…",
];
const PLACEHOLDER_WORDS = new Set(["password", "secret", "pass", "admin", "root", "postgres"]);

/** At most the first 4 characters (fewer for a short value: a quarter of it), then `…`. */
function maskHint(value: string): string {
  return `${value.slice(0, Math.min(4, Math.floor(value.length / 4)))}…`;
}

function isPlaceholder(value: string): boolean {
  const lower = value.toLowerCase();
  return (
    PLACEHOLDER_WORDS.has(lower) ||
    PLACEHOLDER_PARTS.some((part) => lower.includes(part)) ||
    /^(.)\1*$/.test(value)
  );
}

/** Shannon entropy in bits per character. */
function entropy(value: string): number {
  const counts = new Map<string, number>();
  for (const ch of value) counts.set(ch, (counts.get(ch) ?? 0) + 1);
  let bits = 0;
  for (const n of counts.values()) bits -= (n / value.length) * Math.log2(n / value.length);
  return bits;
}

/**
 * Could a literal be a real password or key? 8 to 200 characters, no spaces, no URL, not a placeholder, at
 * least two kinds of character (lower, upper, digit, symbol other than `_-./`) and 3 bits of entropy per
 * character: that leaves out labels (`password_reset`), paths and words. Lower-case words and digits joined by
 * separators are names too (`app.session.token`, `refresh-token-v2`).
 */
function looksSecret(value: string): boolean {
  if (value.length < 8 || value.length > 200 || /\s/.test(value) || value.includes("://"))
    return false;
  if (value.startsWith("$") || isPlaceholder(value)) return false;
  if (/^[a-z0-9]+(?:[._:/-][a-z0-9]+)+$/.test(value)) return false;
  const kinds = [/[a-z]/, /[A-Z]/, /[0-9]/, /[^\w\-./]/].filter((re) => re.test(value)).length;
  return kinds >= 2 && entropy(value) >= 3;
}

function hasSecretName(name: string): boolean {
  const last = name
    .slice(name.lastIndexOf(".") + 1)
    .toLowerCase()
    .replace(/[-_]/g, "");
  return SECRET_NAME_ENDINGS.some((ending) => last.endsWith(ending));
}

function keyShapeAt(line: string): { shape: KeyShape; value: string } | undefined {
  for (const shape of KEY_SHAPES) {
    const match = shape.re.exec(line);
    if (match && !match[0].includes("EXAMPLE") && !isPlaceholder(match[0]))
      return { shape, value: match[0] };
  }
  return undefined;
}

function lower(severity: HealthSeverity): HealthSeverity {
  return severity === "high" ? "medium" : "low";
}

function isEnvFile(path: FilePath): boolean {
  const base = baseName(path);
  return base === ".env" || base.startsWith(".env.");
}

/** The secret findings of one line (at most one), or undefined. */
function lineSecret(
  file: FilePath,
  line: string,
  n: number,
  opts: { sample: boolean; bare: boolean; env: boolean },
): HealthFinding | undefined {
  const at = { file, line: n };
  const browser = opts.sample ? null : BROWSER_VARIABLE.exec(line);
  if (browser) {
    const [, name, value] = browser as unknown as [string, string, string];
    const shape = keyShapeAt(value);
    if (
      (shape && shape.shape.server) ||
      (BROWSER_SECRET_NAME.test(name) && value.length >= 8 && !isPlaceholder(value))
    ) {
      return {
        check: "browser-secret",
        severity: "high",
        ...at,
        title: `Secret in browser variable ${name}`,
        ...BROWSER,
        hint: maskHint(shape?.value ?? value),
      };
    }
    // A public variable holding a public key or a setting: what the prefix is for.
    if (value !== "") return undefined;
  }
  const shape = keyShapeAt(line);
  if (shape) {
    const hint = shape.shape.title === "Private key" ? {} : { hint: maskHint(shape.value) };
    return opts.sample
      ? {
          check: "secret",
          severity: lower(shape.shape.severity),
          ...at,
          title: `${shape.shape.title} in test or example code`,
          ...SAMPLE,
          ...hint,
        }
      : {
          check: "secret",
          severity: shape.shape.severity,
          ...at,
          title: shape.shape.title,
          ...LEAK,
          ...hint,
        };
  }
  if (opts.sample) return undefined;
  const jwt = JWT.exec(line);
  if (jwt) {
    return {
      check: "secret",
      severity: "medium",
      ...at,
      title: "JSON web token",
      ...GUESS,
      hint: maskHint(jwt[1]!),
    };
  }
  const url = URL_PASSWORD.exec(line);
  if (url) {
    const [, , user, password] = url as unknown as [string, string, string, string];
    if (password !== user && password.length >= 6 && !isPlaceholder(password)) {
      return {
        check: "secret",
        severity: "medium",
        ...at,
        title: "Password in a connection URL",
        ...GUESS,
        hint: maskHint(password),
      };
    }
  }
  if (opts.env) return undefined; // a .env file's values are its own finding
  const assignment = opts.bare ? BARE_ASSIGNMENT : QUOTED_ASSIGNMENT;
  for (const match of line.matchAll(assignment)) {
    const name = match[2]!;
    const value = (opts.bare ? match[3] : match[4])!;
    if (hasSecretName(name) && looksSecret(value)) {
      return {
        check: "secret",
        severity: "medium",
        ...at,
        title: `Hardcoded secret in ${name}`,
        ...GUESS,
        hint: maskHint(value),
      };
    }
  }
  return undefined;
}

/** The `.env` finding of a file: at its first secret-named value, else at its first value. */
function envFileFinding(file: FilePath, lines: readonly string[]): HealthFinding | undefined {
  let first: number | undefined;
  for (const [i, line] of lines.entries()) {
    const match = ENV_LINE.exec(line);
    if (!match) continue;
    const value = match[2]!
      .replace(/\s+#.*$/, "")
      .trim()
      .replace(/^(["'])(.*)\1$/, "$2");
    if (value === "") continue;
    const name = match[1]!;
    // A browser variable is public by design; when it holds a secret, `browser-secret` reports its line.
    if (ENV_SECRET_NAME.test(name) && !BROWSER_NAME.test(name) && !isPlaceholder(value)) {
      return {
        check: "env-file",
        severity: "high",
        file,
        line: i + 1,
        title: "Committed .env file with secrets",
        ...ENV_SECRETS,
      };
    }
    first ??= i + 1;
  }
  return first === undefined
    ? undefined
    : {
        check: "env-file",
        severity: "medium",
        file,
        line: first,
        title: "Committed .env file",
        ...ENV_SETTINGS,
      };
}

// ─── Files ──────────────────────────────────────────────────────────────────────────────────────

/** File names (up to the first dot) that a runtime, a framework or a package loads by convention. */
const ENTRY_STEMS = new Set([
  "main",
  "index",
  "cli",
  "server",
  "app",
  "__main__",
  "__init__",
  "mod",
  "lib",
  "build",
  "setup",
  "manage",
  "wsgi",
  "asgi",
  "middleware",
  "page",
  "layout",
  "route",
]);
const ENTRY_DIRS = new Set(["scripts", "bin", "cmd", "pages", "routes", "migrations"]);

function isEntryPoint(path: FilePath): boolean {
  const base = baseName(path);
  if (base.startsWith(".") || base.includes(".config.") || base.endsWith(".d.ts")) return true;
  if (ENTRY_STEMS.has(base.slice(0, base.indexOf(".") === -1 ? undefined : base.indexOf("."))))
    return true;
  return path
    .split("/")
    .slice(0, -1)
    .some((dir) => ENTRY_DIRS.has(dir));
}

/**
 * Source text that makes a file a program's entry point, which nothing refers to by design: Java's
 * `static void main`, Python's `if __name__ == "__main__"`, Go's `func main` in package main and Rust's
 * `fn main`.
 */
const ENTRY_TEXT: Partial<Record<string, (text: string) => boolean>> = {
  java: (text) => /\bstatic\s+(?:public\s+|final\s+)*void\s+main\s*\(/.test(text),
  python: (text) => /^if\s+__name__\s*==\s*["']__main__["']\s*:/m.test(text),
  go: (text) => /^package\s+main\b/m.test(text) && /^func\s+main\s*\(\s*\)/m.test(text),
  rust: (text) => /^\s*(?:pub\s+)?(?:async\s+)?fn\s+main\s*\(/m.test(text),
};

function declaresEntry(file: IndexedFile, texts: TextCache): boolean {
  const test = ENTRY_TEXT[file.language];
  const lines = test && texts.lines(file.path);
  return lines !== undefined && test!(lines.join("\n"));
}

/** Files that some other file references: a symbol or module reference, or a resource it loads. */
function referencedFiles(model: IndexModel): Set<FilePath> {
  const used = new Set<FilePath>();
  for (const ref of model.refs) {
    const from = model.fileOfSymbolId(ref.from);
    const to = model.fileOfSymbolId(ref.to);
    if (to !== undefined && from !== to) used.add(to);
  }
  for (const resource of model.index.resources ?? []) {
    const from = model.fileOfSymbolId(resource.from);
    for (const file of resource.files) if (file !== from) used.add(file);
  }
  return used;
}

/**
 * Files the index's analysis looked at without following imports (Rust tags record calls only, say): no
 * reference into such a file says nothing about whether it is used. Undefined on a legacy index with no
 * recorded analysis.
 */
function importBlindFiles(model: IndexModel): Set<FilePath> | undefined {
  const reports = model.index.analysis;
  if (!reports) return undefined;
  const followed = new Set<FilePath>();
  for (const report of reports)
    for (const result of report.results)
      if (
        result.capabilities.includes("import") &&
        result.status !== "unsupported" &&
        result.status !== "failed"
      )
        for (const file of result.analyzedFiles) followed.add(file);
  return new Set(model.files.map((f) => f.path).filter((path) => !followed.has(path)));
}

/** Whether the unused-file check applies to `file` at all, before the index's references are asked. */
function unusedCandidate(model: IndexModel, file: IndexedFile, texts: TextCache): boolean {
  return (
    CODE_LANGUAGES.has(file.language) &&
    // A file without symbols of its own (a re-export list, a script) is reached through what it imports.
    model.symbolsInFile(file.path).length > 0 &&
    model.index.languages[file.language]?.refs !== "none" &&
    !matchesAnyGlob(file.path, SAMPLE_GLOBS) &&
    !isEntryPoint(file.path) &&
    !declaresEntry(file, texts)
  );
}

function fileFindings(
  model: IndexModel,
  file: IndexedFile,
  used: Set<FilePath> | undefined,
  blind: Set<FilePath> | undefined,
  texts: TextCache,
): HealthFinding[] {
  if (!CODE_LANGUAGES.has(file.language)) return [];
  const out: HealthFinding[] = [];
  const at = { file: file.path, line: 1 };
  if (file.lines > HEALTH_LARGE_FILE_LINES) {
    out.push({
      check: "large-file",
      severity: "low",
      ...at,
      title: `Very large file (${file.lines} lines)`,
      ...LARGE,
    });
  }
  if (
    used &&
    !used.has(file.path) &&
    !blind?.has(file.path) &&
    unusedCandidate(model, file, texts)
  ) {
    out.push({
      check: "unused-file",
      severity: "low",
      ...at,
      title: "Possibly unused file",
      ...UNUSED,
      heuristic: true,
    });
  }
  return out;
}

// ─── The report ─────────────────────────────────────────────────────────────────────────────────

/** Every finding of the checks above over the indexed files, read through `text`. */
export function healthCheck(
  index: SymbolIndex | IndexModel,
  text: GetText | TextCache,
): HealthReport {
  const model = asIndexModel(index);
  const texts = toTextCache(text);
  const notes: string[] = [];
  let used: Set<FilePath> | undefined;
  if (model.index.pruned) {
    notes.push(
      "The index is cut down to what a guide shows, so the check for possibly unused files was skipped.",
    );
  } else if (model.refs.length === 0) {
    notes.push("the index has no references, so xpl did not check for unused files");
  } else {
    used = referencedFiles(model);
  }
  const blind = used && importBlindFiles(model);
  if (used && blind) {
    const unknown = new Map<string, number>();
    for (const file of model.files)
      if (blind.has(file.path) && !used.has(file.path) && unusedCandidate(model, file, texts))
        unknown.set(file.language, (unknown.get(file.language) ?? 0) + 1);
    for (const [language, count] of [...unknown].sort(([a], [b]) => cmp(a, b)))
      notes.push(
        `${language}: the index does not follow imports, so xpl cannot tell whether ${count} ${count === 1 ? "file is" : "files are"} unused.`,
      );
  }

  const findings: HealthFinding[] = [];
  let files = 0;
  for (const file of model.files) {
    findings.push(...fileFindings(model, file, used, blind, texts));
    const lines = texts.lines(file.path);
    if (lines === undefined) continue;
    files++;
    const sample = matchesAnyGlob(file.path, SAMPLE_GLOBS);
    const env = isEnvFile(file.path);
    if (env && !sample) {
      const finding = envFileFinding(file.path, lines);
      if (finding) findings.push(finding);
    }
    const bare = !CODE_LANGUAGES.has(file.language) && !file.path.endsWith(".json");
    for (const [i, line] of lines.entries()) {
      const finding = lineSecret(file.path, line, i + 1, { sample, bare, env });
      if (finding) findings.push(finding);
    }
  }

  findings.sort(
    (a, b) =>
      SEVERITIES.indexOf(a.severity) - SEVERITIES.indexOf(b.severity) ||
      cmp(a.file, b.file) ||
      a.line - b.line ||
      cmp(a.check, b.check),
  );
  const counts = { high: 0, medium: 0, low: 0 };
  for (const finding of findings) counts[finding.severity]++;
  return { findings, counts, files, notes };
}
