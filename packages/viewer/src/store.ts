/**
 * The viewer's state and everything that changes it. A tiny external store (React reads it with
 * `useSyncExternalStore`, see hooks.ts) so that `window.__xpl` (testHooks.ts) and the UI go through
 * exactly the same actions.
 *
 * State is one immutable object; every action swaps in a new one. Anything derived from it (the graph of
 * the current view, code focus, reverse lookup, matches) lives in derive.ts and is memoised per state.
 */
import {
  artifactIdentity,
  applyUserEdits,
  makeUserEdit,
  makeAnchor,
  type MakeAnchorResult,
  type AnchorRole,
  type UserEdit,
  type ArtifactIdentity,
  applyPatch,
  type ExplainerPatch,
  FEEDBACK_SCHEMA,
  parseFeedbackFile,
  parseFeedbackRequest,
  mergeFeedbackRequests,
  hashText,
  type FeedbackKind,
  type FeedbackRequest,
  type FeedbackFile,
} from "@xpl/core";
import {
  asIndexModel,
  codeFocus,
  collapse as collapseView,
  DEFAULT_EDGE_KINDS,
  deriveGraph,
  drillChildren,
  drillIn as drillInView,
  EDGE_KINDS,
  canExpandInPlace,
  expandStub as expandStubView,
  opensView,
  ExplainerModel,
  parseId,
  resolveStubPolicy,
  type Range,
  type Anchor,
  type Edge,
  type ElementId,
  type Explainer,
  type FilePath,
  type GraphView,
  type IndexModel,
  type Stub,
  type StubMode,
  type StubPolicy,
  type Tour,
  type TourStep,
  type SequenceView,
  type View,
  type ViewerBundle,
  type WatchAttention,
} from "@xpl/core";
import { snapshotTexts } from "./snapshot.js";
import { messageOf, ServerApi, type LaunchParams } from "./data.js";
import { changeAt, changeOf, hasBase } from "./diff.js";
import { workspaceView } from "./workspace.js";
import { serializeExplainer, withViewFields } from "./edits.js";
import { clampStep, stepIndex, type Mode, type TourPosition } from "./modes.js";
import {
  appendStep,
  focusIds,
  insertStep,
  moveStep,
  newTourId,
  removeStep,
  sanitizeTours,
  setStepNote,
  withTour,
} from "./tours.js";

/** The editor caret, or the lines of a selection, in one file (1-based, inclusive). */
export interface Cursor {
  file: FilePath;
  fromLine: number;
  toLine: number;
  side?: "base";
  fromCol?: number;
  toCol?: number;
}

export interface ConnectionState {
  status: "offline" | "connecting" | "connected" | "disconnected" | "unavailable";
  attachment?: NonNullable<ViewerBundle["server"]>["attachment"];
  message?: string;
}

export type SaveState =
  | { status: "idle" }
  | { status: "saving" }
  | { status: "saved" }
  | { status: "error"; message: string };

/**
 * What a tour step asked for that is not in the selection itself: the code to show instead of the
 * focus's own, and the editor options. Set when a step is applied and dropped as soon as the selection
 * changes (a click on the diagram is a detour from the tour), so the code always follows what is
 * selected. Leaving Present keeps it: the screen stays as it is.
 */
export interface AppliedStep {
  tourId: string;
  stepId: string;
  /** `TourStep.code`: shown instead of the union of the focus's code (undefined: no override). */
  code: readonly Anchor[] | undefined;
  /** `editor.dimOthers`, default true. */
  dimOthers: boolean;
  /** `editor.hideFileTree`, default true (Present hides the tree; Explore always shows it). */
  hideFileTree: boolean;
  /** `editor.primary`: this file's pane first. */
  primary: FilePath | undefined;
}

export type Perspective = "guide" | "map" | "flow" | "code" | "explore";

type Navigation = Pick<
  ViewerState,
  | "perspective"
  | "mode"
  | "viewId"
  | "selection"
  | "cursor"
  | "openedFile"
  | "openedBase"
  | "openedLine"
  | "tour"
  | "applied"
>;

export interface AuthorDraft {
  edit: UserEdit;
  version: ArtifactIdentity;
}

export interface ViewerState {
  readOnlyGuide?: ViewerBundle["readOnlyGuide"];
  perspective: Perspective;
  canGoBack: boolean;
  canGoForward: boolean;
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
  /**
   * The opened file is shown as its code before the change (a file the change removed, a base anchor's row in
   * the details), in a "Before" pane.
   */
  openedBase: boolean;
  /** The line a "Before" pane opened by `openFile(file, line, "base")` scrolls to (base lines). */
  openedLine: number | undefined;
  /** Bumped every time a file is opened explicitly, so the stack scrolls to it even if it was open. */
  openSeq: number;
  /** Bumped by "Who calls it" (`showCallers`): the callers list is brought on screen, even where it is folded away. */
  callersSeq: number;
  /** Explore or Present (see modes.ts). */
  mode: Mode;
  /**
   * The tour being presented, and the step it is on. Also set in Explore once a tour was chosen (the
   * tour panel, `?tour=`), so that Present starts there.
   */
  tour: TourPosition | undefined;
  /** The step that produced the current selection; undefined after a detour (see `AppliedStep`). */
  applied: AppliedStep | undefined;
  /**
   * Counts the tour steps applied so far. The diagram starts over (its first view, on the step's focus)
   * whenever this changes, even when the step stays in the same view.
   */
  stepSeq: number;
  /**
   * Boxes the reader opened in place (`expandInPlace`): each shows the boxes of the view it opens inside it.
   * A way of looking, like the zoom: never stored in the explainer.
   */
  expanded: ReadonlySet<ElementId>;
  /** Source text of the files loaded so far (all of them in a static bundle). */
  files: Readonly<Record<FilePath, string>>;
  /** Files that could not be loaded, with the reason. */
  fileErrors: Readonly<Record<FilePath, string>>;
  /**
   * The code before the change (`ViewerBundle.baseFiles`, keyed by the changed file's path), and what was
   * fetched from `GET {api}/base-file` under `xpl view`. Empty for an explainer without a change.
   */
  baseFiles: Readonly<Record<FilePath, string>>;
  /** Base files that could not be loaded, with the reason. */
  baseErrors: Readonly<Record<FilePath, string>>;
  /**
   * The editor marks what the change did (added and changed lines, removed lines in between): the "Show
   * changes" toggle of a changed file's pane. On by default; only matters when the explainer has a change.
   */
  showChanges: boolean;
  /** Edits exist that are not persisted (always true after an edit without a server). */
  dirty: boolean;
  save: SaveState;
  editBusy: boolean;
  editDraft: boolean;
  textDrafts: Readonly<Record<string, AuthorDraft>>;
  undoCount: number;
  redoCount: number;
  editHistoryError?: string;
  editError?: string;
  /** Running under `xpl view`. */
  serverMode: boolean;
  connection: ConnectionState;
  attention?: WatchAttention;
  attentionError?: string;
  feedback: FeedbackRequest[];
  feedbackStorageError?: string;
  /** The live source no longer matches its index; reindex before trusting locations and edges. */
  sourceWarning: string | undefined;
  exportInfo: ViewerBundle["exportInfo"];
  /**
   * Said once when opening a box switched the reading tab (a double-click on the Map that opened a flow):
   * which tab the reader is in now and why. Gone at the next move.
   */
  switchNotice?: string;
}

/** How often `xpl view` pages look for changes to the explainer on disk. */
const WATCH_INTERVAL_MS = 2000;

/** Delay before queued edits are sent to the server (coalesces rapid toggling and typing). */
const SAVE_DELAY_MS = 250;

/** A tour by id; `intro` finds `tour:intro` (what `?tour=intro` and `xpl bundle --tour intro` mean). */
function findTour(tours: readonly Tour[], id: string | undefined): Tour | undefined {
  if (id === undefined) return undefined;
  return tours.find((t) => t.id === id) ?? tours.find((t) => t.id === `tour:${id}`);
}

