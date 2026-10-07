import {
  analyzeChange,
  changeOmissions,
  collectAnchors,
  describeChange,
  isBaseAnchor,
  resolveWith,
  shortSha,
  type ChangeAnalysis,
  type ChangeRecord,
  type ChangedSymbol,
  type CallerEntry,
  type Explainer,
  type TestEntry,
} from "@xpl/core";
import { isWorkTreeClean } from "@xpl/indexer";
import type { CommandSpec } from "../command.js";
import type { Ctx } from "../context.js";
import { CliError, UsageError } from "../errors.js";
import { plural } from "../format.js";
import { atomicWrite, jsonFile, withFileLock } from "../fsutil.js";
import { computeChange, isGitWorkTree, mergeBase, resolveCommit } from "../git.js";
import {
  loadExplainer,
  openWorkspace,
  resolveExplainerPath,
  type LoadedExplainer,
  type Workspace,
} from "../repo.js";

/** Callers and tests printed per changed symbol; `--json` lists all of them. */
const MAX_LISTED = 8;

/** `<base>..<head>`, `<base>...<head>` (from their merge base), `<base>..` or `<base>` (head: the index commit). */
export function parseRange(text: string): { base: string; head?: string; mergeBase: boolean } {
  const three = text.indexOf("...");
  const two = text.indexOf("..");
  const sep = three !== -1 ? three : two;
  const width = three !== -1 ? 3 : 2;
  const base = sep === -1 ? text : text.slice(0, sep);
  const head = sep === -1 ? "" : text.slice(sep + width);
  if (base === "" || base.startsWith("-") || head.startsWith("-") || head.includes("..")) {
    throw new UsageError(
      `the change must look like <base>..<head> (e.g. main..HEAD or 2284ff0^..2284ff0), or <base> alone for <base>..<index commit>; got "${text}"`,
    );
  }
  return { base, ...(head !== "" ? { head } : {}), mergeBase: three !== -1 };
}

/** `373, 384, 387-390`: sorted line numbers with runs collapsed. */
export function linesList(lines: readonly number[]): string {
  const sorted = [...new Set(lines)].sort((a, b) => a - b);
  const parts: string[] = [];
  for (let i = 0; i < sorted.length;) {
    let j = i;
    while (j + 1 < sorted.length && sorted[j + 1] === sorted[j]! + 1) j++;
    parts.push(i === j ? String(sorted[i]) : `${sorted[i]}-${sorted[j]}`);
    i = j + 1;
  }
  return parts.join(", ");
}

const STATUS_LETTER = { added: "A", modified: "M", deleted: "D", renamed: "R" } as const;

function callerLine(entry: CallerEntry): string {
  const where = `${entry.file}:${linesList(entry.lines)}`;
  const notes = [
    ...(entry.changed ? [entry.changed === "new" ? "new" : "changed"] : []),
    ...(entry.kinds.some((k) => k !== "call") ? [entry.kinds.join("/")] : []),
    ...(entry.resolution === "heuristic" ? ["heuristic"] : []),
  ];
  return `${entry.id}  (${where}${notes.length > 0 ? `; ${notes.join(", ")}` : ""})`;
}

function testLine(entry: TestEntry): string {
  const notes = [
    ...(entry.changed ? [entry.changed === "new" ? "new" : "changed"] : []),
    ...(entry.via !== undefined ? ["uses its class"] : []),
  ];
  return `${entry.id}${notes.length > 0 ? `  (${notes.join(", ")})` : ""}`;
}

function listBlock(title: string, lines: readonly string[], indent: string): string[] {
  if (lines.length === 0) return [];
  const shown = lines.slice(0, MAX_LISTED);
  return [
    `${indent}${title}:`,
    ...shown.map((line) => `${indent}  ${line}`),
    ...(lines.length > shown.length
      ? [`${indent}  ... ${lines.length - shown.length} more (--json lists all)`]
      : []),
  ];
}

