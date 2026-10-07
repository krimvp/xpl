import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Ajv } from "ajv";
import { expect, it } from "vitest";

const root = join(import.meta.dirname, "../../..");
const skill = join(root, "skill/code-explainer");
const schema = JSON.parse(readFileSync(join(skill, "reference/patch.schema.json"), "utf8"));
const validate = new Ajv({ allErrors: true }).compile(schema);

it("accepts the published authoring patches and distinct view shapes", () => {
  for (const path of [
    "reference/examples/go-retry.patch.json",
    "reference/examples/py-overview.patch.json",
    "../../packages/viewer/scripts/ts-example.patch.json",
    "../../packages/viewer/scripts/ts-example.user.patch.json",
    "../../packages/viewer/scripts/py-example.patch.json",
    "../../packages/viewer/scripts/py-example.user.patch.json",
    "../../packages/viewer/scripts/go-example.patch.json",
    "../../packages/viewer/scripts/go-example.user.patch.json",
  ]) {
    const patch = JSON.parse(readFileSync(join(skill, path), "utf8"));
    expect(validate(patch), `${path}: ${JSON.stringify(validate.errors)}`).toBe(true);
  }
  const change = JSON.parse(
    readFileSync(join(skill, "../../packages/viewer/scripts/ts-change.json"), "utf8"),
  );
  expect(validate(change.patch), JSON.stringify(validate.errors)).toBe(true);
  const reference = readFileSync(join(skill, "reference/patch-format.md"), "utf8");
  for (const [, text] of reference.matchAll(/```json patch\n([\s\S]*?)\n```/g)) {
    const patch = JSON.parse(text!);
    expect(validate(patch), JSON.stringify(validate.errors)).toBe(true);
  }
  expect(validate({ views: [{ id: "view:g", type: "graph", includeAdd: ["repo"] }] })).toBe(true);
  expect(
    validate({
      views: [{ id: "view:f", type: "flow", stepsUpdate: [{ id: "f:1", label: "Go" }] }],
    }),
  ).toBe(true);
  expect(
    validate({
      review: {
        reviewer: "Alex",
        reviewedAt: "2026-10-04T12:00:00Z",
        scope: { content: "all", source: "anchored" },
        omissions: [],
        fingerprint: {
          version: "xpl-review@1",
          contentHash: "sha256-v2:012345abcdef",
          evidenceHash: "sha256-v2:fedcba543210",
        },
      },
    }),
  ).toBe(true);
  expect(
    validate({
      nodes: [
        {
          id: "grp:old",
          anchors: [{ file: "old.ts", at: "base", find: "run()", role: "usage" }],
          summary: null,
        },
      ],
      tours: [{ id: "tour:a", stepsUpdate: [{ id: "1", code: null, note: null }] }],
      review: null,
    }),
  ).toBe(true);
});

it("rejects malformed patch fields before apply checks source evidence", () => {
  for (const patch of [
    { change: { base: "a", head: "b" } },
    { nodes: [{ id: "grp:a", unknown: true }] },
    { nodes: [{ id: "grp:a", anchors: [{ file: "a.ts", role: "invented" }] }] },
    {
      nodes: [
        { id: "grp:a", anchors: [{ file: "a.ts", role: "usage", at: "base", symbol: "run" }] },
      ],
    },
    { views: [{ id: "view:g", type: "wrong" }] },
    { views: [{ id: "view:g", type: "graph", steps: [] }] },
    { views: [{ id: "view:f", type: "flow", stepsUpdate: [{ id: "f:1", label: null }] }] },
    { tours: [{ id: "tour:a", stepsUpdate: [{ id: "1", view: null }] }] },
    { review: { reviewer: "A" } },
  ]) {
    expect(validate(patch), JSON.stringify(patch)).toBe(false);
  }
});