type PendingWrite =
  | { kind: "edit"; fields: Record<string, unknown> }
  | { kind: "review"; review: ExplainerPatch["review"] }
  | {
      kind: "author";
      edits: UserEdit[];
      version?: ArtifactIdentity;
      action: "save" | "undo" | "redo";
      applied: boolean;
    };

export class ViewerStore {
  private state: ViewerState;
  private readonly listeners = new Set<() => void>();
  private api: ServerApi | undefined;
  private readonly liveApi: ServerApi | undefined;
  private pollConnection: (() => Promise<void>) | undefined;
  private indexModel: IndexModel;
  private workspaceRevision = 0;
  private readonly loading = new Set<FilePath>();
  private readonly loadingBase = new Set<FilePath>();
  private readonly pending = new Map<string, PendingWrite>();
  private authorSequence = 0;
  private saveTimer: ReturnType<typeof setTimeout> | undefined;
  private saving: Promise<void> | undefined;
  private readonly past: Navigation[] = [];
  private readonly future: Navigation[] = [];
  private readonly undoEdits: UserEdit[][] = [];
  private readonly redoEdits: UserEdit[][] = [];
  private readonly editStorageKey: string | undefined;
  private readonly editAttachment: NonNullable<ViewerBundle["server"]>["attachment"];
  /** The reading tab (Guide, Map, Flow, Code) last on screen: where "Back to reading" goes from Explore. */
  private reading: Exclude<Perspective, "explore"> = "guide";
  /** Namespace of the page as loaded; edits change request context, never where requests are saved. */
  private readonly feedbackStorageKey: string;

  constructor(
    readonly library: ViewerBundle,
    launch: LaunchParams = {},
  ) {
    const bundle = library;
    this.editAttachment = bundle.server?.attachment;
    this.editStorageKey = this.editAttachment
      ? `xpl-edits:${JSON.stringify([this.editAttachment.root, this.editAttachment.guide])}`
      : undefined;
    const identity = artifactIdentity(bundle.explainer, bundle.index);
    this.feedbackStorageKey = `xpl-feedback:${identity.explainerHash}:${identity.sourceHash}`;
    this.indexModel = asIndexModel(bundle.index);
    this.api = bundle.server?.api
      ? new ServerApi(bundle.server.api, bundle.server.attachment)
      : undefined;
    this.liveApi = this.api;
    const explainer = bundle.explainer;
    const model = this.modelOf(explainer);
    const views = model.views;
    const viewId = views.find((v) => v.id === launch.view)?.id ?? views[0]?.id;

    // Where to start: the URL wins over the bundle. A tour that does not exist falls back to the first
    // one when the page is to open in Present, and to none in Explore.
    const tours = model.tours;
    const asked = findTour(tours, launch.tour) ?? findTour(tours, bundle.tour);
    if (asked && launch.stepId) {
      const index = asked.steps.findIndex((step) => step.id === launch.stepId);
      if (index >= 0) launch = { ...launch, step: index + 1 };
    }
    const present = (launch.mode ?? bundle.mode ?? "explore") === "present" && tours.length > 0;
    const tour = asked ?? (present ? tours[0] : undefined);
    this.state = {
      readOnlyGuide: bundle.readOnlyGuide,
      perspective:
        launch.perspective ??
        (launch.mode || launch.view || bundle.mode === "present" ? "explore" : "guide"),
      canGoBack: false,
      canGoForward: false,
      explainer,
      model,
      viewId,
      selection: (launch.focus ?? []).filter((id) => model.hasElement(id)),
      cursor: undefined,
      openedFile: undefined,
      openedBase: false,
      openedLine: undefined,
      openSeq: 0,
      callersSeq: 0,
      expanded: new Set(),
      mode: "explore",
      tour: tour ? { tourId: tour.id, step: stepIndex(launch.step, tour.steps.length) } : undefined,
      applied: undefined,
      stepSeq: 0,
      files: bundle.files,
      fileErrors: {},
      baseFiles: bundle.baseFiles ?? {},
      baseErrors: {},
      showChanges: true,
      dirty: false,
      save: { status: "idle" },
      editBusy: false,
      editDraft: false,
      textDrafts: {},
      undoCount: 0,
      redoCount: 0,
      serverMode: this.api !== undefined,
      connection: {
        status: this.api ? "connecting" : "offline",
        attachment: bundle.server?.attachment,
      },
      sourceWarning: bundle.sourceWarning,
      feedback: [],
      exportInfo: bundle.exportInfo,
    };
    this.loadFeedback(bundle.feedback);
    // Offline reload opens the original embedded artifact. Its in-memory edits must first be exported.
    if (this.api && this.editStorageKey && typeof localStorage !== "undefined") {
      try {
        const stored = JSON.parse(localStorage.getItem(this.editStorageKey) ?? "null") as {
          identity: string;
          undo: UserEdit[][];
          redo: UserEdit[][];
        } | null;
        if (
          stored &&
          stored.identity === this.editHistoryIdentity() &&
          Array.isArray(stored.undo) &&
          Array.isArray(stored.redo)
        ) {
          this.undoEdits.push(...stored.undo.slice(-50));
          this.redoEdits.push(...stored.redo.slice(-50));
          this.set({ undoCount: this.undoEdits.length, redoCount: this.redoEdits.length });
        }
      } catch (error) {
        this.set({ editHistoryError: `Undo history could not be loaded: ${messageOf(error)}` });
      }
    }
    if (this.state.perspective !== "explore") this.reading = this.state.perspective;
    if (present) this.present();
    else if (launch.perspective && asked && launch.step) {
      this.applyStep(asked, stepIndex(launch.step, asked.steps.length));
      const same = (ids: readonly string[] | undefined) =>
        JSON.stringify(ids) === JSON.stringify(launch.focus);
      // The section's focus as entering its flow left it (`flowEntry`): still the section, applied.
      const flow = launch.perspective === "flow" ? workspaceView(this.state, "flow") : undefined;
      const entry = flow && flow.type !== "graph" ? this.flowEntry(flow) : undefined;
      if (launch.focus && !same(this.state.selection)) {
        if (entry?.selection && same(entry.selection)) this.set(entry);
        else
          this.set({
            selection: launch.focus.filter((id) => model.hasElement(id)),
            applied: undefined,
          });
      }
    }
    const perspective = this.state.perspective;
    if (!present && (perspective === "map" || perspective === "flow"))
      this.set({ viewId: workspaceView(this.state, perspective)?.id ?? this.state.viewId });
    if (launch.file && launch.range) this.openRange(launch.file, launch.range);
  }

  /** The model of an explainer, over tours that are sound (hand-edited files may not be). */
  private modelOf(explainer: Explainer): ExplainerModel {
    return new ExplainerModel(sanitizeTours(explainer), this.indexModel);
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
    this.state = { ...this.state, ...patch, dirty: this.pending.size > 0 };
    if (this.state.perspective !== "explore") this.reading = this.state.perspective;
    for (const listener of [...this.listeners]) listener();
  }

  private position(): Navigation {
    const { perspective, mode, viewId, selection, cursor, tour, applied } = this.state;
    const { openedFile, openedBase, openedLine } = this.state;
    return {
      perspective,
      mode,
      viewId,
      selection,
      cursor,
      openedFile,
      openedBase,
      openedLine,
      tour,
      applied,
    };
  }

  private remember(): void {
    this.past.push(this.position());
    if (this.past.length > 100) this.past.shift();
    this.future.length = 0;
  }

  private navigate(patch: Partial<ViewerState>): void {
    this.remember();
    this.set({ switchNotice: undefined, ...patch, canGoBack: true, canGoForward: false });
  }

  private travel(from: Navigation[], to: Navigation[]): void {
    const position = from.pop();
    if (!position) return;
    to.push(this.position());
    this.set({
      ...position,
      switchNotice: undefined,
      selection: position.selection.filter((id) => this.state.model.hasElement(id)),
      applied:
        position.applied && this.state.model.tour(position.applied.tourId)
          ? position.applied
          : undefined,
      openSeq: this.state.openSeq + 1,
      stepSeq: this.state.stepSeq + 1,
      canGoBack: this.past.length > 0,
      canGoForward: this.future.length > 0,
    });
  }

