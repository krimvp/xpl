/**
 * File-local facts only. Resolution, normalization and semantic tools always run again.
 * Bump EXTRACTION_REVISION when extraction, resource sites or diagnostics change (see ARCHITECTURE §3).
 * SHA-256 addresses entries; exact stored input comparison handles address collisions. A separate checksum
 * detects damaged payloads. Missing/invalid entries and failed writes never affect the published index.
 */
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import { performance } from "node:perf_hooks";
import pkg from "../package.json" with { type: "json" };
import { GRAMMAR_WASM, RUNTIME_WASM, resolveWasmFile, type GrammarId } from "./wasm-files.js";
import type { ProviderSource } from "./providers.js";
import { loadedWasmMatches } from "./wasm.js";

const EXTRACTION_REVISION = 1;
const CACHE_FORMAT = "xpl-extraction@1";

export interface ExtractionProfile {
  provider: string;
  version: string;
  grammar: GrammarId;
  /** File-local options only. Project configuration belongs to fresh resolution/semantic analysis. */
  configuration: string;
}

export interface ExtractionReport {
  enabled: boolean;
  /** Directory alias or inspection failure. Incidental metadata, never part of the saved index. */
  bypassReason?: string;
  scope: "file-local tree-sitter and tags; excludes resolution and semantic tools";
  hits: number;
  misses: number;
  writeFailures: number;
  wallMs: number;
}

function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function missingPath(error: unknown): boolean {
  return (
    !!error &&
    typeof error === "object" &&
    "code" in error &&
    (error.code === "ENOENT" || error.code === "ENOTDIR")
  );
}

function compatibleWasm(fingerprint: string): boolean {
  const files: { file: string; sha256: string }[] = JSON.parse(fingerprint);
  return files.every((file) => loadedWasmMatches(file.file, file.sha256));
}

/** Reject live nodes, Maps and other non-JSON pack data before any serialization can discard them. */
function plainData(value: unknown): boolean {
  if (value === undefined || value === null) return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value !== "object") return false;
  if (!Array.isArray(value) && Object.getPrototypeOf(value) !== Object.prototype) return false;
  return Object.values(value).every(plainData);
}

/** One instance per build: WASM bytes are fingerprinted once per grammar, never across builds. */
export class ExtractionCache {
  readonly report: ExtractionReport;
  private readonly fingerprints = new Map<GrammarId, Promise<string | undefined>>();
  private readonly directory: string;
  private directories?: Promise<Map<string, string>>;

  constructor(
    private readonly root: string,
    enabled = true,
  ) {
    this.directory = join(root, ".explainer", "cache", "extraction-v1");
    this.report = {
      enabled,
      scope: "file-local tree-sitter and tags; excludes resolution and semantic tools",
      hits: 0,
      misses: 0,
      writeFailures: 0,
      wallMs: 0,
    };
  }

  /** Include empty and ignored directories: new output can also change Git's clean-tree decision. */
  private async repositoryDirectories(): Promise<Map<string, string>> {
    const directories = new Map<string, string>();
    const visit = async (path: string): Promise<void> => {
      const info = await stat(join(this.root, path), { bigint: true }).catch((error: unknown) => {
        if (path && missingPath(error)) return undefined; // Deleted or dangling directory link.
        throw error;
      });
      if (!info?.isDirectory()) return;
      const identity = `${info.dev}:${info.ino}`;
      if (directories.has(identity)) return; // Directory aliases must not make the census recurse forever.
      directories.set(identity, path || ".");
      for (const entry of await readdir(join(this.root, path), { withFileTypes: true })) {
        if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
        if (!path && (entry.name === ".explainer" || entry.name === ".git")) continue;
        await visit(join(path, entry.name));
      }
    };
    await visit("");
    return directories;
  }

