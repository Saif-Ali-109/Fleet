import { describe, it, expect, afterAll } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { createServer, type Server, type IncomingMessage, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ENTRY = fileURLToPath(new URL("../runtime/worker/main.ts", import.meta.url));

interface WireLine {
  t: string;
  [k: string]: unknown;
}

interface RunHandle {
  codePromise: Promise<number | null>;
  lines: WireLine[];
  waitFor(pred: (ev: WireLine) => boolean): Promise<WireLine>;
  child: ChildProcess;
}

function baseEnv(extra: Record<string, string>): NodeJS.ProcessEnv {
  const env = { ...process.env, ...extra };
  delete env.GEMINI_API_KEY;
  delete env.OPENROUTER_API_KEY;
  return env;
}

function runWorker(job: unknown, env: NodeJS.ProcessEnv): RunHandle {
  const lines: WireLine[] = [];
  const waiters: Array<{ pred: (ev: WireLine) => boolean; resolve: (ev: WireLine) => void }> = [];
  const child = spawn(process.execPath, ["--import", "tsx", ENTRY], {
    env,
    stdio: ["pipe", "pipe", "pipe"],
  });
  let pending = "";
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    pending += chunk;
    let nl: number;
    while ((nl = pending.indexOf("\n")) !== -1) {
      const line = pending.slice(0, nl);
      pending = pending.slice(nl + 1);
      if (!line.trim()) continue;
      let ev: WireLine;
      try {
        ev = JSON.parse(line);
      } catch {
        continue;
      }
      lines.push(ev);
      for (let i = waiters.length - 1; i >= 0; i--) {
        if (waiters[i]!.pred(ev)) {
          waiters[i]!.resolve(ev);
          waiters.splice(i, 1);
        }
      }
    }
  });
  const codePromise = new Promise<number | null>((resolve) => {
    child.on("close", (code) => resolve(code));
  });
  child.stdin.write(JSON.stringify(job) + "\n");
  child.stdin.end();
  return {
    codePromise,
    lines,
    child,
    waitFor(pred: (ev: WireLine) => boolean): Promise<WireLine> {
      const found = lines.find(pred);
      if (found) return Promise.resolve(found);
      return new Promise((resolve) => waiters.push({ pred, resolve }));
    },
  };
}

function makeJobCtx(root: string): Record<string, unknown> {
  return {
    rootDir: root,
    worktreeDir: root,
    tracesDir: join(root, "traces"),
    runDir: join(root, "run"),
    dryRun: false,
  };
}

const completionsServers: Server[] = [];

afterAll(() => {
  for (const server of completionsServers) server.close();
});

/** OpenAI-compatible /v1/chat/completions stub; `responder` builds the JSON body per request. */
function startCompletionsStub(
  responder: () => Record<string, unknown>,
  delayMs = 0,
): Promise<string> {
  return new Promise((resolve) => {
    const server = createServer((req: IncomingMessage, res: ServerResponse) => {
      let body = "";
      req.on("data", (chunk: Buffer) => {
        body += chunk.toString("utf8");
      });
      req.on("end", () => {
        setTimeout(() => {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify(responder()));
        }, delayMs);
      });
    });
    completionsServers.push(server);
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      resolve(`http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : 0}/v1`);
    });
  });
}

const textCompletion = (text: string): Record<string, unknown> => ({
  id: "chatcmpl-stub",
  object: "chat.completion",
  created: 1700000000,
  model: "stub",
  choices: [
    {
      index: 0,
      message: { role: "assistant", content: text },
      finish_reason: "stop",
    },
  ],
  usage: { prompt_tokens: 11, completion_tokens: 7, total_tokens: 18 },
});

const toolCallCompletion = (): Record<string, unknown> => ({
  id: "chatcmpl-stub-tool",
  object: "chat.completion",
  created: 1700000000,
  model: "stub",
  choices: [
    {
      index: 0,
      message: {
        role: "assistant",
        content: null,
        tool_calls: [
          {
            id: "call_1",
            type: "function",
            function: { name: "read", arguments: JSON.stringify({ path: "README.md" }) },
          },
        ],
      },
      finish_reason: "tool_calls",
    },
  ],
  usage: {},
});

