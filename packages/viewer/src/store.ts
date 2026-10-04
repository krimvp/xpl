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
  FEEDBACK_SCHEMA,
  parseFeedbackFile,
  parseFeedbackRequest,
  sameFeedbackContent,
  type FeedbackKind,
  type FeedbackRequest,
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
} from "@xpl/core";
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

export interface ViewerState {
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
  /** Running under `xpl view`. */
  serverMode: boolean;
  feedback: FeedbackRequest[];
  feedbackStorageError?: string;
  /** The live source no longer matches its index; reindex before trusting locations and edges. */
  sourceWarning: string | undefined;
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

export class ViewerStore {
  private state: ViewerState;
  private readonly listeners = new Set<() => void>();
  private readonly api: ServerApi | undefined;
  private indexModel: IndexModel;
  private workspaceRevision = 0;
  private readonly loading = new Set<FilePath>();
  private readonly loadingBase = new Set<FilePath>();
  private readonly pending = new Map<string, Record<string, unknown>>();
  private saveTimer: ReturnType<typeof setTimeout> | undefined;
  private saving: Promise<void> | undefined;
  private readonly past: Navigation[] = [];
  private readonly future: Navigation[] = [];
  /** The reading tab (Guide, Map, Flow, Code) last on screen: where "Back to reading" goes from Explore. */
  private reading: Exclude<Perspective, "explore"> = "guide";
  /** Namespace of the page as loaded; edits change request context, never where requests are saved. */
  private readonly feedbackStorageKey: string;

  constructor(bundle: ViewerBundle, launch: LaunchParams = {}) {
    const identity = artifactIdentity(bundle.explainer, bundle.index);
    this.feedbackStorageKey = `xpl-feedback:${identity.explainerHash}:${identity.sourceHash}`;
    this.indexModel = asIndexModel(bundle.index);
    this.api = bundle.server?.api ? new ServerApi(bundle.server.api) : undefined;
    const explainer = bundle.explainer;
    const model = this.modelOf(explainer);
    const views = model.views;
    const viewId = views.find((v) => v.id === launch.view)?.id ?? views[0]?.id;

    // Where to start: the URL wins over the bundle. A tour that does not exist falls back to the first
    // one when the page is to open in Present, and to none in Explore.
    const tours = model.tours;
    const asked = findTour(tours, launch.tour) ?? findTour(tours, bundle.tour);
    const present = (launch.mode ?? bundle.mode ?? "explore") === "present" && tours.length > 0;
    const tour = asked ?? (present ? tours[0] : undefined);
    this.state = {
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
      serverMode: this.api !== undefined,
      sourceWarning: bundle.sourceWarning,
      feedback: [],
    };
    this.loadFeedback(bundle.feedback);
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
    this.state = { ...this.state, ...patch };
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
  ): void {
    const from = Math.max(1, Math.floor(fromLine));
    const to = Math.max(from, Math.floor(toLine));
    const cur = this.state.cursor;
    if (
      cur &&
      cur.file === file &&
      cur.fromLine === from &&
      cur.toLine === to &&
      (cur.side ?? "head") === side
    )
      return;
    this.set({
      cursor: { file, fromLine: from, toLine: to, ...(side === "base" ? { side } : {}) },
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
    const explainer = withViewFields(this.state.explainer, viewId, fields);
    if (explainer === this.state.explainer) return;
    const model = this.modelOf(explainer);
    const selection = this.stillShown(model, viewId, this.state.selection);
    this.set({
      explainer,
      model,
      ...(selection.length !== this.state.selection.length
        ? { selection, applied: undefined }
        : {}),
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

  /**
   * Queues an edit for the server: changed fields of a view, or (for a tour, whose fields stay empty)
   * "send this tour", which reads the tour as it is when the request goes out.
   */
  private queueSave(id: string, fields: Record<string, unknown>): void {
    this.pending.set(id, { ...this.pending.get(id), ...fields });
    if (this.saveTimer !== undefined) clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => {
      this.saveTimer = undefined;
      void this.flush();
    }, SAVE_DELAY_MS);
  }

  private async send(api: ServerApi, id: string, fields: Record<string, unknown>): Promise<void> {
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
      const failed = new Map<string, Record<string, unknown>>();
      let firstError: unknown;
      try {
        for (;;) {
          const batch = [...this.pending].filter(([id]) => !failed.has(id));
          if (batch.length === 0) break;
          for (const [id, fields] of batch) {
            this.pending.delete(id);
            try {
              await this.send(api, id, fields);
            } catch (error) {
              failed.set(id, fields);
              firstError ??= error;
            }
          }
        }
      } finally {
        for (const [id, fields] of failed) {
          this.pending.set(id, { ...fields, ...this.pending.get(id) });
        }
        this.saving = undefined;
      }
      if (firstError === undefined) this.set({ dirty: false, save: { status: "saved" } });
      else this.set({ save: { status: "error", message: messageOf(firstError) } });
    })();
    await this.saving;
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
    this.set({
      explainer,
      model,
      tour: tourPosition,
      dirty: true,
      ...(this.api ? { save: { status: "saving" } as SaveState } : {}),
    });
    if (this.api) this.queueSave(tour.id, {});
  }

  // ─── Explain requests and export ─────────────────────────────────────────────────────────────

  private mergeFeedback(requests: readonly FeedbackRequest[]): FeedbackRequest[] {
    const merged = new Map<string, FeedbackRequest>();
    for (const request of requests) {
      const original = merged.get(request.id);
      if (original && !sameFeedbackContent(original, request))
        throw new Error(`Conflicting original content for request ${request.id}`);
      if (!original || Date.parse(request.outcome.at) > Date.parse(original.outcome.at))
        merged.set(request.id, request);
    }
    return [...merged.values()];
  }

  /** Persist before returning. Storage refusal stays visible and exports remain available. */
  private keepFeedback(requests: FeedbackRequest[]): void {
    this.set({ feedback: this.mergeFeedback([...this.state.feedback, ...requests]) });
    if (this.state.feedbackStorageError) return;
    try {
      // One atomic browser write per ID: saving in another tab cannot replace this request.
      for (const request of requests) {
        const key = `${this.feedbackStorageKey}:request:${encodeURIComponent(request.id)}`;
        const saved = localStorage.getItem(key);
        const current = saved ? [parseFeedbackRequest(JSON.parse(saved))] : [];
        const latest = this.mergeFeedback([...current, request])[0]!;
        localStorage.setItem(key, JSON.stringify(latest));
      }
      this.set({ feedbackStorageError: undefined });
    } catch (error) {
      this.set({
        feedbackStorageError: `Browser storage unavailable: ${String(error)}. Export feedback JSON to keep it.`,
      });
    }
  }

  private loadFeedback(embedded: ViewerBundle["feedback"]): void {
    try {
      const requests = embedded ? parseFeedbackFile(embedded).requests : [];
      this.set({ feedback: requests });
      // Keep reading the old array without rewriting it; new saves use individual request keys.
      const saved = localStorage.getItem(this.feedbackStorageKey);
      const stored = saved ? parseFeedbackFile(JSON.parse(saved)).requests : [];
      const prefix = `${this.feedbackStorageKey}:request:`;
      for (let i = 0; i < localStorage.length; i++) {
        const key = localStorage.key(i);
        if (!key?.startsWith(prefix)) continue;
        const json = localStorage.getItem(key);
        if (json !== null) stored.push(parseFeedbackRequest(JSON.parse(json)));
      }
      this.set({
        feedback: this.mergeFeedback([...requests, ...stored]),
        feedbackStorageError: undefined,
      });
    } catch (error) {
      this.set({
        feedbackStorageError: `Could not reload browser feedback: ${String(error)}. Export feedback JSON before closing this page.`,
      });
    }
  }

  async refreshFeedback(): Promise<void> {
    this.loadFeedback({ schema: FEEDBACK_SCHEMA, requests: this.state.feedback });
    if (!this.api) return;
    this.keepFeedback(await this.api.requests());
  }

  feedbackJson(): string {
    return (
      JSON.stringify({ schema: FEEDBACK_SCHEMA, requests: this.state.feedback }, null, 2) + "\n"
    );
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
      outcome: { status: "pending", reason: "Awaiting an explicit revision pass.", at },
    });
    // Include other tabs' requests in this page without rewriting their stored records.
    this.loadFeedback({ schema: FEEDBACK_SCHEMA, requests: this.state.feedback });
    this.keepFeedback([request]);
    if (!this.api) return "command";
    await this.api.postRequest(request);
    return "queued";
  }

