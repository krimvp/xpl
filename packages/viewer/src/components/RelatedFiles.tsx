import { useMemo, useState } from "react";
import type { ExplainerModel, FocusRange, RelatedFileSet, Tour, TourStep } from "@xpl/core";
import { stepSelection } from "../derive.js";
import { useDerived, useStore, useViewerState } from "../hooks.js";
import { holdsCode, mergeSameCards, readerCards, repeatsShownCode } from "../relatedCards.js";

const LABELS: Record<RelatedFileSet["kind"], string> = {
  loads: "Reads",
  discovers: "Finds and registers",
  configures: "Sets up",
  overrides: "Overrides settings in",
  configuration: "Its settings are in",
  test: "Tested by",
};

/** Cards shown before "Show N more": the first ones are the closest; more push the rest of the column down. */
const CARDS_SHOWN = 2;

/**
 * True when some step of the tour lists related files in the Tour (the cards `RelatedFiles` shows for it).
 * The Tour then keeps its right column for every step, so the text does not change width while the reader
 * scrolls; otherwise it has no right column at all.
 */
export function tourHasCards(tour: Tour, model: ExplainerModel): boolean {
  return tour.steps.some((step) => {
    const focus = stepSelection(step, tour.id, model).focus;
    const selection = step.focus.filter((id) => model.hasElement(id));
    return readerCards(selection, model, focus).some(
      (link) => link.kind !== "test" && !repeatsShownCode(link, focus),
    );
  });
}

/** The step's own code: one place per file (its first range), in the order the step shows them; at most 4. */
function ownPlaces(focus: readonly FocusRange[]): { file: string; from: number; to: number }[] {
  const seen = new Set<string>();
  const places: { file: string; from: number; to: number }[] = [];
  for (const { file, range } of focus) {
    if (seen.has(file)) continue;
    seen.add(file);
    places.push({ file, from: range.startLine, to: range.endLine });
  }
  return places.slice(0, 4);
}

/**
 * `reading`: the tour step scrolled to in the Tour, when it is not the step last applied. The cards then
 * follow the step on screen, not the one clicked before the scroll.
 */
