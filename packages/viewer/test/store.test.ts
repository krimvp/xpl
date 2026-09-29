import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ViewerStore } from "../src/store.js";
import { makeBundle, TEXTS } from "./world.js";

const GHOST_TARGET = "file:src/b.ts";

function graphStore(server = false, files = makeBundle().files) {
  const bundle = makeBundle({ files, ...(server ? { server: { api: "/api" } } : {}) });
  const view = bundle.explainer.views.find((v) => v.id === "view:overview")!;
  if (view.type === "graph") view.include = ["sym:src/a.ts#A.run"];
  return new ViewerStore(bundle);
}

describe("selection", () => {
  it("replaces, toggles and clears; a selection change clears the caret and the opened file", () => {
    const store = new ViewerStore(makeBundle(), { view: "view:flow" });
    store.click("flow:1");
    store.click("flow:2", true);
    expect(store.getState().selection).toEqual(["flow:1", "flow:2"]);
    store.click("flow:1", true);
    expect(store.getState().selection).toEqual(["flow:2"]);
    store.click("concept:retry");
    expect(store.getState().selection).toEqual(["concept:retry"]);

    store.setCursor("src/a.ts", 8);
    store.openFile("config/c.yaml");
    store.select(["flow:1"]);
    expect(store.getState().cursor).toBeUndefined();
    expect(store.getState().openedFile).toBeUndefined();
    store.clearSelection();
    expect(store.getState().selection).toEqual([]);
  });

  it("ignores duplicates and does not notify when nothing changes", () => {
    const store = new ViewerStore(makeBundle(), { view: "view:flow" });
    const seen: unknown[] = [];
    store.subscribe(() => seen.push(store.getState()));
    store.select(["flow:1", "flow:1"]);
    expect(store.getState().selection).toEqual(["flow:1"]);
    store.select(["flow:1"]);
    expect(seen).toHaveLength(1);
  });

  it("starts on the requested view, else the first; switching views clears the selection", () => {
    expect(new ViewerStore(makeBundle()).getState().viewId).toBe("view:overview");
    expect(new ViewerStore(makeBundle(), { view: "view:flow" }).getState().viewId).toBe(
      "view:flow",
    );
    expect(new ViewerStore(makeBundle(), { view: "view:nope" }).getState().viewId).toBe(
      "view:overview",
    );
    const store = new ViewerStore(makeBundle());
    store.select(["concept:retry"]);
    expect(store.setView("view:flow")).toBe(true);
    expect(store.getState().viewId).toBe("view:flow");
    expect(store.getState().selection).toEqual([]);
    expect(store.setView("view:nope")).toBe(false);
    expect(store.getState().viewId).toBe("view:flow");
  });
});

describe("the caret", () => {
  it("is normalised and only reported when it moved", () => {
    const store = new ViewerStore(makeBundle());
    let changes = 0;
    store.subscribe(() => changes++);
    store.setCursor("src/a.ts", 12.7, 3);
    expect(store.getState().cursor).toEqual({ file: "src/a.ts", fromLine: 12, toLine: 12 });
    store.setCursor("src/a.ts", 12);
    expect(changes).toBe(1);
    store.setCursor("src/a.ts", 0);
    expect(store.getState().cursor).toEqual({ file: "src/a.ts", fromLine: 1, toLine: 1 });
    store.clearCursor();
    expect(store.getState().cursor).toBeUndefined();
  });

  it("openFile shows a file (and moves the caret to a line); unknown files are ignored", () => {
    const store = new ViewerStore(makeBundle());
    store.openFile("nope.ts");
    expect(store.getState().openedFile).toBeUndefined();
    store.openFile("src/a.ts", 12);
    const state = store.getState();
    expect(state.openedFile).toBe("src/a.ts");
    expect(state.cursor).toEqual({ file: "src/a.ts", fromLine: 12, toLine: 12 });
    store.openFile("src/a.ts");
    expect(store.getState().openSeq).toBe(state.openSeq + 1);
    store.closeOpenedFile();
    expect(store.getState().openedFile).toBeUndefined();
  });
});