  back(): void {
    this.travel(this.past, this.future);
  }
  forward(): void {
    this.travel(this.future, this.past);
  }

  setPerspective(perspective: Perspective): void {
    if (perspective === this.state.perspective && this.state.mode === "explore") return;
    const view =
      perspective === "map" || perspective === "flow"
        ? workspaceView(this.state, perspective)
        : undefined;
    const patch: Partial<ViewerState> = {
      perspective,
      mode: "explore",
      viewId: view?.id ?? this.state.viewId,
    };
    // From the guide to a flow: a guide section's focus (often the function the whole flow is inside) would
    // mark nearly every box. Keep only the flow's own steps; with none, keep the code on screen, unpicked. A
    // box the reader picked in the guide stays picked: they asked where it is in the flow.
    if (
      perspective === "flow" &&
      this.state.perspective === "guide" &&
      this.state.applied &&
      view &&
      view.type !== "graph"
    ) {
      Object.assign(patch, this.flowEntry(view));
    }
    this.navigate(patch);
  }

  private flowEntry(view: SequenceView): Partial<ViewerState> {
    const { selection, model, applied } = this.state;
    const steps = new Set((Array.isArray(view.steps) ? view.steps : []).map((step) => step?.id));
    const own = selection.filter((id) => steps.has(id));
    if (own.length === selection.length) return {};
    const patch: Partial<ViewerState> = { selection: own };
    const lead = codeFocus(selection, model)[0];
    if (own.length === 0 && !applied?.code && lead) {
      patch.openedFile = lead.file;
      patch.openedBase = false;
      patch.openSeq = this.state.openSeq + 1;
      patch.cursor = {
        file: lead.file,
        fromLine: lead.range.startLine,
        toLine: lead.range.startLine,
      };
    }
    return patch;
  }

  /** The reading tab that was on screen last (the Guide when there was none). */
  lastReading(): Exclude<Perspective, "explore"> {
    return this.reading;
  }

  readExplanation(): boolean {
    const { model, selection } = this.state;
    const files = new Set(codeFocus(selection, model).map((focus) => focus.file));
    let best: { tour: string; index: number; score: number } | undefined;
    for (const tour of model.tours) {
      tour.steps.forEach((step, index) => {
        const direct = step.focus.filter((id) => selection.includes(id)).length;
        const related = step.focus.filter((id) =>
          selection.some(
            (selected) =>
              model.hasNode(id) &&
              model.hasNode(selected) &&
              (model.subtreeContains(id, selected) || model.subtreeContains(selected, id)),
          ),
        ).length;
        const shared = codeFocus(step.focus, model).filter((focus) => files.has(focus.file)).length;
        const score = direct * 1000 + related * 100 + shared;
        if (score > (best?.score ?? 0)) best = { tour: tour.id, index, score };
      });
    }
    if (!best) {
      this.setPerspective("guide");
      return false;
    }
    this.previewStep(best.tour, best.index);
    this.set({ perspective: "guide", mode: "explore" });
    return true;
  }

  // ─── Views ───────────────────────────────────────────────────────────────────────────────────

  view(): View | undefined {
    const { model, viewId } = this.state;
    return viewId === undefined ? undefined : model.view(viewId);
  }

