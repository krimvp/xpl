import { spawnSync } from "node:child_process";
import pkg from "../packages/cli/package.json" with { type: "json" };

const tag = process.argv[2];
if (tag !== `v${pkg.version}` || !/^v\d+\.\d+\.\d+$/.test(tag)) {
  console.error(`Release tag ${tag ?? "(missing)"} does not match package version ${pkg.version}.`);
  process.exit(1);
}

const result = spawnSync(
  "npm",
  [
    "view",
    `${pkg.publishName}@${pkg.version}`,
    "version",
    "--registry=https://registry.npmjs.org/",
  ],
  { encoding: "utf8" },
);
if (result.status === 0) {
  console.error(`${pkg.publishName}@${pkg.version} already exists on npm.`);
  process.exit(1);
}
if (!/\bE404\b/.test(result.stderr ?? "")) {
  console.error(
    `Could not check npm for ${pkg.publishName}@${pkg.version}: ${result.stderr || result.error}`,
  );
  process.exit(1);
}
console.log(`${pkg.publishName}@${pkg.version} is ready to publish.`);
