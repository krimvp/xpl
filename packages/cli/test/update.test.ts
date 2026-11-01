/**
 * `xpl update <guide> [--since <rev>]`: one command after work on the code. It builds the index of the code as it
 * is, moves the guide to it, records the change since `<rev>`, and drafts the map again (only what is new or gone,
 * plus a tour of the change). It applies nothing: the new boxes still need their text.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { Explainer, ExplainerPatch } from "@xpl/core";
import { git, makeTempDir, readJson, writeFile, xpl } from "./helpers.js";

function shop(): string {
  const dir = makeTempDir("xpl-update-");
  writeFile(dir, "package.json", '{ "name": "shop" }\n');
  writeFile(
    dir,
    "src/main.ts",
    'import { placeOrder } from "./orders/place";\n\nexport function main(): number {\n  return placeOrder();\n}\n',
  );
  writeFile(dir, "src/orders/place.ts", "export function placeOrder(): number {\n  return 1;\n}\n");
  writeFile(dir, "src/orders/cancel.ts", "export function cancelOrder(): void {}\n");
  git(dir, "init", "-q", "-b", "main");
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", "base");
  return dir;
}

describe("xpl update", () => {
  it("indexes, moves the guide, records the change and drafts the map again, in one run", async () => {
    const dir = shop();
    expect((await xpl(dir, "index", "--precise", "off")).code).toBe(0);
    expect((await xpl(dir, "new", "shop")).code).toBe(0);
    const first = join(makeTempDir("xpl-update-out-"), "first.json");
    expect((await xpl(dir, "draft", "map", "shop", "-o", first)).code).toBe(0);
    expect((await xpl(dir, "apply", "shop", first)).code).toBe(0);

    writeFile(dir, "src/orders/refund.ts", "export function refund(): void {}\n");
    git(dir, "add", "-A");
    git(dir, "commit", "-q", "-m", "refunds");
    const head = git(dir, "rev-parse", "HEAD");

    const out = join(makeTempDir("xpl-update-out-"), "update.json");
    const r = await xpl(dir, "update", "shop", "--since", "HEAD~1", "--precise", "off", "-o", out);
    expect(r.code, r.err + r.out).toBe(0);
    expect(r.out).toContain(`change: ${head.slice(0, 7)}`);
    expect(r.out).toContain(`draft: ${out}`);

    const guide = readJson<Explainer>(dir, ".explainer/shop.explainer.json");
    expect(guide.change?.head).toBe(head);
    expect(guide.index.commit).toBe(head.slice(0, guide.index.commit.length));
    const patch = JSON.parse(readFileSync(out, "utf8")) as ExplainerPatch;
    expect(patch.nodes?.map((n) => n.id)).toEqual(["file:src/orders/refund.ts"]);
    expect(patch.tours?.map((t) => t.id)).toEqual([`tour:changes-${head.slice(0, 7)}`]);
    expect((await xpl(dir, "apply", "shop", out)).code).toBe(0);
  });

  it("without --since drafts the map again and records no change", async () => {
    const dir = shop();
    expect((await xpl(dir, "index", "--precise", "off")).code).toBe(0);
    expect((await xpl(dir, "new", "shop")).code).toBe(0);
    const out = join(makeTempDir("xpl-update-out-"), "update.json");
    const r = await xpl(dir, "update", "shop", "--precise", "off", "-o", out);
    expect(r.code, r.err + r.out).toBe(0);
    expect(r.out).toContain("change: none recorded (pass --since <rev> to record one)");
    const guide = readJson<Explainer>(dir, ".explainer/shop.explainer.json");
    expect(guide.change).toBeUndefined();
    const patch = JSON.parse(readFileSync(out, "utf8")) as ExplainerPatch;
    expect(patch.views?.map((v) => v.id)).toEqual(["view:map", "view:map-src-orders"]);
  });
});
