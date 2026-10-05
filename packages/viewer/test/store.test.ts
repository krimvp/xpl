import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { artifactIdentity, reviewFingerprint, type ReviewScope } from "@xpl/core";
import { ServerApi } from "../src/data.js";
import { ViewerStore } from "../src/store.js";
import { getDerived } from "../src/derive.js";
import { makeBundle, TEXTS } from "./world.js";

const GHOST_TARGET = "file:src/b.ts";

function graphStore(server = false, files = makeBundle().files) {
  const bundle = makeBundle({ files, ...(server ? { server: { api: "/api" } } : {}) });
  const view = bundle.explainer.views.find((v) => v.id === "view:overview")!;
  if (view.type === "graph") view.include = ["sym:src/a.ts#A.run"];
  return new ViewerStore(bundle);
}

it("checks the stored attachment identity and keeps history across a managed restart", () => {
  const history = JSON.stringify({
    identity: '["attachment","/repo/a","guide-a"]',
    undo: [
      [
        {
          collection: "concepts",
          id: "concept:retry",
          before: { summary: "Saved." },
          after: { summary: null },
        },
      ],
    ],
    redo: [],
  });
  // Browser storage is untrusted; a copied record must be checked even if the key matches.
  vi.stubGlobal("localStorage", { getItem: () => history });
  try {
    const counts = [
      { root: "/repo/a", guide: "guide-a", instanceId: "restarted" },
      { root: "/repo/b", guide: "guide-a", instanceId: "restarted" },
      { root: "/repo/a", guide: "guide-b", instanceId: "restarted" },
    ].map(
      (attachment) =>
        new ViewerStore(
          makeBundle({
            server: Object.assign({ api: "/api" }, { attachment }),
          }),
        ).getState().undoCount,
    );
    expect(counts).toEqual([1, 0, 0]);
  } finally {
    vi.unstubAllGlobals();
  }
});

