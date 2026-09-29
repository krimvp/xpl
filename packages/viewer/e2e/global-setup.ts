import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

const viewerDir = fileURLToPath(new URL("..", import.meta.url));

/**
 * Builds the TS fixture bundle once per run: `scripts/make-bundle.ts` indexes fixtures/ts-jobrunner,
 * applies scripts/ts-example.patch.json (Appendix B of docs/handoff.md) and injects the result into the
 * built viewer (dist/index.html) -> dist/bundles/ts-jobrunner.html, which the specs open via file://.
 * `--no-explainer` keeps the run from touching the committed fixtures/ts-jobrunner/.explainer file.
 * Keep the arguments in sync with the `bundle:ts` script in package.json.
 */
export default function globalSetup(): void {
  if (!existsSync(new URL("../dist/index.html", import.meta.url))) {
    throw new Error("dist/index.html is missing: run `npm run build -w @xpl/viewer` first");
  }
  const result = spawnSync(
    "npx",
    [
      "tsx",
      "scripts/make-bundle.ts",
      "../../fixtures/ts-jobrunner",
      "--name",
      "jobrunner",
      "--title",
      "Job runner",
      "--repo",
      "acme/jobrunner",
      "--patch",
      "scripts/ts-example.patch.json",
      "--no-explainer",
    ],
    { cwd: viewerDir, encoding: "utf8" },
  );
  if (result.status !== 0) {
    throw new Error(`make-bundle failed (${result.status}):\n${result.stdout}\n${result.stderr}`);
  }
}
