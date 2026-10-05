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
  hits: QueryHit[];
  total: number;
};
export type SearchMessage =
  | { kind: "snapshot"; index: SymbolIndex; files: Record<string, string>; guides: QueryGuide[] }
  | { kind: "query"; id: number; pattern: string; pages: SearchPages };
export type SearchResult = { groups: SearchGroup[]; total: number };
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
    const groups: SearchGroup[] = GROUPS.map((group) => {
      const offset = (message.pages[group.id] ?? 0) * SEARCH_PAGE_SIZE;
      const result = query(index!, (file) => snapshot!.files[file], {
        pattern: message.pattern,
        ignoreCase: true,
        limit: SEARCH_PAGE_SIZE,
        offset,
        kinds: group.kinds,
        guides: snapshot!.guides,
        textOrigin: "supplied",
      });
      // Minified source and long prose never become megabytes of text on the UI thread.
      for (const hit of result.hits) {
        const at = hit.text.toLowerCase().indexOf(message.pattern.toLowerCase());
        const start = Math.max(0, at - 80);
        const end = Math.min(hit.text.length, start + 400);
        hit.text = `${start ? "…" : ""}${hit.text.slice(start, end)}${end < hit.text.length ? "…" : ""}`;
      }
      return { id: group.id, title: group.title, offset, hits: result.hits, total: result.total };
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
