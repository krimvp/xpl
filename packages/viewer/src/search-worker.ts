/** Source scans run off the UI thread, including index construction and literal phrase matching. */
import { asIndexModel, query, type QueryGuide, type QueryHit, type SymbolIndex } from "@xpl/core";

export const SEARCH_PAGE_SIZE = 16;
const GROUPS = [
  { id: "symbols", title: "Symbols", kinds: ["symbol"] },
  { id: "concepts", title: "Concepts", kinds: ["concept"] },
  { id: "steps", title: "Tour and flow steps", kinds: ["step"] },
  { id: "guides", title: "Guides and tours", kinds: ["guide", "tour"] },
  { id: "source", title: "Source", kinds: ["source"] },
] as const;
export type SearchGroupId = (typeof GROUPS)[number]["id"];
export type SearchPages = Partial<Record<SearchGroupId, number>>;
export type SearchGroup = {
  id: SearchGroupId;
  title: string;
  offset: number;
  hits: SearchHit[];
  total: number;
};
export type SearchHit = QueryHit & { guide: string; commit: string };
export type SearchSnapshot = QueryGuide & { index: SymbolIndex; files: Record<string, string> };
export type SearchMessage =
  | { kind: "snapshot"; snapshots: SearchSnapshot[] }
  | { kind: "query"; id: number; pattern: string; pages: SearchPages };
export type SearchResult = { groups: SearchGroup[]; total: number };
export type SearchReply = { id: number } & ({ result: SearchResult } | { error: string });

let snapshot: Extract<SearchMessage, { kind: "snapshot" }> | undefined;
let indexes: ReturnType<typeof asIndexModel>[] = [];
self.onmessage = (event: MessageEvent<SearchMessage>) => {
  const message = event.data;
  if (message.kind === "snapshot") {
    snapshot = message;
    indexes = message.snapshots.map((g) => asIndexModel(g.index));
    return;
  }
  if (!snapshot) return;
  try {
    const groups: SearchGroup[] = GROUPS.map((group) => {
      const offset = (message.pages[group.id] ?? 0) * SEARCH_PAGE_SIZE;
      const hits: SearchHit[] = [];
      let total = 0;
      for (const [i, guide] of snapshot!.snapshots.entries()) {
        const result = query(indexes[i]!, (file) => guide.files[file], {
          pattern: message.pattern,
          ignoreCase: true,
          limit: SEARCH_PAGE_SIZE,
          offset: Math.max(0, offset - total),
          kinds: group.kinds,
          guides: [{ id: guide.id, explainer: guide.explainer }],
          textOrigin: "supplied",
        });
        hits.push(
          ...result.hits.slice(0, SEARCH_PAGE_SIZE - hits.length).map((hit) => ({
            ...hit,
            guide: guide.id,
            commit: guide.index.commit,
          })),
        );
        total += result.total;
      }
      // Minified source and long prose never become megabytes of text on the UI thread.
      for (const hit of hits) {
        const at = hit.text.toLowerCase().indexOf(message.pattern.toLowerCase());
        const start = Math.max(0, at - 80);
        const end = Math.min(hit.text.length, start + 400);
        hit.text = `${start ? "…" : ""}${hit.text.slice(start, end)}${end < hit.text.length ? "…" : ""}`;
      }
      return { id: group.id, title: group.title, offset, hits, total };
    });
    self.postMessage({
      id: message.id,
      result: { groups, total: groups.reduce((sum, group) => sum + group.total, 0) },
    } satisfies SearchReply);
  } catch (error) {
    self.postMessage({
      id: message.id,
      error: error instanceof Error ? error.message : String(error),
    } satisfies SearchReply);
  }
};
