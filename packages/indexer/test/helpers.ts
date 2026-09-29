/** Shared test helpers: temp directories, git repos, single-file extraction and small index queries. */
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll } from "vitest";
import { splitLines } from "@xpl/core";
import type { FileLanguage, Reference, SymbolIndex } from "@xpl/core";
import { buildIndex, languageForPath, ParserPool, parseFile } from "../src/index.js";
import type { BuildIndexOptions, FileFacts, LanguagePack, FileContext } from "../src/index.js";

const tempDirs: string[] = [];

afterAll(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** Write `files` (path -> text) into a fresh temp directory and return it. Removed after the test file. */
export function makeDir(files: Record<string, string | Buffer> = {}): string {
  const dir = mkdtempSync(join(tmpdir(), "xpl-indexer-"));
  tempDirs.push(dir);
  writeFiles(dir, files);
  return dir;
}

export function writeFiles(dir: string, files: Record<string, string | Buffer>): void {
  for (const [path, content] of Object.entries(files)) {
    const abs = join(dir, ...path.split("/"));
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, content);
  }
}

/** Run git in `cwd` with a fixed identity; returns trimmed stdout. */
export function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "t",
      GIT_AUTHOR_EMAIL: "t@example.com",
      GIT_COMMITTER_NAME: "t",
      GIT_COMMITTER_EMAIL: "t@example.com",
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_SYSTEM: "/dev/null",
    },
  }).trim();
}

/** A temp git repository with `files` committed (when `commit` is true). */
export function makeRepo(files: Record<string, string | Buffer>, commit = true): string {
  const dir = makeDir();
  git(dir, "init", "-q", "-b", "main");
  writeFiles(dir, files);
  if (commit) {
    git(dir, "add", "-A");
    git(dir, "commit", "-q", "-m", "init");
  }
  return dir;
}

const pool = new ParserPool();
afterAll(async () => {
  await pool.dispose();
});

export interface Extracted {
  facts: FileFacts;
  ctx: Omit<FileContext, "tree">;
  pack: LanguagePack;
  /** Run `fn` while the syntax tree is alive (e.g. to call `pack.classifySite`). */
  withTree<T>(fn: (ctx: FileContext) => T): T;
}

/** Parse `source` as if it were file `path` and run its language pack. The tree stays alive (tests are short). */
export async function extract(
  path: string,
  source: string,
  language?: FileLanguage,
): Promise<Extracted> {
  const lang = language ?? languageForPath(path);
  const parsed = await parseFile(pool, path, lang, source);
  if (!parsed) throw new Error(`no language pack for ${lang}`);
  const facts = parsed.pack.extract(parsed.ctx);
  return {
    facts,
    ctx: { file: path, language: lang, source, lines: splitLines(source) },
    pack: parsed.pack,
    withTree: (fn) => fn(parsed.ctx),
  };
}

/** Index `files` in a fresh non-git temp directory. */
export async function indexFiles(
  files: Record<string, string>,
  options: Partial<BuildIndexOptions> = {},
): Promise<{ index: SymbolIndex; warnings: string[]; dir: string }> {
  const dir = makeDir(files);
  const { index, warnings } = await buildIndex({ root: dir, precise: "off", ...options });
  return { index, warnings, dir };
}

/** `from -> to (kind)` triples of refs, for readable assertions. */
export function refTriples(index: SymbolIndex, kind?: Reference["kind"]): string[] {
  return index.refs
    .filter((r) => !kind || r.kind === kind)
    .map((r) => `${r.from} -> ${r.to} (${r.kind})`);
}

/** Does the index contain a ref `from -> to` (of `kind` when given)? */
export function hasRef(
  index: SymbolIndex,
  from: string,
  to: string,
  kind?: Reference["kind"],
): boolean {
  return index.refs.some((r) => r.from === from && r.to === to && (!kind || r.kind === kind));
}

/** Symbols of a file as `kind path startLine-endLine`, in index order. */
export function symbolLines(index: SymbolIndex, file: string): string[] {
  return index.symbols
    .filter((s) => s.file === file)
    .map((s) => `${s.kind} ${s.path} ${s.range.startLine}-${s.range.endLine}`);
}

/** The symbol with this path in this file. */
export function symbol(index: SymbolIndex, file: string, path: string) {
  return index.symbols.find((s) => s.file === file && s.path === path);
}
