import { describeAnchor, reresolveExplainer, type ResolveReport } from "@xpl/core";
import type { CommandSpec } from "../command.js";
import { rangeText } from "../format.js";
import { atomicWrite, jsonFile } from "../fsutil.js";
import { loadExplainer, openWorkspace } from "../repo.js";

/** The human-readable report of a re-resolve (also used by `xpl status`). */
export function renderResolveReport(report: ResolveReport): string[] {
  const { counts } = report;
  const lines = [
    `anchors: ${report.total} (ok ${counts.ok}, moved ${counts.moved}, drifted ${counts.drifted}, missing ${counts.missing})`,
  ];
  if (report.drifted.length > 0) {
    lines.push(`drifted llm elements to re-explain (${report.drifted.length}):`);
    for (const element of report.drifted) {
      const kept =
        element.userFields.length > 0
          ? `  [keep userFields: ${element.userFields.join(", ")}]`
          : "";
      lines.push(`  ${element.elementId}  (${element.owner})${kept}`);
      for (const drifted of element.anchors) {
        const approximate = drifted.approximate
          ? " (approximate: where the span was; the changed code may have shifted, so re-read it)"
          : "";
        lines.push(
          `    ${drifted.path}  ${describeAnchor(drifted.anchor)} [${drifted.anchor.role}]  now at lines ${rangeText(drifted.range)}${approximate}`,
        );
        if (drifted.reason) lines.push(`      ${drifted.reason}`);
      }
    }
  }
  if (report.driftedOther.length > 0) {
    lines.push(`drifted, but not llm-owned (left alone) (${report.driftedOther.length}):`);
    for (const other of report.driftedOther) {
      lines.push(
        `  ${other.elementId}  (origin ${other.origin ?? "?"})  ${other.paths.join(", ")}`,
      );
    }
  }
  if (report.missing.length > 0) {
    lines.push(`missing anchors (${report.missing.length}): fix or drop them explicitly`);
    for (const missing of report.missing) {
      lines.push(
        `  ${missing.elementId}  ${missing.path}  ${describeAnchor(missing.anchor)} [${missing.anchor.role}]`,
        `    ${missing.reason}`,
      );
    }
  }
  return lines;
}

export const resolveCommand: CommandSpec = {
  name: "resolve",
  usage: "xpl resolve <explainer> [--write]",
  summary: "Re-resolve anchors; report drifted llm elements and missing anchors",
  details: [
    "Re-resolves every anchor (elements, sequence steps, tour code overrides) against the index of the",
    "current code: ok, moved (same text, new lines: the span is updated), drifted (text changed) or",
    "missing (symbol gone). Use it after `xpl index` on a changed tree. Unlike the other explainer",
    "commands it ignores the explainer's own (old) index: it uses --index, else the index of the current",
    "commit id, else the newest one.",
    "Prints the counts, the drifted llm elements (re-explain those, skipping their userFields; never",
    "touch origin user) and the missing anchors. --write saves the explainer with the new resolved",
    "ranges and index binding; drifted anchors stay drifted until their element is re-explained.",
  ],
  options: {
    write: { type: "boolean", desc: "Save the re-resolved explainer (default: report only)" },
  },
  positionals: [{ name: "explainer" }],
  async run(ctx, args) {
    const loaded = loadExplainer(ctx, args.positionals[0]!);
    const ws = await openWorkspace(ctx, { explainer: loaded, skipExplainerIndex: true });
    const { explainer, report } = reresolveExplainer(loaded.explainer, ws.model, ws.texts, {
      indexPath: ws.indexRel,
    });
    const write = args.flag("write");
    if (write) await atomicWrite(loaded.abs, jsonFile(explainer));
    if (ctx.json) {
      ctx.emit({
        path: loaded.rel,
        written: write,
        index: { path: ws.indexRel, commit: ws.index.commit },
        ...report,
      });
      return 0;
    }
    ctx.out(
      [
        `resolved ${loaded.rel} against index ${ws.index.commit} (${ws.indexRel})`,
        ...renderResolveReport(report),
        write
          ? `written: ${loaded.rel}`
          : "not written: pass --write to save the re-resolved explainer",
      ].join("\n"),
    );
    return 0;
  },
};