it("does not restore content-derived history on a live page without attachment identity", () => {
  const bundle = makeBundle({ server: { api: "/api" } });
  const identity = artifactIdentity(bundle.explainer, bundle.index);
  const record = JSON.stringify({
    identity: JSON.stringify(["explainer", identity.explainerHash, identity.sourceHash]),
    undo: [
      [
        {
          collection: "concepts",
          id: "concept:retry",
          before: { summary: "Saved." },
          after: { summary: null },
        },
      ],
    ],
    redo: [],
  });
  vi.stubGlobal("localStorage", { getItem: () => record });
  try {
    expect(new ViewerStore(bundle).getState().undoCount).toBe(0);
  } finally {
    vi.unstubAllGlobals();
  }
});

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
    const store = new ViewerStore(makeBundle(), { mode: "explore" });
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

  it("setStubMode edits the view's stub policy (keeping its max), like the other view edits", () => {
    const store = graphStore();
    const stubs = () => {
      const view = store.view();
      return view?.type === "graph" ? view.stubs : undefined;
    };
    expect(stubs()).toBeUndefined();
    store.setStubMode("top"); // already the default: nothing to store
    expect(stubs()).toBeUndefined();
    expect(store.getState().dirty).toBe(false);
    store.setStubMode("all");
    expect(stubs()).toEqual({ mode: "all" });
    expect(store.getState().dirty).toBe(true);
    store.setStubMode("all"); // no change, no new edit
    const before = store.getState().explainer;
    store.setStubMode("all");
    expect(store.getState().explainer).toBe(before);
    store.setStubMode("none");
    expect(stubs()).toEqual({ mode: "none" });
    // a max the view carries stays
    const view = store.view();
    if (view?.type === "graph") view.stubs = { mode: "none", max: 3 };
    store.setStubMode("top");
    expect(stubs()).toEqual({ mode: "top", max: 3 });
    const exported = JSON.parse(store.explainerJson()) as {
      views: { id: string; provenance: { userFields: string[] } }[];
    };
    expect(exported.views.find((v) => v.id === "view:overview")!.provenance.userFields).toEqual([
      "stubs",
    ]);
  });

  it("a folded ghost expands nothing; one of its targets does", () => {
    const bundle = makeBundle();
    const view = bundle.explainer.views.find((v) => v.id === "view:overview")!;
    if (view.type === "graph") view.include = ["sym:src/a.ts#A.run"];
    const store = new ViewerStore(bundle);
    store.expandStub({ ghost: "rest:file:src/a.ts" });
    store.expandStub({ ghost: "more:out" });
    expect(store.getState().dirty).toBe(false);
    store.expandStub({ ghost: "sym:src/a.ts#A.stop" });
    const now = store.view();
    expect(now?.type === "graph" && now.include).toEqual([
      "sym:src/a.ts#A.run",
      "sym:src/a.ts#A.stop",
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
  let respond: (url: string, init?: RequestInit) => Response | Promise<Response>;

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

  it("does not retry an author save accepted after going offline", async () => {
    const bundle = makeBundle({
      server: {
        api: "/api",
        attachment: {
          root: "/repos/jobrunner",
          guide: ".explainer/demo.explainer.json",
          instanceId: "author",
          backend: "none",
          backendAvailable: false,
        },
      },
    });
    const store = new ViewerStore(structuredClone(bundle));
    const captured = store.captureEdit("concepts", "concept:retry", {
      summary: "Saved author text.",
    });
    let finish!: (response: Response) => void;
    respond = () =>
      new Promise<Response>((resolve) => {
        finish = resolve;
      });
    const saving = store.saveEdits([captured.edit], captured.version);
    await vi.waitFor(() => expect(calls.map(({ url }) => url)).toEqual(["/api/edits"]));
    store.useOfflineSnapshot();
    bundle.explainer.concepts[0]!.summary = "Saved author text.";
    finish(
      new Response(
        JSON.stringify({
          explainer: bundle.explainer,
          inverse: [
            {
              collection: "concepts",
              id: "concept:retry",
              before: { summary: "Saved author text." },
              after: { summary: "Tries again." },
            },
          ],
        }),
      ),
    );
    await saving;
    expect(store.getState().dirty).toBe(false);
    expect(store.getState().connection.status).toBe("offline");
    store.setStubMode("none");
    const view = store.view();
    expect(view?.type === "graph" && view.stubs).toEqual({ mode: "none" });
    expect(store.getState().dirty).toBe(true);
    expect(store.getState().undoCount).toBe(1);
    expect(store.getState().textDrafts).toEqual({});
    respond = (url) =>
      new Response(JSON.stringify(url === "/api/bundle" ? bundle : bundle.explainer));
    await store.reconnect();
    await store.flush();
    expect(calls.filter(({ url }) => url === "/api/edits")).toHaveLength(1);
    expect(store.getState().dirty).toBe(false);
    expect(store.getState().undoCount).toBe(1);
  });

  it("binds review saves to the loaded repository and guide", async () => {
    const api = new ServerApi("/api", {
      root: "/repos/jobrunner",
      guide: ".explainer/demo.explainer.json",
      instanceId: "first",
      backend: "none",
      backendAvailable: false,
    });
    await api.putReview(null);
    expect(calls.map(({ url, init }) => ({ url, method: init?.method }))).toEqual([
      { url: "/api/review", method: "PUT" },
    ]);
    expect(body(0)).toEqual({ review: null });
    const header = new Headers(calls[0]!.init?.headers).get("X-Xpl-Attachment");
    expect(header === null ? null : JSON.parse(decodeURIComponent(header))).toEqual({
      root: "/repos/jobrunner",
      guide: ".explainer/demo.explainer.json",
    });
  });

  it("detects a stopped attachment with unsaved edits, supports offline feedback, and retries the same guide", async () => {
    const bundle = makeBundle({ server: { api: "/api" } });
    bundle.server!.attachment = {
      root: "/repos/jobrunner",
      guide: ".explainer/demo.explainer.json",
      instanceId: "first",
      backend: "claude",
      backendAvailable: false,
    };
    const store = new ViewerStore(bundle);
    store.select(["concept:retry"]);
    const fresh = () =>
      new Response(JSON.stringify(bundle), { headers: { "content-type": "application/json" } });
    respond = (url) =>
      url === "/api/bundle"
        ? fresh()
        : new Response(JSON.stringify(bundle.explainer), { headers: { etag: '"first"' } });
    const stop = store.watchExplainer(1000);
    await vi.advanceTimersByTimeAsync(1000);
    expect(store.getState().connection.status).toBe("connected");
    store.toggleEdgeKind("reads");
    respond = () => {
      throw new TypeError("Failed to fetch");
    };
    await vi.advanceTimersByTimeAsync(1000);
    expect(store.getState().connection.status).toBe("disconnected");
    expect(store.getState().dirty).toBe(true);
    store.useOfflineSnapshot();
    expect(store.getState().serverMode).toBe(false);
    store.setStubMode("none");
    await expect(store.requestExplain("concept:retry", "Offline note")).resolves.toBe("command");
    const before = calls.length;
    await vi.advanceTimersByTimeAsync(1000);
    expect(calls).toHaveLength(before);
    bundle.server!.attachment.instanceId = "restarted";
    respond = (url) =>
      url === "/api/bundle"
        ? fresh()
        : new Response(JSON.stringify(bundle.explainer), { headers: { etag: '"restarted"' } });
    await store.reconnect();
    expect(store.getState().connection.status).toBe("connected");
    expect(store.getState().connection.attachment?.instanceId).toBe("restarted");
    expect(store.getState().selection).toEqual(["concept:retry"]);
    expect(store.getState().dirty).toBe(true);
    expect(JSON.parse(store.feedbackJson()).requests[0].note).toBe("Offline note");
    const header = new Headers(calls.at(-1)!.init!.headers).get("X-Xpl-Attachment")!;
    expect(JSON.parse(decodeURIComponent(header))).toEqual({
      root: "/repos/jobrunner",
      guide: ".explainer/demo.explainer.json",
    });
    await store.flush();
    expect(store.getState().dirty).toBe(false);
    expect(JSON.parse(String(calls.at(-1)!.init!.body))).toMatchObject({
      stubs: { mode: "none" },
      edgeKinds: ["calls", "extends", "implements", "reads"],
    });
    stop();
  });

  it("refuses a changed guide in a refreshed bundle and keeps polling a managed unavailable service", async () => {
    const bundle = makeBundle({
      server: {
        api: "/api",
        attachment: {
          root: "/repos/jobrunner",
          guide: ".explainer/demo.explainer.json",
          instanceId: "first",
          backend: "none",
          backendAvailable: false,
        },
      },
    });
    const store = new ViewerStore(bundle);
    const changed = structuredClone(bundle);
    changed.server!.attachment!.guide = ".explainer/other.explainer.json";
    changed.explainer.title = "Another guide";
    respond = (url) =>
      new Response(JSON.stringify(url === "/api/bundle" ? changed : changed.explainer));
    const stop = store.watchExplainer(1000);
    await vi.advanceTimersByTimeAsync(1000);
    expect(store.getState().connection.status).toBe("unavailable");
    expect(store.getState().explainer.title).toBe(bundle.explainer.title);
    respond = () => new Response("temporarily missing", { status: 404 });
    await vi.advanceTimersByTimeAsync(2000);
    expect(store.getState().connection.status).toBe("unavailable");
    respond = (url) =>
      new Response(JSON.stringify(url === "/api/bundle" ? bundle : bundle.explainer));
    await vi.advanceTimersByTimeAsync(1000);
    expect(store.getState().connection.status).toBe("connected");
    stop();
  });

  it.each(["single", "tour", "newer view edit"] as const)(
    "reconciles an in-flight save across offline mode with %s pending",
    async (remaining) => {
      const store = graphStore(true);
      store.setStubMode("none");
      if (remaining === "tour") store.addToTour({ title: "Offline boundary" });
      let finish!: (response: Response) => void;
      respond = () =>
        new Promise<Response>((resolve) => {
          finish = resolve;
        });
      const saving = store.flush();
      expect(calls.map(({ url }) => url)).toEqual(["/api/views/view:overview"]);
      store.useOfflineSnapshot();
      if (remaining === "newer view edit") store.setStubMode("all");
      respond = () => new Response("{}", { status: 200 });
      finish(new Response("{}", { status: 200 }));
      await saving;
      expect(calls.map(({ url }) => url)).toEqual(["/api/views/view:overview"]);
      expect(store.getState().dirty).toBe(remaining !== "single");
      expect(store.getState().connection.status).toBe("offline");
      expect(store.getState().save.status).toBe(remaining === "single" ? "saved" : "idle");
      if (remaining === "single") {
        expect(store.adoptExplainer(makeBundle().explainer)).toBe(true);
        const bundle = makeBundle({ server: { api: "/api" } });
        respond = (url) =>
          new Response(JSON.stringify(url === "/api/bundle" ? bundle : bundle.explainer));
        await store.reconnect();
        expect(store.getState().dirty).toBe(false);
        expect(store.getState().save.status).toBe("saved");
      }
    },
  );

  it.each([
    ["addition", false],
    ["addition", true],
    ["removal", false],
    ["removal", true],
  ] as const)(
    "retries an offline review %s alongside queued view edits: %s",
    async (action, edit) => {
      const bundle = makeBundle({ server: { api: "/api" } });
      const scope: ReviewScope = { content: ["concept:retry"], source: "anchored" };
      const review = {
        reviewer: "Offline reader",
        reviewedAt: "2026-10-05T06:00:00Z",
        scope,
        omissions: [],
        fingerprint: reviewFingerprint(
          bundle.explainer,
          bundle.index,
          (file) => bundle.files[file],
          scope,
        ),
      };
      if (action === "removal")
        bundle.explainer.review = { ...review, sourceCommit: bundle.index.commit };
      const store = new ViewerStore(structuredClone(bundle));
      const stop = store.watchExplainer(1000);
      store.useOfflineSnapshot();
      if (edit) store.setStubMode("none");
      await store.recordReview(
        { ...bundle, explainer: store.getState().explainer },
        action === "removal" ? null : review,
      );
      expect(store.getState().dirty).toBe(true);
      expect(store.getState().explainer.review?.reviewer).toBe(
        action === "removal" ? undefined : "Offline reader",
      );
      let refuse = true;
      respond = (url, init) => {
        if (url === "/api/review") {
          if (refuse)
            return new Response(JSON.stringify({ error: "Review must be inspected again." }), {
              status: 409,
            });
          const saved = JSON.parse(String(init?.body)).review;
          if (saved === null) delete bundle.explainer.review;
          else bundle.explainer.review = { ...saved, sourceCommit: bundle.index.commit };
          return new Response("{}");
        }
        return new Response(JSON.stringify(url === "/api/bundle" ? bundle : bundle.explainer));
      };
      await store.reconnect();
      await store.flush();
      expect(calls.filter(({ url }) => url === "/api/review")).toHaveLength(1);
      expect(store.getState().dirty).toBe(true);
      await vi.advanceTimersByTimeAsync(1000);
      expect(store.getState().explainer.review?.reviewer).toBe(
        action === "removal" ? undefined : "Offline reader",
      );
      refuse = false;
      await store.flush();
      const reviews = calls.filter(({ url }) => url === "/api/review");
      expect(reviews).toHaveLength(2);
      expect(JSON.parse(String(reviews[1]!.init!.body))).toEqual({
        review: action === "removal" ? null : review,
      });
      expect(store.getState().dirty).toBe(false);
      await vi.advanceTimersByTimeAsync(1000);
      expect(store.getState().explainer.review?.reviewer).toBe(
        action === "removal" ? undefined : "Offline reader",
      );
      stop();
    },
  );

  it("a refused live review leaves concurrent failed edits retryable", async () => {
    const bundle = makeBundle({ server: { api: "/api" } });
    const scope: ReviewScope = { content: "all", source: "anchored" };
    const review = {
      reviewer: "Live reader",
      reviewedAt: "2026-10-05T06:00:00Z",
      scope,
      omissions: [],
      fingerprint: reviewFingerprint(
        bundle.explainer,
        bundle.index,
        (file) => bundle.files[file],
        scope,
      ),
    };
    const store = new ViewerStore(bundle);
    let finish!: (response: Response) => void;
    respond = () =>
      new Promise<Response>((resolve) => {
        finish = resolve;
      });
    const recording = store.recordReview(bundle, review);
    await vi.advanceTimersByTimeAsync(0);
    expect(calls.map(({ url }) => url)).toEqual(["/api/review"]);
    store.toggleEdgeKind("reads");
    respond = () => new Response(JSON.stringify({ error: "View write refused." }), { status: 403 });
    const refused = expect(recording).rejects.toThrow("inspect again");
    finish(
      new Response(JSON.stringify({ error: "Reviewed content changed; inspect again." }), {
        status: 400,
      }),
    );
    await refused;
    expect(store.getState().explainer.review).toBeUndefined();
    expect(store.getState().dirty).toBe(true);
    expect(store.getState().save.status).toBe("error");
    respond = () => new Response("{}");
    await store.flush();
    expect(calls.map(({ url }) => url)).toEqual([
      "/api/review",
      "/api/views/view:overview",
      "/api/views/view:overview",
    ]);
    expect(body(2)).toEqual({
      type: "graph",
      edgeKinds: ["calls", "extends", "implements", "reads"],
    });
    expect(store.getState().dirty).toBe(false);
  });

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

  it("persists the stub mode as a `stubs` field of the view", async () => {
    const store = graphStore(true);
    store.setStubMode("none");
    await vi.advanceTimersByTimeAsync(400);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe("/api/views/view:overview");
    expect(body(0)).toEqual({ type: "graph", stubs: { mode: "none" } });
    expect(store.getState().save).toEqual({ status: "saved" });
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
    expect(body(0)).toMatchObject({
      kind: "expand",
      elementId: "concept:retry",
      id: expect.any(String),
      context: { explainerHash: expect.any(String), sourceHash: expect.any(String) },
      outcome: { status: "pending", reason: "Awaiting an explicit revision pass." },
      view: "view:overview",
      label: "Retry",
    });
    respond = () => new Response("busy", { status: 503, statusText: "Unavailable" });
    await expect(store.requestExplain("concept:retry")).rejects.toThrow("503 Unavailable: busy");
    expect(
      JSON.parse(store.feedbackJson()).requests.map((r: { elementId: string }) => r.elementId),
    ).toEqual(["concept:retry", "concept:retry"]);
  });

  it("sends what the user wants changed as the request's note", async () => {
    const store = graphStore(true);
    await store.requestExplain("concept:retry", "  too long  ");
    expect(body(0)).toMatchObject({ kind: "expand", elementId: "concept:retry", note: "too long" });
    await store.requestExplain("concept:retry", "   ");
    expect(body(1)).not.toHaveProperty("note");
  });

  it("polls GET /explainer and shows what changed on disk, keeping the view and the selection", async () => {
    const store = graphStore(true);
    store.select(["concept:retry"]);
    const changed = structuredClone(store.getState().explainer);
    changed.concepts.find((c) => c.id === "concept:retry")!.summary = "Shorter now.";
    let served: Response = new Response(JSON.stringify(changed), {
      headers: { "content-type": "application/json", etag: '"v2"' },
    });
    respond = (url) =>
      url === "/api/bundle"
        ? new Response(JSON.stringify(makeBundle({ explainer: changed })))
        : served;
    const stop = store.watchExplainer(1000);

    await vi.advanceTimersByTimeAsync(1000);
    expect(calls.map((c) => c.url)).toEqual(["/api/explainer", "/api/bundle"]);
    expect(store.getState().model.concept("concept:retry")?.summary).toBe("Shorter now.");
    expect(store.getState().selection).toEqual(["concept:retry"]);
    expect(store.getState().viewId).toBe("view:overview");

    served = new Response(null, { status: 304 });
    await vi.advanceTimersByTimeAsync(1000);
    expect(new Headers(calls[2]!.init!.headers).get("if-none-match")).toBe('"v2"');

    // an older `xpl view` has no such endpoint: stop asking
    respond = () => new Response("not found", { status: 404, statusText: "Not Found" });
    await vi.advanceTimersByTimeAsync(3000);
    expect(calls).toHaveLength(4);
    // Explicit Retry still checks an older server; it must not remain "connecting" forever.
    await store.reconnect();
    expect(store.getState().connection.status).toBe("unavailable");
    await vi.advanceTimersByTimeAsync(3000);
    expect(calls).toHaveLength(5);
    stop();
  });

  it("refreshes loaded source, the index and warnings even when the explanation is unchanged", async () => {
    const store = graphStore(true);
    store.select(["sym:src/a.ts#A.run"]);
    const bundle = makeBundle({ files: { "src/a.ts": "edited source" } });
    bundle.index.commit = "new-index";
    bundle.sourceWarning = "Reindex changed source";
    respond = (url) =>
      url === "/api/explainer"
        ? new Response(JSON.stringify(bundle.explainer), { headers: { etag: '"new"' } })
        : url === "/api/bundle"
          ? new Response(JSON.stringify(bundle))
          : new Response("fresh separately opened file");
    const stop = store.watchExplainer(1000);
    await vi.advanceTimersByTimeAsync(1000);
    expect(store.getState().files["src/a.ts"]).toBe("edited source");
    expect(store.getState().files["src/b.ts"]).toBe("fresh separately opened file");
    expect(store.getState().model.index.commit).toBe("new-index");
    expect(store.getState().selection).toEqual(["sym:src/a.ts#A.run"]);
    expect(store.getState().sourceWarning).toBe("Reindex changed source");
    stop();
  });

  it("does not let a file request from the previous workspace overwrite refreshed source", async () => {
    const store = graphStore(true, {});
    let finish: (response: Response) => void = () => undefined;
    const oldResponse = new Promise<Response>((resolve) => {
      finish = resolve;
    });
    respond = () => oldResponse;
    const loading = store.ensureFile("src/a.ts");
    const refreshed = makeBundle({ files: { "src/a.ts": "new source" } });
    store.adoptExplainer(refreshed.explainer, refreshed);
    finish(new Response("old source"));
    await loading;
    expect(store.getState().files["src/a.ts"]).toBe("new source");
  });

  it("does not replace the explainer while an edit made here is not saved yet", () => {
    const store = graphStore(true);
    store.expandStub({ ghost: GHOST_TARGET });
    const changed = structuredClone(store.getState().explainer);
    changed.concepts.find((c) => c.id === "concept:retry")!.summary = "From disk.";
    expect(store.adoptExplainer(changed)).toBe(false);
    expect(store.getState().model.concept("concept:retry")?.summary).not.toBe("From disk.");
  });

  it("keeps the selected item and open text draft until save or cancel", () => {
    const store = new ViewerStore(makeBundle());
    store.select(["concept:retry"]);
    store.captureEdit("concepts", "concept:retry", {
      summary: store.getState().model.concept("concept:retry")?.summary ?? null,
    });
    store.updateEditDraft("concept:retry", { summary: "Draft." });
    const changed = { ...store.getState().explainer, concepts: [] };
    expect(store.adoptExplainer(changed)).toBe(false);
    expect(store.getState().selection).toEqual(["concept:retry"]);
    store.cancelEdit("concept:retry");
    expect(store.adoptExplainer(changed)).toBe(true);
    expect(store.getState().selection).toEqual([]);
  });
});

it("graph author saves and undo clear invisible selections and stay unavailable during presentation", async () => {
  const store = new ViewerStore(makeBundle());
  store.setMode("explore");
  store.select(["grp:core"]);
  await store.editGraph("view:overview", { type: "ungroup", id: "grp:core" });
  expect(store.getState().selection).toEqual([]);
  store.select(["file:src/a.ts", "file:src/b.ts"]);
  await store.editGraph("view:overview", {
    type: "group",
    id: "grp:work",
    label: "Work",
    members: ["file:src/a.ts", "file:src/b.ts"],
  });
  expect(store.getState().selection).toEqual(["file:src/a.ts", "file:src/b.ts"]);
  expect(store.getState().undoCount).toBe(2);
  store.select(["grp:work"]);
  await store.undoEdit();
  expect(store.getState().selection).toEqual([]);
  expect(store.getState().model.hasNode("grp:work")).toBe(false);
  await store.undoEdit(true);
  store.select(["file:src/a.ts"]);
  await store.editGraph("view:overview", { type: "hide", ids: ["file:src/a.ts"] });
  expect(store.getState().selection).toEqual([]);
  expect(store.getState().undoCount).toBe(3);
  await store.undoEdit();
  store.select(["file:src/a.ts"]);
  expect(store.getState().model.node("file:src/a.ts")?.label).toBe("a.ts");
  expect(store.getState().undoCount).toBe(2);
  store.setPerspective("map");
  await expect(
    store.editGraph("view:overview", { type: "hide", ids: ["file:src/a.ts"] }),
  ).rejects.toThrow("Open Explore");
  store.setMode("present");
  await expect(
    store.editGraph("view:overview", { type: "hide", ids: ["file:src/a.ts"] }),
  ).rejects.toThrow("Open Explore");
});

it("hides a box opened in place without persisting navigation, and undo keeps the open level", async () => {
  const bundle = makeBundle();
  bundle.explainer.nodes.find((n) => n.id === "grp:core")!.opens = "view:inside";
  bundle.explainer.views.push({
    id: "view:inside",
    type: "graph",
    title: "Inside",
    provenance: { origin: "llm" },
    scope: { root: "grp:core", depth: 1 },
    include: ["file:src/a.ts", "file:src/b.ts"],
  });
  const store = new ViewerStore(bundle);
  store.setMode("explore");
  store.toggleExpanded("grp:core");
  expect(getDerived(store.getState()).view.graph?.nodes.map((n) => n.id)).toEqual([
    "file:config/c.yaml",
    "file:src/a.ts",
    "file:src/b.ts",
    "grp:core",
  ]);
  store.select(["file:src/a.ts"]);
  await store.editGraph("view:overview", { type: "hide", ids: ["file:src/a.ts"] });
  expect(getDerived(store.getState()).view.graph?.nodes.map((n) => n.id)).toEqual([
    "file:config/c.yaml",
    "file:src/b.ts",
    "grp:core",
  ]);
  expect(store.getState().selection).toEqual([]);
  expect((store.getState().model.view("view:overview") as { include: string[] }).include).toEqual([
    "grp:core",
    "file:config/c.yaml",
  ]);
  expect(store.getState().undoCount).toBe(1);
  await store.undoEdit();
  expect(getDerived(store.getState()).view.graph?.nodes.map((n) => n.id)).toEqual([
    "file:config/c.yaml",
    "file:src/a.ts",
    "file:src/b.ts",
    "grp:core",
  ]);
  expect(store.getState().expanded.has("grp:core")).toBe(true);
});