function symbolBlock(sym: ChangedSymbol): string[] {
  const head =
    `${sym.id}  (${sym.kind}, lines ${sym.range.startLine}-${sym.range.endLine})  ` +
    (sym.status === "new" ? "new" : `changed at ${linesList(sym.lines)}`);
  const out = [`  ${head}`];
  const name = sym.symbolId.slice(sym.symbolId.lastIndexOf(".") + 1);
  if (sym.callers.length === 0) {
    out.push(
      sym.kind === "method" || sym.kind === "function"
        ? "    callers: none found in the index (it may be called through a variable, a callback or a framework)"
        : "    callers: none found in the index",
    );
  } else {
    out.push(
      ...listBlock(
        `callers outside tests (${sym.callers.length})`,
        sym.callers.map(callerLine),
        "    ",
      ),
    );
  }
  if (sym.viaInstance.length > 0) {
    out.push(
      ...listBlock(
        `callers via instance (${sym.viaInstance.length}; a guess: these build the class, and ${name} runs when the instance is called)`,
        sym.viaInstance.map(callerLine),
        "    ",
      ),
    );
  }
  if (sym.tests.length === 0) {
    out.push(
      "    tests: no test found (no test references it by name; tests of other code may still run it)",
    );
  } else out.push(...listBlock(`tests (${sym.tests.length})`, sym.tests.map(testLine), "    "));
  return out;
}

/** The text report of an analysis (what `xpl change` prints after the header). */
export function renderAnalysis(analysis: ChangeAnalysis, omissions: string[] = []): string[] {
  const out: string[] = [];
  const width = Math.max(
    0,
    ...analysis.files.map((f) => (f.oldPath ? `${f.path} <- ${f.oldPath}` : f.path).length),
  );
  out.push(`files (${analysis.files.length}):`);
  for (const file of analysis.files) {
    const name = file.oldPath ? `${file.path} <- ${file.oldPath}` : file.path;
    const notes = [
      ...(file.test ? ["test"] : []),
      ...(file.status !== "deleted" && !file.indexed ? ["not indexed"] : []),
    ];
    out.push(
      `  ${STATUS_LETTER[file.status]}  ${name.padEnd(width)}  +${file.added} -${file.removed}` +
        (notes.length > 0 ? `  (${notes.join(", ")})` : ""),
    );
  }
  const outside = analysis.files.filter((f) => f.outside.length > 0 && !f.test);
  out.push("");
  out.push(
    analysis.symbols.length === 0
      ? "changed symbols: none outside tests"
      : `changed symbols outside tests (${analysis.symbols.length}):`,
  );
  for (const sym of analysis.symbols) out.push(...symbolBlock(sym));
  if (outside.length > 0) {
    out.push(
      "changed lines outside any symbol (imports, module-level code):",
      ...outside.map((f) => `  ${f.path}: ${linesList(f.outside)}`),
    );
  }
  const testFiles = analysis.files.filter((f) => f.test);
  if (testFiles.length > 0) {
    out.push("", `test files the change touches (${testFiles.length}):`);
    for (const file of testFiles) {
      const symbols = analysis.testSymbols.filter((s) => s.file === file.path);
      const news = symbols.filter((s) => s.status === "new").length;
      out.push(
        `  ${file.path}  +${file.added} -${file.removed}` +
          (symbols.length > 0
            ? `  (${plural(symbols.length, "test symbol")}: ${news} new, ${symbols.length - news} changed)`
            : ""),
      );
      for (const sym of symbols.slice(0, MAX_LISTED)) {
        out.push(`    ${sym.id}  ${sym.status}`);
      }
      if (symbols.length > MAX_LISTED) {
        out.push(`    ... ${symbols.length - MAX_LISTED} more (--json lists all)`);
      }
    }
  }
  out.push("");
  out.push(
    analysis.untested.length === 0
      ? "every changed symbol has a test that references it"
      : `no test found for ${plural(analysis.untested.length, "changed symbol")}: ${analysis.untested.join(", ")}`,
  );
  out.push(
    "Callers are direct (depth 1) and come from the index: calls through a variable, a callback or a framework are not seen. Tests count when they reference the symbol (or build its class); check what they assert.",
  );
  if (omissions.length > 0) out.push("", "Not checked:", ...omissions.map((item) => `  ${item}`));
  return out;
}

/** How many base anchors of the explainer do not resolve (ok or moved) against this change record. */
function brokenBaseAnchors(explainer: Explainer, change: ChangeRecord, ws: Workspace): number {
  let broken = 0;
  for (const site of collectAnchors(explainer)) {
    if (!isBaseAnchor(site.anchor)) continue;
    const status = resolveWith(site.anchor, ws.model, ws.texts, change).status;
    if (status !== "ok" && status !== "moved") broken++;
  }
  return broken;
}

