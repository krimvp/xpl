/**
 * `xpl lint`: the reader-text checks (`lintExplainer`, on small hand-made explainers) and the command (text
 * output, `--json`, `--strict`, exit codes) on an explainer applied to the TS fixture.
 */
import { beforeAll, describe, expect, it } from "vitest";
import type { Explainer } from "@xpl/core";
import { codeLike, lintExplainer, type LintFinding, type LintRule } from "../src/lint.js";
import { cloneDir, indexedFixture, invoke, PATCH_PATH, xpl, xplJson } from "./helpers.js";

/** An explainer with just the parts a test gives (the rest empty). */
function explainer(parts: Record<string, unknown>): Explainer {
  return {
    schema: "code-explainer@0",
    title: "Job runner",
    repo: { name: "demo", commit: "c" },
    index: { path: ".explainer/index-c.json", commit: "c" },
    nodes: [],
    edges: [],
    concepts: [],
    views: [],
    tours: [],
    ...parts,
  } as Explainer;
}

/** A tour with a summary (so the summary check stays quiet) and the given step notes. */
function tour(notes: string[], extra: Record<string, unknown> = {}) {
  return {
    id: "tour:t",
    title: "How a job runs",
    summary: "A job goes from the queue to a worker. Failed jobs come back later.",
    steps: notes.map((note, i) => ({ id: `t${i + 1}`, view: "view:v", focus: [], note })),
    ...extra,
  };
}

const rules = (findings: readonly LintFinding[]) => findings.map((f) => f.rule);
const only = (findings: readonly LintFinding[], rule: LintRule) =>
  findings.filter((f) => f.rule === rule);

