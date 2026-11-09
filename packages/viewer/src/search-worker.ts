/** Source scans run off the UI thread, including index construction and literal phrase matching. */
import {
  asIndexModel,
  hashText,
  isTestFile,
  query,
  type QueryGuide,
  type QueryHit,
  type SymbolIndex,
} from "@xpl/core";
import { plainText, snippet, symbolRank, testTitle } from "./searchSnippet.js";

export const SEARCH_PAGE_SIZE = 16;
/** The guide's own words first (they answer the question), then the code's names, then its text. */
const GROUPS = [
  { id: "steps", title: "Tour and flow steps", kinds: ["step"] },
  { id: "concepts", title: "Concepts", kinds: ["concept"] },
  { id: "guides", title: "Guides and tours", kinds: ["guide", "tour"] },
  { id: "symbols", title: "Symbols", kinds: ["symbol"] },
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
export type SearchHit = QueryHit & { guide: string; commit: string; sourceHash?: string };
export type SearchSnapshot = QueryGuide & { index: SymbolIndex; files: Record<string, string> };
export type SearchMessage =
  | { kind: "snapshot"; snapshots: SearchSnapshot[] }
  | { kind: "query"; id: number; pattern: string; pages: SearchPages };
export type SearchResult = { groups: SearchGroup[]; total: number };
export type SearchReply = { id: number } & ({ result: SearchResult } | { error: string });

/** A test case (a function in a test file) by its describe titles, not the index's dotted path. */
function testCaseTitle(
  index: ReturnType<typeof asIndexModel> | undefined,
  hit: { file: string; id: string },
): string | undefined {
  const id = hit.id.replace(/^sym:/, "");
  if (!index || !isTestFile(hit.file) || index.symbol(id)?.kind !== "function") return undefined;
  return testTitle(index, id);
}

let snapshot: Extract<SearchMessage, { kind: "snapshot" }> | undefined;
let indexes: ReturnType<typeof asIndexModel>[] = [];
let sourceHashes: Map<string, string>[] = [];
self.onmessage = (event: MessageEvent<SearchMessage>) => {
  const message = event.data;
  if (message.kind === "snapshot") {
    snapshot = message;
    indexes = message.snapshots.map((g) => asIndexModel(g.index));
    sourceHashes = message.snapshots.map(() => new Map());
    return;
  }
  if (!snapshot) return;
  try {
    const groups: SearchGroup[] = GROUPS.map((group) => {
      const offset = (message.pages[group.id] ?? 0) * SEARCH_PAGE_SIZE;
      const hits: SearchHit[] = [];
      let total = 0;
      for (const [i, guide] of snapshot!.snapshots.entries()) {
        const sourceHash = (file: string): string | undefined => {
          const text = guide.files[file];
          if (text === undefined) return;
          let hash = sourceHashes[i]!.get(file);
          if (!hash) {
            hash = hashText(text);
            sourceHashes[i]!.set(file, hash);
          }
          return hash;
        };
        // (names are ranked, so all of them are read; the other groups page in the index's order)
        const ranked = group.id === "symbols";
        const result = query(indexes[i]!, (file) => guide.files[file], {
          pattern: message.pattern,
          ignoreCase: true,
          limit: ranked ? 0 : SEARCH_PAGE_SIZE,
          offset: ranked ? 0 : Math.max(0, offset - total),
          kinds: group.kinds,
          guides: [{ id: guide.id, explainer: guide.explainer }],
          textOrigin: "supplied",
        });
        hits.push(
          ...result.hits
            .slice(0, ranked ? undefined : SEARCH_PAGE_SIZE - hits.length)
            .map((hit) => {
              const hash =
                hit.kind === "source" || hit.kind === "symbol" ? sourceHash(hit.file) : undefined;
              return {
                ...hit,
                guide: guide.id,
                commit: guide.index.commit,
                ...(hash === undefined ? {} : { sourceHash: hash }),
              };
            }),
        );
        total += result.total;
      }
      if (group.id === "symbols") {
        const files = new Map(snapshot!.snapshots.map((g) => [g.id, g.files]));
        const ranked = hits
          .map((hit, at) => ({ hit, at, rank: symbolRank(hit, files.get(hit.guide) ?? {}) }))
          .sort((a, b) => a.rank - b.rank || a.at - b.at)
          .map(({ hit }) => hit);
        hits.splice(0, hits.length, ...ranked.slice(offset, offset + SEARCH_PAGE_SIZE));
      }
      // A guide's Markdown reads as plain words, a test as its describe titles; minified source and long
      // prose never become megabytes of text on the UI thread.
      for (const hit of hits) {
        const index = indexes[snapshot!.snapshots.findIndex((g) => g.id === hit.guide)];
        const text =
          hit.kind === "source"
            ? hit.text
            : hit.kind === "symbol"
              ? (testCaseTitle(index, hit) ?? hit.text)
              : plainText(hit.text);
        hit.text = snippet(text, message.pattern);
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
