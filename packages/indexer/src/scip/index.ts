/**
 * Precise references from SCIP indexes (ARCHITECTURE.md §3, "Precise resolution").
 *
 * Importing this module registers the three providers (`scip-typescript`, `scip-python`, `scip-go`) in the
 * provider registry, which is how `buildIndex` uses them by default (`src/build.ts` imports it).
 * `registerScipProviders(options)` registers differently configured ones (timeout, command runner, ...).
 */
import { registerProvider } from "../providers.js";
import { createScipProviders } from "./resolvers.js";
import type { ScipOptions } from "./resolvers.js";

export { decodeIndex, ProtoError, ProtoReader, parseScipRange } from "./proto.js";
export type { ScipIndex, ScipDocument, ScipOccurrence, ScipSymbolInformation } from "./proto.js";
export { mapScip } from "./map.js";
export type { ColumnEncoding, MapInput, MapResult, ScipSource } from "./map.js";
export {
  createScipProviders,
  scipGoProvider,
  scipPythonProvider,
  scipTypescriptProvider,
} from "./resolvers.js";
export type { ScipOptions } from "./resolvers.js";
export { parseScipSymbol } from "./symbol.js";

/** Register the SCIP providers (replacing earlier ones with the same ids). */
export function registerScipProviders(options: ScipOptions = {}): void {
  for (const resolver of createScipProviders(options)) registerProvider(resolver);
}

registerScipProviders();