describe("worker main.ts fork e2e", () => {
  it("dryRun job emits canned events, exits 0, and never touches the network", async () => {
    const root = mkdtempSync(join(tmpdir(), "wk-dry-"));
    try {
      const run = runWorker(
        {
          role: "tester",
          task: "Run tests",
          ctx: { ...makeJobCtx(root), dryRun: true },
        },
        baseEnv({
          FLEET_PROVIDERS: "ollama",
          OLLAMA_BASE_URL: "http://127.0.0.1:9/v1",
        }),
      );
      const code = await run.codePromise;
      expect(code).toBe(0);
      expect(run.lines.map((ev) => ev.t)).toEqual(["init", "text", "result", "step_finish"]);
      const init = run.lines[0]!;
      expect(init.role).toBe("tester");
      expect(init.provider).toBe("ollama");
      expect(typeof init.model).toBe("string");
      expect(typeof init.sessionId).toBe("string");
      const finish = run.lines[3]!;
      expect(finish.usage).toEqual({
        input: 0,
        output: 0,
        reasoning: 0,
        cached: 0,
        cacheWrite: 0,
        total: 0,
      });
      expect(finish.costUsd).toBe(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 30000);

  it("provider-backed job against a local OpenAI-compatible stub runs to result + step_finish, exit 0", async () => {
    const root = mkdtempSync(join(tmpdir(), "wk-live-"));
    const baseUrl = await startCompletionsStub(() => textCompletion("hello from stub"));
    try {
      const run = runWorker(
        {
          role: "coder",
          task: "Fix the bug",
          ctx: makeJobCtx(root),
        },
        baseEnv({
          FLEET_PROVIDERS: "ollama",
          OLLAMA_BASE_URL: baseUrl,
        }),
      );
      const code = await run.codePromise;
      expect(code).toBe(0);
      expect(run.lines.map((ev) => ev.t)).toEqual(["init", "text", "result", "step_finish"]);
      const init = run.lines[0]!;
      expect(init.role).toBe("coder");
      expect(init.provider).toBe("ollama");
      expect(init.model).toBe("qwen2.5-coder:7b");
      expect(run.lines[2]).toEqual({ t: "result", text: "hello from stub" });
      const finish = run.lines[3] as unknown as { usage: Record<string, number>; costUsd: number };
      expect(finish.usage.input).toBe(11);
      expect(finish.usage.output).toBe(7);
      expect(finish.usage.total).toBe(18);
      expect(finish.costUsd).toBe(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 30000);

  it("fails promptly when Gemini reservation IPC is unavailable", async () => {
    const root = mkdtempSync(join(tmpdir(), "wk-quota-ipc-"));
    try {
      const started = Date.now();
      const run = runWorker(
        {
          role: "coder",
          task: "Do not call the model",
          ctx: makeJobCtx(root),
        },
        baseEnv({
          FLEET_PROVIDERS: "gemini",
          GEMINI_API_KEY: "dummy-key",
        }),
      );
      const code = await run.codePromise;
      expect(code).not.toBe(0);
      expect(Date.now() - started).toBeLessThan(5000);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 30000);

  it("SIGTERM mid-run produces an error event and a nonzero exit", async () => {
    const root = mkdtempSync(join(tmpdir(), "wk-abort-"));
    writeFileSync(join(root, "README.md"), "# stub\n", "utf8");
    const baseUrl = await startCompletionsStub(toolCallCompletion, 400);
    try {
      const run = runWorker(
        {
          role: "coder",
          task: "Do work",
          ctx: makeJobCtx(root),
        },
        baseEnv({
          FLEET_PROVIDERS: "ollama",
          OLLAMA_BASE_URL: baseUrl,
        }),
      );
      await run.waitFor((ev) => ev.t === "init");
      run.child.kill("SIGTERM");
      const code = await run.codePromise;
      expect(code).not.toBe(0);
      const errors = run.lines.filter((ev) => ev.t === "error");
      expect(errors.length).toBeGreaterThan(0);
      expect(typeof errors[errors.length - 1]!.error).toBe("string");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 30000);

  it("malformed job stdin yields an error event and nonzero exit without any model call", async () => {
    const run = runWorker({ bogus: true }, baseEnv({ FLEET_PROVIDERS: "ollama" }));
    const code = await run.codePromise;
    expect(code).not.toBe(0);
    expect(run.lines.map((ev) => ev.t)).toEqual(["error"]);
  }, 30000);
});
