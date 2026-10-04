/**
 * File-local facts only. Resolution, normalization and semantic tools always run again.
 * Bump EXTRACTION_REVISION when extraction, resource sites or diagnostics change (see ARCHITECTURE §3).
 * SHA-256 addresses entries; exact stored input comparison handles address collisions. A separate checksum
 * detects damaged payloads. Missing/invalid entries and failed writes never affect the published index.
 */
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
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
  scope: "file-local tree-sitter and tags; excludes resolution and semantic tools";
  hits: number;
  misses: number;
  writeFailures: number;
  wallMs: number;
}

function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
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

  constructor(root: string, enabled = true) {
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
      const fingerprint = this.report.enabled ? await this.fingerprint(profile.grammar) : undefined;
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
      if (fingerprint && compatibleWasm(fingerprint) && reusable(value)) {
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
