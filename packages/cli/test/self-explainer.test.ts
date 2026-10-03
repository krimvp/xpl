/**
 * xpl's own explainer (`.explainer/xpl.explainer.json`) must keep up with the code: a change that moves code
 * under one of its anchors has to re-explain it in the same commit (skill: "After the code changed"), or
 * `xpl bundle xpl` refuses and the page points at the wrong code.
 *
 * The index is built in memory with `precise: "off"`: anchors hash the text of symbols and lines, which does
 * not depend on how references are resolved, so the heuristic index (a few seconds for this repository; the
 * SCIP pass of `xpl index` takes most of its ~40 s) classifies them exactly as `xpl status` does. Nothing is
 * written to `.explainer/`.
 */
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { reresolveExplainer, validateExplainer, type Explainer } from "@xpl/core";
import { buildIndex } from "@xpl/indexer";
import { WorkingTree } from "../src/repo.js";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const EXPLAINER = join(ROOT, ".explainer", "xpl.explainer.json");
const FIX = "run `xpl index`, `xpl resolve xpl --write` and re-explain what `xpl status xpl` lists";

describe("xpl's own explainer", () => {
  it("has no drifted or missing anchors against the working tree, and validates strictly", async () => {
    const explainer = JSON.parse(readFileSync(EXPLAINER, "utf8")) as Explainer;
    const { index } = await buildIndex({ root: ROOT, precise: "off" });
    const texts = new WorkingTree(ROOT).texts;

    const { report } = reresolveExplainer(explainer, index, texts);
    const stale = [
      ...report.drifted.map((d) => `drifted: ${d.elementId}`),
      ...report.driftedOther.map((d) => `drifted (${d.origin ?? "no origin"}): ${d.elementId}`),
      ...report.missing.map((m) => `missing: ${m.elementId} ${m.path}`),
    ];
    expect(stale, `.explainer/xpl.explainer.json does not match the code; ${FIX}`).toEqual([]);

    const errors = validateExplainer(explainer, index, texts, { mode: "strict" })
      .filter((issue) => issue.severity === "error")
      .map((issue) => `${issue.path}: ${issue.message}`);
    expect(errors, `xpl validate xpl fails; ${FIX}`).toEqual([]);
  }, 120_000);
});
