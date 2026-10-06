import { describe, expect, it } from "vitest";
import {
  BUNDLE_SCHEMA,
  INDEX_PACKING,
  injectBundle,
  isPackedIndex,
  packIndex,
  parseBundle,
  serializeBundle,
  unpackIndex,
  type PackedIndex,
  type SymbolIndex,
  type ViewerBundle,
} from "../src/index.js";
import { jobrunner } from "./helpers.js";

const bundle = {
  schema: BUNDLE_SCHEMA,
  explainer: { title: "</script><script>alert(1)</script>" },
  index: {},
  files: { "a.ts": "if (a < b) {}" + String.fromCharCode(0x2028) },
} as unknown as ViewerBundle;

describe("bundle", () => {
  it("injects before </head>, escapes, and round-trips", () => {
    const html = injectBundle("<html><head><title>x</title></head><body></body></html>", bundle);
    expect(html).toMatch(/<script id="xpl-data" type="application\/json">.*<\/script><\/head>/);
    expect(html.match(/<\/script>/g)).toHaveLength(1);
    const text = html.match(/<script id="xpl-data"[^>]*>([\s\S]*?)<\/script>/)![1]!;
    expect(parseBundle(text)).toEqual(bundle);
  });

  it("replaces an existing payload and rejects foreign JSON", () => {
    const once = injectBundle("<head></head>", bundle);
    expect(injectBundle(once, bundle)).toBe(once);
    expect(() => parseBundle('{"schema":"nope"}')).toThrow(/bundle@0/);
  });
});

describe("bundle: the packed index", () => {
  const { index } = jobrunner();

  it("round-trips independently pruned guide snapshots in a packed offline library", () => {
    const other = {
      ...index,
      commit: "other-snapshot",
      symbols: index.symbols.slice(0, 1),
      refs: [],
    };
    const library = {
      ...bundle,
      index,
      guideId: "repository",
      guides: [
        {
          guideId: "retry.json",
          explainer: bundle.explainer,
          index: other,
          files: { "retry.ts": "retry()" },
        },
      ],
    };
    const html = injectBundle("<head></head>", library, { packIndex: true });
    const text = html.match(/<script id="xpl-data"[^>]*>([\s\S]*?)<\/script>/)![1]!;
    const encoded = JSON.parse(text);
    expect(isPackedIndex(encoded.guides[0].index)).toBe(true);
    expect(parseBundle(text)).toEqual(library);
  });

  it.each(["legacy", "provider facts"])(
    "%s: packs to a fraction of the plain JSON and unpacks without losing provenance",
    (shape) => {
      const tagged: SymbolIndex =
        shape === "legacy"
          ? index
          : {
              ...index,
              providers: [
                { id: "syntax", version: "1" },
                { id: "semantic", version: "2" },
              ],
              symbols: index.symbols.map((symbol) => ({
                ...symbol,
                provider: 0,
              })),
              refs: index.refs.map((ref, i) => ({
                ...ref,
                provider: i === 0 ? 0 : 1,
              })),
            };
      const packed = packIndex(tagged);
      expect(isPackedIndex(packed)).toBe(true);
      expect(JSON.stringify(packed).length).toBeLessThan(JSON.stringify(tagged).length / 2);
      expect(unpackIndex(JSON.parse(JSON.stringify(packed)) as PackedIndex)).toEqual(tagged);
    },
  );

  it("keeps an entry of a shape it does not know as it is", () => {
    const odd: SymbolIndex = {
      ...index,
      symbols: [{ ...index.symbols[0]!, id: "other.ts#x" }, index.symbols[1]!],
      refs: [
        { ...index.refs[0]!, site: { startLine: 3, endLine: 3, startCol: 0, endCol: 4 } },
        { ...index.refs[0]!, extra: true } as unknown as SymbolIndex["refs"][number],
        { ...index.refs[0]!, site: { startLine: 3, endLine: 5 } },
      ],
    };
    const packed = packIndex(odd);
    expect(packed.symbols.map((entry) => Array.isArray(entry))).toEqual([false, true]);
    expect(packed.refs.map((entry) => Array.isArray(entry))).toEqual([false, false, true]);
    expect(unpackIndex(packed)).toEqual(odd);
  });

  it("is written packed on request, and parseBundle unpacks it", () => {
    const full = { ...bundle, index } as ViewerBundle;
    const plain = injectBundle("<head></head>", full);
    const packed = injectBundle("<head></head>", full, { packIndex: true });
    expect(packed.length).toBeLessThan(plain.length / 2);
    expect(packed).toContain(INDEX_PACKING);
    const text = packed.match(/<script id="xpl-data"[^>]*>([\s\S]*?)<\/script>/)![1]!;
    expect(parseBundle(text)).toEqual(full);
  });
});

it("refuses nested or live-attached guide snapshots at the bundle boundary", () => {
  const { index } = jobrunner();
  const snapshot = { guideId: "other", explainer: bundle.explainer, index, files: {} };
  for (const extra of [{ server: { api: "/api" } }, { guides: [] }, { explainer: undefined }]) {
    expect(() =>
      parseBundle(JSON.stringify({ ...bundle, index, guides: [{ ...snapshot, ...extra }] })),
    ).toThrow("invalid embedded guide snapshot");
  }
});

it.each(["../escape", "version-a/b", "https://other/version-a", "version-", "api"])(
  "refuses unsafe published locator %s",
  (version) => {
    const current = {
      version: "version-a",
      createdAt: "2026-10-05T00:00:00.000Z",
      commits: { index: "commit" },
      identity: { explainerHash: "hash", sourceHash: "source" },
      includedSource: { head: ["a.ts"], base: [] },
      review: undefined,
    };
    const published = { ...bundle, publication: { current, previous: [] } };
    expect(parseBundle(serializeBundle(published)).publication?.current.version).toBe("version-a");
    expect(() =>
      parseBundle(
        serializeBundle({
          ...published,
          publication: { current: { ...current, version }, previous: [] },
        }),
      ),
    ).toThrow("invalid or duplicate published version");
  },
);

it("refuses live APIs in a published snapshot", () => {
  const published = {
    ...bundle,
    publication: {
      current: {
        version: "version-a",
        createdAt: "2026-10-05T00:00:00.000Z",
        commits: { index: "commit" },
        identity: { explainerHash: "hash", sourceHash: "source" },
        includedSource: { head: ["a.ts"], base: [] },
        review: undefined,
      },
      previous: [],
    },
  };
  expect(parseBundle(serializeBundle(published)).publication?.current.version).toBe("version-a");
  expect(() => parseBundle(serializeBundle({ ...published, server: { api: "/api" } }))).toThrow(
    "invalid published snapshot",
  );
});
