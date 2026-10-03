import { useMemo } from "react";
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

export function RelatedFiles({ onOpen }: { onOpen: () => void }) {
  const store = useStore();
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
  return (
    <section className="related-files" aria-label="Related files">
      <h3>Related files</h3>
      {links.map((link) => (
        <details className="resource-set" key={link.id} open={link.files.length === 1}>
          <summary>
            <span className="resource-kind">{LABELS[link.kind]}</span>
            <span className="resource-label">{link.label}</span>
            <span className="count">
              {link.files.length} {link.files.length === 1 ? "file" : "files"}
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
            <p className="resource-key" key={symbol}>
              Key: <code>{symbol}</code>
            </p>
          ))}
          <p className="resource-trust">
            {link.resolution === "static"
              ? "Found in the code"
              : link.resolution === "inferred"
                ? "Likely, from how the code is written: check the lines below"
                : "Added by the explainer's author"}
            {link.pattern ? " · files that match a pattern, not checked one by one" : ""}
          </p>
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
      ))}
    </section>
  );
}
