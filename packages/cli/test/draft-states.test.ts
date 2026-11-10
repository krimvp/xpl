/**
 * `xpl draft states <guide> <type>`: the states of one status type (a TypeScript enum or union of string
 * literals, a Python `Enum`, a Go type with a `const` block), the places that set and test each state, and a
 * transition wherever one function tests a state and then sets another. One flow view, a tour, TODOs to write.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { ExplainerPatch, PatchSequenceStep, SequenceView } from "@xpl/core";
import { makeTempDir, writeFile, xpl, xplJson } from "./helpers.js";

/** Draft, apply, validate and lint: a draft applies as it is and only its TODOs are left to write. */
async function draftStates(
  dir: string,
  entry: string,
): Promise<{ patch: ExplainerPatch; notes: string[] }> {
  expect((await xpl(dir, "index", "--precise", "off")).code).toBe(0);
  expect((await xpl(dir, "new", "s")).code).toBe(0);
  const out = join(makeTempDir("xpl-states-out-"), "states.json");
  const r = await xplJson<{ notes: string[] }>(dir, "draft", "states", "s", entry, "-o", out);
  expect(r.code, r.err + r.out).toBe(0);
  const patch = JSON.parse(readFileSync(out, "utf8")) as ExplainerPatch;
  const applied = await xpl(dir, "apply", "s", out);
  expect(applied.code, applied.out + applied.err).toBe(0);
  const valid = await xpl(dir, "validate", "s");
  expect(valid.code, valid.out + valid.err).toBe(0);
  const lint = await xplJson<{ counts: Record<string, number> }>(dir, "lint", "s");
  expect(Object.keys(lint.json.counts)).toEqual(["todo-left"]);
  return { patch, notes: r.json.notes };
}

const flow = (patch: ExplainerPatch) => patch.views?.[0] as SequenceView;
/** Each step as `id name -> next ids`: the name of its state (`Queued`) or transition (`Queued>Running`). */
const graph = (patch: ExplainerPatch) =>
  (flow(patch).steps as PatchSequenceStep[]).map((s) => {
    const move = /\(now: (\S+) to (\S+)\)$/.exec(s.label);
    const name = move ? `${move[1]}>${move[2]}` : /\(now: (\S+)\)$/.exec(s.label)?.[1];
    return `${s.id} ${name} -> ${(s.next ?? []).map((l) => l.step).join(", ")}`;
  });
const step = (patch: ExplainerPatch, id: string) =>
  (flow(patch).steps as PatchSequenceStep[]).find((s) => s.id === id);

const TS_JOB = `import { Status } from "./status";

export class Job {
  status: Status = Status.Queued;

  start(): void {
    if (this.status !== Status.Queued) throw new Error("not queued");
    this.status = Status.Running;
  }

  finish(ok: boolean): void {
    if (this.status === Status.Running) {
      this.status = ok ? Status.Done : Status.Failed;
    }
  }

  retry(): void {
    if (this.status === Status.Failed) {
      log("again");
    } else {
      this.status = Status.Queued;
    }
  }
}

export function label(s: Status): string {
  switch (s) {
    case Status.Done:
      return "ok";
    default:
      return "?";
  }
}

function log(text: string): void {
  console.log(text, Status.Paused);
}
`;

