/**
 * `xpl live --backend api`: the live agent that sends one chat completion to an OpenAI-compatible endpoint and
 * answers with the patch it gets back. Every test talks to a fake endpoint on 127.0.0.1 (node:http); no provider
 * is called.
 */
import { createServer, type IncomingHttpHeaders } from "node:http";
import type { AddressInfo } from "node:net";
import { symlinkSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import type { Explainer } from "@xpl/core";
import { apiLiveAgent, type ApiConfig } from "../src/api-agent.js";
import { createCtx } from "../src/context.js";
import { openLive, type LiveRun } from "../src/live.js";
import { invoke, makeTempDir, readJson, writeFile, writeViewerStub } from "./helpers.js";
import { explanation, liveRepo, work } from "./live-repo.js";

const SKILL = resolve(fileURLToPath(import.meta.url), "../../../../skill/code-explainer");
const KEY = "sk-test-7f3a9c1e5b";

interface Seen {
  headers: IncomingHttpHeaders;
  body: {
    model: string;
    messages: { role: string; content: string }[];
  };
}

/** A fake chat completions endpoint: each request gets `reply(n)`, a status and a body. */
async function endpoint(
  reply: (n: number, seen: Seen) => { status?: number; body: unknown } | null,
) {
  const seen: Seen[] = [];
  const server = createServer((req, res) => {
    let text = "";
    req.on("data", (chunk: Buffer) => (text += chunk.toString()));
    req.on("end", () => {
      const request = { headers: req.headers, body: JSON.parse(text) } as Seen;
      seen.push(request);
      const answer = req.url === "/v1/chat/completions" ? reply(seen.length, request) : null;
      if (answer === null && req.url === "/v1/chat/completions") return; // never answers
      res.writeHead(answer ? (answer.status ?? 200) : 404, { "content-type": "application/json" });
      res.end(typeof answer?.body === "string" ? answer.body : JSON.stringify(answer?.body ?? {}));
    });
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  servers.push(server);
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
  return { url, seen };
}
const servers: ReturnType<typeof createServer>[] = [];
afterEach(() => {
  for (const server of servers.splice(0)) server.close();
});

/** A chat completion whose message is `content`. */
const completion = (content: string) => ({
  body: { choices: [{ index: 0, message: { role: "assistant", content } }] },
});
const fenced = (patch: unknown) =>
  completion(`Here is the patch.\n\n\`\`\`json\n${JSON.stringify(patch, null, 2)}\n\`\`\`\n`);

/** A live session on the changed repo whose agent is the api agent. */
async function session(config: Omit<ApiConfig, "model"> & { timeoutMs?: number }) {
  const dir = liveRepo();
  work(dir);
  const out: string[] = [];
  const ctx = createCtx(
    { out: (t) => out.push(t), err: (t) => out.push(t) },
    { root: dir, cwd: dir, env: process.env, json: false, indexOption: undefined },
  );
  const { timeoutMs, ...rest } = config;
  const live = await openLive(ctx, {
    name: "live",
    precise: "off",
    backend: "api",
    agent: apiLiveAgent(
      { model: "test-model", ...rest },
      { skillDir: SKILL, ...(timeoutMs ? { timeoutMs } : {}) },
    ),
    agentQuietMs: 0,
    signal: new AbortController().signal,
  });
  await live.cycle();
  return { dir, live, out };
}

const tour = (dir: string) =>
  readJson<Explainer>(dir, ".explainer/live.explainer.json").tours.find(
    (t) => t.id === "tour:live",
  );
const SUMMARY = "The change adds a file that returns a number. The runner does not call it yet.";

describe("xpl live --backend api", () => {
  it("sends the rules, the guide and the code in one request, and applies the patch it answers", async () => {
    const api = await endpoint(() => fenced(explanation(SUMMARY)));
    const { dir, live } = await session({ baseUrl: api.url, apiKey: KEY });
    expect(live.status().explanation).toMatchObject({ backend: "api", stale: true });
    await live.explain();
    expect(live.status().explanation).toMatchObject({ state: "idle", stale: false, error: null });
    expect(tour(dir)?.summary).toBe(SUMMARY);

    expect(api.seen).toHaveLength(1);
    const { headers, body } = api.seen[0]!;
    expect(headers.authorization).toBe(`Bearer ${KEY}`);
    expect(body.model).toBe("test-model");
    const [system, user] = body.messages;
    expect(system!.role).toBe("system");
    // the rules come from the skill folder: live.md, the writing rules and the patch format
    expect(system!.content).toContain("## The design level");
    expect(system!.content).toContain("# Writing for readers");
    expect(system!.content).toContain("### 3.9 Tour");
    expect(user!.role).toBe("user");
    // the guide, the code now and the code before the change
    expect(user!.content).toContain('"id": "view:system"');
    expect(user!.content).toContain("### src/extra.ts\n```\nexport function extra(): number {");
    expect(user!.content).toContain("return x.trim();");
    expect(user!.content).toMatch(/### src\/store\/memory\.ts \(before\)\n```\n[^`]*return x;/);
  });

  it("gives the lint findings of the first answer to the second request", async () => {
    const long =
      "The change adds a small file to the storage part that returns a number which the runner and the queue can both read again later on. The runner does not call it yet.";
    const api = await endpoint(() => fenced(explanation(long)));
    const { dir, live } = await session({ baseUrl: api.url, apiKey: KEY });
    await live.explain();
    expect(api.seen).toHaveLength(2);
    expect(api.seen[0]!.body.messages[1]!.content).not.toContain("Your previous patch");
    expect(api.seen[1]!.body.messages[1]!.content).toContain("tour:live summary (long-sentence)");
    expect(tour(dir)?.summary).toBe(long);
  });

  it("counts an answer that is not a JSON object as a failed try, and says so to the retry", async () => {
    const api = await endpoint((n) =>
      n === 1 ? completion("I am not able to write that patch.") : fenced(explanation(SUMMARY)),
    );
    const { dir, live } = await session({ baseUrl: api.url, apiKey: KEY });
    await live.explain();
    expect(api.seen).toHaveLength(2);
    expect(api.seen[1]!.body.messages[1]!.content).toContain(
      "- the answer holds no JSON object: answer with one xpl patch, a JSON object, in a ```json block",
    );
    expect(live.status().explanation.state).toBe("idle");
    expect(tour(dir)?.summary).toBe(SUMMARY);
  });

  it.each([
    [401, /HTTP 401.*XPL_LLM_API_KEY/],
    [429, /HTTP 429.*rate limit/],
    [500, /HTTP 500/],
  ])("reports HTTP %i as a failed run, without the key", async (status, message) => {
    const api = await endpoint(() => ({
      status,
      body: {
        error: { message: `Incorrect API key provided: ${KEY}. Authorization: Bearer ${KEY}` },
      },
    }));
    const { dir, live, out } = await session({ baseUrl: api.url, apiKey: KEY });
    const before = JSON.stringify(readJson(dir, ".explainer/live.explainer.json"));
    await live.explain();
    const explained = live.status().explanation;
    expect(explained.state).toBe("failed");
    expect(explained.error).toMatch(message);
    expect(explained.error).toContain("Incorrect API key provided");
    expect(JSON.stringify(live.status())).not.toContain(KEY);
    expect(out.join("\n")).not.toContain(KEY);
    expect(JSON.stringify(readJson(dir, ".explainer/live.explainer.json"))).toBe(before);
  });

  it("gives up on an endpoint that does not answer within the timeout", async () => {
    const api = await endpoint(() => null);
    const { live } = await session({ baseUrl: api.url, apiKey: KEY, timeoutMs: 300 });
    await live.explain();
    expect(live.status().explanation).toMatchObject({ state: "failed" });
    expect(live.status().explanation.error).toContain("did not answer within 0.3 s");
  });

  it("sends no key to an endpoint that needs none", async () => {
    const api = await endpoint(() => fenced(explanation(SUMMARY)));
    const { dir, live } = await session({ baseUrl: `${api.url}/` });
    await live.explain();
    expect(api.seen[0]!.headers.authorization).toBeUndefined();
    expect(tour(dir)?.summary).toBe(SUMMARY);
  });

  it("reads files through its tools, and never one outside the repository or behind a symlink out of it", async () => {
    const dir = liveRepo();
    const outside = makeTempDir("xpl-outside-");
    writeFile(outside, "secret.ts", "export const secret = 'do-not-send';\n");
    symlinkSync(join(outside, "secret.ts"), join(dir, "src/leak.ts"));
    const escapes = [
      `../${basename(outside)}/secret.ts`,
      join(outside, "secret.ts"),
      "src/leak.ts",
    ];
    const call = (id: string, name: string, args: unknown) => ({
      id,
      type: "function",
      function: { name, arguments: JSON.stringify(args) },
    });
    const api = await endpoint((n) =>
      n === 1
        ? {
            body: {
              choices: [
                {
                  index: 0,
                  finish_reason: "tool_calls",
                  message: {
                    role: "assistant",
                    content: null,
                    tool_calls: [
                      call("c1", "read_file", { path: "src/queue.ts" }),
                      call("c2", "list_files", { folder: "src" }),
                      call("c3", "search_text", { text: "do-not-send" }),
                      call("c4", "read_base_file", { path: "src/store/memory.ts" }),
                      ...escapes.map((path, i) => call(`e${i}`, "read_file", { path })),
                    ],
                  },
                },
              ],
            },
          }
        : fenced({}),
    );
    const ctx = createCtx(
      { out: () => {}, err: () => {} },
      { root: dir, cwd: dir, env: process.env, json: false, indexOption: undefined },
    );
    await (
      await openLive(ctx, {
        name: "live",
        precise: "off",
        backend: "none",
        agentQuietMs: 0,
        signal: new AbortController().signal,
      })
    ).cycle();
    const run: LiveRun = {
      root: dir,
      guidePath: join(dir, ".explainer/live.explainer.json"),
      base: null,
      change: undefined,
      before: {
        "src/store/memory.ts": "export function load(x: string): string {\n  return x;\n}\n",
      },
      findings: [],
      unassigned: [],
    };
    const agent = apiLiveAgent({ baseUrl: api.url, model: "m" }, { skillDir: SKILL });
    expect(await agent(run, new AbortController().signal)).toEqual({});
    expect(api.seen).toHaveLength(2);
    const results = new Map(
      api.seen[1]!.body.messages.filter((m) => m.role === "tool").map((m) => [
        (m as { tool_call_id?: string }).tool_call_id,
        m.content,
      ]),
    );
    expect(results.get("c1")).toContain("1: export interface Job {");
    expect(results.get("c2")).toContain("src/queue.ts\nsrc/runner.ts");
    expect(results.get("c3")).toBe('No line contains "do-not-send".');
    expect(results.get("c4")).toContain("return x;");
    for (const [i, path] of escapes.entries())
      expect(results.get(`e${i}`)).toBe(
        `No file "${path}": give a path of the repository relative to its root, as list_files prints it.`,
      );
    expect(JSON.stringify(api.seen)).not.toContain("do-not-send';");
  });
});

describe("xpl live --backend api, from the command line", () => {
  const env = { XPL_LLM_BASE_URL: "", XPL_LLM_MODEL: "", XPL_LLM_API_KEY: "" };

  it("refuses to start without an endpoint and a model, and names the variables", async () => {
    const dir = liveRepo();
    const r = await invoke(["live", "--once", "--backend", "api"], { cwd: dir, env });
    expect(r.code).toBe(2);
    expect(r.err).toContain("XPL_LLM_BASE_URL");
    expect(r.err).toContain("XPL_LLM_MODEL");
    const flags = await invoke(["live", "--once", "--model", "m"], { cwd: dir, env });
    expect(flags.code).toBe(2);
    expect(flags.err).toContain("--model and --base-url need --backend api");
  });

  it("--once explains the change with the key from the environment, and says where the code goes", async () => {
    const api = await endpoint(() => fenced(explanation(SUMMARY)));
    const dir = liveRepo();
    work(dir);
    const r = await invoke(
      ["live", "--once", "--precise", "off", "--backend", "api", "--skill-dir", SKILL],
      {
        cwd: dir,
        env: {
          ...env,
          XPL_LLM_BASE_URL: api.url,
          XPL_LLM_MODEL: "test-model",
          XPL_LLM_API_KEY: KEY,
          XPL_VIEWER_HTML: writeViewerStub(),
        },
      },
    );
    expect(r.err).toBe("");
    expect(r.code).toBe(0);
    expect(r.out).toContain(
      `live: --backend api sends the guide and the source code it explains to ${api.url} (model test-model)`,
    );
    expect(r.out).not.toContain(KEY);
    expect(api.seen[0]!.headers.authorization).toBe(`Bearer ${KEY}`);
    expect(tour(dir)?.summary).toBe(SUMMARY);
    expect((await invoke(["validate", "live"], { cwd: dir })).code).toBe(0);
  });
});
