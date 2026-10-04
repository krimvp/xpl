import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { existsSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { fileURLToPath } from "node:url";

const viewerDir = fileURLToPath(new URL("..", import.meta.url));

/** The original fixture examples and a small Rust structural example get browser bundles. */
const LANGUAGES = ["ts", "py", "go", "rs"] as const;

/**
 * Builds the fixture bundles once per run, one `scripts/make-bundle.ts` process per language in
 * parallel (plus `ts-change.html`: the TS fixture as a change explainer, see `--change`): it indexes fixtures/<lang>-jobrunner, applies scripts/<lang>-example.patch.json (actor llm)
 * and then scripts/<lang>-example.user.patch.json (actor user), which together are Appendix B of
 * docs/handoff.md for that language, and injects the result into the built viewer (dist/index.html)
 * -> dist/bundles/<lang>-jobrunner.html, which the specs open via file://. Rust uses a temporary
 * structural patch, without a user patch or a committed fixture explainer.
 * `--no-explainer` keeps the run from touching the committed fixtures/<lang>-jobrunner/.explainer files;
 * regenerate those by running the same command without it (`npm run bundle:ts -w @xpl/viewer` does that
 * for TS; for Python and Go pass `--patch scripts/<lang>-example.patch.json`, which finds the sibling
 * `.user.patch.json` by itself).
 */
function makeBundle(
  lang: (typeof LANGUAGES)[number],
  change = false,
  architecture = false,
): Promise<void> {
  const patchDir = lang === "rs" ? mkdtempSync(join(tmpdir(), "xpl-rust-e2e-")) : undefined;
  const rustPatch = patchDir ? join(patchDir, "rust.patch.json") : undefined;
  if (rustPatch)
    writeFileSync(
      rustPatch,
      JSON.stringify({
        views: [
          {
            id: "view:rust",
            type: "graph",
            title: "Rust structure",
            include: [
              "sym:src/queue.rs#JobQueue.pop",
              "sym:src/worker.rs#demo.handlers.echo",
              "sym:src/runner.rs#impl Runner<Q>.dispatch",
            ],
          },
        ],
        concepts: [
          {
            id: "concept:rust",
            label: "Queue contract",
            summary: "The queue supplies a job to the runner.",
            anchors: [{ file: "src/queue.rs", symbol: "JobQueue.pop", role: "definition" }],
          },
        ],
      }),
    );
  return new Promise((resolve, reject) => {
    const child = spawn(
      "npx",
      [
        "tsx",
        "scripts/make-bundle.ts",
        `../../fixtures/${lang}-jobrunner`,
        "--name",
        "jobrunner",
        "--title",
        "Job runner",
        "--repo",
        "acme/jobrunner",
        "--no-explainer",
        // An architecture explainer (a system map whose service box opens the map of its parts): the skill's
        // worked repo overview.
        ...(architecture
          ? [
              "--patch",
              "../../skill/code-explainer/reference/examples/py-overview.patch.json",
              "--no-user-patch",
              "--out",
              `dist/bundles/${lang}-architecture.html`,
              "--dev-json",
              `dist/bundles/${lang}-architecture.bundle.json`,
            ]
          : rustPatch
            ? ["--patch", rustPatch, "--no-user-patch"]
            : [
                "--patch",
                `scripts/${lang}-example.patch.json`,
                "--user-patch",
                `scripts/${lang}-example.user.patch.json`,
              ]),
        // The change explainer (diff view): the same fixture with a made-up change (scripts/ts-change.json).
        ...(change
          ? [
              "--change",
              `scripts/${lang}-change.json`,
              "--out",
              `dist/bundles/${lang}-change.html`,
              "--dev-json",
              `dist/bundles/${lang}-change.bundle.json`,
            ]
          : []),
      ],
      { cwd: viewerDir },
    );
    let output = "";
    child.stdout.on("data", (chunk: Buffer) => (output += chunk));
    child.stderr.on("data", (chunk: Buffer) => (output += chunk));
    child.on("error", (error) => {
      if (patchDir) rmSync(patchDir, { recursive: true, force: true });
      reject(error);
    });
    child.on("close", (status) => {
      if (patchDir) rmSync(patchDir, { recursive: true, force: true });
      if (status === 0) resolve();
      else reject(new Error(`make-bundle for ${lang} failed (${status}):\n${output}`));
    });
  });
}

export default async function globalSetup(): Promise<void> {
  if (!existsSync(new URL("../dist/index.html", import.meta.url))) {
    throw new Error("dist/index.html is missing: run `npm run build -w @xpl/viewer` first");
  }
  const results = await Promise.allSettled([
    ...LANGUAGES.map((lang) => makeBundle(lang)),
    makeBundle("ts", true),
    makeBundle("py", false, true),
  ]);
  const failures = results.flatMap((result) =>
    result.status === "rejected" ? [String(result.reason)] : [],
  );
  if (failures.length > 0) throw new Error(failures.join("\n"));
}
