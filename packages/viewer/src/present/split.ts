/**
 * How wide a talk's code needs to be (PresentMode splits the screen once per tour): the length of the
 * lines its steps focus, in columns. A tour with a flow step gives the diagram more of the width, but not
 * the width its code needs: a code column narrower than its focused lines wraps them on every step.
 */
import { codeFocus, type ExplainerModel, type FilePath, type Tour } from "@xpl/core";
import { overrideFocus } from "../derive.js";
import { indentColumns } from "../editor.js";

/** Lines read per range at most (a step that focuses a whole file says nothing about its width). */
const RANGE_LINES = 80;
/** The share of the focused lines that should fit unwrapped: a few long lines do not decide. */
const SHARE = 0.75;

/**
 * The columns that `SHARE` of the lines the tour's steps focus fit in (tabs count 4), or 0 when its code is
 * not known (no focus, or files not loaded).
 */
export function focusColumns(
  tour: Tour,
  model: ExplainerModel,
  files: Readonly<Record<FilePath, string>>,
): number {
  const lengths: number[] = [];
  const split = new Map<FilePath, string[]>();
  const lines = (file: FilePath) => {
    let known = split.get(file);
    if (!known) {
      const text = files[file];
      known = text === undefined ? [] : text.split("\n");
      split.set(file, known);
    }
    return known;
  };
  for (const step of tour.steps) {
    const ranges =
      Array.isArray(step.code) && step.code.length > 0
        ? overrideFocus({ anchors: step.code, owner: `${tour.id}/${step.id}` }, model)
        : codeFocus(
            (Array.isArray(step.focus) ? step.focus : []).filter(
              (id): id is string => typeof id === "string" && model.hasElement(id),
            ),
            model,
          );
    for (const { file, range } of ranges) {
      const text = lines(file);
      const last = Math.min(range.endLine, range.startLine + RANGE_LINES - 1, text.length);
      for (let n = range.startLine; n <= last; n++) {
        const line = text[n - 1]!;
        if (line.trim() === "") continue;
        lengths.push(indentColumns(line) + line.trimStart().length);
      }
    }
  }
  if (lengths.length === 0) return 0;
  lengths.sort((a, b) => a - b);
  return lengths[Math.min(lengths.length - 1, Math.floor(lengths.length * SHARE))]!;
}
