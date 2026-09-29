/**
 * The viewer's state and everything that changes it. A tiny external store (React reads it with
 * `useSyncExternalStore`, see hooks.ts) so that `window.__xpl` (testHooks.ts) and the UI go through
 * exactly the same actions.
 *
 * State is one immutable object; every action swaps in a new one. Anything derived from it (the graph of
 * the current view, code focus, reverse lookup, matches) lives in derive.ts and is memoised per state.
 */
import {
  asIndexModel,
  collapse as collapseView,
  DEFAULT_EDGE_KINDS,
  deriveGraph,
  drillChildren,
  drillIn as drillInView,
  EDGE_KINDS,
  expandStub as expandStubView,
  ExplainerModel,
  parseId,
  type Edge,
  type ElementId,
  type Explainer,
  type FilePath,
  type GraphView,
  type IndexModel,
  type Stub,
  type View,
  type ViewerBundle,
} from "@xpl/core";
import { messageOf, ServerApi, type LaunchParams } from "./data.js";
import { serializeExplainer, withViewFields } from "./edits.js";
import { PRESENT_AVAILABLE, type Mode, type TourPosition } from "./modes.js";

/** The editor caret, or the lines of a selection, in one file (1-based, inclusive). */
export interface Cursor {
  file: FilePath;
  fromLine: number;
  toLine: number;
}

export type SaveState =
  | { status: "idle" }
  | { status: "saving" }
  | { status: "saved" }
  | { status: "error"; message: string };

export interface ViewerState {
  explainer: Explainer;
  model: ExplainerModel;
  /** The view on screen; undefined only when the explainer has no views. */
  viewId: string | undefined;
  /** Selected element ids, in the order they were added. */
  selection: readonly ElementId[];
  cursor: Cursor | undefined;
  /**
   * A file the user asked for (file tree, anchor list, `setCursor`). It goes first in the editor stack,
   * focused or not. Cleared when the selection changes.
   */
  openedFile: FilePath | undefined;
  /** Bumped every time a file is opened explicitly, so the stack scrolls to it even if it was open. */
  openSeq: number;
  /** Explore or Present (Present is a later phase: see modes.ts). */
  mode: Mode;
  tour: TourPosition | undefined;
  /** Source text of the files loaded so far (all of them in a static bundle). */
  files: Readonly<Record<FilePath, string>>;
  /** Files that could not be loaded, with the reason. */
  fileErrors: Readonly<Record<FilePath, string>>;
  /** View edits exist that are not persisted (always true after an edit without a server). */
  dirty: boolean;
  save: SaveState;
  /** Running under `xpl view`. */
  serverMode: boolean;
}

/** Delay before queued view edits are sent to the server (coalesces rapid toggling). */
const SAVE_DELAY_MS = 250;

export class ViewerStore {
  private state: ViewerState;
  private readonly listeners = new Set<() => void>();
  private readonly api: ServerApi | undefined;
  private readonly indexModel: IndexModel;
  private readonly loading = new Set<FilePath>();
  private readonly pending = new Map<string, Record<string, unknown>>();
  private saveTimer: ReturnType<typeof setTimeout> | undefined;
  private saving: Promise<void> | undefined;

  constructor(bundle: ViewerBundle, launch: LaunchParams = {}) {
    this.indexModel = asIndexModel(bundle.index);
    this.api = bundle.server?.api ? new ServerApi(bundle.server.api) : undefined;
    const explainer = bundle.explainer;
    const model = new ExplainerModel(explainer, this.indexModel);
    const views = model.views;
    const viewId = views.find((v) => v.id === launch.view)?.id ?? views[0]?.id;

    const requested = launch.mode ?? bundle.mode ?? "explore";
    const tourId = launch.tour ?? bundle.tour;
    this.state = {
      explainer,
      model,
      viewId,
      selection: [],
      cursor: undefined,
      openedFile: undefined,
      openSeq: 0,
      mode: PRESENT_AVAILABLE ? requested : "explore",
      tour: tourId !== undefined ? { tourId, step: launch.step ?? 0 } : undefined,
      files: bundle.files,
      fileErrors: {},
      dirty: false,
      save: { status: "idle" },
      serverMode: this.api !== undefined,
    };
  }

  // ─── Subscription (arrow properties: passed straight to useSyncExternalStore) ────────────────

  readonly getState = (): ViewerState => this.state;

  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  private set(patch: Partial<ViewerState>): void {
    this.state = { ...this.state, ...patch };
    for (const listener of [...this.listeners]) listener();
  }

  // ─── Views ───────────────────────────────────────────────────────────────────────────────────

  view(): View | undefined {
    const { model, viewId } = this.state;
    return viewId === undefined ? undefined : model.view(viewId);
  }

