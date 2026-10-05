/** Source scans run off the UI thread, including index construction and literal phrase matching. */
import {
  asIndexModel,
  query,
  type QueryGuide,
  type QueryResult,
  type SymbolIndex,
} from "@xpl/core";

export type SearchMessage =
  | { kind: "snapshot"; index: SymbolIndex; files: Record<string, string>; guides: QueryGuide[] }
  | { kind: "query"; id: number; pattern: string };
export type SearchResult = Pick<QueryResult, "hits" | "total">;
export type SearchReply = { id: number } & ({ result: SearchResult } | { error: string });

let snapshot: Extract<SearchMessage, { kind: "snapshot" }> | undefined;
let index: ReturnType<typeof asIndexModel> | undefined;
self.onmessage = (event: MessageEvent<SearchMessage>) => {
  const message = event.data;
  if (message.kind === "snapshot") {
    snapshot = message;
    index = asIndexModel(message.index);
    return;
  }
  if (!snapshot || !index) return;
  try {
    const result = query(index, (file) => snapshot!.files[file], {
      pattern: message.pattern,
      ignoreCase: true,
      limit: 80,
      guides: snapshot.guides,
      textOrigin: "supplied",
    });
    // Minified source and long prose never become megabytes of text on the UI thread.
    for (const hit of result.hits) {
      const at = hit.text.toLowerCase().indexOf(message.pattern.toLowerCase());
      const start = Math.max(0, at - 80);
      const end = Math.min(hit.text.length, start + 400);
      hit.text = `${start ? "…" : ""}${hit.text.slice(start, end)}${end < hit.text.length ? "…" : ""}`;
    }
    self.postMessage({
      id: message.id,
      result: { hits: result.hits, total: result.total },
    } satisfies SearchReply);
  } catch (error) {
    self.postMessage({
      id: message.id,
      error: error instanceof Error ? error.message : String(error),
    } satisfies SearchReply);
  }
};
