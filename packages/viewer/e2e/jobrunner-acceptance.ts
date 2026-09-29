/**
 * The acceptance checks of docs/ARCHITECTURE.md section 8 for one language of the job-runner example
 * (`fixtures/<lang>-jobrunner` + `scripts/<lang>-example*.patch.json`, a port of Appendix B of
 * docs/handoff.md), opened from file://. acceptance.spec.ts runs them for the TS fixture with the
 * line numbers of the handoff written out; acceptance-py.spec.ts and acceptance-go.spec.ts call
 * `defineAcceptance` with their fixture's layout instead, and every line number is derived at test time
 * from the bundle the page embeds: symbol ranges from the index, and statements found by a text marker
 * inside `Runner.dispatch` (a marker must occur on exactly one line, or the test fails saying so).
 * Editing a fixture therefore cannot silently move the expectations away from the code they describe.
 */
import { expect, test, type Page } from "@playwright/test";
import {
  byId,
  focusOf,
  linesWith,
  matchesOf,
  openBundle,
  readEmbeddedBundle,
  stateOf,
  watchProblems,
} from "./helpers.js";

/** One language's copy of the example: where the code is and how to find its lines. */
export interface JobrunnerFixture {
  /** Shown in the test titles. */
  name: string;
  /** The fixture's bundle built by global-setup.ts. */
  bundle: URL;
  /** Repo-relative paths. */
  files: {
    runner: string;
    queue: string;
    worker: string;
    metrics: string;
    /** A file no check is about: it must show up dimmed in the tree. */
    bus: string;
    config: string;
    test: string;
  };
  /** Symbol paths (without the file). */
  symbols: {
    /** `Runner.dispatch`: the sequence's entry point and lifeline. */
    dispatch: string;
    /** The queue methods the steps call. */
    pop: string;
    requeue: string;
    /** `Worker.run`: where `job.completed` is emitted. */
    run: string;
    /** The metrics handler that receives it. */
    handler: string;
  };
  /**
   * Text that pins lines of `Runner.dispatch` (each on exactly one line of it) or of `Worker.run`.
   * `retryStart` is the comment that opens the retry block, `retryEnd` the last statement of it, and
   * `retryClose` how many lines after that the block still runs (Go: the closing brace).
   */
  markers: {
    pop: string;
    run: string;
    requeue: string;
    retryStart: string;
    retryInner: string;
    retryEnd: string;
    retryClose: number;
    /** A line of the loop that belongs to no step and not to the retry block. */
    idle: string;
    /** The emit call in `Worker.run`. */
    emit: string;
  };
}

interface Range {
  startLine: number;
  endLine: number;
}

interface EmbeddedBundle {
  index: { files: { path: string; lines: number }[]; symbols: { id: string; range: Range }[] };
  files: Record<string, string>;
}

/** Numbers of the lines `start..end`, inclusive. */
const lines = (start: number, end: number): number[] =>
  Array.from({ length: end - start + 1 }, (_, i) => start + i);

const range = (r: Range): number[] => lines(r.startLine, r.endLine);

/** What the index and the embedded sources say about the fixture's code. */
class Source {
  constructor(private readonly bundle: EmbeddedBundle) {}

  symbol(file: string, path: string): Range {
    const symbol = this.bundle.index.symbols.find((s) => s.id === `${file}#${path}`);
    if (!symbol) throw new Error(`the index has no symbol ${file}#${path}`);
    return symbol.range;
  }

  /** Line count of a file as the index has it (what a whole-file anchor resolves to). */
  lineCount(file: string): number {
    const found = this.bundle.index.files.find((f) => f.path === file);
    if (!found) throw new Error(`the index has no file ${file}`);
    return found.lines;
  }

  /** The line of `file` within `range` that contains `text`; there must be exactly one. */
  lineOf(file: string, range: Range, text: string): number {
    const source = (this.bundle.files[file] ?? "").split(/\r?\n/);
    const hits = lines(range.startLine, range.endLine).filter((n) =>
      (source[n - 1] ?? "").includes(text),
    );
    if (hits.length !== 1) {
      throw new Error(
        `${file} lines ${range.startLine}-${range.endLine}: expected one line containing ` +
          `${JSON.stringify(text)}, found ${hits.length}`,
      );
    }
    return hits[0]!;
  }
}