  setView(id: string): boolean {
    if (!this.state.model.view(id)) return false;
    if (id === this.state.viewId) return true;
    this.set({ viewId: id, selection: [], cursor: undefined, openedFile: undefined });
    return true;
  }

  // ─── Selection ───────────────────────────────────────────────────────────────────────────────

  select(ids: readonly ElementId[]): void {
    const selection = [...new Set(ids)];
    const current = this.state.selection;
    if (
      selection.length === current.length &&
      selection.every((id, i) => id === current[i]) &&
      this.state.cursor === undefined &&
      this.state.openedFile === undefined
    ) {
      return;
    }
    this.set({ selection, cursor: undefined, openedFile: undefined });
  }

  /** Shift-click: adds the element, or removes it when it is already selected. */
  toggle(id: ElementId): void {
    const current = this.state.selection;
    this.select(current.includes(id) ? current.filter((x) => x !== id) : [...current, id]);
  }

  /** A click on any diagram element or concept. */
  click(id: ElementId, additive = false): void {
    if (additive) this.toggle(id);
    else this.select([id]);
  }

  clearSelection(): void {
    this.select([]);
  }

  // ─── Code side ───────────────────────────────────────────────────────────────────────────────

  /**
   * The caret (or the lines of a selection) moved in an editor. Drives the reverse lookup. Real cursor
   * moves and `window.__xpl.setCursor` both end up here.
   */
  setCursor(file: FilePath, fromLine: number, toLine: number = fromLine): void {
    const from = Math.max(1, Math.floor(fromLine));
    const to = Math.max(from, Math.floor(toLine));
    const cur = this.state.cursor;
    if (cur && cur.file === file && cur.fromLine === from && cur.toLine === to) return;
    this.set({ cursor: { file, fromLine: from, toLine: to } });
  }

  clearCursor(): void {
    if (this.state.cursor !== undefined) this.set({ cursor: undefined });
  }

  /** Shows a file first in the editor stack (file tree, anchor list). `line` also moves the cursor there. */
  openFile(file: FilePath, line?: number): void {
    if (!this.indexModel.hasFile(file)) return;
    void this.ensureFile(file);
    const patch: Partial<ViewerState> = { openedFile: file, openSeq: this.state.openSeq + 1 };
    if (line !== undefined) {
      const at = Math.max(1, Math.floor(line));
      patch.cursor = { file, fromLine: at, toLine: at };
    }
    this.set(patch);
  }

  /** Closes the pane of a file that was opened but is not part of the focus. */
  closeOpenedFile(): void {
    if (this.state.openedFile !== undefined) this.set({ openedFile: undefined });
  }

  /** Loads a file's text from the server when the bundle does not carry it. */
  async ensureFile(file: FilePath): Promise<void> {
    if (file in this.state.files || this.loading.has(file) || !this.indexModel.hasFile(file))
      return;
    if (!this.api) {
      if (!(file in this.state.fileErrors)) {
        this.set({
          fileErrors: { ...this.state.fileErrors, [file]: "not included in this bundle" },
        });
      }
      return;
    }
    this.loading.add(file);
    try {
      const text = await this.api.file(file);
      const { [file]: _dropped, ...errors } = this.state.fileErrors;
      this.set({ files: { ...this.state.files, [file]: text }, fileErrors: errors });
    } catch (error) {
      this.set({ fileErrors: { ...this.state.fileErrors, [file]: messageOf(error) } });
    } finally {
      this.loading.delete(file);
    }
  }

  // ─── Mode and tour (the seam for Present mode) ───────────────────────────────────────────────

  setMode(mode: Mode): void {
    if (mode === "present" && !PRESENT_AVAILABLE) return;
    if (mode !== this.state.mode) this.set({ mode });
  }

  setTour(tour: TourPosition | undefined): void {
    this.set({ tour });
  }

  // ─── View edits (persisted through the server when there is one) ─────────────────────────────

  /** Expands a stub: its ghost target joins the view. */
  expandStub(stub: Pick<Stub, "ghost">): void {
    const view = this.graphView();
    if (!view) return;
    const next = expandStubView(view, stub);
    if (next !== view) this.editView(view.id, { include: next.include });
  }

  /** Includes the children of a node (a group's members): it becomes a container. */
  drillIn(id: ElementId): void {
    const view = this.graphView();
    if (!view) return;
    const next = drillInView(view, id, this.state.model);
    if (next !== view) this.editView(view.id, { include: next.include });
  }

  /** Removes what is included below a container. */
  collapse(id: ElementId): void {
    const view = this.graphView();
    if (!view) return;
    const next = collapseView(view, id, this.state.model);
    if (next !== view) this.editView(view.id, { include: next.include });
  }

