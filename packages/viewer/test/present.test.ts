import type { FocusRange } from "@xpl/core";
import { describe, expect, it } from "vitest";
import type { PaneSpec } from "../src/derive.js";
import { captionCap, captionFit } from "../src/present/caption.js";
import { rangePlaces, talkPanes } from "../src/present/ranges.js";
import { focusColumns } from "../src/present/split.js";
import { ViewerStore } from "../src/store.js";
import { searchFor, watchUrl } from "../src/url.js";
import { makeBundle } from "./world.js";

describe("the caption of a talk", () => {
  it("leaves the diagram 200px, or 45% of a very short column", () => {
    // 1280x720: a 659px column, a 40px title bar over the diagram
    expect(captionCap(659, 40)).toBe(659 - 8 - 40 - 200);
    // 853x480 with a two-row header: a 384px column
    expect(captionCap(384, 34)).toBe(384 - 8 - 34 - 173);
    expect(captionCap(150, 34)).toBe(80);
  });

  it("takes the largest type at which every caption fits, and scrolls only at the smallest", () => {
    // tallest caption at sizes 0..3
    const heights = [300, 260, 210, 180];
    const at = (size: number) => heights[size]!;
    expect(captionFit(at, 400, false)).toEqual({ size: 0, height: 300 });
    expect(captionFit(at, 250, false)).toEqual({ size: 2, height: 210 });
    expect(captionFit(at, 150, false)).toEqual({ size: 3, height: 150 });
    // a tour with a long note starts one size down, even when the larger one would fit
    expect(captionFit(at, 400, true)).toEqual({ size: 1, height: 260 });
  });
});

const range = (startLine: number, endLine: number, role: FocusRange["role"] = "definition") =>
  ({
    file: "tree.go",
    range: { startLine, endLine },
    role,
    elementId: `e${startLine}`,
    status: "ok",
  }) as FocusRange;

describe("two places in one file", () => {
  it("groups near ranges, and keeps far-apart ones apart", () => {
    const places = rangePlaces([range(414, 428), range(90, 95), range(429, 431), range(100, 102)]);
    expect(places.map((p) => [p.from, p.to])).toEqual([
      [90, 102],
      [414, 431],
    ]);
    // near but together too tall for one pane: two places
    expect(rangePlaces([range(10, 25), range(28, 40)]).length).toBe(2);
    // overlapping: always one
    expect(rangePlaces([range(10, 40), range(20, 50)]).length).toBe(1);
  });

  it("a talk shows each place in a pane of its own, the step's lead first", () => {
    const pane: PaneSpec = {
      file: "tree.go",
      ranges: [range(90, 95, "definition"), range(414, 428, "call-site")],
      focused: true,
      dim: true,
      opened: false,
      lead: 414,
    };
    const other: PaneSpec = { ...pane, file: "mux.go", ranges: [range(1, 3)], lead: 1 };
    const panes = talkPanes([pane, other]);
    expect(panes.map((p) => [p.file, p.part, p.lead, p.ranges.map((r) => r.role)])).toEqual([
      ["tree.go", 1, 414, ["call-site"]],
      ["tree.go", 2, 90, ["definition"]],
      ["mux.go", undefined, 1, ["definition"]],
    ]);
    // a file opened on purpose is shown whole
    expect(talkPanes([{ ...pane, opened: true }]).length).toBe(1);
  });
});