const sources = new Map<string, Source>();
function sourceOf(bundle: URL): Source {
  let source = sources.get(bundle.href);
  if (!source) {
    source = new Source(readEmbeddedBundle(bundle).bundle as unknown as EmbeddedBundle);
    sources.set(bundle.href, source);
  }
  return source;
}

/** Everything the checks expect, derived from the fixture's index and sources. */
function expectations(fx: JobrunnerFixture) {
  const source = sourceOf(fx.bundle);
  const { files, symbols, markers } = fx;
  const dispatch = source.symbol(files.runner, symbols.dispatch);
  const inDispatch = (text: string) => source.lineOf(files.runner, dispatch, text);
  const requeue = inDispatch(markers.requeue);
  const retry = {
    startLine: inDispatch(markers.retryStart),
    endLine: inDispatch(markers.retryEnd) + markers.retryClose,
  };
  const retryInner = inDispatch(markers.retryInner);
  // The markers must describe what the checks assume: the requeue call and another line sit in the block.
  const block = `${retry.startLine}-${retry.endLine}`;
  if (!(retry.startLine < requeue && requeue <= retry.endLine)) {
    throw new Error(`the requeue call (${requeue}) is not inside the retry block ${block}`);
  }
  if (!(retry.startLine <= retryInner && retryInner <= retry.endLine) || retryInner === requeue) {
    throw new Error(`line ${retryInner} is not another line of the retry block ${block}`);
  }
  const workerRun = source.symbol(files.worker, symbols.run);
  return {
    dispatchId: `sym:${files.runner}#${symbols.dispatch}`,
    pop: inDispatch(markers.pop),
    popDef: source.symbol(files.queue, symbols.pop),
    run: inDispatch(markers.run),
    runDef: workerRun,
    requeue,
    requeueDef: source.symbol(files.queue, symbols.requeue),
    retry,
    retryInner,
    idle: inDispatch(markers.idle),
    retryKey: source.symbol(files.config, "retry"),
    testLines: source.lineCount(files.test),
    emit: source.lineOf(files.worker, workerRun, markers.emit),
    handlerDef: source.symbol(files.metrics, symbols.handler),
  };
}

const focusRows = (focus: Awaited<ReturnType<typeof focusOf>>) =>
  focus.map(({ file, range: r, role }) => [file, r.startLine, r.endLine, role]);

interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** The boxes overlap or are less than `slack` px apart. */
const touches = (a: Box, b: Box, slack = 3): boolean =>
  a.x - slack <= b.x + b.width &&
  b.x - slack <= a.x + a.width &&
  a.y - slack <= b.y + b.height &&
  b.y - slack <= a.y + a.height;

/** `inner` lies within `outer`. */
const inside = (inner: Box, outer: Box): boolean =>
  inner.x >= outer.x &&
  inner.y >= outer.y &&
  inner.x + inner.width <= outer.x + outer.width &&
  inner.y + inner.height <= outer.y + outer.height;

/** The files that have an editor pane, in stack order. */
const paneFiles = (page: Page) =>
  page.locator("[data-file]").evaluateAll((els) => els.map((el) => el.getAttribute("data-file")));

/** The editor pane of a file. */
const pane = (page: Page, file: string) => page.locator(`[data-file="${file}"]`);

/** `window.__xpl.setCursor`: the caret moves like a click would move it (and opens the file). */
const setCursor = (page: Page, file: string, line: number) =>
  page.evaluate((target) => window.__xpl!.setCursor(target.file, target.line), { file, line });

