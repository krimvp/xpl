import { useEffect, useMemo } from "react";
import { splitLines, type TourStep } from "@xpl/core";
import { stepSelection } from "../derive.js";
import { useStore, useViewerState } from "../hooks.js";

/** One bounded excerpt in the step's source order, using the same focus as the full code view. */
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
  const first = selection.order[0];
  const base = first?.base ?? false;
  const focus = (base ? selection.base : selection.focus).find((item) => item.file === first?.file);
  const file = focus?.file;
  const text = file === undefined ? undefined : (base ? state.baseFiles : state.files)[file];
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
  const end = range ? Math.min(range.endLine, range.startLine + 11) : 0;
  return (
    <section className="guide-source" aria-label={`Source excerpt, step ${index + 1}`}>
      <h4>Source excerpt</h4>
      {file && (
        <p className="guide-source-file">
          <code>{file}</code>
          {base && " (before change)"}
        </p>
      )}
      {selection.focus.length + selection.base.length > 1 && (
        <p>First source range of {selection.focus.length + selection.base.length}</p>
      )}
      {available && range && file !== undefined && text !== undefined ? (
        <>
          <p>
            Showing lines {range.startLine}–{end}
            {end < range.endLine && ` of ${range.startLine}–${range.endLine}`}
          </p>
          <pre tabIndex={0} aria-label={`Source lines ${range.startLine} to ${end}`}>
            <code>
              {lines.slice(range.startLine - 1, end).map((line, offset) => (
                <span className="guide-source-line" key={offset}>
                  <span className="guide-source-number" aria-hidden="true">
                    {range.startLine + offset}
                  </span>
                  {line}
                  {"\n"}
                </span>
              ))}
            </code>
          </pre>
          <button
            className="btn"
            onClick={() => store.openRange(file, range, base ? "base" : "head")}
          >
            Open full code
          </button>
        </>
      ) : (
        <p>
          {!focus
            ? "No checked source range for this step."
            : !checked || (!base && state.sourceWarning)
              ? "Source has changed; open the code to check this range."
              : "Source is not available in this page."}
        </p>
      )}
    </section>
  );
}