  /** True when double-clicking `id` would add something to the current graph view. */
  canDrillIn(id: ElementId): boolean {
    const view = this.graphView();
    if (!view) return false;
    const included = new Set(view.include);
    return drillChildren(this.state.model, id).some((child) => !included.has(child));
  }

  toggleEdgeKind(kind: Edge["kind"]): void {
    const view = this.graphView();
    if (!view) return;
    const kinds = new Set<Edge["kind"]>(view.edgeKinds ?? DEFAULT_EDGE_KINDS);
    if (kinds.has(kind)) kinds.delete(kind);
    else kinds.add(kind);
    this.editView(view.id, { edgeKinds: EDGE_KINDS.filter((k) => kinds.has(k)) });
  }

  private graphView(): GraphView | undefined {
    const view = this.view();
    return view?.type === "graph" ? view : undefined;
  }

  private editView(viewId: string, fields: Record<string, unknown>): void {
    const explainer = withViewFields(this.state.explainer, viewId, fields);
    if (explainer === this.state.explainer) return;
    const model = new ExplainerModel(explainer, this.indexModel);
    const selection = this.stillShown(model, viewId, this.state.selection);
    this.set({
      explainer,
      model,
      ...(selection.length !== this.state.selection.length ? { selection } : {}),
      dirty: true,
      ...(this.api ? { save: { status: "saving" } as SaveState } : {}),
    });
    if (this.api) this.queueSave(viewId, fields);
  }

  /**
   * The selected elements that the (edited) graph view still draws. Selecting something and then
   * collapsing it away, or switching off its edge kind, must not leave an invisible selection behind.
   * Concepts and sequence steps do not depend on the graph.
   */
  private stillShown(
    model: ExplainerModel,
    viewId: string,
    selection: readonly ElementId[],
  ): readonly ElementId[] {
    const view = model.view(viewId);
    if (view?.type !== "graph" || viewId !== this.state.viewId) return selection;
    const graph = deriveGraph(view, model);
    const shown = new Set<string>([
      ...graph.nodes.map((n) => n.id),
      ...graph.edges.map((e) => e.id),
      ...graph.stubs.map((s) => s.id),
    ]);
    return selection.filter(
      (id) => shown.has(id) || model.concept(id) !== undefined || parseId(id).type === "step",
    );
  }

  private queueSave(viewId: string, fields: Record<string, unknown>): void {
    this.pending.set(viewId, { ...this.pending.get(viewId), ...fields });
    if (this.saveTimer !== undefined) clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => {
      this.saveTimer = undefined;
      void this.flush();
    }, SAVE_DELAY_MS);
  }

  /** Sends the queued view edits now (also the "retry" after a failed save). Resolves when nothing is left. */
  async flush(): Promise<void> {
    if (this.saveTimer !== undefined) {
      clearTimeout(this.saveTimer);
      this.saveTimer = undefined;
    }
    if (this.saving) {
      await this.saving;
      return;
    }
    const api = this.api;
    if (!api || this.pending.size === 0) return;
    this.saving = (async () => {
      let batch: [string, Record<string, unknown>][] = [];
      try {
        while (this.pending.size > 0) {
          batch = [...this.pending];
          this.pending.clear();
          while (batch.length > 0) {
            const [viewId, fields] = batch[0]!;
            const view = this.state.model.view(viewId);
            if (view) await api.putView(viewId, { type: view.type, ...fields });
            batch.shift();
          }
        }
        this.set({ dirty: false, save: { status: "saved" } });
      } catch (error) {
        // Keep what was not sent (newer edits win), so the next flush retries it.
        for (const [viewId, fields] of batch) {
          this.pending.set(viewId, { ...fields, ...this.pending.get(viewId) });
        }
        this.set({ save: { status: "error", message: messageOf(error) } });
      } finally {
        this.saving = undefined;
      }
    })();
    await this.saving;
  }

  // ─── Explain requests and export ─────────────────────────────────────────────────────────────

  /**
   * "Explain this": queues a request on the server (`"queued"`); without one the caller shows the
   * command to run instead (`"command"`). Rejects with a readable message when the server refuses.
   */
  async requestExplain(id: ElementId): Promise<"queued" | "command"> {
    if (!this.api) return "command";
    await this.api.postRequest({
      kind: "expand",
      id,
      ...(this.state.viewId !== undefined ? { view: this.state.viewId } : {}),
      label: this.state.model.label(id),
    });
    return "queued";
  }

  /** The explainer as pretty JSON, including the view edits made in this session. */
  explainerJson(): string {
    return serializeExplainer(this.state.explainer);
  }
}