  setView(id: string): boolean {
    if (!this.state.model.view(id)) return false;
    if (id === this.state.viewId) return true;
    const shared = this.state.perspective !== "explore";
    this.navigate({
      viewId: id,
      selection: shared ? this.state.selection : [],
      cursor: shared ? this.state.cursor : undefined,
      openedFile: shared ? this.state.openedFile : undefined,
      openedBase: shared && this.state.openedBase,
      applied: undefined,
    });
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
    this.navigate({
      selection,
      cursor: undefined,
      openedFile: undefined,
      openedBase: false,
      applied: undefined,
    });
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

  /** "Who calls it" on a name in the code: picks it, and asks for its callers list to be shown. */
  showCallers(id: ElementId): void {
    this.select([id]);
    this.set({ callersSeq: this.state.callersSeq + 1 });
  }

  // ─── Code side ───────────────────────────────────────────────────────────────────────────────

  /**
   * The caret (or the lines of a selection) moved in an editor. Drives the reverse lookup. Real cursor
   * moves and `window.__xpl.setCursor` both end up here.
   */
  setCursor(
    file: FilePath,
    fromLine: number,
    toLine: number = fromLine,
    side: "head" | "base" = "head",
    fromCol?: number,
    toCol?: number,
  ): void {
    const from = Math.max(1, Math.floor(fromLine));
    const to = Math.max(from, Math.floor(toLine));
    const cur = this.state.cursor;
    if (
      cur &&
      cur.file === file &&
      cur.fromLine === from &&
      cur.toLine === to &&
      (cur.side ?? "head") === side &&
      cur.fromCol === fromCol &&
      cur.toCol === toCol
    )
      return;
    this.set({
      cursor: {
        file,
        fromLine: from,
        toLine: to,
        ...(side === "base" ? { side } : {}),
        ...(fromCol !== undefined ? { fromCol, toCol } : {}),
      },
    });
  }

  clearCursor(): void {
    if (this.state.cursor !== undefined) this.set({ cursor: undefined });
  }

  /**
   * Shows a file first in the editor stack (file tree, anchor list). `line` also moves the cursor there.
   * `side: "base"` shows the code before the change instead (a base anchor's row), in a "Before" pane
   * scrolled to `line` (a base line); a file the change removed always opens that way (the index does not
   * know it).
   */
  openFile(file: FilePath, line?: number, side?: "base"): void {
    const change = changeOf(this.state.explainer);
    const base = side === "base" || this.isRemovedFile(file);
    if (base ? !hasBase(change, file) : !this.indexModel.hasFile(file)) return;
    if (base) void this.ensureBaseFile(file);
    else void this.ensureFile(file);
    const at = line !== undefined ? Math.max(1, Math.floor(line)) : undefined;
    const patch: Partial<ViewerState> = {
      openedFile: file,
      openedBase: base,
      openedLine: base ? at : undefined,
      openSeq: this.state.openSeq + 1,
    };
    // The caret is in the code as it is now (its lines look up diagram elements): not in a "Before" pane.
    if (at !== undefined && !base) patch.cursor = { file, fromLine: at, toLine: at };
    this.navigate(patch);
  }

  /** Search and shared links use inclusive source columns, only within supplied snapshot text. */
  openRange(file: FilePath, range: Range): void {
    const text = this.state.files[file];
    if (text === undefined || !this.indexModel.hasFile(file)) return;
    const lines = text.split("\n");
    const { startLine, endLine, startCol, endCol } = range;
    if (
      ![startLine, endLine].every(Number.isInteger) ||
      startLine < 1 ||
      endLine < startLine ||
      endLine > lines.length ||
      (startCol !== undefined &&
        (!Number.isInteger(startCol) ||
          !Number.isInteger(endCol) ||
          startCol < 1 ||
          endCol! < 1 ||
          startCol > lines[startLine - 1]!.replace(/\r$/, "").length ||
          endCol! > lines[endLine - 1]!.replace(/\r$/, "").length ||
          (startLine === endLine && endCol! < startCol)))
    )
      return;
    this.navigate({
      mode: "explore",
      perspective: "code",
      selection: [],
      applied: undefined,
      openedFile: file,
      openedBase: false,
      openedLine: undefined,
      openSeq: this.state.openSeq + 1,
      cursor: {
        file,
        fromLine: startLine,
        toLine: endLine,
        ...(startCol !== undefined ? { fromCol: startCol, toCol: endCol } : {}),
      },
    });
  }

  /** Closes the pane of a file that was opened but is not part of the focus. */
  closeOpenedFile(): void {
    if (this.state.openedFile !== undefined) this.set({ openedFile: undefined, openedBase: false });
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
    const revision = this.workspaceRevision;
    try {
      const text = await this.api.file(file);
      if (revision !== this.workspaceRevision) return;
      const { [file]: _dropped, ...errors } = this.state.fileErrors;
      this.set({ files: { ...this.state.files, [file]: text }, fileErrors: errors });
    } catch (error) {
      if (revision !== this.workspaceRevision) return;
      this.set({ fileErrors: { ...this.state.fileErrors, [file]: messageOf(error) } });
    } finally {
      this.loading.delete(file);
      if (revision !== this.workspaceRevision) void this.ensureFile(file);
    }
  }

  /** A file the change deleted (its code before the change can be shown; the index does not know it). */
  isRemovedFile(file: FilePath): boolean {
    const changed = changeAt(changeOf(this.state.explainer), file);
    return changed?.status === "deleted" && !this.indexModel.hasFile(file);
  }

  /**
   * Loads the code before the change of a changed file (modified, renamed or deleted): from the bundle's
   * `baseFiles`, else from `GET {api}/base-file` under `xpl view`. A static page without it says so.
   */
  async ensureBaseFile(file: FilePath): Promise<void> {
    const change = changeOf(this.state.explainer);
    if (!hasBase(change, file) || file in this.state.baseFiles || this.loadingBase.has(file))
      return;
    if (!this.api) {
      if (!(file in this.state.baseErrors)) {
        this.set({
          baseErrors: {
            ...this.state.baseErrors,
            [file]: "the code before the change is not included in this page",
          },
        });
      }
      return;
    }
    this.loadingBase.add(file);
    const revision = this.workspaceRevision;
    try {
      const text = await this.api.baseFile(file);
      if (revision !== this.workspaceRevision) return;
      const { [file]: _dropped, ...errors } = this.state.baseErrors;
      this.set({ baseFiles: { ...this.state.baseFiles, [file]: text }, baseErrors: errors });
    } catch (error) {
      if (revision !== this.workspaceRevision) return;
      this.set({ baseErrors: { ...this.state.baseErrors, [file]: messageOf(error) } });
    } finally {
      this.loadingBase.delete(file);
      if (revision !== this.workspaceRevision) void this.ensureBaseFile(file);
    }
  }

  /** The "Show changes" toggle: mark what the change did in the code, or show the code as it is. */
  setShowChanges(on: boolean): void {
    if (this.state.showChanges !== on) this.set({ showChanges: on });
  }

  // ─── Present mode: tours ─────────────────────────────────────────────────────────────────────

  /** The Explore / Present toggle. Present needs a tour: without one it stays in Explore. */
  setMode(mode: Mode): void {
    if (mode === "present") this.present();
    else this.setPerspective("explore");
  }

  /** The tour the state points at (being presented, or the one Present would start with). */
  currentTour(): Tour | undefined {
    const { model, tour } = this.state;
    return tour ? model.tour(tour.tourId) : undefined;
  }

  /**
   * Starts (or resumes) a tour in Present mode and applies the step: `step` is an index; by default the
   * step the tour is on, else the first. `tourId` defaults to the current tour, else the first one.
   * False when there is no such tour.
   */
  present(tourId?: string, step?: number): boolean {
    const { model, tour: at } = this.state;
    const tour =
      tourId !== undefined ? findTour(model.tours, tourId) : (this.currentTour() ?? model.tours[0]);
    if (!tour) return false;
    const index = clampStep(step ?? (at?.tourId === tour.id ? at.step : 0), tour.steps.length);
    this.set({ mode: "present", tour: { tourId: tour.id, step: index } });
    this.applyStep(tour, index);
    return true;
  }

  /** Leaves Present. The view, the selection and what the last step made of the code stay as they are. */
  exitPresent(): void {
    if (this.state.mode !== "explore") this.set({ mode: "explore" });
  }

  /** Jumps to step `index` of the tour that is on (clamped). Applies it, whatever detour came before. */
  goToStep(index: number): void {
    const tour = this.currentTour();
    if (!tour || tour.steps.length === 0) return;
    const at = clampStep(index, tour.steps.length);
    this.set({ tour: { tourId: tour.id, step: at } });
    this.applyStep(tour, at);
  }

  nextStep(): void {
    const at = this.state.tour;
    if (at) this.goToStep(at.step + 1);
  }

  /** The previous step; after a detour, first the step that was interrupted (`returnFromDetour`). */
  prevStep(): void {
    const at = this.state.tour;
    if (at && !this.returnFromDetour()) this.goToStep(at.step - 1);
  }

  /**
   * While presenting, after a detour (a click on the diagram): applies the interrupted step again, and says
   * so. ← and Esc do this first, so that a stray click is one key away from the slide.
   */
  returnFromDetour(): boolean {
    const at = this.state.tour;
    if (this.state.mode !== "present" || !at || this.state.applied !== undefined) return false;
    if ((this.currentTour()?.steps.length ?? 0) === 0) return false;
    this.goToStep(at.step);
    return true;
  }

  /** Shows a step's view and selection without switching to Present (the tour panel's "show"). */
  previewStep(tourId: string, index: number): void {
    const tour = this.state.model.tour(tourId);
    if (!tour || index < 0 || index >= tour.steps.length) return;
    this.navigate({ tour: { tourId, step: index } });
    this.applyStep(tour, index);
  }

  /** Picks the tour Present plays (the header's tour picker); starts it at its first step when presenting. */
  chooseTour(tourId: string): void {
    const tour = this.state.model.tour(tourId);
    if (!tour) return;
    if (this.state.mode === "present") this.present(tourId, 0);
    else this.set({ tour: { tourId, step: 0 } });
  }

  /**
   * What a step does: its view, its focus as the selection, and the code override and editor options
   * (`applied`). A step whose view is gone keeps the current view; focus ids the model does not know
   * are skipped. Reading files is left to the editor stack.
   */
  private applyStep(tour: Tour, index: number): void {
    const step = tour.steps[index];
    if (!step) return;
    const { model } = this.state;
    const view = model.view(step.view);
    const editor = step.editor ?? {};
    const focus = (Array.isArray(step.focus) ? step.focus : []).filter(
      (id): id is string => typeof id === "string" && model.hasElement(id),
    );
    this.set({
      viewId: view ? view.id : this.state.viewId,
      selection: [...new Set(focus)],
      cursor: undefined,
      openedFile: undefined,
      openedBase: false,
      stepSeq: this.state.stepSeq + 1,
      applied: {
        tourId: tour.id,
        stepId: step.id,
        // An empty override is "not given": it would leave the code side blank.
        code: Array.isArray(step.code) && step.code.length > 0 ? step.code : undefined,
        dimOthers: editor.dimOthers !== false,
        hideFileTree: editor.hideFileTree !== false,
        primary: typeof editor.primary === "string" ? editor.primary : undefined,
      },
    });
  }

  // ─── View edits (persisted through the server when there is one) ─────────────────────────────

  // A talk does not edit the diagram: while presenting, the view edits below do nothing (a stray
  // double-click must not rewrite the explainer). Tours are edited from Explore.

  /**
   * Expands a stub: its ghost target joins the view. A ghost that folds several elements ("rest of
   * <file>", "N more") is no element and expands nothing: pass one of its targets instead (the ghost menu).
   */
  expandStub(stub: Pick<Stub, "ghost">): void {
    if (this.state.mode === "present") return;
    const view = this.graphView();
    if (!view) return;
    const next = expandStubView(view, stub);
    if (next !== view) this.editView(view.id, { include: next.include });
  }

  /** Includes the children of a node (a group's members): it becomes a container. */
  drillIn(id: ElementId): void {
    if (this.state.mode === "present") return;
    const view = this.graphView();
    if (!view) return;
    const next = drillInView(view, id, this.state.model);
    if (next !== view) this.editView(view.id, { include: next.include });
  }

  /**
   * True when the box opens a more detailed view (`Node.opens`) that the reader can go to: not while
   * presenting (the tour decides what is on screen), and not when that view is already shown.
   */
  canZoomInto(id: ElementId): boolean {
    if (this.state.mode === "present") return false;
    const target = opensView(this.state.model, id);
    return target !== undefined && target.id !== this.state.viewId;
  }

  /**
   * Shows the view a box opens: the next level down (the inside of a service). In the reader's map or flow,
   * the perspective follows the kind of view; Back returns to the level above.
   */
  zoomInto(id: ElementId): void {
    if (!this.canZoomInto(id)) return;
    const target = opensView(this.state.model, id)!;
    const from = this.state.perspective;
    this.goToLevel(target.id);
    const now = this.state.perspective;
    if (now !== from && (now === "map" || now === "flow") && (from === "map" || from === "flow")) {
      // The tab changed under the reader's pointer: say so (shown in the caption, read out politely).
      const tab = (p: Perspective) => (p === "map" ? "Map" : "Flow");
      this.set({
        switchNotice: `Now in the ${tab(now)} tab: opened from ${this.state.model.label(id)} on the ${tab(from)}.`,
      });
    }
  }

  /** Shows a level of the zoom trail (or any view), in the perspective that draws it. */
  goToLevel(viewId: string): void {
    const target = this.state.model.view(viewId);
    if (!target || this.state.mode === "present") return;
    const perspective: Perspective =
      this.state.perspective === "explore" ? "explore" : target.type === "graph" ? "map" : "flow";
    this.navigate({
      perspective,
      mode: "explore",
      viewId: target.id,
      selection: [],
      cursor: undefined,
      openedFile: undefined,
      openedBase: false,
      applied: undefined,
    });
  }

  /** True when the box can show the boxes of the view it opens inside itself, on this map. */
  canExpandInPlace(id: ElementId): boolean {
    if (this.state.mode === "present") return false;
    return canExpandInPlace(this.state.model, id);
  }

  /** True when the box shows the inside of the view it opens, on this map. */
  isExpanded(id: ElementId): boolean {
    return this.state.expanded.has(id);
  }

  /** Shows (or folds back) the inside of a box on the current map: the boxes of the view it opens. */
  toggleExpanded(id: ElementId): void {
    if (!this.isExpanded(id) && !this.canExpandInPlace(id)) return;
    const expanded = new Set(this.state.expanded);
    if (expanded.has(id)) expanded.delete(id);
    else expanded.add(id);
    this.set({ expanded });
  }

  /** Removes what is included below a container. */
  collapse(id: ElementId): void {
    if (this.state.mode === "present") return;
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

  /**
   * How many ghost boxes the graph view draws where it stops (`GraphView.stubs.mode`): `top` (the default),
   * `all` or `none`. A `max` the view already carries is kept. Does nothing when the view already has that
   * mode, and while presenting.
   */
  setStubMode(mode: StubMode): void {
    const view = this.graphView();
    if (!view || this.state.mode === "present") return;
    if (resolveStubPolicy(view.stubs).mode === mode) return;
    const stubs: StubPolicy = { ...(view.stubs ?? {}), mode };
    this.editView(view.id, { stubs });
  }

  toggleEdgeKind(kind: Edge["kind"]): void {
    const view = this.graphView();
    if (!view || this.state.mode === "present") return;
    const kinds = new Set<Edge["kind"]>(view.edgeKinds ?? DEFAULT_EDGE_KINDS);
    if (kinds.has(kind)) kinds.delete(kind);
    else kinds.add(kind);
    this.editView(view.id, { edgeKinds: EDGE_KINDS.filter((k) => kinds.has(k)) });
  }

  private graphView(): GraphView | undefined {
    const view = this.view();
    return view?.type === "graph"
      ? view
      : this.state.perspective === "map"
        ? (workspaceView(this.state, "map") as GraphView | undefined)
        : undefined;
  }

  private editView(viewId: string, fields: Record<string, unknown>): void {
    if (this.state.editBusy || this.state.readOnlyGuide) return;
    const explainer = withViewFields(this.state.explainer, viewId, fields);
    if (explainer === this.state.explainer) return;
    const model = this.modelOf(explainer);
    const selection = this.stillShown(model, viewId, this.state.selection);
    this.queueSave(viewId, fields);
    this.set({
      explainer,
      model,
      ...(selection.length !== this.state.selection.length
        ? { selection, applied: undefined }
        : {}),
      ...(this.api ? { save: { status: "saving" } as SaveState } : {}),
    });
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

  /**
   * Queues an edit for the server: changed fields of a view, or (for a tour, whose fields stay empty)
   * "send this tour", which reads the tour as it is when the request goes out.
   */
  private queueSave(id: string, fields: Record<string, unknown>): void {
    const prior = this.pending.get(id);
    this.pending.set(id, {
      kind: "edit",
      fields: { ...(prior?.kind === "edit" ? prior.fields : {}), ...fields },
    });
    this.scheduleSave();
  }

  private scheduleSave(): void {
    if (this.saveTimer !== undefined) clearTimeout(this.saveTimer);
    if (!this.api) return;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = undefined;
      void this.flush();
    }, SAVE_DELAY_MS);
  }

  private async send(api: ServerApi, id: string, write: PendingWrite): Promise<void> {
    if (write.kind === "review") {
      await api.putReview(write.review);
      return;
    }
    if (write.kind === "author") {
      this.set({ editBusy: true, save: { status: "saving" } });
      try {
        let version = write.version;
        if (!version) {
          const bundle = await api.bundle();
          this.indexModel = asIndexModel(bundle.index);
          this.workspaceRevision++;
          this.set({
            files: bundle.files,
            baseFiles: bundle.baseFiles ?? {},
            fileErrors: {},
            baseErrors: {},
            sourceWarning: bundle.sourceWarning,
            exportInfo: bundle.exportInfo,
          });
          version = artifactIdentity(bundle.explainer, bundle.index);
        }
        const result = await api.putEdits(version, write.edits);
        if (!write.applied) this.acceptAuthor(write, result);
        this.set({ editError: undefined });
      } catch (error) {
        // Rejected author actions require inspection; transport failures stay retryable.
        if (!write.applied && /^4\d\d\b/.test(messageOf(error)) && this.pending.get(id) === write)
          this.pending.delete(id);
        this.set({ editError: messageOf(error) });
        throw error;
      } finally {
        this.set({ editBusy: false });
      }
      return;
    }
    const { fields } = write;
    if (parseId(id).type === "tour") {
      const tour = this.state.model.tour(id);
      if (tour) await api.putTour(id, { title: tour.title, steps: tour.steps });
      return;
    }
    const view = this.state.model.view(id);
    if (view) await api.putView(id, { type: view.type, ...fields });
  }

  /**
   * Sends the queued edits now (also the "retry" after a failed save). Resolves when nothing is left
   * that can be sent. An edit the server refuses stays queued (newer edits to the same view or tour
   * queue up behind it, so an old edit is never sent after a newer one) and does not hold back the others.
   */
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
      const failed = new Set<string>();
      let firstError: unknown;
      try {
        for (;;) {
          const batch = [...this.pending.keys()].filter((id) => !failed.has(id));
          if (batch.length === 0 || this.api !== api) break;
          for (const id of batch) {
            if (this.api !== api) break;
            const write = this.pending.get(id);
            if (!write) continue;
            try {
              await this.send(api, id, write);
              // A successful response owns only the exact write it sent, not any newer edit.
              if (this.pending.get(id) === write) this.pending.delete(id);
              if (write.kind === "author") this.keepEditHistory();
            } catch (error) {
              failed.add(id);
              firstError ??= error;
            }
          }
        }
      } finally {
        this.saving = undefined;
        this.set({
          save:
            firstError !== undefined
              ? { status: "error", message: messageOf(firstError) }
              : this.pending.size === 0
                ? { status: "saved" }
                : { status: "idle" },
        });
      }
    })();
    await this.saving;
  }

  /** Check selected head/base lines before staging a user evidence edit. */
  previewEvidence(role: AnchorRole): MakeAnchorResult {
    const cursor = this.state.cursor;
    if (!cursor)
      return { ok: false, error: "Select lines in the source pane to preview evidence." };
    const { file, fromLine, toLine, side } = cursor;
    if (side === "base")
      return makeAnchor(
        { file, at: "base", role, span: { from: fromLine - 1, to: toLine - 1 } },
        this.indexModel,
        snapshotTexts(this.state),
        { change: this.state.explainer.change },
      );
    const text = this.state.files[file];
    if (text === undefined)
      return { ok: false, error: "Wait for the selected source file to load." };
    if (this.indexModel.file(file)?.hash !== hashText(text))
      return {
        ok: false,
        error: "This source differs from the index. Reindex and reload before selecting evidence.",
      };
    let symbol = this.indexModel.innermostSymbolAt(file, fromLine);
    while (symbol && symbol.range.endLine < toLine)
      symbol = this.indexModel.parentSymbol(symbol.id);
    const start = symbol?.range.startLine ?? 1;
    return makeAnchor(
      {
        file,
        role,
        ...(symbol ? { symbol: symbol.path } : {}),
        span: { from: fromLine - start, to: toLine - start },
      },
      this.indexModel,
      snapshotTexts(this.state),
    );
  }

  /** Capture fields and version when the author opens the editor, before typing begins. */
  captureEdit(
    collection: UserEdit["collection"],
    id: string,
    fields: Record<string, unknown>,
  ): { edit: UserEdit; version: ArtifactIdentity } {
    if (this.state.readOnlyGuide)
      throw new Error("This guide preview is read-only. Open its own service to edit it.");
    const draft = this.state.textDrafts[id] ?? {
      edit: makeUserEdit(this.state.explainer, this.indexModel, collection, id, fields),
      version: artifactIdentity(this.state.explainer, this.indexModel.index),
    };
    this.set({ textDrafts: { ...this.state.textDrafts, [id]: draft } });
    return draft;
  }

  updateEditDraft(id: string, values: Record<string, unknown>): void {
    const draft = this.state.textDrafts[id];
    if (!draft || this.state.editBusy) return;
    this.setTextDrafts({
      ...this.state.textDrafts,
      [id]: { ...draft, edit: { ...draft.edit, after: values } },
    });
  }

  private setTextDrafts(textDrafts: ViewerState["textDrafts"]): void {
    const editDraft = Object.values(textDrafts).some(({ edit }) =>
      Object.keys(edit.after).some(
        (key) => JSON.stringify(edit.after[key]) !== JSON.stringify(edit.before[key]),
      ),
    );
    this.set({ textDrafts, editDraft });
  }

  cancelEdit(id: string): void {
    const textDrafts = { ...this.state.textDrafts };
    delete textDrafts[id];
    for (const [key, write] of this.pending) {
      if (write.kind === "author" && !write.applied && write.edits.some((edit) => edit.id === id))
        this.pending.delete(key);
    }
    this.setTextDrafts(textDrafts);
    if (this.state.editError) this.set({ editError: undefined, save: { status: "idle" } });
  }

  private editHistoryIdentity(): string | undefined {
    return this.editAttachment
      ? JSON.stringify(["attachment", this.editAttachment.root, this.editAttachment.guide])
      : undefined;
  }

  private keepEditHistory(): void {
    this.set({ undoCount: this.undoEdits.length, redoCount: this.redoEdits.length });
    if (
      !this.liveApi ||
      !this.editStorageKey ||
      typeof localStorage === "undefined" ||
      [...this.pending.values()].some((write) => write.kind === "author" && write.applied)
    )
      return;
    try {
      localStorage.setItem(
        this.editStorageKey,
        JSON.stringify({
          identity: this.editHistoryIdentity(),
          undo: this.undoEdits,
          redo: this.redoEdits,
        }),
      );
      this.set({ editHistoryError: undefined });
    } catch (error) {
      this.set({
        editHistoryError: `Edits are saved, but undo history could not be retained: ${messageOf(error)}`,
      });
    }
  }

  async saveEdits(edits: UserEdit[], version: ArtifactIdentity): Promise<void> {
    if (this.state.readOnlyGuide) throw new Error("This guide preview is read-only.");
    await this.writeEdits(edits, "save", version);
  }

  private acceptAuthor(
    write: Extract<PendingWrite, { kind: "author" }>,
    result: { explainer: Explainer; inverse: UserEdit[] },
  ): void {
    this.set({
      explainer: result.explainer,
      model: this.modelOf(result.explainer),
      editError: undefined,
    });
    if (write.action === "save") {
      this.undoEdits.push(result.inverse);
      if (this.undoEdits.length > 50) this.undoEdits.shift();
      this.redoEdits.length = 0;
      const textDrafts = { ...this.state.textDrafts };
      for (const edit of write.edits) {
        const draft = textDrafts[edit.id];
        if (
          draft &&
          Object.keys(edit.after).every(
            (key) => JSON.stringify(draft.edit.after[key]) === JSON.stringify(edit.after[key]),
          )
        )
          delete textDrafts[edit.id];
      }
      this.setTextDrafts(textDrafts);
    } else {
      const from = write.action === "redo" ? this.redoEdits : this.undoEdits;
      const to = write.action === "redo" ? this.undoEdits : this.redoEdits;
      from.pop();
      to.push(result.inverse);
    }
    write.applied = true;
    this.keepEditHistory();
  }

  editHistoryDescription(redo = false): string {
    return (
      (redo ? this.redoEdits : this.undoEdits)
        .at(-1)
        ?.map(
          (edit) =>
            `${Object.keys(edit.after)
              .map((field) => (field === "anchors" ? "evidence" : field))
              .join(", ")} of ${this.state.model.label(edit.id)}`,
        )
        .join("; ") ?? "author edit"
    );
  }

  /** Refresh unrelated content first; touched-field preconditions still forbid overwriting another author. */
  async undoEdit(redo = false): Promise<void> {
    if (this.state.editDraft)
      throw new Error("Save or cancel the author draft before undo or redo.");
    const from = redo ? this.redoEdits : this.undoEdits;
    const edits = from.at(-1);
    if (!edits) return;
    await this.writeEdits(edits, redo ? "redo" : "undo");
  }

  private async writeEdits(
    edits: UserEdit[],
    action: "save" | "undo" | "redo",
    version?: ArtifactIdentity,
  ): Promise<void> {
    if (this.state.editBusy) throw new Error("Wait for the current edit to finish saving.");
    try {
      if ([...this.pending.values()].some((write) => write.kind === "author" && !write.applied))
        throw new Error("Retry or cancel the pending author save before submitting another edit.");
      if (action === "save" && edits.some((edit) => "anchors" in edit.after))
        applyUserEdits(this.state.explainer, edits, this.indexModel, snapshotTexts(this.state));
      await this.flush();
      if (this.api && this.state.dirty) throw new Error("Save or cancel the pending edits first.");
      const write: Extract<PendingWrite, { kind: "author" }> = {
        kind: "author",
        edits,
        version,
        action,
        applied: false,
      };
      const id = `author:${++this.authorSequence}`;
      if (!this.api) {
        const current = this.state.explainer;
        const expected = artifactIdentity(current, this.indexModel.index);
        if (version && JSON.stringify(version) !== JSON.stringify(expected))
          throw new Error(
            "This explanation changed while you were editing. Reopen the editor and inspect it before saving.",
          );
        write.version = version ?? expected;
        const result = applyUserEdits(current, edits, this.indexModel, snapshotTexts(this.state));
        this.pending.set(id, write);
        this.acceptAuthor(write, result);
        return;
      }
      this.pending.set(id, write);
      this.set({ save: { status: "saving" } });
      await this.flush();
      if (!write.applied)
        throw new Error(
          this.state.save.status === "error"
            ? this.state.save.message
            : "Author edit remains unsaved. Use Retry save.",
        );
    } catch (error) {
      this.set({
        editError: messageOf(error),
        save: { status: "error", message: messageOf(error) },
      });
      throw error;
    }
  }

  /** Bind the author action to the inspected snapshot, never regenerate its fingerprint at save time. */
  async recordReview(snapshot: ViewerBundle, review: ExplainerPatch["review"]): Promise<void> {
    if (this.state.readOnlyGuide) throw new Error("This guide preview is read-only.");
    if (this.state.editBusy || this.state.editDraft)
      throw new Error("Save or cancel the author edit before recording a review.");
    await this.flush();
    if (this.api && (this.state.dirty || this.state.save.status === "error"))
      throw new Error("Save the pending edits before recording a review.");
    const current = this.state.explainer;
    const result = applyPatch(
      current,
      { review },
      this.indexModel,
      snapshotTexts({ ...snapshot, explainer: current }),
      { actor: "user" },
    );
    if (!result.ok)
      throw new Error(
        result.issues.find((i) => i.severity === "error")?.message ?? "Review rejected.",
      );
    const write: PendingWrite = { kind: "review", review };
    this.pending.set("review", write);
    this.set({ explainer: result.explainer, model: this.modelOf(result.explainer) });
    const api = this.api;
    if (api) {
      await this.flush();
      if (this.pending.has("review")) {
        const message =
          this.state.save.status === "error"
            ? this.state.save.message
            : "Review remains unsaved. Use Retry save.";
        // An explicit author action refused by the server must be inspected again. Network failures
        // and offline Retry saves retain their pending review; newer actions are never rolled back.
        if (this.pending.get("review") === write && /^4\d\d\b/.test(message)) {
          this.pending.delete("review");
          const explainer = { ...this.state.explainer, review: current.review };
          this.set({
            explainer,
            model: this.modelOf(explainer),
            save: this.pending.size > 0 ? this.state.save : { status: "idle" },
          });
        }
        throw new Error(message);
      }
      if (this.api !== api) return;
      const bundle = await api.bundle();
      this.adoptExplainer(bundle.explainer, bundle);
    }
  }

  // ─── Tour edits (Explore): persisted like view edits ─────────────────────────────────────────

  /**
   * "Add to tour": appends a step `{ view, focus: the selection }` to a tour, or, given a title, to a
   * new tour `tour:<slug of the title>`. Render-only ids (stubs, ghosts) are not stored. Returns where
   * the step went; undefined without a view, or when the tour does not exist or the title is empty.
   */
  addToTour(
    target: { tourId: string } | { title: string },
  ): { tourId: string; stepId: string } | undefined {
    const { viewId, selection, model } = this.state;
    if (viewId === undefined) return undefined;
    let tour: Tour | undefined;
    if ("tourId" in target) tour = model.tour(target.tourId);
    else {
      const title = target.title.trim();
      if (title !== "") {
        tour = {
          id: newTourId(
            title,
            model.tours.map((t) => t.id),
          ),
          title,
          steps: [],
        };
      }
    }
    if (!tour) return undefined;
    const added = appendStep(tour, viewId, focusIds(selection, model));
    this.editTour(added.tour, true);
    return { tourId: tour.id, stepId: added.stepId };
  }

  /** The note of a step (markdown, shown as the caption); empty text removes it. */
  setStepNote(tourId: string, stepId: string, note: string): void {
    const tour = this.state.model.tour(tourId);
    if (tour) this.editTour(setStepNote(tour, stepId, note));
  }

  /** Moves a step up (`-1`) or down (`+1`) within its tour. */
  moveStep(tourId: string, stepId: string, delta: -1 | 1): void {
    const tour = this.state.model.tour(tourId);
    if (tour) this.editTour(moveStep(tour, stepId, delta));
  }

  /** Deletes a step; returns it with its position, so that the caller can offer an undo. */
  removeStep(tourId: string, stepId: string): { step: TourStep; index: number } | undefined {
    const tour = this.state.model.tour(tourId);
    const index = tour ? tour.steps.findIndex((step) => step.id === stepId) : -1;
    if (!tour || index === -1) return undefined;
    const step = tour.steps[index]!;
    this.editTour(removeStep(tour, stepId));
    return { step, index };
  }

  /** Puts a deleted step back where it was. */
  restoreStep(tourId: string, step: TourStep, index: number): void {
    const tour = this.state.model.tour(tourId);
    if (tour) this.editTour(insertStep(tour, step, index));
  }

  private editTour(tour: Tour, choose = false): void {
    if (this.state.editBusy || this.state.readOnlyGuide) return;
    const before = this.state.model.tour(tour.id);
    if (before === tour) return;
    const explainer = withTour(this.state.explainer, tour);
    const model = this.modelOf(explainer);
    const at = this.state.tour;
    // Keep the position inside the tour; adding to a tour makes it the one Present plays.
    const tourPosition: TourPosition | undefined =
      at?.tourId === tour.id
        ? { tourId: tour.id, step: clampStep(at.step, tour.steps.length) }
        : choose
          ? { tourId: tour.id, step: 0 }
          : at;
    this.queueSave(tour.id, {});
    this.set({
      explainer,
      model,
      tour: tourPosition,
      ...(this.api ? { save: { status: "saving" } as SaveState } : {}),
    });
  }

  // ─── Explain requests and export ─────────────────────────────────────────────────────────────

  /** Persist before returning. Storage refusal stays visible and exports remain available. */
  private keepFeedback(requests: readonly FeedbackRequest[]): void {
    const held = mergeFeedbackRequests([...this.state.feedback, ...requests]);
    this.set({ feedback: held });
    try {
      // Read both legacy arrays and per-ID records. New writes never replace either format.
      const saved = localStorage.getItem(this.feedbackStorageKey);
      const stored = saved ? parseFeedbackFile(JSON.parse(saved)).requests : [];
      const prefix = `${this.feedbackStorageKey}:request:`;
      for (let i = 0; i < localStorage.length; i++) {
        const key = localStorage.key(i);
        if (!key?.startsWith(prefix)) continue;
        const json = localStorage.getItem(key);
        if (json !== null) stored.push(parseFeedbackRequest(JSON.parse(json)));
      }
      const feedback = mergeFeedbackRequests([...held, ...stored]);
      this.set({ feedback, feedbackStorageError: undefined });
      for (const request of feedback) {
        // Immutable versions prevent a stale read in another tab from overwriting a newer outcome.
        const json = JSON.stringify(request);
        const key = `${prefix}${encodeURIComponent(request.id)}:revision:${request.outcome.revision}:${hashText(json)}`;
        if (localStorage.getItem(key) === null) localStorage.setItem(key, json);
      }
    } catch (error) {
      this.set({
        feedbackStorageError: `Browser storage unavailable: ${String(error)}. Export feedback JSON to keep it.`,
      });
    }
  }

  private loadFeedback(embedded: ViewerBundle["feedback"]): void {
    try {
      this.keepFeedback(embedded ? parseFeedbackFile(embedded).requests : []);
    } catch (error) {
      this.set({
        feedbackStorageError: `Could not reload browser feedback: ${String(error)}. Export feedback JSON before closing this page.`,
      });
    }
  }

  async refreshFeedback(): Promise<void> {
    this.loadFeedback(undefined);
    if (!this.api) return;
    // Every response uses the same revision rule, including delayed or overlapping refreshes.
    this.keepFeedback(await this.api.requests());
  }

  /** Export only after reconciling every observed version, including a refreshed bundle. */
  feedbackFile(embedded?: FeedbackFile): FeedbackFile {
    this.loadFeedback(embedded);
    return { schema: FEEDBACK_SCHEMA, requests: this.state.feedback };
  }

  feedbackJson(): string {
    return JSON.stringify(this.feedbackFile(), null, 2) + "\n";
  }

  /** Capture the element and selected inclusive lines against exactly the snapshot being viewed. */
  async requestExplain(
    id: ElementId,
    note?: string,
    kind: FeedbackKind = "expand",
  ): Promise<"queued" | "command"> {
    const at = new Date().toISOString();
    const cursor = this.state.cursor;
    const focus = codeFocus([id], this.state.model)[0];
    const range = cursor
      ? { ...cursor, side: cursor.side ?? ("head" as const) }
      : focus
        ? {
            file: focus.file,
            fromLine: focus.range.startLine,
            toLine: focus.range.endLine,
            side: "head" as const,
          }
        : undefined;
    const request = parseFeedbackRequest({
      id:
        crypto.randomUUID?.() ??
        Array.from(crypto.getRandomValues(new Uint8Array(16)), (n) =>
          n.toString(16).padStart(2, "0"),
        ).join(""),
      kind,
      elementId: id,
      at,
      context: artifactIdentity(this.state.explainer, this.state.model.index.index),
      ...(this.state.sourceWarning ? { sourceWarning: this.state.sourceWarning } : {}),
      ...(note?.trim() ? { note: note.trim() } : {}),
      ...(this.state.viewId ? { view: this.state.viewId } : {}),
      label: this.state.model.label(id),
      ...(range ? { range } : {}),
      outcome: {
        revision: 0,
        status: "pending",
        reason: "Awaiting an explicit revision pass.",
        at,
      },
    });
    // Include other tabs' requests in this page without rewriting their stored records.
    this.loadFeedback({ schema: FEEDBACK_SCHEMA, requests: this.state.feedback });
    this.keepFeedback([request]);
    if (!this.api) return "command";
    await this.api.postRequest(request);
    return "queued";
  }

  // ─── Changes made on disk (Claude's `xpl apply`) ──────────────────────────────────────────────

  get canReconnect(): boolean {
    return this.liveApi !== undefined;
  }

  /** Keep loaded data and browser feedback usable after stopping the optional service. */
  useOfflineSnapshot(): void {
    this.api = undefined;
    if (this.saveTimer !== undefined) clearTimeout(this.saveTimer);
    this.saveTimer = undefined;
    this.set({
      serverMode: false,
      connection: { ...this.state.connection, status: "offline", message: undefined },
    });
  }

  /** Retry the page's original address and repository/guide, without discarding edits. */
  async reconnect(): Promise<void> {
    if (!this.liveApi) return;
    this.api = this.liveApi;
    this.set({
      serverMode: true,
      ...(this.state.dirty
        ? {
            save: {
              status: "error" as const,
              message: "Offline edits remain unsaved. Use Retry save to persist them.",
            },
          }
        : {}),
      connection: { ...this.state.connection, status: "connecting", message: undefined },
    });
    if (!this.pollConnection) this.watchExplainer();
    await this.pollConnection?.();
  }

  async controlWatch(action: "pause" | "resume" | "stop"): Promise<void> {
    if (!this.api || !this.state.attention || !this.state.serverMode)
      throw new Error("Watch controls need a connected managed service.");
    const api = this.api;
    const attention = await api.controlWatch(action, this.state.attention.instanceId);
    if (this.api === api && attention) this.set({ attention, attentionError: undefined });
  }

  /**
   * Under `xpl view`, polls `GET {api}/explainer` and shows what changed on disk without a reload, so
   * source edits, new indexes and applied feedback arrive together. Fetches a fresh bundle after the
   * workspace ETag changes and preserves unsaved edits and reader position. Availability still updates
   * with unsaved edits. Only an unmanaged server without this endpoint stops automatic polling.
   * Returns the function that stops it.
   */
  watchExplainer(intervalMs = WATCH_INTERVAL_MS): () => void {
    if (!this.liveApi) return () => undefined;
    let etag: string | undefined;
    let busy = false;
    let stopped = false;
    const poll = async () => {
      const api = this.api;
      if (!api || stopped || busy || (typeof document !== "undefined" && document.hidden)) return;
      busy = true;
      let serviceAvailable = false;
      try {
        if (api.attachment?.instanceId) {
          try {
            const attention = await api.attention();
            if (this.api !== api || stopped) return;
            serviceAvailable = attention?.instanceId === api.attachment.instanceId;
            this.set({ attention, attentionError: undefined });
          } catch (error) {
            if (this.api !== api || stopped) return;
            this.set({ attentionError: messageOf(error) });
          }
        }
        const fresh = await api.getExplainer(etag);
        if (this.api !== api) return;
        if (fresh) {
          const bundle = await api.bundle();
          if (this.api !== api) return;
          this.set({
            connection: {
              status: "connected",
              attachment: bundle.server?.attachment ?? api.attachment,
            },
          });
          // Availability still updates while edits prevent adoption of a new workspace.
          if (
            this.state.editBusy ||
            this.state.editDraft ||
            this.state.dirty ||
            this.pending.size > 0 ||
            this.saving
          )
            return;
          const files = { ...bundle.files };
          const fileErrors: Record<string, string> = {};
          await Promise.all(
            Object.keys(this.state.files)
              .filter((file) => !(file in files))
              .map(async (file) => {
                try {
                  files[file] = await api.file(file);
                } catch (error) {
                  fileErrors[file] = messageOf(error);
                }
              }),
          );
          if (
            this.api === api &&
            this.adoptExplainer(bundle.explainer, { ...bundle, files, fileErrors })
          )
            etag = fresh.etag;
        } else {
          this.set({
            connection: { ...this.state.connection, status: "connected", message: undefined },
          });
        }
      } catch (error) {
        if (this.api !== api) return;
        const message = messageOf(error);
        this.set({
          connection: {
            ...this.state.connection,
            status: serviceAvailable
              ? "connected"
              : /^\d{3}\b/.test(message)
                ? "unavailable"
                : "disconnected",
            message,
          },
        });
        // Old unmanaged viewers have no polling endpoint. Managed services keep retrying.
        if (!api.attachment?.instanceId && /^404\b/.test(message)) stop();
      } finally {
        busy = false;
      }
    };
    this.pollConnection = async () => {
      etag = undefined;
      await poll();
    };
    const timer = setInterval(() => void poll(), intervalMs);
    const stop = () => {
      stopped = true;
      clearInterval(timer);
      this.pollConnection = undefined;
    };
    return stop;
  }

  /**
   * Shows `explainer` (a newer version from disk) in place of the current one, keeping where the user
   * is: the view, the tour step and the selection, as far as they still exist. Skipped while edits made
   * here are not saved yet: they would be lost, and the next poll after the save brings both.
   */
  adoptExplainer(
    explainer: Explainer,
    workspace?: ViewerBundle & { fileErrors?: Record<string, string> },
  ): boolean {
    if (
      this.state.editBusy ||
      this.state.editDraft ||
      this.state.dirty ||
      this.pending.size > 0 ||
      this.saving
    )
      return false;
    if (!workspace && serializeExplainer(explainer) === serializeExplainer(this.state.explainer))
      return false;
    if (workspace) {
      this.workspaceRevision++;
      this.indexModel = asIndexModel(workspace.index);
    }
    const model = this.modelOf(explainer);
    const { viewId, tour, applied } = this.state;
    const tourNow = tour ? model.tour(tour.tourId) : undefined;
    const selection = this.state.selection.filter((id) => model.hasElement(id));
    this.set({
      explainer,
      model,
      viewId: viewId !== undefined && model.view(viewId) ? viewId : model.views[0]?.id,
      tour:
        tour && tourNow ? { ...tour, step: clampStep(tour.step, tourNow.steps.length) } : undefined,
      applied: applied && model.tour(applied.tourId) ? applied : undefined,
      ...(selection.length !== this.state.selection.length ? { selection } : {}),
      ...(workspace
        ? {
            files: workspace.files,
            fileErrors: workspace.fileErrors ?? {},
            baseFiles: workspace.baseFiles ?? {},
            baseErrors: {},
            sourceWarning: workspace.sourceWarning,
            exportInfo: workspace.exportInfo,
          }
        : {}),
    });
    return true;
  }

  /** The explainer as pretty JSON, including the view and tour edits made in this session. */
  explainerJson(): string {
    return serializeExplainer(this.state.explainer);
  }
}
