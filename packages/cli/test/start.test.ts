import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  bundleOf,
  copyFixture,
  invoke,
  makeTempDir,
  readJson,
  writeFile,
  writeViewerStub,
  xpl,
  xplJson,
} from "./helpers.js";

describe("xpl start", () => {
  it.each([
    {
      fixture: "rb-jobrunner",
      constant: "lib/constants.rb",
      source: "module Jobrunner\n  EMPTY = 1\nend\n",
      parts: [
        "file:lib/jobrunner/queue.rb",
        "file:lib/jobrunner/runner.rb",
        "file:lib/jobrunner.rb",
      ],
    },
    {
      fixture: "php-jobrunner",
      constant: "src/Jobrunner/Constants.php",
      source: "<?php\nnamespace Jobrunner;\nconst EMPTY = 1;\n",
      parts: [
        "file:src/Jobrunner/Job.php",
        "file:src/Jobrunner/Queue.php",
        "file:src/Jobrunner/Runner.php",
      ],
    },
  ])(
    "drafts $fixture from nested declarations without adding relationships",
    async ({ fixture, constant, source, parts }) => {
      const dir = copyFixture(fixture);
      writeFile(dir, constant, source);
      const started = await xpl(
        dir,
        "start",
        "audit",
        "--question",
        "How does a job move through this repository?",
        "--audience",
        "A new maintainer",
        "--precise",
        "off",
      );
      expect(started.code, started.err).toBe(0);
      const guide = readJson(dir, ".explainer/audit.explainer.json");
      expect(guide.views.map((view: { id: string }) => view.id)).toEqual([
        "view:system",
        "view:overview",
      ]);
      expect(guide.views[1].include).toEqual(parts);
      expect(guide.edges).toEqual([]);
      expect((await xpl(dir, "validate", "audit")).code).toBe(0);

      const out = join(makeTempDir("xpl-namespaced-draft-"), "draft.html");
      const env = { XPL_VIEWER_HTML: writeViewerStub() };
      const ready = await invoke(["bundle", "audit", "-o", out], { cwd: dir, env });
      expect(ready.code).toBe(1);
      expect(ready.err).toContain("todo-left");
      expect(existsSync(out)).toBe(false);
      const preview = await invoke(["bundle", "audit", "-o", out, "--draft"], { cwd: dir, env });
      expect(preview.code, preview.err).toBe(0);
      expect(bundleOf(readFileSync(out, "utf8")).exportInfo).toMatchObject({ status: "draft" });
    },
  );

  it("creates an index-backed first guide and an editable draft for its reader and question", async () => {
    const dir = copyFixture();
    const result = await xpl(
      dir,
      "start",
      "job-retries",
      "--question",
      "How does a failed job get retried?",
      "--audience",
      "Maintainers",
      "--precise",
      "off",
    );
    expect(result.code, result.err).toBe(0);
    // the draft is applied already: the next line says to apply an edited patch again, and what the viewer
    // cannot edit (the titles and the tour summary hold TODOs too)
    expect(result.out).toMatch(
      /^next: write the TODOs in (\S+) and run `xpl apply job-retries \1`, then `xpl lint job-retries`\. `xpl view job-retries` also edits the step notes \(Edit > Edit the tour\) and box texts \(Edit text\), not the titles or the tour summary$/m,
    );
    expect(result.out).toContain("note: the draft guesses the kind of project");
    expect(result.out).toContain("draft notes:");
    expect(result.out).toContain("xpl view job-retries");
    const draftPath = /draft patch: (.+)/.exec(result.out)?.[1];
    expect(draftPath).toBeDefined();
    expect(existsSync(draftPath!)).toBe(true);
    expect(draftPath!.startsWith(dir)).toBe(false);

    const guide = readJson(dir, ".explainer/job-retries.explainer.json");
    const patch = JSON.parse(readFileSync(draftPath!, "utf8"));
    expect(guide.index.path).toMatch(/^\.explainer\/index-/);
    expect(existsSync(join(dir, guide.index.path))).toBe(true);
    expect(guide.scope.audience).toBe("Maintainers");
    expect(guide.views[0].scope.question).toBe("How does a failed job get retried?");
    expect(patch.scope.audience).toBe("Maintainers");
    expect((await xpl(dir, "validate", "job-retries")).code).toBe(0);
    // without --entry it drafted an overview, says so, and names where the path could start
    expect(result.out).toContain("note: drafted an overview of the whole repository");
    expect(result.out).toContain(
      "run `xpl draft path job-retries sym:src/runner.ts#Runner.dispatch -o <file>`",
    );
    // the command is named once; the draft's note keeps only the room it leaves for the path
    expect(
      [...result.out.matchAll(/xpl draft path job-retries ([^\s`]+)/g)].map((m) => m[1]),
    ).toEqual(["sym:src/runner.ts#Runner.dispatch"]);
    expect(result.out).toContain(
      "note: room is left for 2 more steps (9 at most), the main path and its risks\n",
    );
  });

  it("names no entry from common words or the project's name: it names where the bin starts, or says none was found", async () => {
    const write = (bin: boolean) => {
      const dir = makeTempDir("xpl-start-words-");
      writeFile(
        dir,
        "package.json",
        `{ "name": "kv"${bin ? ', "bin": { "kv": "dist/kv.js" }' : ""} }\n`,
      );
      writeFile(dir, "src/main.ts", 'import { run } from "./cli.js";\n\nrun(process.argv);\n');
      writeFile(
        dir,
        "src/cli.ts",
        'import { put } from "./store.js";\n\nexport function run(argv: string[]): number {\n  put(argv[0]!, argv[1]!);\n  return 0;\n}\n',
      );
      writeFile(
        dir,
        "src/store.ts",
        "const kv = new Map<string, string>();\n\nexport function put(key: string, value: string): void {\n  kv.set(key, value);\n}\n\nexport function get(key: string): string | undefined {\n  return kv.get(key);\n}\n",
      );
      return dir;
    };
    const start = (dir: string) =>
      xpl(
        dir,
        "start",
        "guide",
        "--question",
        "How is kv put together?",
        "--audience",
        "A new contributor",
        "--precise",
        "off",
      );
    const declared = await start(write(true));
    expect(declared.code, declared.err).toBe(0);
    expect(declared.out).toContain(
      "note: drafted an overview of the whole repository, not the path that answers the question (no --entry). To draft that path, run `xpl draft path guide sym:src/cli.ts#run -o <file>` (where the `bin` of `package.json` starts; no word of the question names a function), or pass --entry next time.\n",
    );
    const none = await start(write(false));
    expect(none.code, none.err).toBe(0);
    expect(none.out).toContain(
      "note: drafted an overview of the whole repository, not the path that answers the question (no --entry). No word of the question names a function, and no manifest names where the main path starts, so no entry is guessed: find the function the path starts at with `xpl search <word>`, then run `xpl draft path guide <entry> -o <file>`.\n",
    );
  });

  it("starts a path draft at a named source symbol", async () => {
    const dir = copyFixture();
    const result = await xpl(
      dir,
      "start",
      "dispatch",
      "--question",
      "What happens after dispatch?",
      "--audience",
      "New maintainers",
      "--entry",
      "src/runner.ts#Runner.dispatch",
      "--precise",
      "off",
    );
    expect(result.code, result.err).toBe(0);
    const guide = readJson(dir, ".explainer/dispatch.explainer.json");
    expect(guide.views[0].type).toBe("sequence");
    expect(guide.views[0].scope.question).toBe("What happens after dispatch?");
    expect((await xpl(dir, "validate", "dispatch")).code).toBe(0);
  });

  it("requires a question and reader before creating files", async () => {
    const dir = copyFixture();
    const result = await xpl(dir, "start", "first");
    expect(result.code).toBe(2);
    expect(result.err).toContain("--question <question>");
    expect(existsSync(join(dir, ".explainer"))).toBe(false);

    const json = await xplJson(
      dir,
      "start",
      "first",
      "--question",
      "What runs?",
      "--audience",
      "Maintainers",
      "--precise",
      "off",
    );
    expect(json.code).toBe(0);
    expect(json.json).toMatchObject({
      ok: true,
      name: "first",
      path: ".explainer/first.explainer.json",
    });
    expect(existsSync(json.json.draft)).toBe(true);
    expect(json.json.notes).toContain(
      "the draft guesses the kind of project, its users and its entry points from the code and its import lines: check each in the README and the code",
    );
    expect(existsSync(json.json.notesFile)).toBe(true);
  });

  it("leaves no guide after an unknown entry so the author can retry", async () => {
    const dir = copyFixture();
    const result = await xpl(
      dir,
      "start",
      "retry",
      "--question",
      "What runs?",
      "--audience",
      "Maintainers",
      "--entry",
      "src/runner.ts#NotThere",
      "--precise",
      "off",
    );
    expect(result.code).toBe(1);
    expect(result.err).toContain("NotThere");
    expect(existsSync(join(dir, ".explainer/retry.explainer.json"))).toBe(false);
  });
});
