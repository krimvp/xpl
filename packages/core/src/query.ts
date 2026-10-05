/** Pure queries over the supplied snapshot. Missing text and pruned/failed analysis remain in the scope. */
import { toTextCache, type GetText, type TextCache } from "./anchors.js";
import { asIndexModel, type IndexModel } from "./index-model.js";
import { CODE_LANGUAGES } from "./languages.js";
import type { AnalysisReport, ElementId, Explainer, Range, SymbolIndex } from "./schema.js";

export interface QueryGuide {
  /** Stable catalog key, supplied by the adapter; never interpreted as a filesystem path. */
  id: string;
  explainer: Explainer;
}

export interface GuideDescriptor {
  id: string;
  title: string;
  audience?: string;
  questions: string[];
  roots: ElementId[];
  kind: "repository" | "subsystem" | "question" | "change" | "unknown";
  commit: string;
  indexCommit: string;
  change?: { base: string; head: string };
}

/** Metadata for a local or exported catalog; scope comes from recorded views, never the filename. */
export function guideCatalog(guides: readonly QueryGuide[]): GuideDescriptor[] {
  return guides.map(({ id, explainer: e }) => {
    const questions = [
      ...new Set(e.views.map((v) => v.scope.question).filter((q): q is string => !!q)),
    ];
    const roots = [...new Set(e.views.map((v) => v.scope.root))];
    return {
      id,
      title: e.title,
      ...(e.scope?.audience !== undefined ? { audience: e.scope.audience } : {}),
      questions,
      roots,
      kind: e.change
        ? "change"
        : questions.length
          ? "question"
          : roots.includes("repo")
            ? "repository"
            : roots.length
              ? "subsystem"
              : "unknown",
      commit: e.repo.commit,
      indexCommit: e.index.commit,
      ...(e.change ? { change: { base: e.change.base, head: e.change.head } } : {}),
    };
  });
}

export interface SourceHit {
  kind: "source";
  file: string;
  line: number;
  /** First match on the line, inclusive UTF-16 columns; zero-width regex hits cover the whole line. */
  range: Range;
  id: ElementId;
  offset: number;
  /** Display text only. Columns always refer to the untrimmed source. */
  text: string;
}

export type QueryHit =
  | SourceHit
  | {
      kind: "symbol";
      file: string;
      range: Range;
      id: ElementId;
      text: string;
    }
  | ({ guide: string; commit: string; text: string } & (
      | { kind: "guide" }
      | { kind: "concept"; element: ElementId }
      | { kind: "tour"; tour: string }
      | {
          kind: "step";
          tour: string;
          step: string;
          stepIndex: number;
          view: string;
          focus: ElementId[];
        }
      | { kind: "step"; view: string; step: string; element: ElementId }
    ));

export interface QueryOptions {
  pattern: string;
  regex?: boolean;
  ignoreCase?: boolean;
  /** Source and symbols first, followed by guide context. Defaults to all kinds. */
  kinds?: readonly QueryHit["kind"][];
  /** Default 50; 0 = all. Total counts every hit before this limit. */
  limit?: number;
  /** Skip this many matches before retaining a bounded page. Totals still count every match. */
  offset?: number;
  codeOnly?: boolean;
  /** Adapter-resolved source/symbol scope, e.g. CLI --under. Guide text is independent of it. */
  scope?: { hasFile(path: string): boolean; hasLine(path: string, line: number): boolean };
  guides?: readonly QueryGuide[];
  textOrigin?: "working-tree" | "supplied";
}

export interface QueryScope {
  commit: string;
  textOrigin: "working-tree" | "supplied";
  indexedFiles: string[];
  /** Indexed paths selected by codeOnly/scope, even when their text is unavailable. */
  selectedFiles: string[];
  searchedFiles: string[];
  unavailableFiles: string[];
  symbols: { retained: number; total: number };
  refs: { retained: number; total: number };
  /** Original run coverage, not a promise of completeness for the retained index. Absent = unknown. */
  analysis: AnalysisReport[] | undefined;
  guides: GuideDescriptor[];
}

export interface QueryResult {
  hits: QueryHit[];
  total: number;
  matchedFiles: number;
  scope: QueryScope;
}

/** Code, then config, then other text; paths are already sorted by IndexModel. */
function fileRank(language: string): number {
  return CODE_LANGUAGES.has(language) ? 0 : ["yaml", "json", "toml"].includes(language) ? 1 : 2;
}

