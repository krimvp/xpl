/** Shared #16/#17 measurement scope: build only, sampled before snapshot serialization. */
import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { buildIndex, type BuildIndexOptions } from "../packages/indexer/src/index.js";

export function diskCost(path: string): { files: number; bytes: number; allocatedBytes: number } {
  let files = 0,
    bytes = 0,
    allocatedBytes = 0;
  for (const entry of readdirSync(path, { withFileTypes: true })) {
    const child = join(path, entry.name);
    if (entry.isDirectory()) {
      const cost = diskCost(child);
      files += cost.files;
      bytes += cost.bytes;
      allocatedBytes += cost.allocatedBytes;
    } else {
      const stat = statSync(child);
      files++;
      bytes += stat.size;
      allocatedBytes += stat.blocks * 512;
    }
  }
  return { files, bytes, allocatedBytes };
}

export async function measuredBuild(options: BuildIndexOptions) {
  const started = performance.now();
  const cpuStarted = process.cpuUsage();
  const result = await buildIndex(options);
  const wallMs = performance.now() - started;
  const cpu = process.cpuUsage(cpuStarted);
  const peakRssKiB = process.resourceUsage().maxRSS;
  const heapUsedBytes = process.memoryUsage().heapUsed;
  return {
    result,
    metrics: {
      wallMs,
      cpuUserMs: cpu.user / 1000,
      cpuSystemMs: cpu.system / 1000,
      peakRssKiB,
      heapUsedBytes,
      counts: {
        files: result.index.files.length,
        symbols: result.index.symbols.length,
        refs: result.index.refs.length,
        warnings: result.warnings.length,
      },
      extraction: result.extraction,
      work: result.work,
    },
  };
}