/**
 * The full SHA of the commit the index was built from: the index commit when it is a short SHA; for an index of a
 * root below the git top level (always `wt-<hash>`), HEAD when the files under the root are those of HEAD (nothing
 * changed, and the index matches the working tree).
 */
async function indexCommitSha(ctx: Ctx, ws: Workspace): Promise<string> {
  const commit = ws.index.commit;
  if (/^[0-9a-f]{7,}$/i.test(commit)) {
    const sha = await resolveCommit(ctx.root, commit);
    if (sha) return sha;
    throw new CliError(
      `the index commit ${commit} (${ws.indexRel}) is not a commit of this repository. Check out the head of the change, run \`xpl index\`, then run \`xpl change\` again.`,
    );
  }
  if (ws.stale === undefined && (await isWorkTreeClean(ctx.root))) {
    const head = await resolveCommit(ctx.root, "HEAD");
    if (head) return head;
  }
  throw new CliError(
    `the index ${commit} (${ws.indexRel}) was built from files that are not committed, so it matches no commit. ` +
      "Check out the head of the change with no uncommitted changes, run `xpl index`, then run `xpl change` again.",
  );
}

function header(
  loaded: LoadedExplainer,
  change: ChangeRecord,
  analysis: ChangeAnalysis,
  ws: Workspace,
): string {
  return (
    `change ${loaded.name}: ${describeChange(change)} (${plural(analysis.totals.files, "file")}, ` +
    `+${analysis.totals.added} -${analysis.totals.removed}), index ${ws.index.commit}`
  );
}

