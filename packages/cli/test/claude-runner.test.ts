import { spawn } from "node:child_process";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import { randomUUID, createHash } from "node:crypto";
import { chmodSync, existsSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { artifactIdentity } from "@xpl/core";
import { claudeRunner } from "../src/claude-runner.js";
import { createCtx } from "../src/context.js";
import { openJobs } from "../src/jobs.js";
import { loadExplainer, openWorkspace } from "../src/repo.js";
import { appendRequest } from "../src/requests.js";
import {
  cloneDir,
  indexedFixture,
  makeTempDir,
  applyStdin,
  readFile,
  readJson,
  writeFile,
  xpl,
  writeViewerStub,
} from "./helpers.js";

let demo: string;
beforeAll(async () => {
  demo = await indexedFixture();
  expect((await xpl(demo, "new", "demo")).code).toBe(0);
  expect(
    (
      await applyStdin(demo, {
        nodes: [{ id: "file:src/queue.ts", summary: "Queue holds pending jobs." }],
        views: [
          {
            id: "view:queue",
            type: "graph",
            title: "Queue",
            scope: { root: "repo", depth: 1 },
            edgeKinds: [],
            stubs: { mode: "none" },
            include: ["file:src/queue.ts"],
          },
        ],
      })
    ).code,
  ).toBe(0);
  expect((await xpl(demo, "ready", "demo")).code).toBe(0);
});

async function setup(body: string, creation = false) {
  const root = cloneDir(demo);
  if (creation) expect((await xpl(root, "new", "creation")).code).toBe(0);
  const name = creation ? "creation" : "demo";
  const tooling = makeTempDir();
  const skillDir = join(tooling, "skill");
  const files = {
    "SKILL.md": "Installed code-explainer instructions",
    "bin/xpl": "installed launcher",
  };
  for (const [file, text] of Object.entries(files)) writeFile(skillDir, file, text);
  writeFile(
    skillDir,
    "xpl-install.json",
    JSON.stringify({
      version: "0.0.0",
      cli: process.execPath,
      files: Object.fromEntries(
        Object.entries(files).map(([p, s]) => [p, createHash("sha256").update(s).digest("hex")]),
      ),
    }),
  );
  const executable = writeFile(
    tooling,
    "claude",
    `#!${process.execPath}\nimport fs from 'node:fs';\nconst args=process.argv.slice(2);\nconst prompt=fs.readFileSync(0,'utf8');\nconst output=JSON.parse(prompt.match(/^Output: (.+)$/m)[1]);\nfs.writeFileSync(process.env.STUB_CAPTURE,JSON.stringify({args,prompt,cwd:process.cwd(),output,pid:process.pid}));\n${body}\n`,
  );
  chmodSync(executable, 0o755);
  const ctx = createCtx(
    { out() {}, err() {} },
    {
      root,
      cwd: root,
      env: { ...process.env, PATH: tooling, STUB_CAPTURE: join(tooling, "capture.json") },
      json: true,
      indexOption: undefined,
    },
  );
  const loaded = loadExplainer(ctx, name);
  const ws = await openWorkspace(ctx, { explainer: loaded });
  const request = (
    await appendRequest(root, {
      id: "request-original",
      elementId: "file:src/queue.ts",
      kind: "correct",
      note: "Explain the queued job.",
      explainer: name,
      context: artifactIdentity(loaded.explainer, ws.index),
    })
  ).request;
  const instanceId = randomUUID();
  writeFile(
    root,
    ".explainer/service/instance.json",
    JSON.stringify({ schema: "xpl-service-instance@1", root, instanceId, state: "running" }),
  );
  return { root, tooling, skillDir, ctx, instanceId, request, name };
}

const valid = `fs.writeFileSync(output,JSON.stringify([{id:'request-original',patch:{nodes:[{id:'file:src/queue.ts',summary:'Stores jobs until a worker claims them.'}]}}]));\nconsole.log(JSON.stringify({type:'result',is_error:false,result:'Proposal written'}));`;

describe("configured Claude adapter (stub executable, no provider)", () => {
  it.each([
    "normal exit",
    "rate-limit exit",
    "timeout",
    "cancelled",
    "superseded",
    "service stop",
    "parent death",
    "recovery",
    "detached inherited pipe",
    "identity read failure",
    "cleanup deadline",
    "shutdown cleanup deadline",
  ])("bounds attempt cleanup after %s and fences any unsafe retry", async (guard) => {
    const body = [
      "const {spawn}=await import('node:child_process');",
      "const active=(pid)=>{try{return !/\\) Z /.test(fs.readFileSync('/proc/'+pid+'/stat','utf8'));}catch{return false;}};",
      "if(fs.existsSync(process.env.STUB_RETRY)){",
      "const prior=JSON.parse(fs.readFileSync(process.env.STUB_PRIOR,'utf8'));",
      "const capture=JSON.parse(fs.readFileSync(process.env.STUB_CAPTURE,'utf8'));",
      "fs.writeFileSync(process.env.STUB_CAPTURE,JSON.stringify({...capture,overlap:[prior.pid,prior.grandchild].some(active)}));",
      valid,
      "}else{",
      `const grandchild=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:${guard === "detached inherited pipe" ? "'inherit',detached:true" : "'ignore'"}});`,
      "const capture=JSON.parse(fs.readFileSync(process.env.STUB_CAPTURE,'utf8'));",
      "fs.writeFileSync(process.env.STUB_CAPTURE,JSON.stringify({...capture,grandchild:grandchild.pid}));",
      "grandchild.unref();",
      ...(guard === "normal exit"
        ? [valid, "process.exit(0);}"]
        : guard === "rate-limit exit"
          ? ["console.error('Rate limit 429');process.exit(2);}"]
          : ["setInterval(()=>{},1000);}"]),
    ].join("\n");
    const { root, tooling, skillDir, ctx, request } = await setup(body);
    unlinkSync(join(root, ".explainer/service/instance.json"));
    // Inject the external filesystem failure in the actual service process, not our own modules.
    const preload = writeFile(
      tooling,
      "process-failure.mjs",
      [
        "import fs from 'node:fs/promises';import {writeFileSync,existsSync} from 'node:fs';",
        "import {syncBuiltinESMExports} from 'node:module';",
        "const original=fs.readFile;let launcher;",
        "fs.readFile=async function(path,...args){",
        "const match=String(path).match(/^\\/proc\\/(\\d+)\\/stat$/);",
        "if(process.env.STUB_IDENTITY_FAILURE && match && Number(match[1])!==process.pid && !launcher){launcher=Number(match[1]);writeFileSync(process.env.STUB_LAUNCHER,JSON.stringify({pid:launcher,grandchild:0}));}",
        "if(path==='/proc/sys/kernel/random/boot_id' && launcher && !existsSync(process.env.STUB_RETRY)){const error=new Error('EACCES: injected boot identity read failure');error.code='EACCES';throw error;}",
        "if(path==='/proc/sys/kernel/random/boot_id' && existsSync(process.env.STUB_CLEANUP_HANG))return new Promise(()=>{});",
        "return original.call(this,path,...args);};syncBuiltinESMExports();",
      ].join("\n"),
    );
    const env = {
      ...ctx.env,
      PATH: tooling + ":" + process.env.PATH,
      XPL_VIEWER_HTML: writeViewerStub(),
      STUB_RETRY: join(tooling, "retry"),
      STUB_PRIOR: join(tooling, "prior.json"),
      STUB_LAUNCHER: join(tooling, "launcher.json"),
      STUB_CLEANUP_HANG: join(tooling, "cleanup-hang"),
      ...(guard === "identity read failure" ? { STUB_IDENTITY_FAILURE: "1" } : {}),
    };
    const start = (recover = false) =>
      spawn(
        process.execPath,
        [
          "--import",
          preload,
          "--import",
          "tsx",
          fileURLToPath(new URL("../src/main.ts", import.meta.url)),
          "service",
          "start",
          "demo",
          "--root",
          root,
          "--port",
          "0",
          "--backend",
          "claude",
          "--skill-dir",
          skillDir,
          "--job-timeout",
          ["timeout", "detached inherited pipe", "cleanup deadline"].includes(guard) ? "1" : "30",
          ...(recover ? ["--recover"] : []),
        ],
        { env, stdio: "ignore" },
      );
    const active = (pid: number) => {
      try {
        return !/\) Z /.test(readFile("/proc", String(pid) + "/stat"));
      } catch {
        return false;
      }
    };
    const ready = async (pid: number) => {
      await expect
        .poll(
          () => {
            try {
              const instance = readJson(root, ".explainer/service/instance.json");
              return instance.pid === pid && instance.state === "running" ? instance.url : null;
            } catch {
              return null;
            }
          },
          { timeout: 10000 },
        )
        .toMatch(/^http:\/\/127\.0\.0\.1:/);
      return readJson(root, ".explainer/service/instance.json").url as string;
    };
    const service = start();
    let recovered: ReturnType<typeof start> | undefined;
    let capture: { pid: number; grandchild: number } | undefined;
    let groupId: number | undefined;
    try {
      const url = await ready(service.pid!);
      const id = randomUUID();
      const response = await fetch(new URL("/api/jobs", url), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id, selectedRequestIds: [request.id] }),
      });
      expect(response.status).toBe(200);
      const captureFile = guard === "identity read failure" ? "launcher.json" : "capture.json";
      await expect
        .poll(
          () => {
            try {
              return readJson(tooling, captureFile).grandchild;
            } catch {
              return null;
            }
          },
          { timeout: 10000 },
        )
        .toBeTypeOf("number");
      capture = readJson(tooling, captureFile);
      writeFile(tooling, "prior.json", JSON.stringify(capture));
      const attempt = readJson(root, ".explainer/service/jobs.json").jobs[0];
      groupId = attempt.owner.process?.groupId ?? capture!.pid;
      let currentUrl = url;
      const crashed = guard === "parent death" || guard === "recovery";
      if (guard.includes("cleanup deadline")) {
        writeFile(tooling, "cleanup-hang", "hold the process identity read during cleanup");
        process.kill(groupId!, "SIGSTOP");
      }
      if (crashed) {
        if (guard === "recovery") process.kill(groupId!, "SIGSTOP");
        const exited = once(service, "exit");
        service.kill("SIGKILL");
        await exited;
        if (guard === "parent death") {
          await expect
            .poll(() => [active(capture!.pid), active(capture!.grandchild)])
            .toEqual([false, false]);
        }
        recovered = start(true);
        currentUrl = await ready(recovered.pid!);
      } else if (guard === "cancelled" || guard === "superseded") {
        const fenced = await fetch(
          new URL("/api/jobs/" + id + "/" + (guard === "cancelled" ? "cancel" : "supersede"), url),
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: "{}",
          },
        );
        expect(fenced.status).toBe(200);
      }
      if (guard === "service stop" || guard === "shutdown cleanup deadline") {
        const stopped = await fetch(new URL("/api/service/stop", url), {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: "Bearer " + readJson(root, ".explainer/service/instance.json").token,
          },
          body: "{}",
        });
        expect(stopped.status).toBe(200);
        await expect
          .poll(() => service.exitCode ?? service.signalCode, { timeout: 5000 })
          .not.toBeNull();
        if (guard === "shutdown cleanup deadline") {
          const failed = readJson(root, ".explainer/service/jobs.json").jobs[0];
          expect(failed.state).toBe("failed");
          expect(failed.cleanup).toEqual(failed.owner.process);
          expect(active(groupId!)).toBe(true);
          unlinkSync(join(tooling, "cleanup-hang"));
        }
        recovered = start();
        currentUrl = await ready(recovered.pid!);
      }
      const terminal =
        crashed || guard === "service stop"
          ? "interrupted"
          : guard === "normal exit"
            ? "completed"
            : guard === "cancelled" || guard === "superseded"
              ? guard
              : "failed";
      await expect
        .poll(() => readJson(root, ".explainer/service/jobs.json").jobs[0].state, {
          timeout: 10000,
        })
        .toBe(terminal);
      // A terminal receipt must already be drained; polling for death here hides early finalization.
      if (guard === "cleanup deadline") {
        expect(active(groupId!)).toBe(true);
      } else if (guard === "detached inherited pipe") {
        expect(active(capture!.pid)).toBe(false);
        expect(active(capture!.grandchild)).toBe(true); // It escaped the group; held pipes cannot delay teardown.
        process.kill(capture!.grandchild, "SIGKILL");
        await expect.poll(() => active(capture!.grandchild)).toBe(false);
      } else {
        expect([active(capture!.pid), active(capture!.grandchild)]).toEqual([false, false]);
      }
      const finished = readJson(root, ".explainer/service/jobs.json").jobs[0];
      if (guard === "identity read failure") {
        expect(finished.owner.process).toBeUndefined();
        expect(finished.error).toContain("EACCES");
        expect(existsSync(join(tooling, "capture.json"))).toBe(false); // Claude never started.
      } else {
        expect(finished.owner.process).toEqual({
          groupId,
          startTime: expect.stringMatching(/^[a-f0-9-]{36}:\d+$/),
        });
      }
      if (guard === "cleanup deadline") {
        expect(finished.error).toContain("JOB_PROCESS_CLEANUP");
        expect(finished.error).toContain(String(groupId));
        expect(finished.error).toContain("verified");
        expect(finished.cleanup).toEqual(finished.owner.process);
        const blocked = await fetch(new URL("/api/jobs/" + id + "/retry", currentUrl), {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ expectedAttempt: 1 }),
        });
        expect(blocked.status).toBe(503);
        expect(readJson(root, ".explainer/service/jobs.json").jobs[0].attempt).toBe(1);
        const stopped = await fetch(new URL("/api/service/stop", currentUrl), {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: "Bearer " + readJson(root, ".explainer/service/instance.json").token,
          },
          body: "{}",
        });
        expect(stopped.status).toBe(200);
        await expect
          .poll(() => service.exitCode ?? service.signalCode, { timeout: 5000 })
          .not.toBeNull();
        unlinkSync(join(tooling, "cleanup-hang"));
        recovered = start(true);
        currentUrl = await ready(recovered.pid!);
        expect([active(groupId!), active(capture!.pid), active(capture!.grandchild)]).toEqual([
          false,
          false,
          false,
        ]);
        expect(readJson(root, ".explainer/service/jobs.json").jobs[0].cleanup).toBeUndefined();
      }
      if (guard === "rate-limit exit") {
        expect(finished.error).toContain("Claude is rate limited");
        expect(finished.error).toContain("Claude exit code 2");
      }
      if (guard === "timeout") expect(finished.error).toContain("timed out after 1000 ms");
      writeFile(tooling, "retry", "retry");
      const retryable = terminal === "failed" || terminal === "interrupted";
      const nextId = retryable ? id : randomUUID();
      const retry = await fetch(
        new URL(retryable ? "/api/jobs/" + id + "/retry" : "/api/jobs", currentUrl),
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(
            retryable ? { expectedAttempt: 1 } : { id: nextId, selectedRequestIds: [request.id] },
          ),
        },
      );
      expect(retry.status).toBe(200);
      const next = () =>
        readJson(root, ".explainer/service/jobs.json").jobs.find(
          (j: { id: string }) => j.id === nextId,
        );
      await expect.poll(() => next().state, { timeout: 10000 }).toBe("completed");
      expect(readJson(tooling, "capture.json").overlap).toBe(false);
      expect(next().attempt).toBe(retryable ? 2 : 1);
      expect(readJson(root, ".explainer/requests.json")[0].outcome.status).toBe("pending");
      // In particular, a failed identity read must not leave an unstarted launcher holding stop open.
      const runningService = recovered ?? service;
      const stopped = await fetch(new URL("/api/service/stop", currentUrl), {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: "Bearer " + readJson(root, ".explainer/service/instance.json").token,
        },
        body: "{}",
      });
      expect(stopped.status).toBe(200);
      await expect
        .poll(() => runningService.exitCode ?? runningService.signalCode, { timeout: 5000 })
        .not.toBeNull();
    } finally {
      for (const child of [service, recovered])
        if (child && child.exitCode === null && child.signalCode === null) {
          const exited = once(child, "exit");
          child.kill("SIGKILL");
          await exited;
        }
      // Also clean up the orphan on the red run, including a stopped process.
      for (const pid of [groupId, capture?.pid, capture?.grandchild])
        if (pid) {
          try {
            process.kill(-pid, "SIGKILL");
          } catch {}
          try {
            process.kill(pid, "SIGKILL");
          } catch {}
        }
    }
  });

  it("writes a validated reviewable revision without changing the guide or outcomes", async () => {
    const { root, ctx, skillDir, tooling, instanceId, request } = await setup(valid);
    const original = readFile(root, ".explainer/demo.explainer.json");
    const jobs = await openJobs(ctx, instanceId, claudeRunner(ctx, { skillDir }));
    try {
      const submitted = await jobs.submit("demo", {
        id: randomUUID(),
        selectedRequestIds: [request.id],
      });
      await expect
        .poll(async () => {
          const current = await jobs.get("demo", submitted.id);
          return { state: current.state, error: current.error };
        })
        .toEqual({ state: "completed", error: null });
      const journal = readJson(
        root,
        `.explainer/revisions/${submitted.input.revisionRunId}/run.json`,
      );
      expect(journal.state).toBe("proposed");
      expect(journal.serviceJob.id).toBe(submitted.id);
      const completed = await jobs.get("demo", submitted.id);
      expect(
        (
          await jobs.review("demo", submitted.id, {
            attemptId: completed.owner!.attemptId,
            decisions: [{ id: request.id, status: "addressed", reason: "Checked the proposal." }],
          })
        ).state,
      ).toBe("reviewed");
      await jobs.fence("demo", submitted.id, "superseded");
      const accepted = await xpl(
        root,
        "revise",
        "demo",
        "--run",
        submitted.input.revisionRunId,
        "--accept",
      );
      expect(accepted.code).toBe(1);
      expect(accepted.err).toContain("manual --accept cannot bypass cancellation or supersession");
      expect(journal.proposals[0].patch.nodes[0].summary).toBe(
        "Stores jobs until a worker claims them.",
      );
      expect(readFile(root, ".explainer/demo.explainer.json")).toBe(original);
      expect(readJson(root, ".explainer/requests.json")[0].outcome.status).toBe("pending");
      const capture = readJson(tooling, "capture.json");
      expect(capture.args).toContain("--print");
      expect(capture.args).toContain("--restricted");
      expect(capture.args[capture.args.indexOf("--permission-mode") + 1]).toBe("dontAsk");
      expect(capture.args[capture.args.indexOf("--tools") + 1]).toBe("Read,Glob,Grep,Write");
      const settings = JSON.parse(capture.args[capture.args.indexOf("--settings") + 1]);
      expect(settings.disableAllHooks).toBe(true);
      expect(settings.permissions.allow).toEqual([`Edit(/${capture.output})`]);
      expect(capture.cwd).not.toBe(root);
      expect(capture.prompt).toContain(skillDir);
    } finally {
      await jobs.close();
    }
  });

  it("creates a guide proposal from an initialized empty guide through the same revision journal", async () => {
    const body = `fs.writeFileSync(output,JSON.stringify([{id:'request-original',patch:{nodes:[{id:'file:src/queue.ts',summary:'Stores jobs until a worker claims them.'}],views:[{id:'view:creation',type:'graph',title:'Queue',scope:{root:'repo',depth:1},edgeKinds:[],stubs:{mode:'none'},include:['file:src/queue.ts']}]}}]));console.log(JSON.stringify({is_error:false,result:'Creation proposal written'}));`;
    const { root, ctx, skillDir, instanceId, request, name } = await setup(body, true);
    const original = readFile(root, ".explainer/creation.explainer.json");
    const jobs = await openJobs(ctx, instanceId, claudeRunner(ctx, { skillDir }));
    try {
      const job = await jobs.submit(name, {
        id: randomUUID(),
        selectedRequestIds: [request.id],
        include: ["view:creation"],
      });
      await expect
        .poll(async () => {
          const current = await jobs.get(name, job.id);
          return { state: current.state, error: current.error };
        })
        .toEqual({ state: "completed", error: null });
      const journal = readJson(root, `.explainer/revisions/${job.input.revisionRunId}/run.json`);
      expect(journal.previous.views).toEqual([]);
      expect(journal.proposals[0].patch.views[0].id).toBe("view:creation");
      expect(journal.state).toBe("proposed");
      expect(readFile(root, ".explainer/creation.explainer.json")).toBe(original);
    } finally {
      await jobs.close();
    }
  });

  it.each([
    ["plain authentication error", `console.log('Not logged in');`, "Claude authentication failed"],
    [
      "malformed output",
      `fs.writeFileSync(output,'{invalid');console.log('{}');`,
      "proposal contains invalid JSON",
    ],
    [
      "authentication",
      `console.log(JSON.stringify({is_error:true,result:'Not logged in: 401'}));`,
      "Claude authentication failed",
    ],
    ["rate limit", `console.error('Rate limit 429');process.exitCode=1;`, "Claude is rate limited"],
    [
      "missing output",
      `console.log(JSON.stringify({is_error:false,result:'Could not write'}));`,
      "produced no proposal file",
    ],
    [
      "wrong selection",
      `fs.writeFileSync(output,JSON.stringify([{id:'unselected',patch:{}}]));console.log('{}');`,
      "one proposal per selected request",
    ],
    [
      "invalid anchor",
      `fs.writeFileSync(output,JSON.stringify([{id:'request-original',patch:{nodes:[{id:'file:src/queue.ts',anchors:[{file:'missing.ts',span:{from:1,to:2}}]}]}}]));console.log('{}');`,
      "revision patch rejected",
    ],
    [
      "scope escape",
      `fs.writeFileSync(output,JSON.stringify([{id:'request-original',patch:{nodes:[{id:'file:src/worker.ts',summary:'Out of scope.'}]}}]));console.log('{}');`,
      "outside its selected scope",
    ],
    [
      "unfinished output",
      `fs.writeFileSync(output,JSON.stringify([{id:'request-original',patch:{nodes:[{id:'file:src/queue.ts',summary:'TODO explain this'}]}}]));console.log('{}');`,
      "not ready for review",
    ],
    [
      "symlink output",
      `fs.symlinkSync(process.env.STUB_CAPTURE,output);console.log('{}');`,
      "regular owned file",
    ],
  ])(
    "reports %s as a failed job without modifying guide or outcomes",
    async (_name, body, message) => {
      const { root, ctx, skillDir, instanceId, request } = await setup(body);
      const original = readFile(root, ".explainer/demo.explainer.json");
      const requests = readFile(root, ".explainer/requests.json");
      const jobs = await openJobs(ctx, instanceId, claudeRunner(ctx, { skillDir }));
      try {
        const job = await jobs.submit("demo", {
          id: randomUUID(),
          selectedRequestIds: [request.id],
        });
        await expect.poll(async () => (await jobs.get("demo", job.id)).state).toBe("failed");
        expect((await jobs.get("demo", job.id)).error).toContain(message);
        expect((await jobs.get("demo", job.id)).result).toBeNull();
        expect(readFile(root, ".explainer/demo.explainer.json")).toBe(original);
        expect(readFile(root, ".explainer/requests.json")).toBe(requests);
      } finally {
        await jobs.close();
      }
    },
  );

  it("fails when Claude is absent from PATH instead of guessing authentication from version", async () => {
    const { root, ctx, skillDir, tooling, instanceId, request } = await setup(valid);
    unlinkSync(join(tooling, "claude"));
    const jobs = await openJobs(ctx, instanceId, claudeRunner(ctx, { skillDir }));
    try {
      const job = await jobs.submit("demo", { id: randomUUID(), selectedRequestIds: [request.id] });
      await expect.poll(async () => (await jobs.get("demo", job.id)).state).toBe("failed");
      expect((await jobs.get("demo", job.id)).error).toContain("not installed on PATH");
      expect(readJson(root, `.explainer/revisions/${job.input.revisionRunId}/run.json`).state).toBe(
        "selected",
      );
    } finally {
      await jobs.close();
    }
  });

  it.each(["cancelled", "superseded", "timeout"] as const)(
    "kills %s child and never journals its already written output",
    async (action) => {
      const { root, ctx, skillDir, tooling, instanceId, request } = await setup(
        valid + "\nsetInterval(()=>{},1000);",
      );
      const jobs = await openJobs(
        ctx,
        instanceId,
        claudeRunner(ctx, { skillDir, timeoutMs: action === "timeout" ? 1000 : 5000 }),
      );
      try {
        const job = await jobs.submit("demo", {
          id: randomUUID(),
          selectedRequestIds: [request.id],
        });
        await expect.poll(() => existsSync(join(tooling, "capture.json"))).toBe(true);
        const capture = readJson(tooling, "capture.json");
        await expect.poll(() => existsSync(capture.output)).toBe(true);
        if (action === "timeout") {
          // Observe the configured deadline before checking death; a one-second poll would race it.
          await expect
            .poll(async () => (await jobs.get("demo", job.id)).state, { timeout: 3000 })
            .toBe("failed");
        } else await jobs.fence("demo", job.id, action);
        await expect
          .poll(() => {
            try {
              process.kill(capture.pid, 0);
              return false;
            } catch {
              return true;
            }
          })
          .toBe(true);
        const stored = await jobs.get("demo", job.id);
        expect(stored.result).toBeNull();
        if (action === "timeout") {
          expect(stored.error).toContain("timed out after 1000 ms");
        } else expect(stored.state).toBe(action);
        await expect.poll(() => existsSync(capture.cwd)).toBe(false);
        expect(
          readJson(root, `.explainer/revisions/${job.input.revisionRunId}/run.json`).state,
        ).toBe("selected");
      } finally {
        await jobs.close();
      }
    },
  );
});