describe("lintExplainer", () => {
  it("a clean explainer has no findings", () => {
    const { findings, checked } = lintExplainer(
      explainer({
        tours: [
          tour([
            "### The runner takes a job\nThe runner asks the queue for the next job. The queue returns the oldest one first.",
            "### A failed job waits\nThe runner puts a failed job back with a delay. The delay doubles each time.",
          ]),
        ],
        views: [
          {
            id: "view:flow",
            type: "flow",
            title: "What happens to a job",
            participants: [],
            steps: [
              {
                id: "f:1",
                from: "a",
                to: "b",
                label: "Take the next job",
                kind: "call",
                anchors: [],
              },
              {
                id: "f:2",
                from: "a",
                to: "b",
                label: "Run it",
                kind: "call",
                anchors: [],
                summary: "The worker runs the handler for the job type.",
              },
            ],
          },
        ],
      }),
    );
    expect(findings).toEqual([]);
    // the explainer title, the tour title and summary, 2 note headings and 2 note bodies, the view title, 2 step
    // labels and 1 step summary
    expect(checked).toBe(11);
  });

  it("a tour without a summary, and one with too many sentences", () => {
    const missing = lintExplainer(explainer({ tours: [tour([], { summary: undefined })] }));
    expect(rules(missing.findings)).toEqual(["tour-summary"]);
    expect(missing.findings[0]).toMatchObject({
      elementId: "tour:t",
      kind: "tour",
      field: "summary",
      quote: "How a job runs",
    });
    expect(missing.findings[0]!.hint).toContain("2-4 sentences");
    // a summary that is not a string (an old or hand-edited file) counts as missing, never throws
    expect(
      rules(lintExplainer(explainer({ tours: [tour([], { summary: 42 })] })).findings),
    ).toEqual(["tour-summary"]);
    const long = lintExplainer(
      explainer({ tours: [tour([], { summary: "One. Two. Three. Four. Five." })] }),
    );
    expect(only(long.findings, "tour-summary")[0]!.message).toBe("5 sentences (more than 4)");
  });

  it('notes without a "### title" line; placeholders such as "Fix 1:"', () => {
    const { findings } = lintExplainer(
      explainer({
        tours: [
          tour([
            "The runner asks the queue for the next job.",
            "Fix 1: the queue drops jobs with no type.",
            "### Note\nThe queue drops jobs with no type.",
          ]),
        ],
      }),
    );
    expect(findings.map((f) => [f.elementId, f.rule])).toEqual([
      ["tour:t/t1", "note-heading"],
      ["tour:t/t2", "note-heading"],
      ["tour:t/t3", "placeholder-title"],
    ]);
    expect(findings[1]!.message).toContain('starts with "Fix 1:"');
    expect(findings[2]).toMatchObject({ field: "note heading", quote: "Note" });
  });

  it("titles that look like code, in every place a title is", () => {
    const { findings } = lintExplainer(
      explainer({
        title: "Runner.dispatch",
        tours: [
          tour(["### _HOST_RE.fullmatch(host_header)\nThe header must match the pattern."], {
            title: "parseAccept",
          }),
        ],
        views: [{ id: "view:g", type: "graph", title: "build_middleware_stack", include: [] }],
        nodes: [{ id: "grp:x", label: "self.app(scope)", anchors: [] }],
      }),
    );
    expect(only(findings, "code-title").map((f) => [f.elementId, f.field, f.message])).toEqual([
      ["(explainer)", "title", "looks like code (a dotted name)"],
      ["tour:t", "title", "looks like code (a single identifier)"],
      ["tour:t/t1", "note heading", "looks like code (a call)"],
      ["view:g", "title", "looks like code (an identifier with _)"],
      ["grp:x", "label", "looks like code (a call)"],
    ]);
  });

  it("codeLike: code is caught, plain titles are not", () => {
    for (const code of [
      "_HOST_RE.fullmatch(host_header)",
      "self.app(scope, receive, _send)",
      "parsed_host.is_valid_port",
      "Match.NONE",
      'netloc from scope["server"]',
      "if (q === 0) continue",
      "return defaultSupport",
      "except Exception as exc",
      "parseAccept",
      "ServerErrorMiddleware",
      "src/a.ts#Runner",
      "None",
    ]) {
      expect(codeLike(code), code).toBeDefined();
    }
    for (const plain of [
      "PR #3472: one Host header parser",
      "How a job is dispatched",
      "Starlette in five minutes",
      "Requests and responses",
      "WebSocket support",
      "Built on Node.js, e.g. for servers",
      "q=0 means no",
      "Step 1 of the request: the router",
    ]) {
      expect(codeLike(plain), plain).toBeUndefined();
    }
  });

  it("placeholder titles", () => {
    const titles = ["Fix 1", "Note", "Step 3", "Part 2:", "TODO", "3"];
    const { findings } = lintExplainer(
      explainer({
        views: titles.map((title, i) => ({
          id: `view:${i}`,
          type: "graph",
          title,
          include: [],
        })),
        tours: [tour([], { title: "Step 1 of the request: the router" })],
      }),
    );
    expect(only(findings, "placeholder-title").map((f) => f.quote)).toEqual(titles);
  });

  it("long sentences, and fields whose sentences are long on average", () => {
    const long = Array.from({ length: 26 }, (_, i) => `word${i}`).join(" ") + ".";
    const twentyTwo = Array.from({ length: 22 }, (_, i) => `w${i}`).join(" ") + ".";
    const { findings } = lintExplainer(
      explainer({
        nodes: [
          { id: "sym:a#long", label: "a", summary: long, anchors: [] },
          { id: "sym:a#avg", label: "b", summary: `${twentyTwo} ${twentyTwo}`, anchors: [] },
          // 25 words is the limit: no finding
          {
            id: "sym:a#ok",
            label: "c",
            summary: Array.from({ length: 25 }, () => "w").join(" "),
            anchors: [],
          },
        ],
      }),
    );
    expect(findings.map((f) => [f.elementId, f.rule, f.message])).toEqual([
      ["sym:a#long", "long-sentence", "26 words (more than 25)"],
      ["sym:a#avg", "long-average", "2 sentences, 22.0 words on average (more than 20)"],
    ]);
    expect(findings[0]!.quote.length).toBeLessThanOrEqual(80);
    expect(findings[0]!.quote.endsWith("…")).toBe(true);
  });

  it("a backticked identifier counts as one word, and e.g. does not end a sentence", () => {
    const words24 = Array.from({ length: 23 }, () => "w").join(" ");
    const { findings } = lintExplainer(
      explainer({
        nodes: [
          {
            id: "sym:a#x",
            label: "x",
            // `scope["starlette.exception_handlers"]` would be three words if split at the dots
            summary: `${words24} \`scope["starlette.exception_handlers"]\`.`,
            anchors: [],
          },
          {
            id: "sym:a#y",
            label: "y",
            summary: "Checks the header, e.g. the port. Then it stops.",
            anchors: [],
          },
        ],
      }),
    );
    expect(findings).toEqual([]);
  });

  it('a bare "It" or "This" with a verb starts a sentence; a named subject does not', () => {
    const steps = [
      "It calls the next layer inside a try block.",
      "It also stores the handlers.",
      "It's too late to send an error page.",
      "This is the outer layer.",
      "This middleware calls the router.",
      "This way the router sees the scope.",
      "Its handlers run first.",
      "ServerErrorMiddleware calls the next layer.",
      "It in the queue: the job.",
    ].map((summary, i) => ({
      id: `s:${i + 1}`,
      from: "a",
      to: "b",
      label: "A stage",
      kind: "call",
      anchors: [],
      summary,
    }));
    const { findings } = lintExplainer(
      explainer({
        views: [{ id: "view:s", type: "sequence", title: "Steps", participants: [], steps }],
      }),
    );
    expect(only(findings, "bare-it").map((f) => [f.elementId, f.message])).toEqual([
      ["s:1", 'starts with a bare "It"'],
      ["s:2", 'starts with a bare "It"'],
      ["s:3", 'starts with a bare "It"'],
      ["s:4", 'starts with a bare "This"'],
    ]);
    expect(findings.find((f) => f.elementId === "s:1")).toMatchObject({
      kind: "step",
      view: "view:s",
    });
  });

  it("marketing and filler words, outside code spans only", () => {
    const { findings } = lintExplainer(
      explainer({
        concepts: [
          {
            id: "concept:a",
            label: "Retries",
            summary: "A robust and seamless retry loop that we leverage everywhere it is crucial.",
            anchors: [],
          },
          {
            id: "concept:b",
            label: "Code",
            // filler words that are identifiers in backticks: no finding
            summary: "The runner calls `simply()` and reads `config.robust` and `just`.",
            anchors: [],
          },
        ],
      }),
    );
    const filler = only(findings, "filler-word");
    expect(filler).toHaveLength(1);
    expect(filler[0]!.message).toBe(
      '"robust", "seamless", "leverage", "crucial": marketing or filler',
    );
    expect(filler[0]!.hint).toContain('"leverage": write "use"');
    expect(findings.filter((f) => f.elementId === "concept:b")).toEqual([]);
  });

  it("absolute words need evidence, but not in code, after a negation or before a condition", () => {
    const { findings } = lintExplainer(
      explainer({
        tours: [
          tour(["### One parser\nNow all three agree, and every caller rejects it the same way."], {
            title: "Reject malformed Host headers the same way everywhere",
          }),
        ],
        nodes: [
          {
            id: "sym:a#ok",
            label: "a",
            summary:
              "Uses the header only when it parses. Not all callers check it. Reads `allHosts` and `never`.",
            anchors: [],
          },
        ],
      }),
    );
    const absolute = only(findings, "absolute-word");
    expect(absolute.map((f) => [f.elementId, f.field, f.message])).toEqual([
      ["tour:t", "title", '"everywhere": an absolute claim that needs evidence'],
      ["tour:t/t1", "note", '"all", "every": an absolute claim that needs evidence'],
    ]);
    expect(absolute[1]!.quote).toContain("Now all three agree");
  });

  it('idioms such as "at all" or "after all" are not absolute claims', () => {
    const idioms = [
      "A Host route does not match at all.",
      "The port is checked, after all.",
      "The header changed all of a sudden.",
      "The parser fixes it once and for all.",
      "All in all, the parser is small.",
      "The fallback was there all along.",
      "First of all, the header is parsed.",
      "Above all, keep the port.",
      "That is all right for a test.",
      "It does not match at all for IPv6, and not at all when the port is bad.",
      "Is it used at all? Not At All.",
    ];
    const { findings } = lintExplainer(
      explainer({
        nodes: idioms.map((summary, i) => ({
          id: `sym:a#n${i}`,
          label: "n",
          summary,
          anchors: [],
        })),
      }),
    );
    expect(only(findings, "absolute-word")).toEqual([]);
    // the same words outside an idiom still count
    const real = lintExplainer(
      explainer({
        nodes: [
          {
            id: "sym:a#x",
            label: "x",
            summary:
              "After all callers moved, routes match at all times. Above all routes sits the app. It does not match at all.",
            anchors: [],
          },
        ],
      }),
    );
    // "After all callers", "at all times" and "Above all routes" claim something about every case
    expect(only(real.findings, "absolute-word").map((f) => f.message)).toEqual([
      '"all": an absolute claim that needs evidence',
    ]);
    expect(only(real.findings, "absolute-word")[0]!.quote).toContain("After all callers moved");
    const times = lintExplainer(
      explainer({
        nodes: [{ id: "sym:a#t", label: "t", summary: "Routes match at all times.", anchors: [] }],
      }),
    );
    expect(rules(times.findings)).toEqual(["absolute-word"]);
  });

  it("markdown in a field the viewer shows as plain text; markdown fields may use it", () => {
    const md = "The **router** picks a [route](https://example.com/routing).";
    const { findings } = lintExplainer(
      explainer({
        title: "# Job runner",
        tours: [
          tour(
            [
              // a step note is markdown: no finding, and neither is its ### title line
              `### The **runner** takes a job\n${md}`,
            ],
            { title: "How __a job__ runs", summary: `${md} Failed jobs come back later.` },
          ),
        ],
        views: [
          {
            id: "view:s",
            type: "sequence",
            title: "**Dispatch**",
            participants: [],
            steps: [
              {
                id: "s:1",
                from: "a",
                to: "b",
                label: "[pop](./queue.ts)",
                kind: "call",
                anchors: [],
                summary: md,
              },
            ],
          },
        ],
        nodes: [
          { id: "sym:a#n", label: "n", summary: md, detail: md, anchors: [] },
          { id: "grp:g", label: "**Group**", summary: "Plain.", anchors: [] },
        ],
        edges: [
          {
            id: "edge:e",
            from: "a",
            to: "b",
            kind: "calls",
            label: "e",
            summary: "## Heading\nText.",
            anchors: [],
          },
        ],
        concepts: [{ id: "concept:c", label: "C", summary: md, anchors: [] }],
      }),
    );
    const marked = only(findings, "markdown-in-plain");
    expect(marked.map((f) => [f.elementId, f.field])).toEqual([
      ["(explainer)", "title"],
      ["tour:t", "title"],
      ["view:s", "title"],
      ["s:1", "label"],
      ["s:1", "summary"],
      ["sym:a#n", "summary"],
      ["grp:g", "label"],
      ["edge:e", "summary"],
      ["concept:c", "summary"],
    ]);
    expect(marked[0]!.message).toBe(
      "markdown (# heading) in a field the viewer shows as plain text: the marks show as-is",
    );
    expect(marked.find((f) => f.elementId === "sym:a#n")!.message).toContain(
      "**bold**, [text](link)",
    );
    // `__bold__` needs a space inside, so a Python dunder such as __init__ is never taken for it
    expect(marked.find((f) => f.elementId === "tour:t")!.message).toContain("__bold__");
  });

  it("markdown-in-plain: code is not markdown", () => {
    const plainText = [
      "Calls `**kwargs` and passes **kwargs on, then 2**8 retries.",
      "Python's __init__ and __call__ run first; so does `__init__`.",
      "Reads xs[0](y) and the PR #3472 fix, step #2 of 3.",
      "A Host such as `[::1]` or [:::] is checked.",
      "Uses `[text](url)` in the docs and a* b** c.",
    ];
    const { findings } = lintExplainer(
      explainer({
        nodes: plainText.map((summary, i) => ({
          id: `sym:a#p${i}`,
          label: "p",
          summary,
          anchors: [],
        })),
        views: [
          {
            id: "view:f",
            type: "flow",
            title: "PR #3472: one Host parser",
            participants: [],
            steps: [
              { id: "f:1", from: "a", to: "b", label: "Check the port", kind: "call", anchors: [] },
            ],
          },
        ],
      }),
    );
    expect(only(findings, "markdown-in-plain")).toEqual([]);
  });

  it("a note that repeats the summary of a focused element", () => {
    const { findings } = lintExplainer(
      explainer({
        nodes: [
          {
            id: "grp:stack",
            label: "Middleware stack",
            summary: "The app builds the stack once, on the first request, and keeps it.",
            anchors: [],
          },
        ],
        views: [
          {
            id: "view:s",
            type: "sequence",
            title: "Request in",
            participants: [],
            steps: [
              {
                id: "in:1",
                from: "a",
                to: "b",
                label: "build_middleware_stack()",
                kind: "call",
                anchors: [],
                summary: "On the first request the app builds the stack once and keeps it.",
              },
            ],
          },
        ],
        tours: [
          {
            id: "tour:t",
            title: "Request path",
            summary: "How a request reaches your function. Errors come back the same way.",
            steps: [
              {
                id: "t1",
                view: "view:s",
                focus: ["in:1"],
                note: "### Built once\nThe stack is built once, on the first request. So adding middleware later fails.",
              },
              {
                id: "t2",
                view: "view:s",
                focus: ["grp:stack"],
                // says something else: no finding
                note: "### Order matters\nThe first middleware in the list runs first.",
              },
            ],
          },
        ],
      }),
    );
    expect(only(findings, "repeats-summary")).toEqual([
      expect.objectContaining({
        elementId: "tour:t/t1",
        field: "note",
        quote: "The stack is built once, on the first request.",
        message: "repeats the summary of in:1, which the reader sees next to the note",
      }),
    ]);
    // sequence views may show calls as labels: no flow-label-code there
    expect(only(findings, "flow-label-code")).toEqual([]);
  });

  it("flow step labels written as code; plain stage names pass", () => {
    const labels = [
      "_HOST_RE.fullmatch(host_header)",
      "return matched",
      "if (q === 0) continue",
      "await response(...)",
      "Check the port",
      "Pick a handler",
      "`IPv6Address` check",
    ];
    const { findings } = lintExplainer(
      explainer({
        views: [
          {
            id: "view:f",
            type: "flow",
            title: "What happens to a Host header",
            participants: [],
            steps: labels.map((label, i) => ({
              id: `f:${i + 1}`,
              from: "a",
              to: "b",
              label,
              kind: "call",
              anchors: [],
            })),
          },
        ],
      }),
    );
    expect(only(findings, "flow-label-code").map((f) => f.quote)).toEqual(labels.slice(0, 4));
  });

  it("reads a malformed explainer without throwing", () => {
    const odd = {
      title: 3,
      tours: [null, { id: "tour:x", steps: [null, { note: 5 }, { id: "s", note: "" }] }],
      views: [{ id: "view:x", type: "flow", steps: [null, { label: 4 }] }],
      nodes: [null, "x"],
      edges: "nope",
    } as unknown as Partial<Explainer>;
    const { findings } = lintExplainer(explainer(odd));
    expect(rules(findings)).toEqual(["tour-summary", "tour-summary"]);
  });
});

