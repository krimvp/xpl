import { execFileSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { expect, test } from "@playwright/test";
import { parseBundle } from "@xpl/core";
import { run } from "../../cli/src/cli.js";
import { byId, openEditMenu, stateOf, watchProblems } from "./helpers.js";

// Stage through the real CLI; browser reads file:// only, including deleted base source.
test("old staged links and downloaded navigation restore the exact version after promotion", async ({
  page,
}) => {
  const problems = watchProblems(page);
  const scratch = mkdtempSync(join(tmpdir(), "xpl-version-links-"));
  const root = join(scratch, "source");
  const destination = join(scratch, "versions");
  mkdirSync(root);
  const git = (...args: string[]) =>
    execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
  const command = async (args: string[], patch?: unknown) => {
    const output: string[] = [];
    const errors: string[] = [];
    const code = await run(args, {
      cwd: root,
      env: { ...process.env, XPL_VIEWER_HTML: resolve("dist/index.html") },
      out: (text) => output.push(text),
      err: (text) => errors.push(text),
      ...(patch ? { readStdin: async () => JSON.stringify(patch) } : {}),
    });
    expect(code, errors.join("\n") + output.join("\n")).toBe(0);
    return output.join("\n");
  };
  const patch = (title: string) => ({
    title,
    nodes: [
      {
        id: "file:app.ts",
        summary: "The application returns its recorded result.",
        anchors: [{ file: "app.ts", symbol: "app", role: "definition" }],
      },
    ],
    views: [
      {
        id: "view:app",
        type: "graph",
        title: "Application",
        include: ["file:app.ts"],
        stubs: { mode: "none" },
        layout: { "file:app.ts": { x: title === "First version" ? 120 : 320, y: 80 } },
      },
    ],
    tours: [
      {
        id: "tour:app",
        title: "Application walkthrough",
        summary: "Read the application result in the recorded source.",
        steps: [
          {
            id: "read-app",
            note: "The function returns the recorded value.",
            focus: ["file:app.ts"],
            view: "view:app",
          },
        ],
      },
    ],
  });
  try {
    git("init", "-q");
    git("config", "user.email", "test@example.com");
    git("config", "user.name", "Version test");
    writeFileSync(join(root, "app.ts"), "export function app() {\n  return 1;\n}\n");
    writeFileSync(join(root, "old.ts"), "export const removed = 9;\n");
    git("add", ".");
    git("commit", "-qm", "Base source");
    const base = git("rev-parse", "HEAD");
    writeFileSync(join(root, "app.ts"), "export function app() {\n  return 2;\n}\n");
    rmSync(join(root, "old.ts"));
    git("add", ".");
    git("commit", "-qm", "First head");
    const head = git("rev-parse", "HEAD");
    await command(["index", "--precise", "off"]);
    await command(["new", "demo", "--title", "First version"]);
    await command(["change", "demo", `${base}..${head}`]);
    await command(["apply", "demo", "-"], patch("First version"));
    const first = JSON.parse(await command(["stage", "demo", "--dir", destination, "--json"]));
    const firstHtml = readFileSync(join(first.directory, "index.html"));
    const current = pathToFileURL(join(destination, "current/index.html")).href;
    await page.goto(current + "?perspective=guide&tour=tour:app&step-id=read-app");
    await expect.poll(() => stateOf(page).then((s) => s.stepId)).toBe("read-app");
    expect(new URL(page.url()).pathname).toContain(`/${first.version}/index.html`);
    expect(new URL(page.url()).searchParams.get("version")).toBe(first.version);
    const stepLink = page.url();

    writeFileSync(join(root, "app.ts"), "export function app() {\n  return 3;\n}\n");
    git("add", "app.ts");
    git("commit", "-qm", "Second head");
    await command(["index", "--precise", "off"]);
    await command(["resolve", "demo", "--write"]);
    await command(["change", "demo", `${base}..${git("rev-parse", "HEAD")}`]);
    await command(["apply", "demo", "-"], patch("Second version"));
    const second = JSON.parse(await command(["stage", "demo", "--dir", destination, "--json"]));
    expect(second.version).not.toBe(first.version);
    expect(readFileSync(join(first.directory, "index.html"))).toEqual(firstHtml);
    await page.goto(current);
    await expect(page.locator(".header .title")).toHaveText("Second version");
    await page.getByTestId("explanation-info").locator("summary").first().click();
    const versions = page.getByRole("region", { name: "Staged versions" });
    const history = versions
      .locator("details")
      .filter({ has: page.getByText("Earlier versions (1)", { exact: true }) });
    await expect(history).not.toHaveAttribute("open", "");
    await history.locator("summary").first().click();
    await expect(history).toContainText("author review: unchecked");
    await expect(history.getByRole("link", { name: /^Open version staged/ })).toHaveAttribute(
      "href",
      pathToFileURL(join(first.directory, "index.html")).href + `?version=${first.version}`,
    );

    await page.goto(
      pathToFileURL(join(second.directory, "index.html")).href +
        `?version=${second.version}&perspective=explore&view=view:app&focus=file:app.ts`,
    );
    await expect(byId(page, "file:app.ts")).toHaveAttribute("transform", "translate(320 80)");

    await page.goto(stepLink);
    await expect(page.locator(".header .title")).toHaveText("First version");
    await expect.poll(() => stateOf(page).then((s) => s.stepId)).toBe("read-app");
    await page.getByTestId("explanation-info").locator("summary").first().click();
    const latest = page.getByRole("link", { name: "Open latest version" });
    await expect(latest).toHaveAttribute("href", current);
    await latest.click();
    await expect(page.locator(".header .title")).toHaveText("Second version");
    const immutable =
      pathToFileURL(join(first.directory, "index.html")).href + `?version=${first.version}`;
    await page.goto(immutable + "&perspective=explore&view=view:app&focus=file:app.ts");
    await expect.poll(() => stateOf(page).then((s) => s.selection)).toEqual(["file:app.ts"]);
    await expect(byId(page, "file:app.ts")).toHaveAttribute("transform", "translate(120 80)");
    await page.reload();
    await expect.poll(() => stateOf(page).then((s) => s.selection)).toEqual(["file:app.ts"]);
    await expect(byId(page, "file:app.ts")).toHaveAttribute("transform", "translate(120 80)");

    for (const [file, range, side, selected] of [
      ["app.ts", "2:3-2:11", "head", "return 2;"],
      ["old.ts", "1:1-1:6", "base", "export"],
    ]) {
      await page.goto(immutable + `&file=${file}&range=${range}&side=${side}`);
      const pane = page.locator(`[data-file="${file}"][data-side="${side}"]`);
      await expect(pane).toBeVisible();
      await pane.locator(".cm-content").focus();
      await expect
        .poll(() => page.evaluate(() => window.getSelection()?.toString()))
        .toBe(selected);
    }
    // One browser save/reopen proof combines a tour step, diagram focus and source cursor.
    await page.goto(immutable + "&mode=present&tour=tour:app&step-id=read-app");
    await expect(page.getByTestId("present")).toBeVisible();
    await page.evaluate(() => window.__xpl!.setCursor("app.ts", 2));
    await (await openEditMenu(page)).getByTestId("edit-save-html").click();
    await expect(page.getByTestId("readiness-summary")).toContainText("Ready: 0 errors");
    const [download] = await Promise.all([
      page.waitForEvent("download"),
      page.getByTestId("save-html-ready").click(),
    ]);
    const savedPath = join(scratch, "present.html");
    await download.saveAs(savedPath);
    const saved = parseBundle(
      /<script id="xpl-data"[^>]*>([\s\S]*?)<\/script>/.exec(readFileSync(savedPath, "utf8"))![1]!,
    );
    expect(saved.server).toBeUndefined();
    expect(saved.publication?.current.identity).toEqual(first.manifest.identity);
    await page.goto(pathToFileURL(savedPath).href);
    await expect(page.getByTestId("present")).toBeVisible();
    await expect
      .poll(() => stateOf(page))
      .toMatchObject({
        mode: "present",
        stepId: "read-app",
        selection: ["file:app.ts"],
        cursor: { file: "app.ts", fromLine: 2, toLine: 2 },
      });
    await expect(page.locator(".header .title")).toHaveText("First version");
    await expect(byId(page, "file:app.ts")).toHaveAttribute("transform", "translate(120 80)");
    await page.goto(
      pathToFileURL(join(second.directory, "index.html")).href + `?version=${first.version}`,
    );
    await expect(page.getByTestId("no-data")).toContainText("does not contain version");
    expect(problems).toEqual([]);
  } finally {
    for (const entry of existsSync(destination) ? readdirSync(destination) : [])
      if (entry.startsWith("version-")) chmodSync(join(destination, entry), 0o700);
    rmSync(scratch, { recursive: true, force: true });
  }
});
