import { describe, expect, it } from "vitest";
import {
  indexedFixture,
  invoke,
  makeTempDir,
  STUB_VIEWER_HTML,
  writeFile,
  xpl,
} from "./helpers.js";

const READS = [
  ["validate"],
  ["lint"],
  ["ready"],
  ["status"],
  ["bundle", "-o", "guide.html", "--draft"],
  ["anchors"],
  ["draft", "repo"],
  ["resolve"],
];

describe("commands with no explainer argument", () => {
  it("uses the only explainer and reports which one was selected", async () => {
    const dir = await indexedFixture();
    expect((await xpl(dir, "new", "demo")).code).toBe(0);
    const viewer = writeFile(makeTempDir(), "viewer.html", STUB_VIEWER_HTML);
    for (const argv of READS) {
      const run = (args: string[]) => invoke(args, { cwd: dir, env: { XPL_VIEWER_HTML: viewer } });
      const result = await run([...argv, "--json"]);
      // the name goes after the command (and after the kind of a draft)
      const at = argv[0] === "draft" ? 2 : 1;
      const explicit = await run([...argv.slice(0, at), "demo", ...argv.slice(at), "--json"]);
      expect(result.err, argv[0]).toContain("using demo");
      expect(result.code, argv[0]).toBe(explicit.code);
      expect(JSON.parse(result.out), argv[0]).toEqual(JSON.parse(explicit.out));
    }
  });

  it("lists choices when several explainers exist", async () => {
    const dir = await indexedFixture();
    expect((await xpl(dir, "new", "alpha")).code).toBe(0);
    expect((await xpl(dir, "new", "beta")).code).toBe(0);
    for (const argv of READS) {
      const result = await xpl(dir, ...argv);
      expect(result.code, argv[0]).toBe(2);
      expect(result.err, argv[0]).toContain("alpha, beta");
      expect(result.err, argv[0]).toContain("xpl");
    }
  });

  it("points to creation when there is no explainer", async () => {
    const dir = await indexedFixture();
    for (const argv of READS) {
      const result = await xpl(dir, ...argv);
      expect(result.code, argv[0]).toBe(2);
      expect(result.err, argv[0]).toContain("xpl new");
    }
  });

  it("keeps the commands that create or patch a guide explicit", async () => {
    const dir = await indexedFixture();
    expect((await xpl(dir, "new", "demo")).code).toBe(0);
    for (const argv of [["apply"], ["new"]]) {
      const result = await xpl(dir, ...argv);
      expect(result.code, argv[0]).toBe(2);
      expect(result.err, argv[0]).toContain("missing <");
    }
  });
});