/** A window with just enough of `location` and `history` for `watchUrl`; Back is asynchronous, as in a browser. */
function fakeWindow(search: string) {
  const entries: { search: string; state: unknown }[] = [{ search, state: null }];
  let at = 0;
  const listeners = new Set<() => void>();
  const searchOf = (url: string) => new URL(url, "http://xpl.test").search;
  const go = (delta: number) => {
    const next = at + delta;
    if (next < 0 || next >= entries.length) return;
    at = next;
    queueMicrotask(() => listeners.forEach((listener) => listener()));
  };
  const win = {
    location: {
      pathname: "/",
      hash: "",
      get search() {
        return entries[at]!.search;
      },
    },
    history: {
      get state() {
        return entries[at]!.state;
      },
      pushState(state: unknown, _: string, url: string) {
        entries.splice(at + 1);
        entries.push({ search: searchOf(url), state });
        at += 1;
      },
      replaceState(state: unknown, _: string, url: string) {
        entries[at] = { search: searchOf(url), state };
      },
      back: () => go(-1),
      forward: () => go(1),
    },
    addEventListener: (_: string, listener: () => void) => listeners.add(listener),
    removeEventListener: (_: string, listener: () => void) => listeners.delete(listener),
  } as unknown as Window;
  return {
    win,
    entries,
    at: () => at,
    back: () => go(-1),
    forward: () => go(1),
  };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("Back, Forward and a talk", () => {
  it("Esc leaves a talk started on the page like Back does: the address then says what is on screen", async () => {
    const store = new ViewerStore(makeBundle(), { perspective: "guide" });
    const page = fakeWindow("?perspective=guide");
    watchUrl(store, undefined, page.win);
    store.present("tour:demo", 0);
    expect(page.entries.length).toBe(2);
    store.nextStep();
    store.exitPresent();
    await settle();
    expect(page.at()).toBe(0);
    expect(page.win.location.search).toBe(searchFor(store.getState(), "", undefined));
    expect(page.win.location.search).toContain("step=2");
  });

  it("Back during a talk leaves it; Forward resumes it", async () => {
    const store = new ViewerStore(makeBundle(), { perspective: "guide" });
    const page = fakeWindow("?perspective=guide");
    watchUrl(store, undefined, page.win);
    store.present("tour:demo", 1);
    page.back();
    await settle();
    expect(store.getState().mode).toBe("explore");
    expect(page.win.location.search).toBe(searchFor(store.getState(), "", undefined));
    page.forward();
    await settle();
    expect(store.getState().mode).toBe("present");
    expect(store.getState().tour).toEqual({ tourId: "tour:demo", step: 1 });
  });

  it("a page that opens in a talk: Esc keeps the tour and step, and Back returns to the talk", async () => {
    const bundle = makeBundle();
    bundle.mode = "present";
    const store = new ViewerStore(bundle, {});
    const page = fakeWindow("");
    watchUrl(store, "present", page.win);
    expect(page.win.location.search).toBe("?mode=present&tour=tour:demo&step=1");
    store.nextStep();
    store.exitPresent();
    expect(page.entries.length).toBe(2);
    expect(page.win.location.search).toBe("?mode=explore&tour=tour:demo&step=2");
    page.back();
    await settle();
    expect(store.getState().mode).toBe("present");
    expect(store.getState().tour!.step).toBe(1);
    expect(page.win.location.search).toBe("?mode=present&tour=tour:demo&step=2");
  });
});

describe("the one split of a talk", () => {
  it("is as wide as most of the lines the tour focuses, not its longest one", () => {
    const store = new ViewerStore(makeBundle(), {});
    const { model, files } = store.getState();
    const tour = model.explainer.tours!.find((t) => t.id === "tour:demo")!;
    const plain = focusColumns(tour, model, files);
    expect(plain).toBeGreaterThan(0);
    expect(plain).toBeLessThan(20);
    // one odd long line does not decide; when most of the focused code is long, the split follows it
    const one = { ...files, "src/a.ts": files["src/a.ts"]!.replace("line 7;", "x".repeat(150)) };
    expect(focusColumns(tour, model, one)).toBe(plain);
    const long = Object.fromEntries(
      Object.entries(files).map(([path, text]) => [path, text.replace(/line/g, "line".repeat(20))]),
    );
    expect(focusColumns(tour, model, long)).toBeGreaterThan(60);
    // code that is not loaded says nothing
    expect(focusColumns(tour, model, {})).toBe(0);
  });
});