  /** Symlinks, mounts and other aliases share one device/inode check, independent of path shape. */
  private async safeLocation(): Promise<boolean> {
    if (!this.report.enabled) return false;
    let directories: Map<string, string>;
    try {
      directories = await (this.directories ??= this.repositoryDirectories());
    } catch {
      this.report.enabled = false;
      this.report.bypassReason = "cannot inspect repository directory identities";
      return false;
    }
    for (const path of [
      dirname(dirname(this.directory)),
      dirname(this.directory),
      this.directory,
    ]) {
      try {
        const info = await stat(path, { bigint: true });
        const alias = directories.get(`${info.dev}:${info.ino}`);
        if (alias === undefined) continue;
        this.report.bypassReason = `${relative(this.root, path)} aliases repository directory ${alias}`;
      } catch (error) {
        if (missingPath(error)) return true;
        this.report.bypassReason = `cannot inspect cache directory ${relative(this.root, path)}`;
      }
      this.report.enabled = false;
      return false;
    }
    return true;
  }

  private fingerprint(grammar: GrammarId): Promise<string | undefined> {
    let value = this.fingerprints.get(grammar);
    if (!value) {
      value = (async () => {
        try {
          const deps: Record<string, string> = pkg.dependencies;
          return JSON.stringify(
            await Promise.all(
              [RUNTIME_WASM, GRAMMAR_WASM[grammar]].map(async (wasm) => ({
                package: wasm.pkg,
                version: deps[wasm.pkg],
                file: wasm.file,
                sha256: sha256(await readFile(resolveWasmFile(wasm))),
              })),
            ),
          );
        } catch {
          return undefined; // A missing grammar must be retried by extraction, not masked by a hit.
        }
      })();
      this.fingerprints.set(grammar, value);
    }
    return value;
  }

  async extract<T>(
    source: ProviderSource,
    profile: ExtractionProfile,
    extract: () => Promise<T>,
    reusable: (value: T) => boolean = () => true,
  ): Promise<T> {
    const started = performance.now();
    try {
      const fingerprint = (await this.safeLocation())
        ? await this.fingerprint(profile.grammar)
        : undefined;
      const input = JSON.stringify({
        format: CACHE_FORMAT,
        revision: EXTRACTION_REVISION,
        indexer: pkg.version,
        ...profile,
        fingerprint,
        path: source.path,
        language: source.language,
        source: source.text,
      });
      const target = join(this.directory, `${sha256(input)}.json`);
      if (fingerprint && compatibleWasm(fingerprint)) {
        try {
          const entry: unknown = JSON.parse(await readFile(target, "utf8"));
          if (
            entry &&
            typeof entry === "object" &&
            "input" in entry &&
            entry.input === input &&
            "payload" in entry &&
            typeof entry.payload === "string" &&
            "checksum" in entry &&
            entry.checksum === sha256(`${input}\0${entry.payload}`)
          ) {
            const value: T = JSON.parse(entry.payload);
            if (reusable(value)) {
              this.report.hits++;
              return value;
            }
          }
        } catch {
          // Missing, truncated, invalid or incompatible entry: extract from the captured source.
        }
      }
      this.report.misses++;
      const value = await extract();
      if (
        fingerprint &&
        compatibleWasm(fingerprint) &&
        reusable(value) &&
        (await this.safeLocation())
      ) {
        const temp = `${target}.${randomUUID()}.tmp`;
        try {
          if (!plainData(value)) throw new Error("extraction returned non-JSON data");
          const payload = JSON.stringify(value);
          await mkdir(this.directory, { recursive: true });
          await writeFile(
            temp,
            JSON.stringify({ input, payload, checksum: sha256(`${input}\0${payload}`) }),
            { flag: "wx" },
          );
          await rename(temp, target);
        } catch {
          this.report.writeFailures++;
        } finally {
          await rm(temp, { force: true }).catch(() => {});
        }
      }
      return value;
    } finally {
      this.report.wallMs += performance.now() - started;
    }
  }
}
