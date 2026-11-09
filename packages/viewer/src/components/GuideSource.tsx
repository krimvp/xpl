import { useEffect, useMemo } from "react";
import { splitLines, type FocusRange, type TourStep } from "@xpl/core";
import { stepSelection } from "../derive.js";
import { useStore, useViewerState } from "../hooks.js";
import { firstContentLine } from "../readerWords.js";

/** The most lines an excerpt shows; "Show code" opens the whole range. */
const EXCERPT_LINES = 12;

/** Which code link a step's excerpt shows first: where a thing is defined, then where it is called. */
const ROLE_ORDER: Record<string, number> = { definition: 0, "call-site": 1 };

/**
 * One short excerpt of the step's code, under its picture. It shows the step's most telling code link (a
 * definition before a call, a call before a usage) and starts after the import lines at the top of a file:
 * twelve lines of imports tell a reader nothing. A link with only imports in it is skipped.
 */
export function GuideSource({
  step,
  tourId,
  index,
}: {
  step: TourStep;
  tourId: string;
  index: number;
}) {
  const store = useStore();
  const state = useViewerState();
  const selection = useMemo(
    () => stepSelection(step, tourId, state.model),
    [step, tourId, state.model],
  );
  // every code link of the step, in the step's own order, then by role (stable sort keeps that order)
  const candidates = useMemo(() => {
    const seen = new Set<string>();
    const out: { focus: FocusRange; base: boolean }[] = [];
    for (const side of selection.order) {
      const key = `${side.base ? "base" : "head"}:${side.file}`;
      if (seen.has(key)) continue;
      seen.add(key);
      for (const focus of side.base ? selection.base : selection.focus)
        if (focus.file === side.file) out.push({ focus, base: side.base });
    }
    return out.sort((a, b) => (ROLE_ORDER[a.focus.role] ?? 2) - (ROLE_ORDER[b.focus.role] ?? 2));
  }, [selection]);
  const total = selection.focus.length + selection.base.length;
  const textOf = (candidate: { focus: FocusRange; base: boolean }) =>
    (candidate.base ? state.baseFiles : state.files)[candidate.focus.file];
  // The first link that has code past its imports. One whose file has not loaded yet stops the search: it
  // may be the one to show.
  const chosen = useMemo(() => {
    for (const candidate of candidates) {
      const text = textOf(candidate);
      if (text === undefined || !usable(candidate.focus)) return { candidate, start: undefined };
      const start = firstContentLine(splitLines(text), candidate.focus.range);
      if (start !== undefined) return { candidate, start };
    }
    return undefined;
  }, [candidates, state.files, state.baseFiles]);
  const candidate = chosen?.candidate ?? candidates[0];
  const focus = candidate?.focus;
  const base = candidate?.base ?? false;
  const file = focus?.file;
  const text = candidate ? textOf(candidate) : undefined;
  useEffect(() => {
    if (file === undefined || text !== undefined) return;
    if (base) void store.ensureBaseFile(file);
    else void store.ensureFile(file);
  }, [store, file, base, text]);
  const lines = useMemo(() => (text === undefined ? [] : splitLines(text)), [text]);
  const range = focus?.range;
  const checked = focus?.status === "ok" || focus?.status === "moved";
  const available =
    checked &&
    (base || !state.sourceWarning) &&
    range !== undefined &&
    Number.isInteger(range.startLine) &&
    Number.isInteger(range.endLine) &&
    range.startLine > 0 &&
    range.endLine >= range.startLine &&
    range.endLine <= lines.length;
  // every link of the step holds only imports: no excerpt (the picture and "Show code" remain)
  if (candidates.length > 0 && !chosen && candidates.every((c) => textOf(c) !== undefined))
    return null;
  const start = chosen?.start ?? range?.startLine ?? 0;
  const end = range ? Math.min(range.endLine, start + EXCERPT_LINES - 1) : 0;
  const position = candidate ? candidates.indexOf(candidate) + 1 : 0;
  return (
    <section className="guide-source" aria-label={`Source excerpt, step ${index + 1}`}>
      {available && range && file !== undefined && text !== undefined ? (
        <>
          <p className="guide-source-caption">
            <code>{file}</code>
            {base && " (before the change)"} · {start === end ? "line" : "lines"} {start}
            {start !== end && `–${end}`}
            {/* (N12: "(of 44–80)" read as a second range: say how much of the code link this is) */}
            {(start !== range.startLine || end < range.endLine) &&
              ` (${end - start + 1} of its ${range.endLine - range.startLine + 1} lines)`}
            {total > 1 && ` · code link ${position} of ${total}`}
          </p>
          <pre tabIndex={0} aria-label={`Source lines ${start} to ${end}`}>
            <code>
              {lines.slice(start - 1, end).map((line, offset) => (
                <span className="guide-source-line" key={offset}>
                  <span className="guide-source-number" aria-hidden="true">
                    {start + offset}
                  </span>
                  {line}
                </span>
              ))}
            </code>
          </pre>
          <button
            className="btn"
            onClick={() => store.openRange(file, range, base ? "base" : "head")}
          >
            Show code
          </button>
        </>
      ) : (
        <p>
          {!focus
            ? "No checked code for this step."
            : !checked || (!base && state.sourceWarning)
              ? "The code has changed; open it to check this part."
              : "This page does not include this code."}
        </p>
      )}
    </section>
  );
}

const usable = (focus: FocusRange) => focus.status === "ok" || focus.status === "moved";
