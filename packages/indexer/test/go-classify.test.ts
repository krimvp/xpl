import { describe, expect, it } from "vitest";
import type { ClassifiedSite, Span } from "../src/index.js";
import { extract } from "./helpers.js";
import type { Extracted } from "./helpers.js";

const src = (...lines: string[]): string => lines.join("\n") + "\n";

/** 1-based line and column of the `«…»` marked position inside `context`, located in `source`. */
function locate(source: string, context: string): { line: number; col: number } {
  const plain = context.replace(/[«»]/g, "");
  const index = source.indexOf(plain);
  if (index < 0) throw new Error(`context not found: ${plain}`);
  if (source.indexOf(plain, index + 1) >= 0) throw new Error(`context is ambiguous: ${plain}`);
  const before = source.slice(0, index + context.indexOf("«"));
  const lines = before.split("\n");
  return { line: lines.length, col: lines[lines.length - 1]!.length + 1 };
}

function classifier(ex: Extracted, source: string) {
  return (context: string): ClassifiedSite | undefined => {
    const { line, col } = locate(source, context);
    return ex.withTree((ctx) => ex.pack.classifySite(ctx, line, col));
  };
}

/** The source text a span covers (1-based inclusive lines and columns); newlines are shown as ⏎. */
function covered(text: string, s: Span): string {
  const lines = text.split("\n");
  const out: string[] = [];
  for (let line = s.startLine; line <= s.endLine; line++) {
    const t = lines[line - 1] ?? "";
    out.push(
      t.slice(line === s.startLine ? s.startCol - 1 : 0, line === s.endLine ? s.endCol : t.length),
    );
  }
  return out.join("⏎");
}

/** `kind «covered text»` of a classification. */
const show = (text: string, c: ClassifiedSite | undefined): string | undefined =>
  c && `${c.kind} «${covered(text, c.site)}»`;

const source = src(
  "package sample", // 1
  "", // 2
  "import (", // 3
  '\t"fmt"', // 4
  '\tq2 "example.com/m/queue"', // 5
  '\t_ "embed"', // 6
  '\t. "os"', // 7
  ")", // 8
  "", // 9
  "type Runner struct {", // 10
  "\tqueue JobQueue", // 11
  "\tpool  *worker.Pool", // 12
  "\tBase", // 13
  "\tio.Closer", // 14
  "}", // 15
  "", // 16
  "type Iface interface {", // 17
  "\tio.Reader", // 18
  "\tRun()", // 19
  "}", // 20
  "", // 21
  "var counter int", // 22
  "", // 23
  "func (r *Runner) Dispatch(ctx context.Context, job *Job) error {", // 24
  "\tw, err := r.pool.Lease(ctx)", // 25
  "\tresult := w.Run(job)", // 26
  "\tr.count++", // 27
  "\tcounter = 1", // 28
  "\tr.field, counter = 2, 3", // 29
  '\tq2.Do(Job{ID: "x"}, &worker.Options{})', // 30
  "\tr.queue.Requeue(", // 31
  "\t\tjob,", // 32
  "\t)", // 33
  "\tfmt.Println(result, err)", // 34
  "\tx := (*Impl)(nil)", // 35
  "\tvar y Local", // 36
  "\thandlers[k].Run()", // 37
  "\treturn nil", // 38
  "}", // 39
);

describe("Go classifySite agrees with the sites `extract` emits", () => {
  it("every emitted call / extends / type-ref / write site is found by classifySite", async () => {
    const ex = await extract("a.go", source);
    const key = (kind: string, s: Span) =>
      `${kind} ${s.startLine}:${s.startCol}-${s.endLine}:${s.endCol}`;
    const classified = ex.withTree((ctx) => {
      const found = new Set<string>();
      const identifiers = ctx.tree.rootNode.descendantsOfType([
        "identifier",
        "field_identifier",
        "type_identifier",
        "package_identifier",
      ]);
      for (const node of identifiers) {
        const r = ex.pack.classifySite(
          ctx,
          node.startPosition.row + 1,
          node.startPosition.column + 1,
        );
        if (r) found.add(key(r.kind, r.site));
      }
      return found;
    });
    const missing = ex.facts.sites
      .filter((s) => !classified.has(key(s.kind, s.site)))
      .map((s) => `${s.kind} ${[...s.qualifier, s.name].join(".")}`);
    expect(missing).toEqual([]);
    expect(ex.facts.sites.length).toBeGreaterThan(15);
  });

  it("classifies import specs (alias, blank, dot, path) with the binding's span", async () => {
    const ex = await extract("a.go", source);
    const at = classifier(ex, source);
    const bindings = ex.facts.imports;
    expect(bindings.map((b) => b.localName)).toEqual(["fmt", "q2", "_", "."]);
    const contexts = [
      '\t"«f»mt"', // inside the path of an un-aliased import
      '\t«q»2 "example.com/m/queue"', // the alias
      '\t«_» "embed"', // blank identifier
      '\t«.» "os"', // dot
    ];
    contexts.forEach((context, i) => {
      expect(at(context), context).toEqual({ kind: "import", site: bindings[i]!.site });
    });
    expect(at('q2 "«e»xample.com/m/queue"')).toEqual({ kind: "import", site: bindings[1]!.site });
  });
});

