/**
 * `xpl lint`: the reader-text checks (`lintExplainer`, on small hand-made explainers) and the command (text
 * output, `--json`, `--strict`, exit codes) on an explainer applied to the TS fixture.
 */
import { beforeAll, describe, expect, it } from "vitest";
import { ExplainerModel, INDEX_SCHEMA, type Explainer, type SymbolIndex } from "@xpl/core";
import {
  codeLike,
  isLiteral,
  LINT_LIMITS,
  lintExplainer,
  type LintFinding,
  type LintRule,
} from "../src/lint.js";
import {
  cloneDir,
  indexedFixture,
  invoke,
  PATCH_PATH,
  readFile,
  writeFile,
  xpl,
  xplJson,
} from "./helpers.js";

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

describe("lintExplainer: plain notes for readers who do not know the code", () => {
  const archViews = [
    { id: "view:v", type: "graph", title: "Inside the shop", include: ["dir:src", "grp:db"] },
  ];
  const archNodes = [
    { id: "grp:db", kind: "group", label: "Orders database", role: "database", members: [] },
  ];

  it("long-note: a note body over the limit, but not a TODO placeholder", () => {
    const long = Array.from({ length: 16 }, () => "The queue keeps jobs.").join(" ");
    const { findings } = lintExplainer(
      explainer({
        tours: [
          tour([`### The queue keeps jobs\n\n${long}`, `### TODO: a title\n\nTODO: ${long}`]),
        ],
      }),
    );
    expect(only(findings, "long-note").map((f) => f.elementId)).toEqual(["tour:t/t1"]);
  });

  it("code-heavy: too many code names, fewer allowed on an architecture map and in the summary", () => {
    const three =
      "### The runner takes a job\n\n`Runner.dispatch` asks `Queue.pop` for a job and runs it on `Worker.run`.";
    const two =
      "### The orders part keeps orders\n\n`saveOrder` writes each order with `pool.query`.";
    // three names in a note on a code map: fine
    expect(
      only(lintExplainer(explainer({ tours: [tour([three])] })).findings, "code-heavy"),
    ).toEqual([]);
    const four = `${three} Then \`Queue.ack\` removes it.`;
    expect(
      only(lintExplainer(explainer({ tours: [tour([four])] })).findings, "code-heavy").map(
        (f) => f.message,
      ),
    ).toEqual([
      "4 code names (`Runner.dispatch`, `Queue.pop`, `Worker.run`, `Queue.ack`); a note takes at most 3",
    ]);
    // two names on an architecture map: too many
    const arch = lintExplainer(
      explainer({ nodes: archNodes, views: archViews, tours: [tour([two])] }),
    );
    expect(only(arch.findings, "code-heavy")).toHaveLength(1);
    expect(only(arch.findings, "code-heavy")[0]!.message).toContain(
      "a note on an architecture map takes at most 1",
    );
    // the tour summary
    const summary = lintExplainer(
      explainer({
        tours: [
          tour([], {
            summary:
              "`Runner` takes jobs from `Queue`. `Worker` runs them and `Bus` tells the metrics.",
          }),
        ],
      }),
    );
    expect(only(summary.findings, "code-heavy").map((f) => f.field)).toEqual(["summary"]);
  });
});

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
    const short = lintExplainer(
      explainer({ tours: [tour([], { summary: "A job goes from the queue to a worker." })] }),
    );
    expect(only(short.findings, "tour-summary")[0]!.message).toBe("1 sentence (fewer than 2)");
  });

  it("the tour summary of a change may have 5 sentences (behaviour, risk and tests), not 6", () => {
    const change = { base: "a", head: "b", files: [] };
    const five = lintExplainer(
      explainer({ change, tours: [tour([], { summary: "One. Two. Three. Four. Five." })] }),
    );
    expect(only(five.findings, "tour-summary")).toEqual([]);
    const six = lintExplainer(
      explainer({ change, tours: [tour([], { summary: "One. Two. Three. Four. Five. Six." })] }),
    );
    expect(only(six.findings, "tour-summary")[0]).toMatchObject({
      message: "6 sentences (more than 5)",
    });
    // the hint names the competing limit, so that one fix does not trip another rule
    expect(only(six.findings, "tour-summary")[0]!.hint).toBe(
      "keep the summary to 2-5 sentences; move the rest into the steps (two sentences joined into one over 25 words is a long-sentence finding)",
    );
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

  it('"only" after a verb or a noun narrows a claim; "only" that opens a clause makes one', () => {
    const narrow = [
      "TrustedHostMiddleware compares only the host part, without the port.",
      "A Host route matches the host part only, so a port does not matter.",
      "An unparseable header gives Match.NONE, otherwise only the host part is matched.",
      '`URL` reads only `scope["server"]` here.',
      "A helper that only reads the header.",
    ];
    const claims = [
      "Only the router calls it.",
      "Now only `URL` checks the port.",
      "It is the only caller of the parser.",
      "The parser is called only by tests.",
      "Three places read it; only `URL` checks the port.",
    ];
    const node = (summary: string, i: number) => ({
      id: `sym:a#n${i}`,
      label: "n",
      summary,
      anchors: [],
    });
    const quiet = lintExplainer(explainer({ nodes: narrow.map(node) }));
    expect(only(quiet.findings, "absolute-word")).toEqual([]);
    const loud = lintExplainer(explainer({ nodes: claims.map(node) }));
    expect(only(loud.findings, "absolute-word").map((f) => f.elementId)).toEqual(
      claims.map((_, i) => `sym:a#n${i}`),
    );
  });

  it('"all" after a list of named cases is evidence; "all three" and "each x and each y all" are not', () => {
    const named = [
      "Now `URL`, `TrustedHostMiddleware` and `Host.matches` all call `parse_host_header`.",
      "URL, TrustedHostMiddleware and Host.matches all call parse_host_header.",
    ];
    const vague = [
      "After this PR all three call parse_host_header.",
      "The app, each middleware and each endpoint all have the same signature.",
      "The router and the app all routes see.",
      "Now all three agree.",
    ];
    const node = (summary: string, i: number) => ({
      id: `sym:a#n${i}`,
      label: "n",
      summary,
      anchors: [],
    });
    expect(
      only(lintExplainer(explainer({ nodes: named.map(node) })).findings, "absolute-word"),
    ).toEqual([]);
    expect(
      only(lintExplainer(explainer({ nodes: vague.map(node) })).findings, "absolute-word").map(
        (f) => f.elementId,
      ),
    ).toEqual(vague.map((_, i) => `sym:a#n${i}`));
  });

  it('"all", "every" or "only" before a count in digits quotes a measured result', () => {
    const measured = [
      "All 22 new cases pass on the head.",
      "18 of the 22 cases fail on the base, and all of the 22 pass now.",
      "Only 4 of the 22 cases pass on the base.",
      "Every one of the 3 tests fails on the base.",
    ];
    const claims = [
      "Now all three agree.",
      "All callers pass 2 arguments.",
      "The delay is never 0.",
      "The parser always returns 1 value.",
    ];
    const node = (summary: string, i: number) => ({
      id: `sym:a#n${i}`,
      label: "n",
      summary,
      anchors: [],
    });
    expect(
      only(lintExplainer(explainer({ nodes: measured.map(node) })).findings, "absolute-word"),
    ).toEqual([]);
    expect(
      only(lintExplainer(explainer({ nodes: claims.map(node) })).findings, "absolute-word").map(
        (f) => f.elementId,
      ),
    ).toEqual(claims.map((_, i) => `sym:a#n${i}`));
  });

  it('"outside everything" is a position, not a claim; the quote points at the word', () => {
    const { findings } = lintExplainer(
      explainer({
        nodes: [
          {
            id: "sym:a#x",
            label: "x",
            summary: "One layer sits outside everything, one above the router.",
            anchors: [],
          },
          {
            id: "sym:a#y",
            label: "y",
            // the quote is centred on the word, also after a long code span
            summary: `Reads \`${"x".repeat(90)}\` first, then runs everything else in a try block.`,
            anchors: [],
          },
        ],
      }),
    );
    expect(only(findings, "absolute-word").map((f) => f.elementId)).toEqual(["sym:a#y"]);
    expect(only(findings, "absolute-word")[0]!.quote).toContain("runs everything else");
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

  it("markdown in a title or a label; markdown fields may use it", () => {
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
    // titles and labels only: summaries may use inline markdown (the viewer renders it)
    const marked = only(findings, "markdown-in-plain");
    expect(marked.map((f) => [f.elementId, f.field])).toEqual([
      ["(explainer)", "title"],
      ["tour:t", "title"],
      ["view:s", "title"],
      ["s:1", "label"],
      ["grp:g", "label"],
    ]);
    expect(marked[0]!.message).toBe(
      "markdown (# heading) in a title, which the viewer shows as plain text: the marks show as-is",
    );
    expect(marked.find((f) => f.elementId === "s:1")!.message).toContain("in a label");
    // `__bold__` needs a space inside, so a Python dunder such as __init__ is never taken for it
    expect(marked.find((f) => f.elementId === "tour:t")!.message).toContain("__bold__");
    // a link or a heading in a summary is still a finding, of its own rule
    expect(
      only(findings, "markdown-in-summary").map((f) => [f.elementId, f.field, f.message]),
    ).toEqual([
      ["s:1", "summary", expect.stringMatching(/^a link in a summary: /)],
      ["sym:a#n", "summary", expect.stringMatching(/^a link in a summary: /)],
      ["edge:e", "summary", expect.stringMatching(/^a heading line in a summary: /)],
      ["concept:c", "summary", expect.stringMatching(/^a link in a summary: /)],
    ]);
  });

  it("summaries may use inline markdown: code spans, bold, emphasis", () => {
    const summaries = [
      "**New:** each branch stores its sender in `send_file` instead of awaiting it.",
      "**Changed:** `_handle_simple` and `_open_file` close the file.",
      "__Unchanged code__ sends a body from an *iterator*.",
    ];
    const { findings } = lintExplainer(
      explainer({
        nodes: summaries.map((summary, i) => ({
          id: `sym:a#n${i}`,
          label: "n",
          summary,
          anchors: [],
        })),
        views: [
          {
            id: "view:f",
            type: "flow",
            title: "Sending a file",
            participants: [],
            steps: [
              {
                id: "f:1",
                from: "a",
                to: "b",
                label: "Pick a sender",
                kind: "call",
                anchors: [],
                summary: summaries[0],
              },
            ],
          },
        ],
        concepts: [{ id: "concept:c", label: "Listener", summary: summaries[2], anchors: [] }],
      }),
    );
    expect(findings).toEqual([]);
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
    // the second tour: no summary, and three steps without a note (untitled)
    expect(rules(findings)).toEqual([
      "tour-summary",
      "tour-summary",
      "untitled-step",
      "untitled-step",
      "untitled-step",
    ]);
  });
});

/** A map, a flow, a group with members and a concept, for the order checks. */
const ORDER_PARTS = {
  nodes: [
    { id: "grp:core", label: "Scheduling", members: ["file:src/queue.ts", "file:src/runner.ts"] },
    { id: "grp:tests", label: "Tests of the runner", members: ["file:test/runner.test.ts"] },
    { id: "file:src/worker.ts", label: "Worker" },
  ],
  concepts: [
    {
      id: "concept:retry",
      label: "Retry policy",
      summary: "Failed jobs wait.",
      related: ["file:src/queue.ts"],
      anchors: [],
    },
    { id: "concept:lonely", label: "Backoff", summary: "Delays double.", anchors: [] },
  ],
  views: [
    {
      id: "view:map",
      type: "graph",
      title: "The parts of the runner",
      include: ["grp:core", "file:src/worker.ts", "file:src/metrics.ts", "grp:tests"],
    },
    {
      id: "view:flow",
      type: "flow",
      title: "What happens to a job",
      participants: ["sym:src/runner.ts#Runner.dispatch", "file:src/worker.ts"],
      steps: [
        {
          id: "flow:1",
          from: "sym:src/runner.ts#Runner.dispatch",
          to: "file:src/worker.ts",
          label: "Run the job",
          kind: "call",
          anchors: [],
        },
      ],
    },
  ],
};

/** A tour of `steps` ([view, focus, note title]) over ORDER_PARTS. */
function orderTour(steps: [string, string[], string][], extra: Record<string, unknown> = {}) {
  return explainer({
    ...ORDER_PARTS,
    tours: [
      {
        id: "tour:o",
        title: "How a job runs",
        summary: "A job goes from the queue to a worker. Failed jobs come back later.",
        steps: steps.map(([view, focus, title], i) => ({
          id: `t${i + 1}`,
          view,
          focus,
          note: `### ${title}\nThe runner takes the next job.`,
        })),
        ...extra,
      },
    ],
  });
}

describe("order checks", () => {
  it("a tour that starts on the map and visits every box has no order finding", () => {
    const { findings } = lintExplainer(
      orderTour([
        ["view:map", ["grp:core", "concept:retry"], "The runner has three parts"],
        ["view:flow", ["flow:1"], "The worker runs the job"],
        ["view:map", ["file:src/metrics.ts"], "Metrics count the jobs"],
        ["view:map", ["grp:tests"], "Tests run the runner"],
      ]),
    );
    expect(findings).toEqual([]);
  });

  it("tour-first-step: a test, an edge case, a flow before the map, a concept that lights up nothing", () => {
    const cases: [[string, string[], string], string][] = [
      [["view:map", ["grp:tests"], "Tests run the runner"], "it focuses a test"],
      [
        ["view:map", ["file:test/runner.test.ts", "concept:retry"], "The runner is tested"],
        "it focuses a test",
      ],
      [["view:map", ["grp:core"], "Edge case: an empty queue"], 'its title says "Edge case"'],
      [["view:map", ["grp:core"], "A corner-case first"], 'its title says "corner-case"'],
      [["view:map", ["grp:core"], "Open questions"], 'its title says "Open questions"'],
      [["view:flow", ["flow:1"], "The worker runs the job"], "it opens on the flow view:flow"],
      [["view:map", ["concept:lonely"], "Delays double"], "it focuses only a concept"],
    ];
    for (const [first, reason] of cases) {
      const { findings } = lintExplainer(
        orderTour([first, ["view:map", ["grp:core"], "The runner has three parts"]]),
      );
      const found = only(findings, "tour-first-step");
      expect(found, first[2]).toHaveLength(1);
      expect(found[0]).toMatchObject({ elementId: "tour:o", kind: "tour", field: "steps" });
      expect(found[0]!.message, first[2]).toContain(reason);
      expect(found[0]!.hint).toContain("start with the big picture");
    }
    // the key idea first is fine when the map lights up the boxes it relates to
    const idea = lintExplainer(
      orderTour([
        ["view:map", ["concept:retry"], "Failed jobs wait"],
        ["view:map", ["grp:core"], "The runner has three parts"],
      ]),
    );
    expect(only(idea.findings, "tour-first-step")).toEqual([]);
    // a tour with no map may open on a flow
    const flowOnly = lintExplainer(orderTour([["view:flow", ["flow:1"], "The worker runs"]]));
    expect(only(flowOnly.findings, "tour-first-step")).toEqual([]);
  });

  it("tour-covers-map: lists the boxes no step visits and no note names", () => {
    const { findings } = lintExplainer(
      orderTour([["view:map", ["grp:core"], "The runner has three parts"]], {
        // a mention by label counts ("a worker" names the Worker box): this summary names none
        summary: "Jobs go from the queue to a runner. Failed jobs come back later.",
      }),
    );
    const covers = only(findings, "tour-covers-map");
    expect(covers).toHaveLength(1);
    expect(covers[0]).toMatchObject({
      elementId: "tour:o",
      kind: "tour",
      view: "view:map",
      field: "steps",
      quote: "Worker, metrics.ts, Tests of the runner",
      ids: ["file:src/worker.ts", "file:src/metrics.ts", "grp:tests"],
    });
    expect(covers[0]!.message).toBe(
      "3 boxes of the map view:map (4 boxes) never come up: no step focuses them, no note names them",
    );
    // visited through a flow step's ends, a member, or named in a note or the summary (code spans count)
    const covered = lintExplainer(
      orderTour(
        [
          ["view:map", ["file:src/runner.ts"], "The runner has three parts"],
          ["view:flow", ["flow:1"], "The worker runs the job"],
          ["view:map", ["grp:core"], "The `metrics` module and the tests of the runner"],
        ],
        { summary: "A job goes from the queue to a worker. Tests of the runner check it." },
      ),
    );
    expect(only(covered.findings, "tour-covers-map")).toEqual([]);
  });

  it("tour-covers-map: only maps the tour uses, of at most 10 boxes", () => {
    const big = Array.from({ length: 11 }, (_, i) => `file:src/m${i}.ts`);
    const parts = {
      ...ORDER_PARTS,
      views: [
        ...ORDER_PARTS.views,
        { id: "view:big", type: "graph", title: "Every file", include: big },
      ],
    };
    const tourOn = (view: string) =>
      lintExplainer(
        explainer({
          ...parts,
          tours: [
            {
              id: "tour:o",
              title: "How a job runs",
              summary: "A job goes from the queue to a worker. Failed jobs come back later.",
              steps: [
                {
                  id: "t1",
                  view,
                  focus: view === "view:flow" ? ["flow:1"] : ["file:src/m0.ts"],
                  note: "### The parts\nThe runner.",
                },
              ],
            },
          ],
        }),
      );
    expect(only(tourOn("view:big").findings, "tour-covers-map")).toEqual([]);
    // view:map is not used by this tour
    expect(only(tourOn("view:flow").findings, "tour-covers-map")).toEqual([]);
  });

  it("tour-length: more than 12 steps", () => {
    const steps = (n: number) =>
      Array.from(
        { length: n },
        (_, i) =>
          ["view:map", ["grp:core"], `Part ${i + 1} of the runner`] as [string, string[], string],
      );
    expect(only(lintExplainer(orderTour(steps(12))).findings, "tour-length")).toEqual([]);
    const long = only(lintExplainer(orderTour(steps(13))).findings, "tour-length");
    expect(long.map((f) => [f.elementId, f.field, f.message])).toEqual([
      ["tour:o", "steps", "13 steps (more than 12)"],
    ]);
    expect(long[0]!.hint).toContain("split the tour");
  });
});

// ─── Rules that do not fight: example values, anchored claims, label stems ───────────────────

describe("lintExplainer: concrete text passes", () => {
  it("code-heavy: example values in code spans are not code names", () => {
    const values = [
      "`503`",
      "`-1`",
      "`1.5`",
      "`Infinity`",
      "`undefined`",
      "`null`",
      "`true`",
      "`0x1f`",
      "`10_000`",
      "`30s`",
      "`5%`",
    ];
    const routes = [
      "`/admin/*`",
      "`/`",
      "`-`",
      "`{id:[0-9]+}`",
      "`lots/of/:fun`",
      "`users/{id}`",
      '`"utf-8"`',
      "`'a'`",
      "`https://example.com/x`",
    ];
    for (const value of [...values, ...routes]) expect(isLiteral(value), value).toBe(true);
    for (const code of [
      "`parseHost`",
      "`Ky.create`",
      "`shouldRetry: () => true`",
      "`**kwargs`",
      "`std::vector`",
      "`src/types.ts`",
    ]) {
      expect(isLiteral(code), code).toBe(false);
    }
    const note =
      "### A retry waits\nA `503` with `retry: -1` or `Infinity` waits; `/admin/*` and `users/{id}` match. `Ky.create` reads it.";
    const { findings } = lintExplainer(explainer({ tours: [tour([note])] }));
    expect(only(findings, "code-heavy")).toEqual([]);
    // four real code names are still too many for a note
    const heavy =
      "### A retry waits\n`Ky.create` calls `retry`, `fetch` and `parseHost` with a `503`.";
    const loud = only(lintExplainer(explainer({ tours: [tour([heavy])] })).findings, "code-heavy");
    expect(loud.map((f) => f.message)).toEqual([
      "4 code names (`Ky.create`, `retry`, `fetch`, `parseHost`); a note takes at most 3",
    ]);
    expect(loud[0]!.hint).toContain("Example values");
  });

  it("code-heavy: the files a map leaves off may be named in that sentence (the skill asks for the list)", () => {
    const views = [
      { id: "view:v", type: "graph", title: "Inside the shop", include: ["dir:src", "grp:db"] },
    ];
    const nodes = [
      { id: "grp:db", kind: "group", label: "Orders database", role: "database", members: [] },
    ];
    const listed =
      "### The shop has two parts\nThe app keeps orders in a database. Two helper files, `is.ts` and `types.ts`, are left off this map.";
    const quiet = lintExplainer(explainer({ views, nodes, tours: [tour([listed])] }));
    expect(only(quiet.findings, "code-heavy")).toEqual([]);
    // the same names in another sentence still count
    const other = "### The shop has two parts\nThe app uses `is.ts` and `types.ts` for checks.";
    const loud = lintExplainer(explainer({ views, nodes, tours: [tour([other])] }));
    expect(only(loud.findings, "code-heavy")).toHaveLength(1);
  });

  it("absolute-word: an element with anchors carries its evidence; one without does not", () => {
    const anchored = { file: "src/a.ts", symbol: "f", role: "definition" };
    const { findings } = lintExplainer(
      explainer({
        nodes: [
          {
            id: "sym:a#x",
            label: "x",
            summary: "Every caller gets the same error.",
            anchors: [anchored],
          },
          { id: "sym:a#y", label: "y", summary: "Every caller gets the same error.", anchors: [] },
        ],
        views: [
          {
            id: "view:f",
            type: "flow",
            title: "Retries",
            participants: [],
            steps: [
              { id: "f:1", label: "Stop", summary: "Ky never retries a 404.", anchors: [anchored] },
              { id: "f:2", label: "Stop", summary: "Ky never retries a 404.", anchors: [] },
            ],
          },
        ],
      }),
    );
    expect(only(findings, "absolute-word").map((f) => f.elementId)).toEqual(["f:2", "sym:a#y"]);
    expect(only(findings, "absolute-word")[0]!.hint).toContain("anchor it");
  });

  it("absolute-word: a tour note sentence that names the part the step shows points at its evidence", () => {
    const nodes = [
      {
        id: "grp:keys",
        label: "Secret keys",
        members: [],
        anchors: [{ file: "a.py", role: "definition" }],
      },
    ];
    const steps = [
      // names the focused, anchored group: its anchors prove it
      {
        id: "t1",
        view: "view:v",
        focus: ["grp:keys"],
        note: "### Every secret key can verify a token\nThe list keeps old keys.",
      },
      // a focused symbol is code the step shows
      {
        id: "t2",
        view: "view:v",
        focus: ["sym:src/timed.py#TimedSerializer.loads"],
        note: "### Old tokens\nThe loads method never trusts an old timestamp.",
      },
      // a claim about something else
      {
        id: "t3",
        view: "view:v",
        focus: ["grp:keys"],
        note: "### Old tokens\nEvery token expires after a day.",
      },
      // no anchors and no code: no evidence
      {
        id: "t4",
        view: "view:v",
        focus: ["grp:other"],
        note: "### Other\nThe other part never fails.",
      },
    ];
    const { findings } = lintExplainer(
      explainer({
        nodes: [...nodes, { id: "grp:other", label: "The other part", members: [] }],
        tours: [
          {
            id: "tour:t",
            title: "Tokens",
            summary: "Tokens carry a time. Old keys still verify.",
            steps,
          },
        ],
      }),
    );
    expect(only(findings, "absolute-word").map((f) => f.elementId)).toEqual([
      "tour:t/t3",
      "tour:t/t4",
    ]);
    expect(only(findings, "absolute-word")[0]!.hint).toContain("name the part the step focuses");
  });

  it("absolute-word: the same words get the same verdict in a title, a heading, a summary and a note", () => {
    const sentences = [
      "A token expires only if you ask for an age limit",
      "Only the router reads the header",
      "Every key can verify a token",
    ];
    for (const text of sentences) {
      const { findings } = lintExplainer(
        explainer({
          title: text,
          tours: [
            tour([`### ${text}\n${text}.`], {
              title: text,
              summary: `${text}. A second sentence.`,
            }),
          ],
          nodes: [{ id: "grp:g", label: text, summary: `${text}.`, members: [] }],
        }),
      );
      const fields = only(findings, "absolute-word").map((f) => `${f.elementId} ${f.field}`);
      const expected = /^A token/.test(text)
        ? []
        : [
            "(explainer) title",
            "tour:t title",
            "tour:t summary",
            "tour:t/t1 note heading",
            "tour:t/t1 note",
            "grp:g label",
            "grp:g summary",
          ];
      expect(fields, text).toEqual(expected);
    }
    // the message says what kind of "only" counts
    const { findings } = lintExplainer(explainer({ title: "Only the router reads it" }));
    expect(findings[0]!.message).toContain('"only" that opens a clause');
  });

  it("tour-covers-map: a label matches by word stems, and a method by its own name", () => {
    const nodes = [
      { id: "grp:web", label: "Web servers", members: [] },
      { id: "grp:waits", label: "Timeouts and waits", members: [] },
    ];
    const views = [
      {
        id: "view:m",
        type: "graph",
        title: "Routing",
        include: [
          "grp:web",
          "grp:waits",
          "sym:tree.go#nodes.findEdge",
          "sym:tree.go#node.findRoute",
        ],
      },
    ];
    const note =
      "### Where a request goes\nYour app talks to the web server. Its timeout and wait stop it. findEdge picks a child.";
    const { findings } = lintExplainer(
      explainer({
        nodes,
        views,
        tours: [
          {
            id: "tour:t",
            title: "Routes",
            summary: "A path finds a handler. Params are kept.",
            steps: [{ id: "t1", view: "view:m", focus: ["sym:tree.go#node.findRoute"], note }],
          },
        ],
      }),
    );
    expect(only(findings, "tour-covers-map")).toEqual([]);
    // the hint says how to name a box without a code span
    const missed = lintExplainer(
      explainer({
        nodes,
        views,
        tours: [
          {
            id: "tour:t",
            title: "Routes",
            summary: "A path finds a handler. Params are kept.",
            steps: [
              {
                id: "t1",
                view: "view:m",
                focus: ["sym:tree.go#node.findRoute"],
                note: "### Where\nThe router looks.",
              },
            ],
          },
        ],
      }),
    );
    expect(only(missed.findings, "tour-covers-map")[0]!.ids).toEqual([
      "grp:web",
      "grp:waits",
      "sym:tree.go#nodes.findEdge",
    ]);
    expect(only(missed.findings, "tour-covers-map")[0]!.hint).toContain("in plain words");
  });

  it("long-sentence in a full summary: shorten it, do not split it (tour-summary caps the sentences)", () => {
    const long = `${"word ".repeat(27).trim()}.`;
    const full = lintExplainer(
      explainer({ tours: [tour([], { summary: `${long} Two. Three. Four.` })] }),
    );
    expect(only(full.findings, "tour-summary")).toEqual([]);
    expect(only(full.findings, "long-sentence")[0]!.hint).toMatch(
      /^shorten it .* rather than split it/,
    );
    const room = lintExplainer(explainer({ tours: [tour([], { summary: `${long} Two.` })] }));
    expect(only(room.findings, "long-sentence")[0]!.hint).toMatch(/^split it/);
  });
});

// ─── What the viewer will show ─────────────────────────────────────────────────────────────────

describe("lintExplainer: reader checks", () => {
  it("untitled-step: no note, or no heading and a first sentence too long to be a title", () => {
    const long = `${"word ".repeat(20).trim()}. Short.`;
    const { findings } = lintExplainer(
      explainer({
        tours: [
          {
            ...tour([long, "The runner takes a job. It runs it.", "- a list\n- of items"]),
            steps: [
              ...tour([long, "The runner takes a job. Then it runs.", "- a list\n- of items"])
                .steps,
              { id: "t4", view: "view:v", focus: ["grp:core"] },
            ],
          },
        ],
      }),
    );
    expect(
      findings
        .filter((f) => f.rule === "untitled-step" || f.rule === "note-heading")
        .map((f) => [f.elementId, f.rule]),
    ).toEqual([
      ["tour:t/t1", "untitled-step"],
      ["tour:t/t2", "note-heading"],
      ["tour:t/t3", "untitled-step"],
      ["tour:t/t4", "untitled-step"],
    ]);
    expect(only(findings, "untitled-step")[2]!.message).toContain('"Step 4"');
  });

  it("far-ranges: two ranges in one file far apart (a slide shows only one); close ones and a draft's TODO are fine", () => {
    const range = (file: string, startLine: number, endLine: number) => ({
      file,
      role: "definition",
      resolved: { commit: "c", range: { startLine, endLine }, status: "ok" },
    });
    const step = (id: string, code: unknown[], note = "### A step\nThe runner takes a job.") => ({
      id,
      view: "view:v",
      focus: [],
      note,
      code,
    });
    const { findings } = lintExplainer(
      explainer({
        tours: [
          {
            ...tour([]),
            steps: [
              step("t1", [range("tree.go", 414, 428), range("tree.go", 90, 95)]),
              step("t2", [
                range("tree.go", 414, 428),
                range("tree.go", 440, 450),
                range("mux.go", 1, 5),
              ]),
              step("t3", [range("tree.go", 1, 5), { ...range("tree.go", 400, 410), at: "base" }]),
              step(
                "t4",
                [range("tree.go", 1, 5), range("tree.go", 400, 410)],
                "### TODO: say what this shows",
              ),
            ],
          },
        ],
      }),
    );
    expect(
      only(findings, "far-ranges").map((f) => [f.elementId, f.field, f.quote, f.message]),
    ).toEqual([
      [
        "tour:t/t1",
        "code",
        "tree.go:90-95 and 414-428",
        "two ranges in tree.go are 319 lines apart: the code pane scrolls to one of them, and a slide shows only one",
      ],
    ]);
  });

  it("long-talk-note: a note over LONG_NOTE in a talk; other tours may say more", () => {
    const body = "The runner takes the next job from the queue. ".repeat(7).trim();
    expect(body.length).toBeGreaterThan(LINT_LIMITS.talkNoteChars);
    const note = `### The runner takes a job\n${body}`;
    for (const [title, id, want] of [
      ["Intro talk", "tour:t", 1],
      ["How a job runs", "tour:talk", 1],
      ["How a job runs", "tour:t", 0],
    ] as const) {
      const { findings } = lintExplainer(explainer({ tours: [tour([note], { id, title })] }));
      expect(only(findings, "long-talk-note"), `${id} ${title}`).toHaveLength(want);
    }
  });

  it("big-map (on include without an index) and self-loop (an edge from a box to itself is not drawn)", () => {
    const include = Array.from({ length: 9 }, (_, i) => `file:src/f${i}.ts`);
    const { findings } = lintExplainer(
      explainer({
        views: [
          { id: "view:big", type: "graph", title: "Everything", include },
          { id: "view:ref", type: "graph", title: "Reference", include },
        ],
        edges: [
          {
            id: "edge:recurse",
            kind: "calls",
            from: "sym:src/f1.ts#walk",
            to: "sym:src/f1.ts#walk",
            summary: "It walks down.",
            anchors: [],
          },
          {
            id: "edge:other",
            kind: "calls",
            from: "sym:other.ts#a",
            to: "sym:other.ts#a",
            anchors: [],
          },
        ],
        tours: [
          {
            ...tour([]),
            steps: [
              {
                id: "t1",
                view: "view:big",
                focus: [],
                note: "### All of it\nThe runner takes a job.",
              },
            ],
          },
        ],
      }),
    );
    // only the map a tour shows is too big for a picture
    expect(only(findings, "big-map").map((f) => [f.elementId, f.message])).toEqual([
      [
        "view:big",
        "9 boxes (more than 8) on a map a tour shows: a guide picture or a slide of it is too small to read",
      ],
    ]);
    // edge:other is on no map
    expect(only(findings, "self-loop").map((f) => [f.elementId, f.message])).toEqual([
      [
        "edge:recurse",
        "an edge from walk to itself is not drawn on the map (view:big, view:ref): readers see it only from a step that names it",
      ],
    ]);
  });

  it("crowded-map: more than 2 arrows per box, with the least used drawn edges to hide (needs the index)", () => {
    const sym = (id: string, start: number) => ({
      id,
      file: "src/a.ts",
      path: id.split("#")[1]!,
      kind: "function",
      range: { startLine: start, endLine: start + 2 },
      hash: "h",
    });
    const ref = (from: string, to: string, line: number, kind = "call") => ({
      from,
      to,
      kind,
      site: { startLine: line, endLine: line, startCol: 1, endCol: 2 },
      resolution: "precise",
    });
    const [a, b, c] = ["src/a.ts#a", "src/a.ts#b", "src/a.ts#c"];
    const index = {
      schema: INDEX_SCHEMA,
      commit: "c",
      tool: "test",
      languages: {},
      files: [{ path: "src/a.ts", language: "typescript", hash: "h", lines: 40 }],
      symbols: [sym(a!, 1), sym(b!, 10), sym(c!, 20)],
      refs: [
        ref(a!, b!, 2),
        ref(a!, b!, 3),
        ref(b!, a!, 11),
        ref(a!, c!, 2),
        ref(c!, a!, 21),
        ref(b!, c!, 11),
        ref(c!, b!, 21),
        ref(c!, b!, 22),
        ref(a!, b!, 1, "extends"),
      ],
    } as unknown as SymbolIndex;
    const doc = explainer({
      views: [
        {
          id: "view:m",
          type: "graph",
          title: "Three functions",
          include: [`sym:${a}`, `sym:${b}`, `sym:${c}`],
        },
      ],
    });
    // without the index, no arrows to count
    expect(only(lintExplainer(doc).findings, "crowded-map")).toEqual([]);
    const { findings } = lintExplainer(doc, new ExplainerModel(doc, index));
    const crowded = only(findings, "crowded-map");
    expect(crowded.map((f) => [f.elementId, f.field, f.message])).toEqual([
      [
        "view:m",
        "hidden",
        "7 arrows on 3 boxes (more than 2 per box): the arrows cross and hide each other",
      ],
    ]);
    // the one edge to hide is a least used one (one reference)
    expect(crowded[0]!.ids).toHaveLength(1);
    expect(crowded[0]!.hint).toContain(crowded[0]!.ids![0]!);
  });

  it("change-not-shown: changed files no tour step shows or names", () => {
    const change = {
      base: "b",
      head: "h",
      files: ["src/a.ts", "src/b.ts", "src/c.ts", "src/d.ts", "src/e.ts", "pnpm-lock.yaml"].map(
        (path) => ({ path, status: "modified", hunks: [] }),
      ),
    };
    const { findings } = lintExplainer(
      explainer({
        change,
        nodes: [{ id: "grp:tests", label: "Tests", members: ["file:src/c.ts"] }],
        edges: [
          {
            id: "edge:x",
            kind: "calls",
            from: "sym:src/d.ts#f",
            to: "sym:src/d.ts#g",
            anchors: [{ file: "src/e.ts", role: "call-site" }],
          },
        ],
        tours: [
          {
            ...tour([]),
            steps: [
              {
                id: "t1",
                view: "view:v",
                focus: ["sym:src/a.ts#f"],
                note: "### A\nThe runner takes a job.",
              },
              {
                id: "t2",
                view: "view:v",
                focus: ["grp:tests", "edge:x"],
                note: "### B\nThe lock file pnpm-lock.yaml only moves versions.",
              },
            ],
          },
        ],
      }),
    );
    expect(only(findings, "change-not-shown").map((f) => [f.elementId, f.ids, f.message])).toEqual([
      [
        "(explainer)",
        ["src/b.ts"],
        "1 changed file of 6 is on no tour step: no step shows its code, no note names it",
      ],
    ]);
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

  it("prints the findings grouped by element and a count line, and exits 1 (0 with --warn-only)", async () => {
    const { code, out, err } = await xpl(demo, "lint", "demo");
    expect(err).toBe("");
    // any finding exits 1, so `xpl lint --patch p && xpl apply x p` stops on it
    expect(code).toBe(1);
    const lines = out.split("\n");
    expect(lines[0]).toMatch(/^\.explainer\/demo\.explainer\.json: \d+ texts checked$/);
    expect(out).toContain("\ntour:intro (tour)\n  summary  tour-summary: no summary");
    expect(out).toContain("\ntour:intro/t1 (tour step)\n  note  note-heading:");
    expect(out).toContain('    "Big picture first: scheduling is two files."');
    expect(out).toContain('    fix: start the note with "### <plain title>"');
    // the fixture map has two boxes the tour never visits
    expect(out).toContain(
      "  steps  tour-covers-map: 2 boxes of the map view:overview (3 boxes) never come up",
    );
    expect(lines.at(-1)).toMatch(
      /^\d+ findings in \d+ elements \(tour-summary 1, tour-covers-map 1, note-heading 2.*\); fix them, or keep one on purpose \(say why\) and run with --warn-only$/,
    );
    const warnOnly = await xpl(demo, "lint", "demo", "--warn-only");
    expect(warnOnly.code).toBe(0);
    expect(warnOnly.out.split("\n").at(-1)).toMatch(/; warnings only \(--warn-only\)$/);
  });

  it("--json lists the findings; exit 1 when there are any, --strict too, --warn-only 0", async () => {
    const { code, json } = await xplJson<{
      total: number;
      checked: number;
      counts: Record<string, number>;
      findings: LintFinding[];
    }>(demo, "lint", "demo", "--warn-only");
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

    // --strict is the default now, kept for older scripts
    const strict = await xpl(demo, "lint", "demo", "--strict");
    expect(strict.code).toBe(1);
    expect(strict.out).not.toContain("warnings only");
    const plain = await xplJson(demo, "lint", "demo");
    expect(plain.code).toBe(1);
    expect(plain.json.ok).toBe(false);
    const strictJson = await xplJson(demo, "lint", "demo", "--strict");
    expect(strictJson.code).toBe(1);
    expect(strictJson.json.ok).toBe(false);
  });

  it("a clean explainer: ok, and exits 0", async () => {
    const dir = cloneDir(demo);
    expect((await xpl(dir, "new", "clean", "--title", "How a job runs")).code).toBe(0);
    const { code, out } = await xpl(dir, "lint", "clean");
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
    expect(help.out).toContain("Usage: xpl lint <explainer> [--patch <file|->] [--warn-only]");
    for (const rule of ["repeats-summary", "markdown-in-plain", "markdown-in-summary"]) {
      expect(help.out).toContain(rule);
    }
    for (const rule of ["tour-first-step", "tour-covers-map", "tour-length"]) {
      expect(help.out).toContain(rule);
    }
  });

  describe("--patch", () => {
    const FIX = {
      tours: [
        {
          id: "tour:intro",
          summary: "Jobs wait in a queue until a runner takes them. Failed jobs come back later.",
        },
      ],
    };

    it("lints the explainer as it would be after the patch, and writes nothing", async () => {
      const dir = cloneDir(demo);
      const before = readFile(dir, ".explainer/demo.explainer.json");
      writeFile(dir, "fix.json", JSON.stringify(FIX));
      const { code, out } = await xpl(dir, "lint", "demo", "--patch", "fix.json");
      // the notes still have findings
      expect(code).toBe(1);
      expect(out.split("\n")[0]).toMatch(
        /^\.explainer\/demo\.explainer\.json with patch fix\.json \(1 id changed, nothing written\): \d+ texts checked$/,
      );
      expect(out).not.toContain("tour-summary");
      expect(out).toContain("note-heading");
      expect(readFile(dir, ".explainer/demo.explainer.json")).toBe(before);

      // the same from stdin, and --json says what the patch changed
      const json = await invoke(["lint", "demo", "--patch", "-", "--json", "--warn-only"], {
        cwd: dir,
        stdin: JSON.stringify(FIX),
      });
      expect(json.code).toBe(0);
      const result = JSON.parse(json.out);
      expect(result).toMatchObject({ ok: true, patch: "stdin", changed: ["tour:intro"] });
      expect(result.counts["tour-summary"]).toBeUndefined();
      expect(readFile(dir, ".explainer/demo.explainer.json")).toBe(before);
    });

    it("a patch that apply would reject prints the rejection and exits 1", async () => {
      const dir = cloneDir(demo);
      const bad = { tours: [{ id: "tour:intro", sumary: "typo" }] };
      writeFile(dir, "bad.json", JSON.stringify(bad));
      const lint = await xpl(dir, "lint", "demo", "--patch", "bad.json");
      const apply = await xpl(dir, "apply", "demo", "bad.json", "--dry-run");
      expect(lint.code).toBe(1);
      expect(apply.code).toBe(1);
      // the rejection lines are the ones apply prints
      expect(lint.out.split("\n").slice(0, -1)).toEqual(apply.out.split("\n"));
      expect(lint.out.split("\n").at(-1)).toBe(
        "nothing linted: fix the patch, then run `xpl lint --patch` again",
      );
      const json = await xplJson(dir, "lint", "demo", "--patch", "bad.json");
      expect(json.code).toBe(1);
      expect(json.json).toMatchObject({
        ok: false,
        error: "patch rejected: 1 error, nothing applied",
      });
      // a patch file that cannot be read is a fatal error, as in apply
      const missing = await xpl(dir, "lint", "demo", "--patch", "nope.json");
      expect(missing.code).toBe(1);
      expect(missing.err).toContain("cannot read patch file");
    });

    it("the exit code counts the findings after the patch: `lint --patch && apply` stops on one", async () => {
      const dir = cloneDir(demo);
      writeFile(dir, "fix.json", JSON.stringify(FIX));
      expect((await xpl(dir, "lint", "demo", "--patch", "fix.json")).code).toBe(1);
      expect((await xpl(dir, "lint", "demo", "--patch", "fix.json", "--strict")).code).toBe(1);
      expect((await xpl(dir, "lint", "demo", "--patch", "fix.json", "--warn-only")).code).toBe(0);
    });
  });
});
