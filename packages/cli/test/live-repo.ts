/**
 * The repository and the change the `xpl live` tests share (`live.test.ts`, `api-agent.test.ts`), and an
 * explanation of that change as a background agent writes it.
 */
import { rmSync } from "node:fs";
import { join } from "node:path";
import { copyFixture, editFile, git, writeFile } from "./helpers.js";

/** The TS fixture with a folder of two files (`src/store/`), committed on `main`. */
export function liveRepo(): string {
  const dir = copyFixture();
  writeFile(
    dir,
    "src/store/disk.ts",
    'import { load } from "./memory.ts";\n\nexport function save(x: string): string {\n  return load(x);\n}\n',
  );
  writeFile(
    dir,
    "src/store/memory.ts",
    "export function load(x: string): string {\n  return x;\n}\n",
  );
  git(dir, "init", "-q", "-b", "main");
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", "base");
  return dir;
}

/** Edits, adds and deletes a file of the repo: the change the tests record. */
export function work(dir: string): void {
  editFile(dir, "src/store/memory.ts", (text) => text.replace("return x;", "return x.trim();"));
  writeFile(dir, "src/extra.ts", "export function extra(): number {\n  return 1;\n}\n");
  rmSync(join(dir, "src/worker.ts"));
}

/** The explanation of `work` with its design level (the change spans two parts), clean of lint findings. */
export const explanation = (summary: string) => ({
  nodes: [
    { id: "file:src/extra.ts", label: "Extra number", summary: "Returns the extra number." },
    {
      id: "grp:design-extra",
      label: "Extra number",
      summary: "Gives the runner one more number to read.",
      members: ["file:src/extra.ts"],
    },
    {
      id: "grp:design-store",
      label: "Job storage",
      summary: "Keeps the jobs until a worker takes them.",
      members: ["dir:src/store"],
      anchors: [{ file: "src/worker.ts", at: "base", role: "definition" }],
    },
  ],
  views: [
    {
      id: "view:design",
      type: "graph",
      title: "What the change does",
      include: ["grp:design-extra", "grp:design-store"],
    },
  ],
  tours: [
    {
      id: "tour:live",
      title: "Add an extra number",
      summary,
      steps: [
        {
          id: "t1",
          view: "view:overview",
          focus: ["file:src/extra.ts"],
          note: "### A new part\n\nThe new file returns the extra number for the runner.",
        },
        {
          id: "design",
          view: "view:design",
          focus: ["grp:design-extra", "grp:design-store"],
          note: "### Storage loses its worker\n\nBefore: a worker took the jobs. Now: nothing takes them.\n\nRisk: jobs wait for ever.",
        },
        {
          id: "design-extra",
          view: "view:design",
          focus: ["grp:design-extra"],
          note: "### One more number\n\nBefore: none. Now: a function returns one.",
        },
        {
          id: "design-store",
          view: "view:design",
          focus: ["grp:design-store"],
          note: "### The worker is gone\n\nBefore: a worker loop. Now: the store trims each job.",
        },
      ],
    },
  ],
});
