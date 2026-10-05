import { expect, it } from "vitest";
import { ViewerStore } from "../src/store.js";
import { makeBundle } from "./world.js";

it("previews the entire selection relative to its containing symbol or file and rejects stale source", () => {
  const store = new ViewerStore(makeBundle());
  store.setCursor("src/a.ts", 12, 13);
  expect(store.previewEvidence("call-site")).toMatchObject({
    ok: true,
    anchor: {
      symbol: "A.run",
      span: { from: 7, to: 8 },
      resolved: { status: "ok", range: { startLine: 12, endLine: 13 } },
    },
  });
  store.setCursor("src/a.ts", 12, 25);
  expect(store.previewEvidence("usage")).toMatchObject({
    ok: true,
    anchor: { symbol: "A", span: { from: 11, to: 24 } },
  });
  store.setCursor("src/a.ts", 31);
  expect(store.previewEvidence("usage")).toMatchObject({ ok: false });
  const stale = makeBundle();
  stale.files["src/a.ts"] = "// new line\n" + stale.files["src/a.ts"];
  const changed = new ViewerStore(stale);
  changed.setCursor("src/a.ts", 12);
  expect(changed.previewEvidence("usage")).toEqual({
    ok: false,
    error: "This source differs from the index. Reindex and reload before selecting evidence.",
  });
});