describe("xpl draft states", () => {
  it("maps a TypeScript enum: one stage per state, a transition where a function tests one and sets another", async () => {
    const dir = makeTempDir("xpl-states-ts-");
    writeFile(dir, "package.json", '{ "name": "jobs" }\n');
    writeFile(
      dir,
      "src/status.ts",
      'export enum Status {\n  Queued = "queued",\n  Running = "running",\n  Done = "done",\n  Failed = "failed",\n  // Paused is for later\n  Paused = "paused",\n}\n',
    );
    writeFile(dir, "src/job.ts", TS_JOB);
    const { patch, notes } = await draftStates(dir, "sym:src/status.ts#Status");

    const view = flow(patch);
    expect([view.id, view.type, view.participants]).toEqual([
      "view:status-states",
      "flow",
      ["sym:src/status.ts#Status", "sym:src/job.ts#Job.start", "sym:src/job.ts#Job.finish"],
    ]);
    // `retry` sets Queued in the else branch of a Failed test: not a transition from Failed
    expect(graph(patch)).toEqual([
      "status-states:1 Queued -> status-states:2",
      "status-states:2 Queued>Running -> status-states:3",
      "status-states:3 Running -> status-states:4, status-states:5",
      "status-states:4 Running>Done -> status-states:6",
      "status-states:5 Running>Failed -> status-states:7",
      "status-states:6 Done -> ",
      "status-states:7 Failed -> ",
      "status-states:8 Paused -> ",
    ]);
    expect(step(patch, "status-states:2")).toMatchObject({
      from: "sym:src/job.ts#Job.start",
      to: "sym:src/job.ts#Job.start",
      anchors: [
        { file: "src/job.ts", symbol: "Job.start", span: { from: 1, to: 1 }, role: "usage" },
        { file: "src/job.ts", symbol: "Job.start", span: { from: 2, to: 2 }, role: "usage" },
      ],
    });
    expect(step(patch, "status-states:1")?.summary).toBe(
      "TODO: what this state means, in one plain sentence (set in `Job.status` and `Job.retry`; tested in `Job.start`).",
    );
    expect(step(patch, "status-states:1")?.anchors?.[0]).toEqual({
      file: "src/status.ts",
      symbol: "Status",
      span: { from: 1, to: 1 },
      role: "definition",
    });
    expect(patch.tours?.[0]?.steps?.map((s) => s.focus)).toEqual([
      ["sym:src/status.ts#Status"],
      ["status-states:1"],
      ["status-states:3"],
      ["status-states:6"],
      ["status-states:7"],
      ["status-states:8"],
    ]);
    expect(notes).toEqual([
      "never set: `Paused`",
      "never tested: `Paused`",
      "Failed: no move out of it found; check `Job.retry` and add the moves the draft missed",
      "1 use is neither a set nor a test (an argument, a list): `xpl refs sym:src/status.ts#Status --in` lists them",
      "a transition is drafted only where one function tests a state and then sets another, matched in its text: check each in the code, and add the moves the draft missed",
      "the uses come from heuristic references: check each in the code",
    ]);
  });

  it("maps a union of string literals through the fields typed with it, not comments or other fields", async () => {
    const dir = makeTempDir("xpl-states-union-");
    writeFile(dir, "package.json", '{ "name": "posts" }\n');
    writeFile(
      dir,
      "src/post.ts",
      `export type Phase = "draft" | "live" | "archived";

export class Post {
  phase: Phase = "draft";
  title = "live";

  publish(): void {
    // later: this.phase = "archived";
    if (this.phase === "draft") this.phase = "live";
  }

  archive(): void {
    switch (this.phase) {
      case "live":
        this.phase = "archived";
        break;
    }
  }
}
`,
    );
    const { patch, notes } = await draftStates(dir, "sym:src/post.ts#Phase");
    expect(graph(patch)).toEqual([
      "phase-states:1 draft -> phase-states:2",
      "phase-states:2 draft>live -> phase-states:3",
      "phase-states:3 live -> phase-states:4",
      "phase-states:4 live>archived -> phase-states:5",
      "phase-states:5 archived -> ",
    ]);
    expect(step(patch, "phase-states:2")?.anchors).toEqual([
      { file: "src/post.ts", symbol: "Post.publish", span: { from: 2, to: 2 }, role: "usage" },
    ]);
    expect(step(patch, "phase-states:3")?.summary).toBe(
      "TODO: what this state means, in one plain sentence (set in `Post.publish`; tested in `Post.archive`).",
    );
    // not the comment in `publish`
    expect(step(patch, "phase-states:5")?.summary).toBe(
      "TODO: what this state means, in one plain sentence (set in `Post.archive`; no test found).",
    );
    expect(notes).toEqual([
      "never tested (no comparison in the code reads it, so it looks like an end state): `archived`",
      "a transition is drafted only where one function tests a state and then sets another, matched in its text: check each in the code, and add the moves the draft missed",
      "the uses come from heuristic references: check each in the code",
    ]);
  });

  it("reads React state and refs declared with the union: the setter sets, the value and `.current` are tested", async () => {
    const dir = makeTempDir("xpl-states-react-");
    writeFile(dir, "package.json", '{ "name": "ed" }\n');
    writeFile(
      dir,
      "src/Editor.tsx",
      `import { useRef, useState } from "react";

type Mode = "view" | "edit";

export function Editor() {
  const [mode, setMode] = useState<Mode>("view");
  const last = useRef<Mode>("view");
  function open() {
    if (mode === "view") setMode("edit");
  }
  function close() {
    if (last.current === "edit") {
      last.current = "view";
    }
  }
  return <button onClick={open}>{mode}</button>;
}
`,
    );
    const { patch } = await draftStates(dir, "sym:src/Editor.tsx#Mode");
    expect(graph(patch)).toEqual([
      "mode-states:1 view -> mode-states:2",
      "mode-states:2 view>edit -> mode-states:3",
      "mode-states:3 edit -> mode-states:4",
      "mode-states:4 edit>view -> mode-states:1",
    ]);
    expect(flow(patch).participants).toEqual([
      "sym:src/Editor.tsx#Mode",
      "sym:src/Editor.tsx#Editor.open",
      "sym:src/Editor.tsx#Editor.close",
    ]);
  });

  it("maps a Python Enum: a guard that raises reads as the state it guards", async () => {
    const dir = makeTempDir("xpl-states-py-");
    writeFile(
      dir,
      "jobs.py",
      `from enum import Enum, auto


class State(Enum):
    """Where a job is: State.DONE when it ran."""

    QUEUED = "queued"
    RUNNING = auto()
    DONE = "done"
    FAILED = "failed"


class Job:
    def __init__(self):
        self.state = State.QUEUED

    def start(self):
        if self.state is not State.QUEUED:
            raise ValueError("not queued")
        self.state = State.RUNNING

    def finish(self, ok):
        if self.state == State.RUNNING:
            self.state = State.DONE if ok else State.FAILED
        else:
            self.state = State.QUEUED
`,
    );
    const { patch, notes } = await draftStates(dir, "sym:jobs.py#State");
    expect(graph(patch)).toEqual([
      "state-states:1 QUEUED -> state-states:2",
      "state-states:2 QUEUED>RUNNING -> state-states:3",
      "state-states:3 RUNNING -> state-states:4, state-states:5",
      "state-states:4 RUNNING>DONE -> state-states:6",
      "state-states:5 RUNNING>FAILED -> state-states:7",
      "state-states:6 DONE -> ",
      "state-states:7 FAILED -> ",
    ]);
    expect(step(patch, "state-states:2")?.anchors).toEqual([
      { file: "jobs.py", symbol: "Job.start", span: { from: 1, to: 1 }, role: "usage" },
      { file: "jobs.py", symbol: "Job.start", span: { from: 3, to: 3 }, role: "usage" },
    ]);
    expect(step(patch, "state-states:3")?.anchors?.[0]).toEqual({
      file: "jobs.py",
      symbol: "State.RUNNING",
      role: "definition",
    });
    expect(notes).toEqual([
      "never tested (no comparison in the code reads them, so they look like end states): `DONE` and `FAILED`",
      "a transition is drafted only where one function tests a state and then sets another, matched in its text: check each in the code, and add the moves the draft missed",
      "the uses come from heuristic references: check each in the code",
    ]);
  });

  // a negated guard fixes the state for the rest of its function, so the moves inside the if/elif/else
  // after it count; a state the code tests but never leaves gets a note
  it("finds the moves after a guard that raises, inside an if/elif/else, and names a tested state with no move out", async () => {
    const dir = makeTempDir("xpl-states-guard-");
    writeFile(
      dir,
      "status.py",
      `from enum import Enum


class JobStatus(Enum):
    WAITING = "waiting"
    RUNNING = "running"
    BACKING_OFF = "backing_off"
    DONE = "done"
    DEAD = "dead"


class Tracker:
    def __init__(self) -> None:
        self.status: JobStatus = JobStatus.WAITING

    def start(self) -> None:
        if self.status is JobStatus.WAITING:
            self.status = JobStatus.RUNNING

    def finish(self, ok: bool, retries_left: int) -> None:
        if self.status != JobStatus.RUNNING:
            raise ValueError("not running")
        if ok:
            self.status = JobStatus.DONE
        elif retries_left > 0:
            self.status = JobStatus.BACKING_OFF
        else:
            self.status = JobStatus.DEAD

    def pause(self) -> None:
        if self.status is JobStatus.BACKING_OFF:
            return
        self.status = JobStatus.WAITING
`,
    );
    const { patch, notes } = await draftStates(dir, "sym:status.py#JobStatus");
    const moves = graph(patch)
      .map((line) => line.split(" ")[1]!)
      .filter((name) => name.includes(">"));
    expect(moves).toEqual([
      "WAITING>RUNNING",
      "RUNNING>BACKING_OFF",
      "RUNNING>DONE",
      "RUNNING>DEAD",
    ]);
    expect(notes).toContain(
      "BACKING_OFF: no move out of it found; check `Tracker.pause` and add the moves the draft missed",
    );
    expect(notes).toContain(
      "never tested (no comparison in the code reads them, so they look like end states): `DONE` and `DEAD`",
    );
  });

  it("maps a Go type with a const block of its values", async () => {
    const dir = makeTempDir("xpl-states-go-");
    writeFile(dir, "go.mod", "module jobs\n\ngo 1.22\n");
    writeFile(
      dir,
      "job.go",
      `package jobs

type Status int

const (
	Queued Status = iota
	Running
	Done
)

const Limit = 3

type Job struct {
	Status Status
}

func (j *Job) Start() {
	switch j.Status {
	case Queued:
		j.Status = Running
	}
}

func (j *Job) Finish() {
	if j.Status == Running {
		j.Status = Done
	}
}
`,
    );
    const { patch } = await draftStates(dir, "sym:job.go#Status");
    expect(graph(patch)).toEqual([
      "status-states:1 Queued -> status-states:2",
      "status-states:2 Queued>Running -> status-states:3",
      "status-states:3 Running -> status-states:4",
      "status-states:4 Running>Done -> status-states:5",
      "status-states:5 Done -> ",
    ]);
  });

  it("refuses an entry that does not enumerate states", async () => {
    const dir = makeTempDir("xpl-states-no-");
    writeFile(dir, "package.json", '{ "name": "jobs" }\n');
    writeFile(
      dir,
      "src/status.ts",
      'export enum Status {\n  Queued = "queued",\n  Done = "done",\n}\n',
    );
    writeFile(dir, "src/job.ts", TS_JOB);
    writeFile(dir, "src/kinds.ts", 'export type Kind = "a" | Other;\nexport type Other = "b";\n');
    writeFile(dir, "src/shape.ts", "export interface Shape {\n  name: string;\n}\n");
    expect((await xpl(dir, "index", "--precise", "off")).code).toBe(0);
    expect((await xpl(dir, "new", "s")).code).toBe(0);
    const cls = await xpl(dir, "draft", "states", "s", "sym:src/job.ts#Job");
    expect([cls.code, cls.err.trim()]).toEqual([
      1,
      "error: nothing to draft: sym:src/job.ts#Job (a class) does not enumerate states: the entry must be a TypeScript enum or union of string literals, a Python Enum class, or a Go type with a const block of its values. `xpl outline --kind enum,type` lists candidates. No status type? When the state is where the data sits (which list or table holds it), draft the data map (`xpl draft data`) and write the flow by hand.",
    ]);
    const union = await xpl(dir, "draft", "states", "s", "sym:src/kinds.ts#Kind");
    expect(union.code).toBe(1);
    expect(union.err).toContain("sym:src/kinds.ts#Kind (a type) does not enumerate states");
    const shape = await xpl(dir, "draft", "states", "s", "sym:src/shape.ts#Shape");
    expect(shape.err).toContain("sym:src/shape.ts#Shape (an interface) does not enumerate states");
    expect(shape.err).toContain("`xpl outline --kind enum,type` lists candidates");
    // a near name is offered only when the command takes its kind (not the interface Shape)
    const typo = await xpl(dir, "draft", "states", "s", "sym:src/shape.ts#Shapes");
    expect(typo.code).toBe(1);
    expect(typo.err).not.toContain("Did you mean");
    expect(typo.err).toContain("`xpl outline --kind enum,type` lists candidates.");
  });

  // a Python Enum is a class in the index, so `outline --kind enum` lists none: the hint says what works
  it("refuses a Python class that is no Enum with a hint that works for Python, and the route for a state with no enum", async () => {
    const dir = makeTempDir("xpl-states-pyno-");
    writeFile(dir, "jobs.py", "class Job:\n    def __init__(self):\n        self.ready = []\n");
    expect((await xpl(dir, "index", "--precise", "off")).code).toBe(0);
    expect((await xpl(dir, "new", "s")).code).toBe(0);
    const r = await xpl(dir, "draft", "states", "s", "sym:jobs.py#Job");
    expect(r.code).toBe(1);
    expect(r.err).toContain('`xpl search "(Enum)"` finds the Enum classes.');
    expect(r.err).toContain("draft the data map (`xpl draft data`) and write the flow by hand");
    expect(r.err).not.toContain("outline --kind enum");
  });
});