export function defineAcceptance(fx: JobrunnerFixture): void {
  const { files } = fx;
  const open = (page: Page, view?: string) => openBundle(page, view, fx.bundle);

  test.describe(`${fx.name}: view:dispatch`, () => {
    test("clicking step dispatch:3 shows the runner and the queue: the requeue call and the definition highlighted, the rest dimmed", async ({
      page,
    }) => {
      const at = expectations(fx);
      const problems = watchProblems(page);
      await open(page, "view:dispatch");

      await byId(page, "dispatch:3").click();

      // Panes: the call site's file first, then the callee's.
      await expect(page.locator("[data-file]")).toHaveCount(2);
      expect(await paneFiles(page)).toEqual([files.runner, files.queue]);
      const runner = pane(page, files.runner);
      const queue = pane(page, files.queue);
      await expect(runner.locator(".cm-editor")).toBeVisible();
      await expect(queue.locator(".cm-editor")).toBeVisible();

      // Exactly the requeue call inside Runner.dispatch, and the definition of the queue's requeue.
      await expect.poll(() => linesWith(runner, ".xpl-hl")).toEqual([at.requeue]);
      await expect.poll(() => linesWith(queue, ".xpl-hl")).toEqual(range(at.requeueDef));
      await expect.poll(() => linesWith(runner, ".xpl-hl-call-site")).toEqual([at.requeue]);
      await expect.poll(() => linesWith(queue, ".xpl-hl-definition")).toEqual(range(at.requeueDef));

      // Every other visible line is dimmed, and there are some.
      for (const p of [runner, queue]) {
        await expect(p.locator(".cm-line.xpl-dim").first()).toBeVisible();
        await expect(p.locator(".cm-line:not(.xpl-hl):not(.xpl-dim)")).toHaveCount(0);
        expect(await p.locator(".cm-line.xpl-dim.xpl-hl").count()).toBe(0);
      }

      // The focus is exactly those two ranges.
      const focus = await focusOf(page);
      expect(focusRows(focus)).toEqual([
        [files.runner, at.requeue, at.requeue, "call-site"],
        [files.queue, at.requeueDef.startLine, at.requeueDef.endLine, "definition"],
      ]);
      expect(focus.every((f) => f.elementId === "dispatch:3" && f.status === "ok")).toBe(true);

      // The selection shows on the step; files outside the focus are greyed in the tree.
      await expect(byId(page, "dispatch:3")).toHaveClass(/is-selected/);
      await expect(page.locator(`[data-path="${files.runner}"]`)).not.toHaveClass(/is-dimmed/);
      await expect(page.locator(`[data-path="${files.queue}"]`)).not.toHaveClass(/is-dimmed/);
      await expect(page.locator(`[data-path="${files.worker}"]`)).toHaveClass(/is-dimmed/);
      await expect(page.locator(`[data-path="${files.config}"]`)).toHaveClass(/is-dimmed/);

      expect(problems).toEqual([]);
    });

    test("the caret maps back to the innermost diagram element: dispatch:3 on the requeue call, the concept elsewhere in the retry block", async ({
      page,
    }) => {
      const at = expectations(fx);
      const problems = watchProblems(page);
      await open(page, "view:dispatch");
      await byId(page, "dispatch:3").click();
      const runner = pane(page, files.runner);
      await expect.poll(() => linesWith(runner, ".xpl-hl")).toEqual([at.requeue]);

      // A real click on the requeue call.
      const requeueLine = runner.locator(`.cm-line[data-line="${at.requeue}"]`);
      await expect(requeueLine).toContainText(fx.markers.requeue);
      await requeueLine.click({ position: { x: 96, y: 9 } });
      await expect.poll(() => matchesOf(page)).toEqual(["dispatch:3"]);
      await expect(byId(page, "dispatch:3")).toHaveClass(/is-match/);
      await expect(byId(page, "concept:retry-policy")).not.toHaveClass(/is-match/);
      // ... and it is the only element on the page that is marked as a match.
      await expect(page.locator(".is-match")).toHaveCount(1);
      expect((await stateOf(page)).cursor).toMatchObject({
        file: files.runner,
        fromLine: at.requeue,
      });

      // Elsewhere in the retry block: the concept, not the step (the block is not the call).
      expect(at.retryInner).toBeGreaterThanOrEqual(at.retry.startLine);
      expect(at.retryInner).toBeLessThanOrEqual(at.retry.endLine);
      expect(at.retryInner).not.toBe(at.requeue);
      await setCursor(page, files.runner, at.retryInner);
      await expect.poll(() => matchesOf(page)).toEqual(["concept:retry-policy"]);
      await expect(byId(page, "concept:retry-policy")).toHaveClass(/is-match/);
      await expect(byId(page, "dispatch:3")).not.toHaveClass(/is-match/);
      await expect(page.locator(".is-match")).toHaveCount(1);

      await setCursor(page, files.runner, at.requeue);
      await expect.poll(() => matchesOf(page)).toEqual(["dispatch:3"]);
      await expect(byId(page, "dispatch:3")).toHaveClass(/is-match/);
      await expect(byId(page, "concept:retry-policy")).not.toHaveClass(/is-match/);

      // ... and a real click on the other retry line agrees with the hook.
      await runner
        .locator(`.cm-line[data-line="${at.retryInner}"]`)
        .click({ position: { x: 60, y: 9 } });
      await expect.poll(() => matchesOf(page)).toEqual(["concept:retry-policy"]);

      // The other calls of the sequence and the lifeline itself.
      await setCursor(page, files.runner, at.pop);
      await expect.poll(() => matchesOf(page)).toEqual(["dispatch:1"]);
      // A caret moved by the hook is shown where it is: the editor scrolls to it.
      await expect(runner.locator(`.cm-line[data-line="${at.pop}"]`)).toBeInViewport();
      await setCursor(page, files.runner, at.run);
      await expect.poll(() => matchesOf(page)).toEqual(["dispatch:2"]);
      await setCursor(page, files.runner, at.idle);
      await expect.poll(() => matchesOf(page)).toEqual([at.dispatchId]);
      await expect(byId(page, at.dispatchId)).toHaveClass(/is-match/);

      // The callee's side of a step maps back to it as well: the definitions in the queue and worker.
      await setCursor(page, files.queue, at.requeueDef.startLine + 1);
      await expect.poll(() => matchesOf(page)).toEqual(["dispatch:3"]);
      await setCursor(page, files.queue, at.popDef.startLine + 1);
      await expect.poll(() => matchesOf(page)).toEqual(["dispatch:1"]);
      await setCursor(page, files.worker, at.runDef.startLine + 1);
      await expect.poll(() => matchesOf(page)).toEqual(["dispatch:2"]);

      expect(problems).toEqual([]);
    });

    test("setCursor on a file no pane shows opens it, and matches are found there", async ({
      page,
    }) => {
      const at = expectations(fx);
      await open(page, "view:dispatch");
      // No selection: the config file is not on screen. The line after `retry:` is inside the retry key.
      await setCursor(page, files.config, at.retryKey.startLine + 1);
      await expect(pane(page, files.config).locator(".cm-editor")).toBeVisible();
      await expect.poll(() => matchesOf(page)).toEqual(["concept:retry-policy"]);
      await expect(byId(page, "concept:retry-policy")).toHaveClass(/is-match/);
      // The file was only opened, not focused: nothing dimmed.
      await expect(pane(page, files.config).locator(".cm-line.xpl-dim")).toHaveCount(0);
    });

    test("clicking concept:retry-policy focuses the retry block, the retry key and the test, and marks the related lifelines", async ({
      page,
    }) => {
      const at = expectations(fx);
      const problems = watchProblems(page);
      await open(page, "view:dispatch");

      await byId(page, "concept:retry-policy").click();

      const focus = await focusOf(page);
      expect(focusRows(focus)).toEqual([
        [files.runner, at.retry.startLine, at.retry.endLine, "definition"],
        [files.config, at.retryKey.startLine, at.retryKey.endLine, "config"],
        [files.test, 1, at.testLines, "test"],
      ]);
      expect(await paneFiles(page)).toEqual([files.runner, files.config, files.test]);
      await expect
        .poll(() => linesWith(pane(page, files.runner), ".xpl-hl"))
        .toEqual(range(at.retry));
      await expect
        .poll(() => linesWith(pane(page, files.config), ".xpl-hl-config"))
        .toEqual(range(at.retryKey));
      await expect(pane(page, files.test).locator(".cm-line.xpl-hl-test").first()).toBeVisible();
      // The config file dims everything but the retry key.
      await expect(
        pane(page, files.config).locator(".cm-line:not(.xpl-hl):not(.xpl-dim)"),
      ).toHaveCount(0);

      // Co-highlighting: what the concept relates to.
      await expect(byId(page, "concept:retry-policy")).toHaveClass(/is-selected/);
      await expect(byId(page, at.dispatchId)).toHaveClass(/is-related/);
      await expect(byId(page, `file:${files.queue}`)).toHaveClass(/is-related/);
      await expect(byId(page, `file:${files.worker}`)).not.toHaveClass(/is-related/);
      expect((await stateOf(page)).related.sort()).toEqual(
        [`file:${files.queue}`, at.dispatchId].sort(),
      );

      // Tree: the three files are in the focus, the others are greyed.
      await expect(page.locator(`[data-path="${files.test}"]`)).not.toHaveClass(/is-dimmed/);
      await expect(page.locator(`[data-path="${files.bus}"]`)).toHaveClass(/is-dimmed/);

      expect(problems).toEqual([]);
    });

    test("the details panel tells who wrote what: the concept is the user's, the summary of Runner.dispatch is an edit of an llm element", async ({
      page,
    }) => {
      const at = expectations(fx);
      await open(page, "view:dispatch");
      const details = page.locator(".details");

      await byId(page, "concept:retry-policy").click();
      await expect(details).toContainText("Retry policy");
      await expect(details.locator(".badge.origin-user")).toBeVisible();
      await expect(details.locator(".badge.origin-llm")).toHaveCount(0);

      await byId(page, at.dispatchId).click();
      await expect(details).toContainText(
        "The hot loop: pop, lease a worker, run, ack or requeue.",
      );
      const badge = details.locator(".badge.origin-llm");
      await expect(badge).toBeVisible();
      await expect(badge).toHaveAttribute("title", /edited by you: summary/);
      await expect(details.locator(".facts")).toContainText(
        /Origin\s*llm, commit wt-[0-9a-f]+; edited by you: summary/,
      );
    });
  });

  test.describe(`${fx.name}: view:overview`, () => {
    test("renders the group as a box and the stored edge with its label; clicking the edge focuses the emit call and the handler", async ({
      page,
    }) => {
      const at = expectations(fx);
      const problems = watchProblems(page);
      await open(page);
      expect((await stateOf(page)).viewId).toBe("view:overview");

      // grp:scheduling is a box (not a container: its members are not in the view).
      const group = byId(page, "grp:scheduling");
      await expect(group).toBeVisible();
      await expect(group).toHaveClass(/kind-group/);
      await expect(group).not.toHaveClass(/is-container/);
      await expect(group.locator("rect.box")).toBeVisible();
      await expect(group).toContainText("Scheduling");

      // The stored edge from the worker to the metrics, with its label.
      const edge = byId(page, "edge:job-completed");
      await expect(edge).toBeVisible();
      await expect(edge).toContainText("job.completed");
      await expect(edge).toHaveClass(/res-llm/);
      const worker = await byId(page, `file:${files.worker}`).locator("> rect.box").boundingBox();
      const metrics = await byId(page, `file:${files.metrics}`).locator("> rect.box").boundingBox();
      const route = await edge.locator("path.line").boundingBox();
      expect(worker && metrics && route).toBeTruthy();
      // The route joins the two boxes, whichever way the layout runs: it touches both and lies in neither.
      expect(touches(route!, worker!), "the edge starts at the worker").toBe(true);
      expect(touches(route!, metrics!), "the edge ends at the metrics").toBe(true);
      expect(inside(route!, worker!) || inside(route!, metrics!)).toBe(false);

      // The view draws what the overview includes, and nothing is dimmed or selected yet.
      const state = await stateOf(page);
      expect(state.graph!.nodes).toEqual(
        expect.arrayContaining(["grp:scheduling", `file:${files.worker}`, `file:${files.metrics}`]),
      );
      expect(state.graph!.edges).toContain("edge:job-completed");
      expect(state.selection).toEqual([]);

      // Evidence at both ends: the emit call in Worker.run and the handler's definition.
      await edge.click();
      await expect(edge).toHaveClass(/is-selected/);
      const focus = await focusOf(page);
      expect(focusRows(focus)).toEqual([
        [files.worker, at.emit, at.emit, "call-site"],
        [files.metrics, at.handlerDef.startLine, at.handlerDef.endLine, "definition"],
      ]);
      expect(focus.every((f) => f.elementId === "edge:job-completed" && f.status === "ok")).toBe(
        true,
      );
      const workerPane = pane(page, files.worker);
      const metricsPane = pane(page, files.metrics);
      await expect.poll(() => linesWith(workerPane, ".xpl-hl")).toEqual([at.emit]);
      await expect.poll(() => linesWith(metricsPane, ".xpl-hl")).toEqual(range(at.handlerDef));

      expect(problems).toEqual([]);
    });
  });
}