export function RelatedFiles({
  onOpen,
  reading,
  keepPlace = false,
}: {
  onOpen: () => void;
  reading?: { tourId: string; step: TourStep };
  /** The Tour keeps its right column for the whole tour: a step with no cards lists its own code. */
  keepPlace?: boolean;
}) {
  const store = useStore();
  const [all, setAll] = useState<unknown>(undefined);
  const state = useViewerState();
  const derived = useDerived();
  // In the Guide, a section lists its tests itself ("Tests", under the section): not again here.
  const guide = state.perspective === "guide";
  const step = reading?.step;
  const tourId = reading?.tourId;
  const selection = useMemo(
    () => (step ? step.focus.filter((id) => state.model.hasElement(id)) : state.selection),
    [step, state.model, state.selection],
  );
  const focus = useMemo(
    () =>
      step && tourId ? stepSelection(step, tourId, state.model).focus : derived.selection.focus,
    [step, tourId, state.model, derived.selection.focus],
  );
  // The code links of what is shown: the selected elements' own, and the step's.
  const anchors = [
    ...selection.flatMap((id) => {
      const element = state.model.element(id);
      // (a box that holds code names no setting: its cards are its arrows, readerCards)
      if (!element || element.type === "derived-edge" || holdsCode(id, state.model)) return [];
      return (
        element.type === "node"
          ? element.node
          : element.type === "concept"
            ? element.concept
            : element.type === "step"
              ? element.step
              : element.edge
      ).anchors;
    }),
    ...((step ? step.code : state.applied?.code) ?? []),
  ];
  const links = useMemo(
    () =>
      mergeSameCards(
        readerCards(selection, state.model, focus).filter(
          (link) => !(guide && link.kind === "test") && !repeatsShownCode(link, focus),
        ),
      ),
    // (`anchors` follows `selection`, `step` and the applied step)
    [selection, state.model, focus, guide, step, state.applied],
  );
  // The step's own code, in the Tour: one click from showing it.
  const places = keepPlace ? ownPlaces(focus) : [];
  const own = places.length > 0 && (
    <ul data-testid="step-code">
      {places.map((place) => (
        <li key={`${place.file}:${place.from}`}>
          <button
            type="button"
            className="resource-file"
            onClick={() => {
              store.openFile(place.file, place.from);
              onOpen();
            }}
          >
            {place.file.slice(place.file.lastIndexOf("/") + 1)}
            <span className="step-code-lines">
              {place.from === place.to ? `line ${place.from}` : `lines ${place.from}–${place.to}`}
            </span>
          </button>
        </li>
      ))}
    </ul>
  );
  // One name for the column in the Tour, whatever it lists: the step's code, then the files it relates to
  // Elsewhere it lists what the selection relates to.
  const applied = state.applied
    ? state.model.tour(state.applied.tourId)?.steps.find((one) => one.id === state.applied!.stepId)
    : undefined;
  const ofStep =
    guide && (step !== undefined || selection.every((id) => applied?.focus.includes(id) ?? false));
  const title = ofStep ? "This step's code" : "Related files";
  // Nothing to list: no panel at all (an empty one only says that there is nothing), unless the column
  // stays for the tour: then it lists where the step's own code is.
  if (links.length === 0) {
    return own ? (
      <section className="related-files is-own-code" aria-label={title}>
        <h3>{title}</h3>
        {own}
      </section>
    ) : null;
  }
  // "Show N more" holds for this selection only.
  const shown = all === selection ? links : links.slice(0, CARDS_SHOWN);
  return (
    <section className="related-files" aria-label={title}>
      <h3>{title}</h3>
      {own}
      {shown.map((link) => {
        // One file named by its path: the path once, as the link that opens it.
        const single = link.files.length === 1 && link.files[0] === link.label;
        const trust =
          link.resolution === "static"
            ? "Found in the code"
            : link.resolution === "inferred"
              ? "Likely, from how the code is written: check the lines below"
              : "Added by the author";
        return (
          <details className="resource-set" key={link.id} open={link.files.length === 1}>
            <summary title={link.resolution === "inferred" ? undefined : trust}>
              <span className="resource-chevron" aria-hidden="true" />
              <span className="resource-head">
                <span className="resource-kind">{LABELS[link.kind]}</span>
                {!single && <span className="resource-label">{link.label}</span>}
                {link.files.length > 1 && <span className="count">{link.files.length} files</span>}
              </span>
            </summary>
            {link.summary && <p className="resource-summary">{link.summary}</p>}
            {[
              ...new Set(
                anchors
                  .filter(
                    (anchor) =>
                      anchor.role === "config" &&
                      anchor.symbol &&
                      anchor.resolved?.status !== "missing" &&
                      link.files.includes(anchor.file),
                  )
                  .map((anchor) => anchor.symbol!),
              ),
            ].map((symbol) => (
              // "Setting", not "Key": the map has a Key, and a key here is not a secret.
              <p className="resource-key" key={symbol}>
                Setting: <code>{symbol}</code>
              </p>
            ))}
            {(link.resolution === "inferred" || link.pattern) && (
              <p className="resource-trust">
                {link.resolution === "inferred" ? trust : ""}
                {link.resolution === "inferred" && link.pattern ? " · " : ""}
                {link.pattern ? "Files that match a pattern, not checked one by one" : ""}
              </p>
            )}
            <ul>
              {link.files.map((file) => (
                <li key={file}>
                  <button
                    type="button"
                    className="resource-file"
                    onClick={() => {
                      store.openFile(file, link.evidence.find((site) => site.file === file)?.line);
                      onOpen();
                    }}
                  >
                    {file}
                  </button>
                </li>
              ))}
            </ul>
            <details className="resource-evidence">
              <summary>
                Where the code makes this link
                {link.evidence.length > 1 ? ` (${link.evidence.length} places)` : ""}
              </summary>
              {link.evidence.map((site, index) => (
                <button
                  type="button"
                  className="resource-file"
                  key={`${site.file}:${site.line}:${index}`}
                  onClick={() => {
                    store.openFile(site.file, site.line);
                    onOpen();
                  }}
                >
                  {site.file.slice(site.file.lastIndexOf("/") + 1)}, line {site.line}
                </button>
              ))}
            </details>
          </details>
        );
      })}
      {links.length > shown.length && (
        <button type="button" className="link" onClick={() => setAll(selection)}>
          Show {links.length - shown.length} more
        </button>
      )}
    </section>
  );
}