describe("xpl lint", () => {
  let demo: string;

  beforeAll(async () => {
    const indexed = await indexedFixture();
    demo = cloneDir(indexed);
    expect((await xpl(demo, "new", "demo")).code).toBe(0);
    expect((await xpl(demo, "apply", "demo", PATCH_PATH)).code).toBe(0);
  });

  it("prints the findings grouped by element and a count line, and exits 0", async () => {
    const { code, out, err } = await xpl(demo, "lint", "demo");
    expect(err).toBe("");
    expect(code).toBe(0);
    const lines = out.split("\n");
    expect(lines[0]).toMatch(/^\.explainer\/demo\.explainer\.json: \d+ texts checked$/);
    expect(out).toContain("\ntour:intro (tour)\n  summary  tour-summary: no summary");
    expect(out).toContain("\ntour:intro/t1 (tour step)\n  note  note-heading:");
    expect(out).toContain('    "Big picture first: scheduling is two files."');
    expect(out).toContain('    fix: start the note with "### <plain title>"');
    expect(lines.at(-1)).toMatch(
      /^\d+ findings in \d+ elements \(tour-summary 1, note-heading 2.*\); warnings only, --strict exits 1$/,
    );
  });

  it("--json lists the findings; --strict exits 1 when there are any", async () => {
    const { code, json } = await xplJson<{
      total: number;
      checked: number;
      counts: Record<string, number>;
      findings: LintFinding[];
    }>(demo, "lint", "demo");
    expect(code).toBe(0);
    expect(json.ok).toBe(true);
    expect(json.total).toBe(json.findings.length);
    expect(json.counts["tour-summary"]).toBe(1);
    expect(json.findings[0]).toEqual({
      rule: "tour-summary",
      elementId: "tour:intro",
      kind: "tour",
      field: "summary",
      quote: "Intro talk",
      message: expect.any(String),
      hint: expect.any(String),
    });

    const strict = await xpl(demo, "lint", "demo", "--strict");
    expect(strict.code).toBe(1);
    expect(strict.out).not.toContain("warnings only");
    const strictJson = await xplJson(demo, "lint", "demo", "--strict");
    expect(strictJson.code).toBe(1);
    expect(strictJson.json.ok).toBe(false);
  });

  it("a clean explainer: ok, and --strict exits 0", async () => {
    const dir = cloneDir(demo);
    expect((await xpl(dir, "new", "clean", "--title", "How a job runs")).code).toBe(0);
    const { code, out } = await xpl(dir, "lint", "clean", "--strict");
    expect(code).toBe(0);
    expect(out).toBe("ok: .explainer/clean.explainer.json: 1 text checked, no findings");
  });

  it("usage errors exit 2; an unknown explainer exits 1", async () => {
    expect((await xpl(demo, "lint")).code).toBe(2);
    expect((await xpl(demo, "lint", "demo", "--loud")).code).toBe(2);
    const missing = await xpl(demo, "lint", "nope");
    expect(missing.code).toBe(1);
    expect(missing.err).toContain('no explainer "nope"');
    const help = await invoke(["lint", "--help"]);
    expect(help.code).toBe(0);
    expect(help.out).toContain("Usage: xpl lint <explainer> [--strict]");
    expect(help.out).toContain("repeats-summary");
    expect(help.out).toContain("markdown-in-plain");
  });
});