describe("Go classifySite: the specific kinds", () => {
  it("calls: functions, methods, chains, package functions; multi-line calls get the whole call as the site", async () => {
    const ex = await extract("a.go", source);
    const at = classifier(ex, source);
    const shown = (context: string) => show(source, at(context));
    expect(shown("r.pool.«L»ease(ctx)")).toBe("call «r.pool.Lease(ctx)»");
    expect(shown("w.«R»un(job)")).toBe("call «w.Run(job)»");
    expect(shown("q2.«D»o(Job")).toMatch(/^call «q2\.Do\(Job/);
    expect(shown("fmt.«P»rintln(result")).toBe("call «fmt.Println(result, err)»");
    // a multi-line call is classified with the same site as `extract` (the whole call, 3 lines)
    expect(shown("r.queue.«R»equeue(")).toBe("call «r.queue.Requeue(⏎\t\tjob,⏎\t)»");
    expect(at("r.queue.«R»equeue(")!.site).toMatchObject({ startLine: 31, endLine: 33 });
  });

  it("composite literals are calls of the type, with the literal as the site", async () => {
    const ex = await extract("a.go", source);
    const at = classifier(ex, source);
    expect(show(source, at('q2.Do(«J»ob{ID: "x"}'))).toBe('call «Job{ID: "x"}»');
    expect(show(source, at("&worker.«O»ptions{}"))).toBe("call «worker.Options{}»");
  });

  it("type names: fields, parameters, qualified names, conversions, var types", async () => {
    const ex = await extract("a.go", source);
    const at = classifier(ex, source);
    const shown = (context: string) => show(source, at(context));
    expect(shown("queue «J»obQueue")).toBe("type-ref «JobQueue»");
    // a qualified type name: the site is the whole `worker.Pool`, from either part
    expect(shown("*worker.«P»ool")).toBe("type-ref «worker.Pool»");
    expect(shown("job *«J»ob)")).toBe("type-ref «Job»");
    expect(shown("(*«I»mpl)(nil)")).toBe("type-ref «Impl»");
    expect(shown("var y «L»ocal")).toBe("type-ref «Local»");
    expect(shown("(r *«R»unner)")).toBe("type-ref «Runner»"); // the receiver type
  });

  it("embedded fields and interface elements are `extends`", async () => {
    const ex = await extract("a.go", source);
    const at = classifier(ex, source);
    const shown = (context: string) => show(source, at(context));
    expect(shown("\t«B»ase")).toBe("extends «Base»");
    expect(shown("io.«C»loser")).toBe("extends «io.Closer»");
    expect(shown("io.«R»eader")).toBe("extends «io.Reader»");
  });

  it("writes: increments, assignments to package variables and fields, multiple targets", async () => {
    const ex = await extract("a.go", source);
    const at = classifier(ex, source);
    const shown = (context: string) => show(source, at(context));
    expect(shown("r.«c»ount++")).toBe("write «r.count++»");
    expect(shown("«c»ounter = 1")).toBe("write «counter = 1»");
    expect(shown("r.«f»ield, counter")).toBe("write «r.field, counter = 2, 3»");
    expect(shown("r.field, «c»ounter = 2")).toBe("write «r.field, counter = 2, 3»");
  });

  it("classifies by syntax alone: receivers `extract` cannot spell are still calls", async () => {
    const ex = await extract("a.go", source);
    const at = classifier(ex, source);
    expect(show(source, at("handlers[k].«R»un()"))).toBe("call «handlers[k].Run()»");
    expect(ex.facts.sites.some((s) => s.name === "Run" && s.qualifier.includes("handlers"))).toBe(
      false,
    );
  });
});

describe("Go classifySite: reads, and everything else is undefined", () => {
  it("names and selector fields in value positions are reads (bare names flagged): SCIP says whether they are variables", async () => {
    const ex = await extract("a.go", source);
    const at = classifier(ex, source);
    expect(at("«r».pool.Lease")).toMatchObject({ kind: "read", bare: true }); // a receiver in a chain
    expect(at("r.«p»ool.Lease")).toMatchObject({ kind: "read" }); // a field read in a chain
    expect(at("r.«p»ool.Lease")).not.toHaveProperty("bare");
    expect(at("Lease(«c»tx)")).toMatchObject({ kind: "read", bare: true }); // an argument
    expect(at("Println(«r»esult")).toMatchObject({ kind: "read", bare: true });
  });

  it("declarations, receivers, keys, punctuation and positions outside the file are nothing", async () => {
    const ex = await extract("a.go", source);
    const at = classifier(ex, source);
    expect(at("type «R»unner struct")).toBeUndefined(); // a declaration name
    expect(at("func (r *Runner) «D»ispatch(")).toBeUndefined(); // a method name
    expect(at("func («r» *Runner)")).toBeUndefined(); // the receiver variable
    expect(at("«w», err :=")).toBeUndefined(); // a declared local
    expect(at("Job{«I»D:")).toBeUndefined(); // a composite literal key
    expect(at("var «c»ounter int")).toBeUndefined();
    expect(at("«p»ackage sample")).toBeUndefined();
    expect(at("«i»mport (")).toBeUndefined();
    expect(at("Lease«(»ctx)")).toBeUndefined(); // punctuation
    const outside = ex.withTree((ctx) => ex.pack.classifySite(ctx, 999, 1));
    expect(outside).toBeUndefined();
  });

  it("a name that is an argument or operand is a read, not a call or write, even when it also appears as one elsewhere", async () => {
    const source2 = src(
      "package p",
      "func f(cb func()) {", // 2
      "\tcb()", // 3
      "\tg(cb)", // 4
      "\tcb.x = 1", // 5
      "}",
    );
    const ex = await extract("b.go", source2);
    const at = classifier(ex, source2);
    expect(at("\t«c»b()")).toMatchObject({ kind: "call" });
    expect(at("g(«c»b)")).toMatchObject({ kind: "read", bare: true }); // an argument is a read
    expect(at("«c»b.x = 1")).toMatchObject({ kind: "read", bare: true }); // the receiver of a write is read
    expect(at("cb.«x» = 1")).toMatchObject({ kind: "write" });
  });
});
