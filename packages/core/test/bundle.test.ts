import { describe, expect, it } from "vitest";
import { BUNDLE_SCHEMA, injectBundle, parseBundle, type ViewerBundle } from "../src/index.js";

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
