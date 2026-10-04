/** Source selection shared by the offline export and readiness rules. */
import { collectAnchors } from "./anchors.js";
import { codeFocus, viewCandidates, derivedEdgeMap, type FocusOptions } from "./focus.js";
import { deriveGraph, derivedEdgeAnchors, excludedRefs, repr, type DerivedGraph } from "./graph.js";
import { REF_TO_EDGE_KIND, elementIdForSymbolId } from "./ids.js";
import { ExplainerModel } from "./model.js";
import { relatedFiles } from "./related-files.js";
import type { Explainer, GraphView, Reference } from "./schema.js";
import type { IndexModel } from "./index-model.js";

/**
 * The files the viewer needs for this explainer, i.e. every file whose code something in it can show:
 *
 * - the files of every anchor (elements, sequence steps, tour `code` overrides) and the `editor.primary` of tour
 *   steps;
 * - the code of what the views draw (`codeFocus` of a view's candidates, as the viewer computes it): the files of
 *   the nodes a graph view includes (a directory or group: its files, as many as the viewer focuses at most), of
 *   the sites and definitions behind its derived edges, and of a sequence view's participants and steps;
 * - the code of what a tour step can focus;
 * - the dashed stubs of every graph view, one hop out (`deriveGraph`'s stubs): what the viewer shows when one is
 *   clicked, i.e. the sites of the references that cross the edge of the view there and what they lead to
 *   (see `stubFiles`; `opts.stubs: false` leaves them out, for a viewer that fetches files on demand).
 */
export function referencedFiles(
  explainer: Explainer,
  index: IndexModel,
  opts: { stubs?: boolean } = {},
): string[] {
  const model = new ExplainerModel(explainer, index);
  const files = new Set<string>();
  for (const site of collectAnchors(explainer)) files.add(site.anchor.file);
  const focusOptions = new Map<string, FocusOptions>();
  for (const view of model.views) {
    let derived;
    let options: FocusOptions = {};
    if (view.type === "graph") {
      derived = deriveGraph(view, model);
      options = { derivedEdges: derivedEdgeMap(derived) };
      focusOptions.set(view.id, options);
      if (opts.stubs !== false) for (const file of stubFiles(view, derived, model)) files.add(file);
    }
    const candidates = viewCandidates(view, model, derived);
    for (const focus of codeFocus(candidates, model, options)) files.add(focus.file);
    for (const link of relatedFiles(candidates, model))
      for (const file of link.files) files.add(file);
  }
  for (const tour of model.tours) {
    for (const step of Array.isArray(tour.steps) ? tour.steps : []) {
      const ids = Array.isArray(step.focus) ? step.focus : [];
      for (const focus of codeFocus(ids, model, focusOptions.get(step.view) ?? {})) {
        files.add(focus.file);
      }
      for (const link of relatedFiles(ids, model)) for (const file of link.files) files.add(file);
      if (typeof step.editor?.primary === "string") files.add(step.editor.primary);
    }
  }
  return [...files].filter((file) => index.hasFile(file)).sort();
}

/**
 * The files behind the dashed stubs of a graph view: what the viewer shows when a stub is clicked, the sites of the
 * references that cross the edge of the view there and what they lead to (`derivedEdgeAnchors`, as the viewer
 * builds them), not everything a ghost box could open into: a ghost directory joins the view when it is expanded,
 * and its files are fetched on demand under `xpl view` (a static bundle shows them as not included). The references
 * of files the view excludes (`excludeFiles`) do not count, as in `deriveGraph`.
 */
function stubFiles(view: GraphView, graph: DerivedGraph, model: ExplainerModel): Set<string> {
  const files = new Set<string>();
  if (graph.stubs.length === 0) return files;
  const include = new Set(view.include.filter((id) => typeof id === "string" && model.hasNode(id)));
  const dropRef = excludedRefs(view, model, [...include]);
  const stubsInside = new Map<string, DerivedGraph["stubs"]>();
  for (const stub of graph.stubs) {
    const list = stubsInside.get(stub.inside);
    if (list) list.push(stub);
    else stubsInside.set(stub.inside, [stub]);
  }
  const crossing = new Map<string, Reference[]>();
  // most references share their ends: what stands for an element in the view is worked out once
  const shown = new Map<string, string | undefined>();
  const reprOf = (id: string): string | undefined => {
    if (!shown.has(id)) shown.set(id, repr(id, include, model));
    return shown.get(id);
  };
  for (const ref of model.index.refs) {
    const from = elementIdForSymbolId(ref.from);
    const to = elementIdForSymbolId(ref.to);
    const a = reprOf(from);
    const b = reprOf(to);
    if ((a === undefined) === (b === undefined)) continue; // inside the view or outside it, not across
    if (dropRef?.(ref)) continue;
    const kind = REF_TO_EDGE_KIND[ref.kind];
    const direction = a !== undefined ? "out" : "in";
    const outside = a !== undefined ? to : from;
    for (const stub of stubsInside.get((a ?? b)!) ?? []) {
      if (stub.direction !== direction || !stub.kinds.includes(kind)) continue;
      if (!stub.targets.some((t) => model.subtreeContains(t.target, outside))) continue;
      const list = crossing.get(stub.id);
      if (list) list.push(ref);
      else crossing.set(stub.id, [ref]);
    }
  }
  for (const refs of crossing.values()) {
    for (const anchor of derivedEdgeAnchors(refs, model.index)) files.add(anchor.file);
  }
  return files;
}
