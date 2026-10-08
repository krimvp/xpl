import { describe, expect, it } from "vitest";
import { extract, indexFiles, refTriples, symbolLines } from "./helpers.js";

const src = (...lines: string[]) => lines.join("\n") + "\n";

describe("Java language pack", () => {
  it("indexes declarations and links same-package calls and construction across files", async () => {
    const { index } = await indexFiles({
      "src/demo/Job.java": src("package demo;", "public record Job(String id) {}"),
      "src/demo/Queue.java": src(
        "package demo;",
        "interface Ready { void run(); }",
        "class Queue implements Ready {",
        "  private Job job;",
        "  Queue(Job job) { this.job = job; }",
        "  public void run() { this.take(); }",
        '  Job take() { return new Job("x"); }',
        "}",
      ),
      "src/demo/App.java": src(
        "package demo;",
        "class App {",
        '  void start() { Queue q = new Queue(new Job("a")); q.run(); }',
        "}",
      ),
    });
    expect(symbolLines(index, "src/demo/Queue.java")).toEqual([
      "interface Ready 2-2",
      "method Ready.run 2-2",
      "class Queue 3-8",
      "variable Queue.job 4-4",
      "method Queue.Queue 5-5",
      "method Queue.run 6-6",
      "method Queue.take 7-7",
    ]);
    expect(refTriples(index)).toContain(
      "src/demo/App.java#App.start -> src/demo/Queue.java#Queue (call)",
    );
    expect(refTriples(index)).toContain(
      "src/demo/App.java#App.start -> src/demo/Queue.java#Queue.run (call)",
    );
    expect(refTriples(index)).toContain(
      "src/demo/Queue.java#Queue.take -> src/demo/Job.java#Job (call)",
    );
    expect(refTriples(index)).toContain(
      "src/demo/Queue.java#Queue.Queue -> src/demo/Queue.java#Queue.job (write)",
    );
    expect(index.refs.every((ref) => ref.resolution === "heuristic")).toBe(true);
  });

  it("resolves explicit package imports and class heritage without linking external imports", async () => {
    const { index } = await indexFiles({
      "src/main/java/demo/Base.java": src("package demo;", "public class Base { void work() {} }"),
      "src/main/java/demo/Ready.java": src("package demo;", "public interface Ready {}"),
      "src/main/java/app/Runner.java": src(
        "package app;",
        "import demo.Base;",
        "import demo.Ready;",
        "import java.util.List;",
        "class Runner extends Base implements Ready {",
        "  void run() { this.work(); }",
        "}",
      ),
    });
    const refs = refTriples(index);
    expect(refs).toContain(
      "src/main/java/app/Runner.java# -> src/main/java/demo/Base.java#Base (import)",
    );
    expect(refs).toContain(
      "src/main/java/app/Runner.java# -> src/main/java/demo/Ready.java#Ready (import)",
    );
    expect(refs).toContain(
      "src/main/java/app/Runner.java#Runner -> src/main/java/demo/Base.java#Base (extends)",
    );
    expect(refs).toContain(
      "src/main/java/app/Runner.java#Runner -> src/main/java/demo/Ready.java#Ready (implements)",
    );
    expect(refs).toContain(
      "src/main/java/app/Runner.java#Runner.run -> src/main/java/demo/Base.java#Base.work (call)",
    );
    expect(refs.filter((ref) => ref.includes("java.util"))).toEqual([]);
  });

  it("uses declared packages for implicit names across source roots", async () => {
    const { index } = await indexFiles({
      "src/main/java/demo/Worker.java": src("package demo;", "class Worker { void work() {} }"),
      "src/test/java/demo/Runner.java": src(
        "package demo;",
        "class Runner { void run() { new Worker().work(); } }",
      ),
      "src/test/java/demo/Other.java": src(
        "package other;",
        "class Other { void run() { new Worker(); } }",
      ),
    });
    const refs = refTriples(index);
    expect(refs).toContain(
      "src/test/java/demo/Runner.java#Runner.run -> src/main/java/demo/Worker.java#Worker (call)",
    );
    expect(refs.filter((ref) => ref.startsWith("src/test/java/demo/Other.java#"))).toEqual([]);
  });

  it("ignores commented package text when sharing names", async () => {
    const { index } = await indexFiles({
      "src/A.java": src(
        "/*",
        "package wrong;",
        "*/",
        "package right;",
        "class A { void run() {} }",
      ),
      "src/B.java": src("package right;", "class B { void go() { new A().run(); } }"),
      "src/C.java": src("package wrong;", "class C { void go() { new A(); } }"),
    });
    const refs = refTriples(index);
    expect(refs).toContain("src/B.java#B.go -> src/A.java#A (call)");
    expect(refs.filter((ref) => ref.startsWith("src/C.java#"))).toEqual([]);
  });

  it("does not guess a member of a class in another declared package", async () => {
    const { index } = await indexFiles({
      "src/A.java": src("package right;", "class A { void run() {} }"),
      "src/B.java": src(
        "package wrong;",
        "class B { void run() {} void go() { var a = new B(); a.run(); } }",
      ),
    });
    expect(refTriples(index)).toEqual(["src/B.java#B.go -> src/B.java#B (call)"]);
  });

  it("resolves an explicitly imported nested class", async () => {
    const { index } = await indexFiles({
      "src/main/java/demo/Outer.java": src(
        "package demo;",
        "public class Outer { public static class Inner {} }",
      ),
      "src/main/java/app/Use.java": src(
        "package app;",
        "import demo.Outer.Inner;",
        "class Use { Inner make() { return new Inner(); } }",
      ),
    });
    const refs = refTriples(index);
    expect(refs).toContain(
      "src/main/java/app/Use.java# -> src/main/java/demo/Outer.java#Outer.Inner (import)",
    );
    expect(refs).toContain(
      "src/main/java/app/Use.java#Use.make -> src/main/java/demo/Outer.java#Outer.Inner (call)",
    );
  });

  it("resolves fully qualified types without an import statement", async () => {
    const { index } = await indexFiles({
      "src/main/java/a/b/Queue.java": src(
        "package a.b;",
        "public class Queue { public void run() {} }",
      ),
      "src/main/java/app/Use.java": src(
        "package app;",
        "class Use { void go() { a.b.Queue q = new a.b.Queue(); q.run(); } }",
      ),
    });
    const refs = refTriples(index);
    expect(refs).toContain(
      "src/main/java/app/Use.java#Use.go -> src/main/java/a/b/Queue.java#Queue (call)",
    );
    expect(refs).toContain(
      "src/main/java/app/Use.java#Use.go -> src/main/java/a/b/Queue.java#Queue.run (call)",
    );
    expect(refs.filter((ref) => ref.includes("Queue.java# (type-ref)"))).toEqual([]);
  });

  it("classifies imported names, constructors, calls, and type positions for precise occurrences", async () => {
    const source = src(
      "package demo;",
      "import demo.Job;",
      "class Runner extends Base {",
      "  Job make(Job job) { return new Job(job.id()); }",
      "}",
    );
    const parsed = await extract("Runner.java", source);
    parsed.withTree((ctx) => {
      expect(parsed.pack.classifySite(ctx, 2, 13)?.kind).toBe("import");
      expect(parsed.pack.classifySite(ctx, 3, 22)?.kind).toBe("extends");
      expect(parsed.pack.classifySite(ctx, 4, 3)?.kind).toBe("type-ref");
      expect(parsed.pack.classifySite(ctx, 4, 34)?.kind).toBe("call");
      expect(parsed.pack.classifySite(ctx, 4, 42)?.kind).toBe("call");
    });
  });
});