describe("view edits without a server", () => {
  it("expand, drill in, collapse and edge kinds edit the view in memory and mark it dirty", () => {
    const store = graphStore();
    const include = () => {
      const view = store.view();
      return view?.type === "graph" ? view.include : [];
    };
    expect(store.getState().dirty).toBe(false);

    store.expandStub({ ghost: GHOST_TARGET });
    expect(include()).toEqual(["sym:src/a.ts#A.run", GHOST_TARGET]);
    expect(store.getState().dirty).toBe(true);
    store.expandStub({ ghost: GHOST_TARGET }); // already there: nothing changes
    expect(include()).toEqual(["sym:src/a.ts#A.run", GHOST_TARGET]);

    expect(store.canDrillIn(GHOST_TARGET)).toBe(true);
    store.drillIn(GHOST_TARGET);
    expect(include()).toEqual(["sym:src/a.ts#A.run", GHOST_TARGET, "sym:src/b.ts#B"]);
    expect(store.canDrillIn(GHOST_TARGET)).toBe(false);
    store.collapse(GHOST_TARGET);
    expect(include()).toEqual(["sym:src/a.ts#A.run", GHOST_TARGET]);

    store.toggleEdgeKind("imports");
    store.toggleEdgeKind("calls");
    const view = store.view();
    expect(view?.type === "graph" && view.edgeKinds).toEqual(["imports", "extends", "implements"]);

    // The user's edits are recorded on the view and end up in the exported explainer.
    const exported = JSON.parse(store.explainerJson()) as {
      views: { id: string; provenance: { userFields: string[] } }[];
    };
    expect(exported.views.find((v) => v.id === "view:overview")!.provenance.userFields).toEqual([
      "include",
      "edgeKinds",
    ]);
  });

  it("drops selected elements that an edit removes from the view", () => {
    const bundle = makeBundle();
    const view = bundle.explainer.views.find((v) => v.id === "view:overview")!;
    if (view.type === "graph") view.include = ["file:src/a.ts", "file:src/b.ts", "sym:src/b.ts#B"];
    const store = new ViewerStore(bundle);
    // a child, a derived edge, a concept: the concept does not depend on the graph
    store.select(["sym:src/b.ts#B", "edge:calls:file:src/a.ts->file:src/b.ts", "concept:retry"]);
    store.collapse("file:src/b.ts");
    expect(store.getState().selection).toEqual([
      "edge:calls:file:src/a.ts->file:src/b.ts",
      "concept:retry",
    ]);
    store.toggleEdgeKind("calls");
    expect(store.getState().selection).toEqual(["concept:retry"]);
  });

  it("edits of a sequence view's graph actions are ignored", () => {
    const store = new ViewerStore(makeBundle(), { view: "view:flow" });
    store.expandStub({ ghost: GHOST_TARGET });
    store.toggleEdgeKind("calls");
    expect(store.getState().dirty).toBe(false);
  });

  it("explain requests fall back to the command when there is no server", async () => {
    const store = graphStore();
    await expect(store.requestExplain("concept:retry")).resolves.toBe("command");
  });

  it("a file that is not in the bundle is reported, not fetched", async () => {
    const files = { ...makeBundle().files };
    delete files["src/b.ts"];
    const store = graphStore(false, files);
    await store.ensureFile("src/b.ts");
    expect(store.getState().fileErrors["src/b.ts"]).toBe("not included in this bundle");
  });
});

