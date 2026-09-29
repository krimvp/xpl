import { DEFAULT_EDGE_KINDS, type FileLanguage } from "@xpl/core";
import { marked } from "marked";
import { useEffect, useRef, useState } from "react";
import { createReadOnlyEditor } from "./editor.js";
import { layoutDemo, type DemoLayout } from "./layout.js";

const SAMPLE_FILE = "src/runner.ts";
const SAMPLE_LANGUAGE: FileLanguage = "typescript";
const SAMPLE_CODE = `export class Runner {
  dispatch(): void {
    const job = this.queue.pop();
    this.worker.run(job);
  }
}
`;
const NOTE = "Scaffold check: a **read-only** CodeMirror editor and an ELK layout in one file.";

export function App() {
  const editorHost = useRef<HTMLDivElement>(null);
  const [layout, setLayout] = useState<DemoLayout | null>(null);
  const [layoutError, setLayoutError] = useState<string | null>(null);

  useEffect(() => {
    const host = editorHost.current;
    if (!host) return;
    const view = createReadOnlyEditor(host, SAMPLE_CODE, SAMPLE_LANGUAGE);
    return () => view.destroy();
  }, []);

  useEffect(() => {
    let cancelled = false;
    layoutDemo().then(
      (result) => !cancelled && setLayout(result),
      (error: unknown) => !cancelled && setLayoutError(String(error)),
    );
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <main>
      <h1>xpl viewer</h1>
      <p
        data-testid="note"
        dangerouslySetInnerHTML={{ __html: marked.parse(NOTE, { async: false }) }}
      />
      <p data-testid="core-link">
        Default edge kinds (from @xpl/core): {DEFAULT_EDGE_KINDS.join(", ")}
      </p>
      <section>
        <h2>Editor</h2>
        <div ref={editorHost} data-file={SAMPLE_FILE} data-testid="editor-host" />
      </section>
      <section>
        <h2>Layout</h2>
        <pre data-testid="elk-layout">
          {layoutError ??
            (layout
              ? layout.nodes.map((n) => `${n.id}@${n.x},${n.y}`).join(" ") +
                ` (${layout.width}x${layout.height})`
              : "laying out...")}
        </pre>
      </section>
    </main>
  );
}
