import { describeAnchor, reresolveExplainer, type ResolveReport } from "@xpl/core";
import type { CommandSpec } from "../command.js";
import { CliError } from "../errors.js";
import { rangeText } from "../format.js";
import { atomicWrite, withFileLock, jsonFile } from "../fsutil.js";
import { loadExplainer, onlyExplainerName, openWorkspace, resolveExplainerPath } from "../repo.js";

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
      const owner =
        element.owner === "step" && element.view ? `step in ${element.view}` : element.owner;
      lines.push(`  ${element.elementId}  (${owner})${kept}`);
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
    lines.push(`missing code links (${report.missing.length}): fix or remove each one`);
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
  usage: "xpl resolve [explainer] [--write] [--allow-stale]",
  summary: "Check each code link again; list the text to rewrite and the links whose code is gone",
  details: [
    "Checks every code link again against the index of the current code: ok, moved, drifted or missing.",
    "Moved code keeps its text and gets its new lines. Drifted text needs a rewrite; missing code needs a fix.",
    "It uses --index, else the index of the current commit, else the newest one; never the guide's old one.",
    "--write saves the new lines and the index binding. Drifted code links stay drifted until you rewrite them.",
    "--write refuses (exit 1) when the index does not match the working tree: run `xpl index` first.",
    "With one guide in the repository, leave out its name.",
  ],
  options: {
    write: { type: "boolean", desc: "Save the re-resolved guide (default: report only)" },
    "allow-stale": {
      type: "boolean",
      desc: "With --write: save even though the index does not match the working tree",
    },
  },
  positionals: [{ name: "explainer", required: false }],
  async run(ctx, args) {
    const name = args.positionals[0] ?? onlyExplainerName(ctx, "resolve");
    return withFileLock(resolveExplainerPath(ctx, name), async () => {
      const loaded = loadExplainer(ctx, name);
      const write = args.flag("write");
      const ws = await openWorkspace(ctx, {
        explainer: loaded,
        skipExplainerIndex: true,
        deferStaleWarning: true,
      });
      if (ws.stale) {
        if (write && !args.flag("allow-stale")) {
          throw new CliError(
            `refusing to write ${loaded.rel}: ${ws.stale.head}. The ranges it would save are already out of date: ` +
              `run \`xpl index\` first, then \`xpl resolve ${loaded.name} --write\` again ` +
              "(--allow-stale saves them against this index anyway).",
            1,
            { stale: ws.stale.head },
          );
        }
        ctx.warn(ws.stale.message);
      }
      const { explainer, report } = reresolveExplainer(loaded.explainer, ws.model, ws.texts, {
        indexPath: ws.indexRel,
      });
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
            : "not written: pass --write to save the guide with the new lines",
        ].join("\n"),
      );
      return 0;
    });
  },
};
