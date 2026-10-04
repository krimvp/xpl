/** Shared test helpers: temp directories, git repos, single-file extraction and small index queries. */
import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
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

/**
 * What every fixture index keeps, whatever the language: ranges inside files, references between real
 * symbols with their sites inside the symbol that makes them, and the same index built twice or elsewhere.
 * `index` is read after the caller's `beforeAll` built it (`precise: "off"`).
 */
export function describeFixtureInvariants(fixture: string, index: () => SymbolIndex): void {
  const name = basename(fixture);
  describe(`${name}: index invariants`, () => {
    it("every symbol's range lies inside its file, ids follow the path, parents exist", () => {
      const { files, symbols } = index();
      const ids = new Set(symbols.map((s) => s.id));
      for (const symbol of symbols) {
        const file = files.find((f) => f.path === symbol.file)!;
        expect(symbol.range.startLine).toBeGreaterThanOrEqual(1);
        expect(symbol.range.endLine).toBeLessThanOrEqual(file.lines);
        expect(symbol.range.endLine).toBeGreaterThanOrEqual(symbol.range.startLine);
        expect(symbol.id).toBe(`${symbol.file}#${symbol.path}`);
        if (symbol.parent) expect(ids.has(symbol.parent), symbol.parent).toBe(true);
      }
    });

    it("all refs join real files and symbols (module scopes only as `<file>#`), inside the symbol that makes them", () => {
      const { files, symbols, refs } = index();
      const byId = new Map(symbols.map((s) => [s.id, s]));
      const lines = new Map(files.map((f) => [f.path, f.lines]));
      for (const ref of refs) {
        for (const id of [ref.from, ref.to]) {
          const hash = id.indexOf("#");
          expect(lines.has(id.slice(0, hash)), id).toBe(true);
          if (id.slice(hash + 1) !== "") expect(byId.has(id), id).toBe(true);
        }
        expect(ref.resolution).toBe("heuristic");
        expect(ref.site.startLine).toBeGreaterThanOrEqual(1);
        expect(ref.site.endLine).toBeLessThanOrEqual(
          lines.get(ref.from.slice(0, ref.from.indexOf("#")))!,
        );
        const from = byId.get(ref.from);
        if (from && ref.kind !== "implements") {
          expect(ref.site.startLine).toBeGreaterThanOrEqual(from.range.startLine);
          expect(ref.site.endLine).toBeLessThanOrEqual(from.range.endLine);
        }
      }
    });

    it("has a deterministic working-tree commit id and a byte-identical index when built twice", async () => {
      expect(index().commit).toMatch(/^wt-[0-9a-f]{10}$/);
      const again = await buildIndex({ root: fixture, precise: "off" });
      expect(JSON.stringify(again.index)).toBe(JSON.stringify(index()));
    });

    it("a copy of the fixture elsewhere gives the same commit id, symbols and references", async () => {
      const copy = makeDir();
      cpSync(fixture, copy, {
        recursive: true,
        filter: (src) => !src.includes(join(name, ".explainer")),
      });
      const built = await buildIndex({ root: copy, precise: "off" });
      expect(built.index.commit).toBe(index().commit);
      expect(built.index.symbols).toEqual(index().symbols);
      expect(built.index.refs).toEqual(index().refs);
    });
  });
}
