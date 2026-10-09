// Manual CI publisher. Configuration and the author executable come from the trusted workflow, never the PR.
import { execFileSync } from "node:child_process";
import { accessSync, constants, mkdtempSync, rmSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { tmpdir } from "node:os";

function required(name) {
  const value = process.env[name];
  if (!value?.trim()) throw new Error(`Configure ${name} before publishing a preview`);
  return value;
}

function absolute(name) {
  const value = required(name);
  if (!isAbsolute(value)) throw new Error(`${name} must be an absolute path`);
  return value;
}

try {
  const pr = required("XPL_PR");
  const match = /^([\w.-]+)\/([\w.-]+)#([1-9]\d*)$/.exec(pr);
  if (!match) throw new Error("XPL_PR must be owner/repo#number");
  const cli = absolute("XPL_CLI");
  const skill = absolute("XPL_SKILL_DIR");
  const author = absolute("XPL_AUTHOR");
  accessSync(author, constants.X_OK);
  const cache = absolute("XPL_CACHE_DIR");
  const destination = join(absolute("XPL_PREVIEW_DIR"), `pr-${match[3]}`);
  const base = new URL(required("XPL_PREVIEW_URL"));
  if (
    !["https:", "http:"].includes(base.protocol) ||
    base.username ||
    base.password ||
    base.search ||
    base.hash
  )
    throw new Error(
      "XPL_PREVIEW_URL must be an HTTP(S) URL without credentials, query or fragment",
    );
  const url = `${base.href.replace(/\/$/, "")}/pr-${match[3]}`;
  const readToken = required("XPL_READ_TOKEN");
  const publishToken = required("XPL_PUBLISH_TOKEN");
  const authorToken = required("XPL_AUTHOR_TOKEN");
  // An allowlist keeps unrelated CI secrets and publisher credentials out of the author process.
  // This is environment hygiene, not a sandbox: use a trusted author on a dedicated ephemeral runner.
  const common = Object.fromEntries(
    ["PATH", "HOME", "TMPDIR", "SYSTEMROOT", "XPL_VIEWER_HTML"]
      .filter((key) => process.env[key] !== undefined)
      .map((key) => [key, process.env[key]]),
  );
  const sourceEnv = { ...common, GH_TOKEN: readToken, GIT_TERMINAL_PROMPT: "0" };
  if (process.env.GIT_CONFIG_GLOBAL) sourceEnv.GIT_CONFIG_GLOBAL = process.env.GIT_CONFIG_GLOBAL;
  const publisherEnv = { ...sourceEnv, GH_TOKEN: publishToken };
  const command = (args, env = sourceEnv) =>
    JSON.parse(
      execFileSync(process.execPath, [cli, ...args, "--json"], {
        env,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
        timeout: 600_000,
      }),
    );
  const name = "pr-preview";
  let authorHome;
  let phase = "create";
  try {
    const input = command([
      "pr",
      "create",
      pr,
      "--name",
      name,
      "--audience",
      "reviewers",
      "--question",
      "What changes for callers, and what evidence should reviewers inspect?",
      "--skill-dir",
      skill,
      "--cache-dir",
      cache,
      "--precise",
      "off",
    ]);
    authorHome = mkdtempSync(join(tmpdir(), "xpl-author-home-"));
    phase = "author";
    execFileSync(author, [input.handoffPath], {
      cwd: input.repository,
      env: { ...common, HOME: authorHome, XPL_AUTHOR_TOKEN: authorToken },
      stdio: "ignore",
      timeout: 1_200_000,
    });
    phase = "finish";
    const result = command(["pr", "finish", input.directory, "--cache-dir", cache]);
    if (result.status !== "ready") throw new Error("The PR result is not ready");
    phase = "stage";
    command([
      "stage",
      name,
      "--root",
      input.repository,
      "--pr-result",
      result.manifestPath,
      "--dir",
      destination,
    ]);
    phase = "link";
    const linked = command(
      ["pr", "link", destination, "--url", url, "--visibility", "team"],
      publisherEnv,
    );
    process.stdout.write(`${JSON.stringify(linked)}\n`);
  } catch {
    // Also covers a head move during authoring, before stage/link get a chance to check it.
    try {
      command(["pr", "check-link", pr], publisherEnv);
    } catch {
      /* Preserve the original failure. */
    }
    throw new Error(
      `Preview failed during ${phase}; no successful publication is claimed. Check retained PR input/results and rerun for the current head. The previous comment was checked for staleness where GitHub allowed it.`,
    );
  } finally {
    if (authorHome) rmSync(authorHome, { recursive: true, force: true });
  }
} catch (error) {
  // Child output may contain provider secrets or source. Keep it in neither Actions logs nor artifacts.
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
}
