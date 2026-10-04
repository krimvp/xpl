/**
 * Where the viewer app (one self-contained HTML file) comes from:
 *
 *   1. `$XPL_VIEWER_HTML`, when set (an override for viewer development and tests);
 *   2. `viewer.html` next to the running bundle (`packages/cli/dist/viewer.html`, copied by the build);
 *   3. `packages/viewer/dist/index.html`, resolved relative to this package (development, `tsx`);
 *   4. `packages/cli/dist/viewer.html` seen from `src/`.
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Env } from "./context.js";
import { CliError } from "./errors.js";

const here = dirname(fileURLToPath(import.meta.url));

export function viewerHtmlCandidates(): string[] {
  return [
    join(here, "viewer.html"),
    join(here, "..", "..", "viewer", "dist", "index.html"),
    join(here, "..", "dist", "viewer.html"),
  ];
}

/** Path of the viewer HTML, or a `CliError` telling how to build it. */
export function findViewerHtml(
  env: Env,
  candidates: readonly string[] = viewerHtmlCandidates(),
): string {
  const override = env.XPL_VIEWER_HTML;
  if (override) {
    if (!existsSync(override)) {
      throw new CliError(`XPL_VIEWER_HTML points to ${override}, which does not exist`);
    }
    return override;
  }
  const found = candidates.find((candidate) => existsSync(candidate));
  if (!found) {
    throw new CliError(
      "the viewer is unavailable: reinstall the local xpl tarball; for source development, run `npm run build` in the xpl repository " +
        `(looked for ${candidates.join(", ")})`,
    );
  }
  return found;
}

export function readViewerHtml(env: Env): string {
  return readFileSync(findViewerHtml(env), "utf8");
}
