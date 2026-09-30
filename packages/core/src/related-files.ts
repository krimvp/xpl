import { codeFocus, type FocusRange } from "./focus.js";
import { elementIdForSymbolId, parseId } from "./ids.js";
import type { ExplainerModel } from "./model.js";
import type { ElementId, FilePath, ResourceReference } from "./schema.js";

export interface RelatedFileSet {
  id: string;
  kind: ResourceReference["kind"] | "configuration" | "test";
  label: string;
  files: FilePath[];
  evidence: { file: FilePath; line: number }[];
  resolution: "static" | "inferred" | "annotated";
  pattern?: string;
  summary?: string;
}

function targetFiles(
  id: ElementId,
  model: ExplainerModel,
  seen = new Set<ElementId>(),
): FilePath[] {
  if (seen.has(id)) return [];
  seen.add(id);
  const parsed = parseId(id);
  if (parsed.type === "file") return [parsed.path];
  if (parsed.type === "dir" || parsed.type === "repo")
    return [...model.index.filesUnder(parsed.type === "dir" ? parsed.path : "")];
  if (parsed.type === "group")
    return model.members(id).flatMap((member) => targetFiles(member, model, seen));
  return codeFocus([id], model).map((range) => range.file);
}

export function relatedFiles(
  ids: readonly ElementId[],
  model: ExplainerModel,
  extraFocus: readonly FocusRange[] = [],
): RelatedFileSet[] {
  const focus = [
    ...new Map(
      [...codeFocus(ids, model), ...extraFocus].map((range) => [
        `${range.file}:${range.range.startLine}:${range.range.endLine}:${range.role}`,
        range,
      ]),
    ).values(),
  ];
  const configuration = new Set(
    focus.filter((range) => range.role === "config").map((range) => range.file),
  );
  const selected = new Set(ids);
  for (const id of ids)
    for (const related of model.concept(id)?.related ?? []) selected.add(related);
  const contains = (target: string) =>
    [...selected].some(
      (id) =>
        id === target ||
        (model.hasNode(id) && model.hasNode(target) && model.subtreeContains(id, target)),
    );
  const result: RelatedFileSet[] = [];
  for (const [i, resource] of (model.index.index.resources ?? []).entries()) {
    const file = model.index.fileOfSymbolId(resource.from);
    if (
      !file ||
      (!contains(elementIdForSymbolId(resource.from)) &&
        !focus.some(
          (range) =>
            range.file === file &&
            range.range.startLine <= resource.site.startLine &&
            range.range.endLine >= resource.site.endLine,
        ))
    )
      continue;
    const files = resource.files.filter((path) => model.index.hasFile(path));
    if (files.length === 0) continue;
    result.push({
      id: `resource:${i}`,
      kind: resource.kind,
      label: resource.pattern ?? files[0]!,
      files,
      evidence: [{ file, line: resource.site.startLine }],
      resolution: resource.resolution,
      ...(resource.pattern ? { pattern: resource.pattern } : {}),
    });
  }
  for (const edge of model.storedEdges) {
    if (!["loads", "discovers", "configures", "overrides"].includes(edge.kind)) continue;
    const configuredFile = (id: ElementId) =>
      edge.kind === "overrides" &&
      codeFocus([id], model).some((range) => configuration.has(range.file));
    const outgoing = contains(edge.from) || configuredFile(edge.from);
    const incoming = contains(edge.to) || configuredFile(edge.to);
    if (!selected.has(edge.id) && !outgoing && !incoming) continue;
    const target =
      edge.kind === "configures" && incoming
        ? edge.from
        : outgoing || selected.has(edge.id)
          ? edge.to
          : edge.from;
    const files = [...new Set(targetFiles(target, model))].filter((file) =>
      model.index.hasFile(file),
    );
    if (files.length === 0) continue;
    result.push({
      id: edge.id,
      kind: edge.kind as ResourceReference["kind"],
      ...(edge.summary ? { summary: edge.summary } : {}),
      label:
        edge.kind === "overrides" && incoming && !outgoing
          ? `Overridden by ${model.label(target)}`
          : edge.label,
      files,
      resolution: edge.provenance.origin === "llm" ? "inferred" : "annotated",
      evidence: edge.anchors
        .filter((anchor) => anchor.resolved?.status !== "missing")
        .map((anchor) => ({ file: anchor.file, line: anchor.resolved?.range.startLine ?? 1 })),
    });
  }
  for (const role of ["config", "test"] as const) {
    const ranges = focus.filter((range) => range.role === role && model.index.hasFile(range.file));
    for (const file of new Set(ranges.map((range) => range.file))) {
      if (result.some((set) => set.files.includes(file))) continue;
      result.push({
        id: `anchor:${role}:${file}`,
        kind: role === "config" ? "configuration" : "test",
        label: file,
        files: [file],
        resolution: "annotated",
        evidence: ranges
          .filter((range) => range.file === file)
          .map((range) => ({ file, line: range.range.startLine })),
      });
    }
  }
  return result;
}