export const changeCommand: CommandSpec = {
  name: "change",
  usage: "xpl change <explainer> [<base>..<head>]",
  summary: "Record the change an explainer is about (from git) and print its analysis",
  details: [
    "Records the change between two commits in the explainer (`change`: base and head as full SHAs, and every",
    "changed file with its status and hunks, from `git diff -M`), then prints what it touches:",
    "  - the changed files with their added and removed lines,",
    "  - the changed symbols: index symbols that hold an added or edited line (`new` when all of their lines are),",
    "  - for each one its direct callers outside test files, and the tests that reference it (a test function, or",
    "    a test file for an import); `no test found` when there is none,",
    "  - for a method that runs when an instance is called (`__call__`, `handle`), the code that builds the class,",
    "    marked as a guess (`callers via instance`); for a constructor, the calls of its class.",
    "A bounded Not checked section lists the loaded index's report-level limits and changed paths absent from",
    "it. A stale index is named; no section does not establish complete semantic coverage. --json includes omissions.",
    "<base>..<head> takes any git revisions (main..HEAD, 2284ff0^..2284ff0); <base>...<head> starts from their",
    "merge base; <base> alone (or <base>..) ends at the commit of the index. The head must be the commit the index",
    "was built from: check it out and run `xpl index` first. Without a range, prints the analysis of the change",
    'already recorded. Base anchors (`at: "base"` in a patch) point at the code before the change; `xpl show',
    "--at base <path>` prints it with the offsets they use. Needs git; never changes the repository.",
    "Exit codes: 0 ok, 1 no git, an unknown revision, a head that is not the index commit, or no change recorded.",
  ],
  options: {},
  positionals: [{ name: "explainer" }, { name: "base..head", required: false }],
  async run(ctx, args) {
    const name = args.positionals[0]!;
    const rangeText = args.positionals[1];
    const range = rangeText !== undefined ? parseRange(rangeText) : undefined;
    const path = resolveExplainerPath(ctx, name);

    if (!range) {
      const loaded = loadExplainer(ctx, name);
      const change = loaded.explainer.change;
      if (!change) {
        throw new CliError(
          `${loaded.rel} has no change recorded yet: run \`xpl change ${loaded.name} <base>..<head>\` (e.g. main..HEAD)`,
        );
      }
      const ws = await openWorkspace(ctx, { explainer: loaded });
      if (/^[0-9a-f]{7,}$/i.test(ws.index.commit) && !change.head.startsWith(ws.index.commit)) {
        ctx.warn(
          `the recorded change ends at ${shortSha(change.head)}, but the index is ${ws.index.commit}: the symbols, callers and tests below are those of ${ws.index.commit}. ` +
            `Check out ${shortSha(change.head)} and run \`xpl index\`, or record the change again.`,
        );
      }
      const analysis = analyzeChange(change, ws.model, (file) => ws.texts.text(file));
      const omissions = changeOmissions(change, ws.index);
      if (ctx.json) {
        ctx.emit({ path: loaded.rel, written: false, change, analysis, omissions });
        return 0;
      }
      ctx.out(
        [
          header(loaded, change, analysis, ws),
          `recorded in ${loaded.rel}`,
          "",
          ...renderAnalysis(analysis, omissions),
        ].join("\n"),
      );
      return 0;
    }

    if (!(await isGitWorkTree(ctx.root))) {
      throw new CliError(
        `xpl change needs git: ${ctx.root} is not inside a git work tree, so there is no history to compare.`,
      );
    }
    let base = await resolveCommit(ctx.root, range.base);
    if (!base) {
      throw new CliError(
        `"${range.base}" is not a commit of this repository (\`git rev-parse ${range.base}\` found nothing)`,
      );
    }
    const loadedFirst = loadExplainer(ctx, name);
    const wsFirst = await openWorkspace(ctx, { explainer: loadedFirst });
    const indexSha = await indexCommitSha(ctx, wsFirst);
    let head = indexSha;
    if (range.head !== undefined) {
      const given = await resolveCommit(ctx.root, range.head);
      if (!given) {
        throw new CliError(
          `"${range.head}" is not a commit of this repository (\`git rev-parse ${range.head}\` found nothing)`,
        );
      }
      if (given !== indexSha) {
        throw new CliError(
          `the head ${range.head} (${shortSha(given)}) is not the commit the index was built from (${wsFirst.index.commit}). ` +
            `Check out ${shortSha(given)}, run \`xpl index\`, then run this again; or leave out the head to end the change at ${wsFirst.index.commit}.`,
        );
      }
      head = given;
    }
    if (range.mergeBase) {
      const from = await mergeBase(ctx.root, base, head);
      if (!from) {
        throw new CliError(
          `${range.base} and ${shortSha(head)} have no common ancestor, so ${rangeText} has no base`,
        );
      }
      base = from;
    }
    if (base === head) {
      throw new CliError(
        `the base and the head are the same commit (${shortSha(head)}): there is no change. Give the commit before it, e.g. ${shortSha(head)}^..${shortSha(head)}`,
      );
    }
    const change = await computeChange(ctx.root, base, head);

    const ws = wsFirst;
    return withFileLock(path, async () => {
      // the latest file: another writer may have changed it since it was read above
      const loaded = loadExplainer(ctx, name);
      const same = JSON.stringify(loaded.explainer.change) === JSON.stringify(change);
      if (!same) {
        const next: Explainer = { ...loaded.explainer, change };
        await atomicWrite(loaded.abs, jsonFile(orderKeys(next)));
      }
      const broken = brokenBaseAnchors(loaded.explainer, change, ws);
      if (broken > 0) {
        ctx.warn(
          `${plural(broken, "base anchor")} of ${loaded.rel} do not match the code before this change: run \`xpl validate ${loaded.name}\` to see them`,
        );
      }
      const analysis = analyzeChange(change, ws.model, (file) => ws.texts.text(file));
      const omissions = changeOmissions(change, ws.index);
      if (ctx.json) {
        ctx.emit({ path: loaded.rel, written: !same, change, analysis, omissions });
        return 0;
      }
      ctx.out(
        [
          header(loaded, change, analysis, ws),
          same
            ? `unchanged: ${loaded.rel} already records this change`
            : `written to ${loaded.rel}`,
          "",
          ...renderAnalysis(analysis, omissions),
        ].join("\n"),
      );
      return 0;
    });
  },
};

/** Puts `change` right after `index`, where a reader of the file expects it. */
function orderKeys(explainer: Explainer): Explainer {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(explainer)) {
    if (key === "change") continue;
    out[key] = value;
    if (key === "index") out.change = explainer.change;
  }
  if (!("change" in out)) out.change = explainer.change;
  return out as unknown as Explainer;
}
