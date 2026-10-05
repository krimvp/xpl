/** One SCIP artifact selection for manual indexing and watching; reload the attested pair each build. */
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { indexProviders, scipArtifactProvider } from "@xpl/indexer";

export function scipInputPaths(path: string | null): string[] {
  if (!path) return [];
  if (!path.endsWith(".json")) return [path];
  const manifest: unknown = JSON.parse(readFileSync(path, "utf8"));
  if (
    !manifest ||
    typeof manifest !== "object" ||
    !("artifact" in manifest) ||
    typeof manifest.artifact !== "string" ||
    !manifest.artifact
  )
    throw new Error("SCIP manifest requires an artifact path relative to the manifest");
  return [path, resolve(dirname(path), manifest.artifact)];
}

export function scipProviders(path: string) {
  const inputs = scipInputPaths(path);
  const artifact = readFileSync(inputs.at(-1)!);
  return [
    ...indexProviders().filter((provider) => provider.mode === "syntax"),
    scipArtifactProvider({
      artifact,
      ...(inputs.length === 2 ? { manifest: JSON.parse(readFileSync(path, "utf8")) } : {}),
    }),
  ];
}
