import { useMemo } from "react";
import type { RevisionChange } from "@xpl/core";
import { escapeHtml, renderMarkdown } from "../markdown.js";
import { wordChanges } from "../wordDiff.js";
import { roleWords } from "../readerWords.js";
import { useViewerState } from "../hooks.js";

const internal = new Set(["id", "hash", "resolved", "provenance", "userFields"]);
const labels: Record<string, string> = {
  anchors: "Evidence",
  edgeKinds: "Relationships shown",
  include: "Included elements",
  hidden: "Hidden elements",
  opens: "Opens view",
  parent: "Inside",
  root: "Starting at",
  depth: "Levels shown",
  stubs: "Related boxes",
  max: "Maximum",
  index: "Source snapshot",
};
const fieldName = (key: string) =>
  labels[key] ?? key.replace(/([A-Z])/g, " $1").replace(/^./, (c) => c.toUpperCase());
const object = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};

/** Mark changed phrases inside the same safe Markdown the text panes use. */
function markedText(before: string, after: string, markdown: boolean): [string, string] {
  const parse = (text: string) =>
    new DOMParser().parseFromString(
      markdown ? renderMarkdown(text) : escapeHtml(text),
      "text/html",
    );
  const docs = [parse(before), parse(after)];
  const changes = wordChanges(docs[0]!.body.textContent ?? "", docs[1]!.body.textContent ?? "");
  return docs.map((doc, side) => {
    const changed = changes[side]!;
    const walker = doc.createTreeWalker(doc.body, NodeFilter.SHOW_TEXT);
    const nodes: Text[] = [];
    while (walker.nextNode()) nodes.push(walker.currentNode as Text);
    let offset = 0;
    for (const node of nodes) {
      const text = node.data,
        end = offset + text.length;
      const ranges = changed.filter((r) => r.from < end && r.to > offset);
      if (ranges.length) {
        const fragment = doc.createDocumentFragment();
        let at = 0;
        for (const range of ranges) {
          const from = Math.max(0, range.from - offset),
            to = Math.min(text.length, range.to - offset);
          fragment.append(text.slice(at, from));
          const mark = doc.createElement("mark");
          mark.textContent = text.slice(from, to);
          fragment.append(mark);
          at = to;
        }
        fragment.append(text.slice(at));
        node.replaceWith(fragment);
      }
      offset = end;
    }
    return doc.body.innerHTML;
  }) as [string, string];
}
function FieldChange({ field, before, after }: { field: string; before: string; after: string }) {
  const html = useMemo(
    () =>
      markedText(before, after, ["label", "title", "summary", "detail", "note"].includes(field)),
    [before, after, field],
  );
  return (
    <section className="job-field" aria-label={`${fieldName(field)} change`}>
      <h5>
        {fieldName(field)}
        {before === after ? " (unchanged)" : ""}
      </h5>
      <div className="job-comparison">
        <div className="job-before markdown" dangerouslySetInnerHTML={{ __html: html[0] }} />
        <div className="job-after markdown" dangerouslySetInnerHTML={{ __html: html[1] }} />
      </div>
    </section>
  );
}
export function ProposalChanges({ changes }: { changes: RevisionChange[] }) {
  const { model } = useViewerState();
  function plain(value: unknown, field: string): string {
    if (value === null || value === undefined) return "Not set";
    if (typeof value === "boolean") return value ? "Yes" : "No";
    if (typeof value === "string")
      return value.includes(":") && !value.includes(" ") ? model.label(value) : value;
    if (Array.isArray(value))
      return value.length ? value.map((v) => plain(v, field)).join("; ") : "None";
    if (typeof value === "object") {
      const item = object(value);
      if (field === "anchors") {
        const resolved = object(item.resolved),
          range = object(resolved.range);
        const lines =
          range.startLine === undefined
            ? "location unavailable"
            : `${range.startLine}${range.endLine !== range.startLine ? `–${range.endLine}` : ""}`;
        return `${item.file}:${lines} (${roleWords(String(item.role))}) · ${resolved.status ?? "unresolved"}${item.at === "base" ? " · before source change" : ""}`;
      }
      return (
        Object.entries(item)
          .filter(([key]) => !internal.has(key))
          .map(([key, v]) => `${fieldName(key)}: ${plain(v, key)}`)
          .join("; ") || "None"
      );
    }
    return String(value);
  }
  return (
    <>
      {changes.map((change) => {
        if (change.id === "(index)")
          return (
            <article className="job-change" key={change.id}>
              <h4>Checked source snapshot</h4>
              <p>The candidate is bound to the checked repository source.</p>
              <details className="job-raw-change">
                <summary>Show raw change</summary>
                <pre>{JSON.stringify(change, null, 2)}</pre>
              </details>
            </article>
          );
        const before = object(change.before),
          after = object(change.after);
        const fields = [...new Set([...Object.keys(before), ...Object.keys(after)])].filter(
          (key) =>
            !internal.has(key) &&
            (key === "anchors" || JSON.stringify(before[key]) !== JSON.stringify(after[key])),
        );
        return (
          <article className="job-change" key={change.id}>
            <h4>
              {String(
                after.label ??
                  after.title ??
                  before.label ??
                  before.title ??
                  model.label(change.id),
              )}
            </h4>
            <div className="job-comparison job-comparison-heading">
              <strong>Before</strong>
              <strong>After</strong>
            </div>
            {fields.map((field) => (
              <FieldChange
                key={field}
                field={field}
                before={plain(before[field], field)}
                after={plain(after[field], field)}
              />
            ))}
            {!fields.length && <p>No authored fields change.</p>}
            <details className="job-raw-change">
              <summary>Show raw change</summary>
              <pre>{JSON.stringify(change, null, 2)}</pre>
            </details>
          </article>
        );
      })}
    </>
  );
}