function matcher(
  options: QueryOptions,
): (text: string) => { index: number; length: number } | undefined {
  if (options.regex) {
    let re: RegExp;
    try {
      re = new RegExp(options.pattern, options.ignoreCase ? "i" : "");
    } catch (error) {
      throw new Error(
        `invalid regular expression: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    return (text) => {
      const m = re.exec(text);
      return m ? { index: m.index, length: m[0].length } : undefined;
    };
  }
  const needle = options.ignoreCase ? options.pattern.toLowerCase() : options.pattern;
  return (text) => {
    const haystack = options.ignoreCase ? text.toLowerCase() : text;
    const at = haystack.indexOf(needle);
    if (at < 0) return undefined;
    if (haystack.length === text.length) return { index: at, length: needle.length };
    // Lowercasing can expand a character (İ → i + combining dot). Map both boundaries back to source.
    let original = 0,
      folded = 0,
      start = 0,
      end = 0;
    for (const char of text) {
      const next = folded + char.toLowerCase().length;
      if (folded <= at && at < next) start = original;
      if (folded < at + needle.length && at + needle.length <= next) end = original + char.length;
      original += char.length;
      folded = next;
    }
    return { index: start, length: end - start };
  };
}

export function query(
  source: SymbolIndex | IndexModel,
  text: GetText | TextCache,
  options: QueryOptions,
): QueryResult {
  if (!options.pattern) throw new Error("the search pattern is empty");
  const limit = options.limit ?? 50;
  const offset = options.offset ?? 0;
  if (!Number.isSafeInteger(limit) || limit < 0)
    throw new Error("the search limit must be a non-negative integer");
  if (!Number.isSafeInteger(offset) || offset < 0)
    throw new Error("the search offset must be a non-negative integer");
  const matchText = matcher(options);
  const model = asIndexModel(source);
  const texts = toTextCache(text);
  const wants = (kind: QueryHit["kind"]) => !options.kinds || options.kinds.includes(kind);
  const files = model.files
    .filter(
      (f) =>
        (!options.codeOnly || CODE_LANGUAGES.has(f.language)) &&
        (!options.scope || options.scope.hasFile(f.path)),
    )
    .sort((a, b) => fileRank(a.language) - fileRank(b.language));
  const selected = new Set(files.map((f) => f.path));
  const searchedFiles: string[] = [];
  const unavailableFiles: string[] = [];
  const hits: QueryHit[] = [];
  const matchedFiles = new Set<string>();
  let total = 0;
  const offer = (hit: QueryHit) => {
    total++;
    if (hit.kind === "source" || hit.kind === "symbol") matchedFiles.add(hit.file);
    if (total > offset && (limit === 0 || hits.length < limit)) hits.push(hit);
  };
  if (wants("source"))
    for (const file of files) {
      const lines = texts.lines(file.path);
      if (!lines) {
        unavailableFiles.push(file.path);
        continue;
      }
      searchedFiles.push(file.path);
      for (let i = 0; i < lines.length; i++) {
        const line = i + 1;
        if (options.scope && !options.scope.hasLine(file.path, line)) continue;
        const match = matchText(lines[i]!);
        if (!match) continue;
        if (total < offset || (limit > 0 && hits.length >= limit)) {
          total++;
          matchedFiles.add(file.path);
          continue;
        }
        const symbol = model.innermostSymbolAt(file.path, line);
        offer({
          kind: "source",
          file: file.path,
          line,
          range: {
            startLine: line,
            endLine: line,
            ...(match.length
              ? { startCol: match.index + 1, endCol: match.index + match.length }
              : {}),
          },
          id: symbol ? `sym:${symbol.id}` : `file:${file.path}`,
          offset: line - (symbol?.range.startLine ?? 1),
          text: lines[i]!.trim(),
        });
      }
    }
  if (wants("symbol"))
    for (const s of model.symbols) {
      if (
        !selected.has(s.file) ||
        (options.scope && !options.scope.hasLine(s.file, s.range.startLine))
      )
        continue;
      if (matchText(s.path))
        offer({
          kind: "symbol",
          file: s.file,
          range: { ...s.range },
          id: `sym:${s.id}`,
          text: s.path,
        });
    }
  const guides = options.guides ?? [];
  const catalog = guideCatalog(guides);
  for (let i = 0; i < guides.length; i++) {
    const { id, explainer: e } = guides[i]!;
    const base = { guide: id, commit: e.index.commit };
    const descriptor = catalog[i]!;
    const guideText = [descriptor.title, descriptor.audience, ...descriptor.questions]
      .filter(Boolean)
      .join("\n");
    if (wants("guide") && matchText(guideText)) offer({ ...base, kind: "guide", text: guideText });
    if (wants("concept"))
      for (const c of e.concepts) {
        const text = [c.label, c.summary].filter(Boolean).join("\n");
        if (matchText(text)) offer({ ...base, kind: "concept", element: c.id, text });
      }
    for (const tour of e.tours) {
      const text = [tour.title, tour.summary].filter(Boolean).join("\n");
      if (wants("tour") && matchText(text)) offer({ ...base, kind: "tour", tour: tour.id, text });
      if (wants("step"))
        tour.steps.forEach((step, stepIndex) => {
          if (step.note && matchText(step.note))
            offer({
              ...base,
              kind: "step",
              tour: tour.id,
              step: step.id,
              stepIndex,
              view: step.view,
              focus: [...step.focus],
              text: step.note,
            });
        });
    }
    if (wants("step"))
      for (const view of e.views) {
        if (view.type === "graph") continue;
        for (const step of view.steps) {
          const text = [step.label, step.summary].filter(Boolean).join("\n");
          if (matchText(text))
            offer({ ...base, kind: "step", view: view.id, step: step.id, element: step.id, text });
        }
      }
  }
  return {
    hits,
    total,
    matchedFiles: matchedFiles.size,
    scope: {
      commit: model.commit,
      textOrigin: options.textOrigin ?? "supplied",
      indexedFiles: model.files.map((f) => f.path),
      selectedFiles: files.map((f) => f.path),
      searchedFiles,
      unavailableFiles,
      symbols: {
        retained: model.symbols.length,
        total: model.index.pruned?.symbols ?? model.symbols.length,
      },
      refs: { retained: model.refs.length, total: model.index.pruned?.refs ?? model.refs.length },
      analysis: model.index.analysis,
      guides: catalog,
    },
  };
}
