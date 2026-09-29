/**
 * Precise references from SCIP indexes (ARCHITECTURE.md §3, "Precise resolution").
 *
 * Importing this module registers the three resolvers (`scip-typescript`, `scip-python`, `scip-go`) in the
 * precise-resolver registry, which is how `buildIndex` uses them by default (`src/build.ts` imports it).
 * `registerScipResolvers(options)` registers differently configured ones (timeout, command runner, ...).
 */
import { registerPreciseResolver } from "../precise.js";
import { createScipResolvers } from "./resolvers.js";
import type { ScipOptions } from "./resolvers.js";

export { decodeIndex, ProtoError, ProtoReader, parseScipRange } from "./proto.js";
export type { ScipIndex, ScipDocument, ScipOccurrence, ScipSymbolInformation } from "./proto.js";
export { mapScip, toUtf16Offset } from "./map.js";
export type { ColumnEncoding, MapInput, MapResult, ScipSource } from "./map.js";
export {
  createScipResolvers,
  scipGoResolver,
  scipPythonResolver,
  scipTypescriptResolver,
} from "./resolvers.js";
export type { ScipOptions } from "./resolvers.js";
export { parseScipSymbol } from "./symbol.js";

/** Register the SCIP resolvers (replacing earlier ones with the same ids). */
export function registerScipResolvers(options: ScipOptions = {}): void {
  for (const resolver of createScipResolvers(options)) registerPreciseResolver(resolver);
}

registerScipResolvers();
