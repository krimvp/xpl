import { useMemo, useState } from "react";
import { relatedFiles, type RelatedFileSet } from "@xpl/core";
import { useDerived, useStore, useViewerState } from "../hooks.js";

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

export function RelatedFiles({ onOpen }: { onOpen: () => void }) {
  const store = useStore();
  const [all, setAll] = useState<unknown>(undefined);
  const state = useViewerState();
  const derived = useDerived();
  // In the Guide, a section lists its tests itself ("Tests", under the section): not again here.
  const guide = state.perspective === "guide";
  const links = useMemo(
    () =>
      relatedFiles(state.selection, state.model, derived.selection.focus).filter(
        (link) => !(guide && link.kind === "test"),
      ),
    [state.selection, state.model, derived.selection.focus, guide],
  );
  const anchors = [
    ...state.selection.flatMap((id) => {
      const element = state.model.element(id);
      if (!element || element.type === "derived-edge") return [];
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
    ...(state.applied?.code ?? []),
  ];
  // Nothing to list: no panel at all (an empty one only says that there is nothing).
  if (links.length === 0) return null;
  // "Show N more" holds for this selection only.
  const shown = all === state.selection ? links : links.slice(0, CARDS_SHOWN);
  return (
    <section className="related-files" aria-label="Related files">
      <h3>Related files</h3>
      {shown.map((link) => {
        // One file named by its path: the path once, as the link that opens it.
        const single = link.files.length === 1 && link.files[0] === link.label;
        const trust =
          link.resolution === "static"
            ? "Found in the code"
            : link.resolution === "inferred"
              ? "Likely, from how the code is written: check the lines below"
              : "Added by the explainer's author";
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
              <summary>Where the code makes this link</summary>
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
        <button type="button" className="link" onClick={() => setAll(state.selection)}>
          Show {links.length - shown.length} more
        </button>
      )}
    </section>
  );
}