  // ─── Changes made on disk (Claude's `xpl apply`) ──────────────────────────────────────────────

  /**
   * Under `xpl view`, polls `GET {api}/explainer` and shows what changed on disk without a reload, so
   * source edits, new indexes and applied feedback arrive together. Fetches a fresh bundle after the
   * workspace ETag changes and preserves unsaved edits and reader position. Stops for
   * good on a server that has no such endpoint. Returns the function that stops it.
   */
  watchExplainer(intervalMs = WATCH_INTERVAL_MS): () => void {
    const api = this.api;
    if (!api) return () => undefined;
    let etag: string | undefined;
    let busy = false;
    const poll = async () => {
      if (
        busy ||
        this.state.dirty ||
        this.pending.size > 0 ||
        this.saving ||
        (typeof document !== "undefined" && document.hidden)
      )
        return;
      busy = true;
      try {
        const fresh = await api.getExplainer(etag);
        if (fresh) {
          const bundle = await api.bundle();
          const files = { ...bundle.files };
          const fileErrors: Record<string, string> = {};
          // Include files opened outside the explanation, rather than keeping their old cached text.
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
          // Do not acknowledge a skipped update: poll again once the user's edits are saved.
          if (this.adoptExplainer(bundle.explainer, { ...bundle, files, fileErrors }))
            etag = fresh.etag;
        }
      } catch (error) {
        if (/^404\b/.test(messageOf(error))) stop();
      } finally {
        busy = false;
      }
    };
    const timer = setInterval(() => void poll(), intervalMs);
    const stop = () => clearInterval(timer);
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
    if (this.state.dirty || this.pending.size > 0 || this.saving) return false;
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
