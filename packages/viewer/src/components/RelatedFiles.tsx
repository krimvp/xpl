import { useMemo } from "react";
import { relatedFiles, type RelatedFileSet } from "@xpl/core";
import { useDerived, useStore, useViewerState } from "../hooks.js";

const LABELS: Record<RelatedFileSet["kind"], string> = {
  loads: "Loads",
  discovers: "Discovers / registers",
  configures: "Configuration wiring",
  overrides: "Configuration overrides",
  configuration: "Configured by",
  test: "Tested by",
};

export function RelatedFiles({ onOpen }: { onOpen: () => void }) {
  const store = useStore();
  const state = useViewerState();
  const derived = useDerived();
  const links = useMemo(
    () => relatedFiles(state.selection, state.model, derived.selection.focus),
    [state.selection, state.model, derived.selection.focus],
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
  return (
    <section className="related-files" aria-label="Related files">
      <h3>Related files</h3>
      {links.length === 0 ? (
        <p className="empty">
          Select a stage or component to see linked configuration, plugins and resources.
        </p>
      ) : (
        <>
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
                  ? "Resolved from source"
                  : link.resolution === "inferred"
                    ? "Inferred relationship — review the evidence"
                    : "Annotated relationship"}
                {link.pattern ? " · matching files, not confirmed active plugins" : ""}
              </p>
              <ul>
                {link.files.map((file) => (
                  <li key={file}>
                    <button
                      type="button"
                      className="resource-file"
                      onClick={() => {
                        store.openFile(
                          file,
                          link.evidence.find((site) => site.file === file)?.line,
                        );
                        onOpen();
                      }}
                    >
                      {file}
                    </button>
                  </li>
                ))}
              </ul>
              <details className="resource-evidence">
                <summary>Why these files are linked</summary>
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
                    {site.file}:L{site.line}
                  </button>
                ))}
              </details>
            </details>
          ))}
          <p className="resource-disclaimer">
            Source relationships do not prove which files were loaded at runtime.
          </p>
        </>
      )}
    </section>
  );
}
