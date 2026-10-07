import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { test } from "node:test";
import pkg from "../packages/cli/package.json" with { type: "json" };

const script = new URL("./check-release.mjs", import.meta.url);
const tools = mkdtempSync(join(tmpdir(), "xpl-release-check-"));
writeFileSync(
  join(tools, "npm"),
  '#!/bin/sh\ncase "$RELEASE_NPM_RESULT" in\n  duplicate) echo "present"; exit 0;;\n  missing) echo "npm error code E404" >&2; exit 1;;\n  offline) echo "network unavailable" >&2; exit 1;;\nesac\n',
);
chmodSync(join(tools, "npm"), 0o755);

function check(tag, registryResult) {
  return spawnSync(process.execPath, [script.pathname, tag], {
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: `${tools}${delimiter}${process.env.PATH}`,
      RELEASE_NPM_RESULT: registryResult,
    },
  });
}

test("a mismatched tag fails before querying npm", () => {
  const result = check("v999.999.999", "offline");
  assert.equal(result.status, 1);
  assert.match(result.stderr, new RegExp(`v999\\.999\\.999.*${pkg.version}`));
  assert.doesNotMatch(result.stderr, /network unavailable/);
});

test("an existing version cannot be published again", () => {
  const result = check(`v${pkg.version}`, "duplicate");
  assert.equal(result.status, 1);
  assert.match(result.stderr, /already exists/);
});

test("only an npm 404 allows a new version", () => {
  const missing = check(`v${pkg.version}`, "missing");
  assert.equal(missing.status, 0, missing.stderr);
  const offline = check(`v${pkg.version}`, "offline");
  assert.equal(offline.status, 1);
  assert.match(offline.stderr, /network unavailable/);
});

process.on("exit", () => rmSync(tools, { recursive: true, force: true }));