describe("under xpl view (server mode)", () => {
  const calls: { url: string; init?: RequestInit }[] = [];
  let respond: (url: string, init?: RequestInit) => Response;

  beforeEach(() => {
    vi.useFakeTimers();
    calls.length = 0;
    respond = () => new Response("{}", { status: 200 });
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        calls.push({ url, ...(init ? { init } : {}) });
        return respond(url, init);
      }),
    );
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  const body = (i: number) => JSON.parse(String(calls[i]!.init!.body)) as Record<string, unknown>;

  it("persists view edits with PUT /views/<id>, coalescing quick edits into one request", async () => {
    const store = graphStore(true);
    store.expandStub({ ghost: GHOST_TARGET });
    store.toggleEdgeKind("reads");
    expect(store.getState().save).toEqual({ status: "saving" });
    expect(calls).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(400);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe("/api/views/view:overview");
    expect(calls[0]!.init!.method).toBe("PUT");
    expect(body(0)).toEqual({
      type: "graph",
      include: ["sym:src/a.ts#A.run", GHOST_TARGET],
      edgeKinds: ["calls", "extends", "implements", "reads"],
    });
    expect(store.getState().save).toEqual({ status: "saved" });
    expect(store.getState().dirty).toBe(false);
  });

  it("keeps a rejected edit and retries it with the next flush", async () => {
    const store = graphStore(true);
    respond = () =>
      new Response(JSON.stringify({ error: "read-only" }), {
        status: 403,
        statusText: "Forbidden",
      });
    store.expandStub({ ghost: GHOST_TARGET });
    await vi.advanceTimersByTimeAsync(400);
    expect(store.getState().save).toEqual({ status: "error", message: "403 Forbidden: read-only" });
    expect(store.getState().dirty).toBe(true);
    // a newer edit of another field: the failed one is sent again with it
    respond = () => new Response("{}", { status: 200 });
    store.toggleEdgeKind("imports");
    await vi.advanceTimersByTimeAsync(400);
    expect(body(calls.length - 1)).toEqual({
      type: "graph",
      include: ["sym:src/a.ts#A.run", GHOST_TARGET],
      edgeKinds: ["calls", "imports", "extends", "implements"],
    });
    expect(store.getState().save).toEqual({ status: "saved" });
    expect(store.getState().dirty).toBe(false);
  });

  it("flush() retries right away", async () => {
    const store = graphStore(true);
    respond = () => new Response("nope", { status: 500 });
    store.expandStub({ ghost: GHOST_TARGET });
    await vi.advanceTimersByTimeAsync(400);
    expect(store.getState().save.status).toBe("error");
    respond = () => new Response("{}", { status: 200 });
    await store.flush();
    expect(store.getState().save).toEqual({ status: "saved" });
    expect(calls).toHaveLength(2);
  });

  it("fetches files the bundle lacks, once", async () => {
    const files = { ...TEXTS };
    delete (files as Record<string, string>)["src/b.ts"];
    const store = graphStore(true, files);
    respond = (url) =>
      url === "/api/file?path=src%2Fb.ts"
        ? new Response(TEXTS["src/b.ts"], { headers: { "content-type": "text/plain" } })
        : new Response("?", { status: 404 });
    await Promise.all([store.ensureFile("src/b.ts"), store.ensureFile("src/b.ts")]);
    expect(store.getState().files["src/b.ts"]).toBe(TEXTS["src/b.ts"]);
    expect(calls.map((c) => c.url)).toEqual(["/api/file?path=src%2Fb.ts"]);
    await store.ensureFile("src/b.ts");
    expect(calls).toHaveLength(1);
    // present files are never fetched
    await store.ensureFile("src/a.ts");
    expect(calls).toHaveLength(1);
  });

  it("accepts JSON file bodies and records fetch failures per file", async () => {
    const store = graphStore(true, {});
    const json = (value: unknown) =>
      new Response(JSON.stringify(value), { headers: { "content-type": "application/json" } });
    respond = (url) =>
      url.includes("a.ts")
        ? json({ text: "from json" })
        : url.includes("c.yaml")
          ? json("a bare string")
          : new Response("gone", { status: 404, statusText: "Not Found" });
    await store.ensureFile("src/a.ts");
    await store.ensureFile("src/b.ts");
    await store.ensureFile("config/c.yaml");
    expect(store.getState().files["src/a.ts"]).toBe("from json");
    expect(store.getState().files["config/c.yaml"]).toBe("a bare string");
    expect(store.getState().fileErrors["src/b.ts"]).toBe("404 Not Found: gone");
  });

  it("queues explain requests with POST /requests", async () => {
    const store = graphStore(true);
    store.select(["concept:retry"]);
    await expect(store.requestExplain("concept:retry")).resolves.toBe("queued");
    expect(calls[0]!.url).toBe("/api/requests");
    expect(calls[0]!.init!.method).toBe("POST");
    expect(body(0)).toEqual({
      kind: "expand",
      id: "concept:retry",
      view: "view:overview",
      label: "Retry",
    });
    respond = () => new Response("busy", { status: 503, statusText: "Unavailable" });
    await expect(store.requestExplain("concept:retry")).rejects.toThrow("503 Unavailable: busy");
  });
});
