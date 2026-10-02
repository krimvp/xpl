/**
 * The tests of a guide section, gathered in one list under it: the test code the step's focus points at
 * (anchors with the `test` role, and focused code in test files), one entry per test, named by the test
 * function where the index knows it. The Guide shows them as "Tests" with a button each that opens the
 * test in the code; the right rail no longer lists them as "Tested by" related files.
 */
import {
  codeFocus,
  isTestFile,
  type ElementId,
  type ExplainerModel,
  type FilePath,
  type FocusRange,
} from "@xpl/core";

export interface StepTest {
  /** The test function (`test_file_response_stops_on_disconnect`), else the file name. */
  name: string;
  file: FilePath;
  /** The first line of the test, to open it at. */
  line: number;
}

/** The test code among focus ranges: `test` anchors, and anything focused in a test file. */
function testRanges(ranges: readonly FocusRange[]): FocusRange[] {
  return ranges.filter((range) => range.role === "test" || isTestFile(range.file));
}

/**
 * The tests a step focuses (its focus elements, and its code override), in focus order, each test once:
 *
 * - a range that holds test functions (a whole test file, a group of tests) lists each of them;
 * - a range inside a test names that test (a line in a test's local helper names the test);
 * - fixtures and helpers are not tests: a file whose ranges are only those is listed by its name.
 */
export function stepTests(
  focus: readonly ElementId[],
  model: ExplainerModel,
  extra: readonly FocusRange[] = [],
): StepTest[] {
  const out: StepTest[] = [];
  const seen = new Set<string>();
  const add = (file: FilePath, line: number, name: string) => {
    const key = `${file}\0${name}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ file, line, name });
  };
  const files = new Map<FilePath, number>();
  for (const { file, range } of testRanges([...codeFocus(focus, model), ...extra])) {
    if (!files.has(file)) files.set(file, range.startLine);
    const tests = model.index
      .symbolsInFile(file)
      .filter((sym) => isTest(sym, model))
      .sort((a, b) => a.range.startLine - b.range.startLine);
    const within = tests.filter(
      (sym) => sym.range.startLine >= range.startLine && sym.range.endLine <= range.endLine,
    );
    const around = tests.find(
      (sym) => sym.range.startLine <= range.startLine && sym.range.endLine >= range.endLine,
    );
    if (around && within.length <= 1) add(file, range.startLine, leaf(around.path));
    else for (const sym of within) add(file, sym.range.startLine, leaf(sym.path));
  }
  for (const [file, line] of files) {
    if (!out.some((test) => test.file === file))
      add(file, line, file.slice(file.lastIndexOf("/") + 1));
  }
  return out;
}

/** A test: a function or method named like one, not nested in another function. */
function isTest(
  sym: { path: string; kind: string; parent?: string },
  model: ExplainerModel,
): boolean {
  return (
    (sym.kind === "function" || sym.kind === "method") &&
    isTestName(sym.path) &&
    !nestedInFunction(sym, model)
  );
}

/** `TestFoo.test_bar` -> `test_bar`. */
const leaf = (path: string) => path.slice(path.lastIndexOf(".") + 1);

/** A test function by its name, in the usual conventions (`test_x`, `testX`, `TestX`, `x_test`). */
function isTestName(path: string): boolean {
  return /^(test|Test)|_test$/.test(leaf(path));
}

/** A function defined inside another function (a test's local helper). */
function nestedInFunction(sym: { parent?: string }, model: ExplainerModel): boolean {
  for (let at = sym.parent; at !== undefined;) {
    const parent = model.index.symbol(at);
    if (!parent) return false;
    if (parent.kind === "function" || parent.kind === "method") return true;
    at = parent.parent;
  }
  return false;
}
