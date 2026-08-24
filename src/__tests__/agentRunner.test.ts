import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { writeFileSync, readFileSync, existsSync, mkdirSync, rmSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { killActiveWorkers, parseTrace, readStderrTail, resetWorkerAbort, runWorker } from "../agentRunner.ts";
import type { RunContext, Role, RolePolicy } from "../types.ts";

const FAKE_WORKER = join(import.meta.dirname, "fixtures", "fakeWorker.mjs");
const LONG_WORKER = join(import.meta.dirname, "fixtures", "longWorker.mjs");

// ---- Shared fixtures ----

function makeCtx(overrides: Partial<RunContext> = {}): RunContext {
  return {
    runId: "test-run-123",
    rootDir: "/repo",
    runDir: "/repo/.runs/test-run-123",
    worktreeDir: "/repo/.runs/test-run-123/worktree",
    tracesDir: "/repo/.runs/test-run-123/traces",
    branch: "fix/test-branch",
    dryRun: false,
    issue: {
      repo: "owner/repo",
      number: 42,
      title: "Test issue",
      body: "Reproduce the bug",
      url: "https://github.com/owner/repo/issues/42",
      state: "open",
      labels: [],
      author: "dev",
    },
    repoUrl: "git@github.com:owner/repo.git",
    ...overrides,
  };
}

function makePolicy(overrides: Partial<RolePolicy> = {}): RolePolicy {
  return {
    role: "coder" as Role,
    model: "opencode/laguna-s-2.1-free",
    fallbacks: ["opencode/deepseek-v4-flash-free"],
    ...overrides,
  };
}

let tmpTraceDir: string;
let savedEnv: Record<string, string | undefined>;

beforeEach(() => {
  tmpTraceDir = join(tmpdir(), "opencode-test-" + Date.now() + "-" + Math.random().toString(36).slice(2, 8));
  mkdirSync(tmpTraceDir, { recursive: true });
  savedEnv = {};
  for (const key of [
    "FLEET_WORKER_ENTRY",
    "FAKE_FAIL_PROVIDERS",
    "FLEET_PROVIDERS",
    "WORKER_TIMEOUT_MS",
    "WORKER_TIMEOUT_GRACE_MS",
    "GEMINI_API_KEY",
    "OPENROUTER_API_KEY",
  ]) {
    savedEnv[key] = process.env[key];
    delete process.env[key];
  }
  resetWorkerAbort();
});

afterEach(() => {
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  rmSync(tmpTraceDir, { recursive: true, force: true });
});

/** Real temp ctx dirs: the manager forks with cwd = ctx.rootDir, which must exist. */
function makeRealCtx(): RunContext {
  const root = mkdtempSync(join(tmpdir(), "rw-fork-"));
  const runDir = join(root, ".runs", "test-run-123");
  return makeCtx({
    rootDir: root,
    runDir,
    worktreeDir: join(runDir, "worktree"),
    tracesDir: join(runDir, "traces"),
  });
}

function writeTrace(name: string, content: string): string {
  const path = join(tmpTraceDir, name);
  writeFileSync(path, content, "utf8");
  return path;
}

// ---- runWorker tests (fork + stdin-job contract against a fake worker entry) ----

describe("runWorker", () => {
  it("stubs workers on dryRun without touching the DB or forking", async () => {
    const dir = mkdtempSync(join(tmpdir(), "rw-"));
    const runDir = join(dir, ".runs", "test-run-123");
    const ctx = makeCtx({
      runDir,
      worktreeDir: join(runDir, "worktree"),
      tracesDir: join(runDir, "traces"),
      dryRun: true,
    });
    // No FLEET_WORKER_ENTRY configured: any fork would target the real worker
    // entry and fail loudly — the stub must short-circuit before that.
    const result = await runWorker("coder", "Fix the bug", ctx, makePolicy(), {});
    expect(result.ok).toBe(true);
    expect(result.text).toContain("[dry-run]");
    expect(result.provider).toBe("gemini");
    expect(result.attempts).toEqual([{ model: "opencode/laguna-s-2.1-free", ok: true, provider: "gemini" }]);
    rmSync(dir, { recursive: true, force: true });
  });

  it("forks ONE JSON job into the worker and reads the answer back from the redirected trace stream", async () => {
    process.env.FLEET_WORKER_ENTRY = FAKE_WORKER;
    process.env.FLEET_PROVIDERS = "ollama";
    const ctx = makeRealCtx();
    const res = await runWorker("coder", "Fix the bug #42", ctx, makePolicy(), {});

    expect(res.ok).toBe(true);
    expect(res.provider).toBe("ollama");
    expect(res.sessionID).toBe("sess-fake-1");
    expect(res.model).toBe("fake-model");
    expect(res.text).toContain("hello from ollama re: Fix the bug #42");
    expect(res.tokens.input).toBe(3);
    expect(res.attempts).toEqual([{ model: "fake-model", ok: true, provider: "ollama" }]);
    // stdio fd redirect: the worker's NDJSON landed in tracesDir/<role>.jsonl
    const trace = readFileSync(join(ctx.tracesDir, "coder.jsonl"), "utf8");
    expect(trace).toContain('"t":"init"');
    expect(trace).toContain('"t":"result"');
  }, 30000);

  it("threads opts.extraTask through the job ctx verbatim", async () => {
    process.env.FLEET_WORKER_ENTRY = FAKE_WORKER;
    process.env.FLEET_PROVIDERS = "ollama";
    const ctx = makeRealCtx();
    const res = await runWorker("coder", "base task", ctx, makePolicy(), {
      extraTask: "reviewer findings: fix flaky test",
    });
    expect(res.ok).toBe(true);
    expect(res.text).toContain("[extra: reviewer findings: fix flaky test]");
  }, 30000);

  it("walks FLEET_PROVIDERS on runtime failure and records every attempt with its provider", async () => {
    process.env.FLEET_WORKER_ENTRY = FAKE_WORKER;
    process.env.FLEET_PROVIDERS = "gemini,ollama";
    process.env.GEMINI_API_KEY = "dummy-key-for-walk-test";
    process.env.FAKE_FAIL_PROVIDERS = "gemini";
    const ctx = makeRealCtx();
    const res = await runWorker("coder", "walk me", ctx, makePolicy(), {});

    expect(res.ok).toBe(true);
    expect(res.attempts).toEqual([
      { model: "fake-model", ok: false, error: "synthetic failure on gemini", provider: "gemini" },
      { model: "fake-model", ok: true, provider: "ollama" },
    ]);
    expect(res.provider).toBe("ollama");
    expect(res.text).toContain("hello from ollama re: walk me");
  }, 30000);

  it("fails fast with a synthetic attempt when no candidate provider has keys", async () => {
    process.env.FLEET_WORKER_ENTRY = FAKE_WORKER;
    process.env.FLEET_PROVIDERS = "gemini";
    delete process.env.GEMINI_API_KEY;
    const ctx = makeRealCtx();
    const res = await runWorker("coder", "never forked", ctx, makePolicy(), {});

    expect(res.ok).toBe(false);
    expect(res.error).toBe("no provider keys configured");
    expect(res.attempts).toEqual([{ model: "none", ok: false, error: "no provider keys configured" }]);
    expect(existsSync(join(ctx.tracesDir, "coder.jsonl"))).toBe(false);
  });

  it("killActiveWorkers SIGTERMs the live fork and latches fail-fast ('aborted by user')", async () => {
    process.env.FLEET_WORKER_ENTRY = LONG_WORKER;
    process.env.FLEET_PROVIDERS = "gemini";
    process.env.GEMINI_API_KEY = "dummy-key-for-abort-test";
    const ctx = makeRealCtx();

    const pending = runWorker("coder", "task", ctx, makePolicy(), {});
    let killed = 0;
    for (let i = 0; i < 600 && killed === 0; i++) {
      await new Promise((resolve) => setTimeout(resolve, 25));
      killed = killActiveWorkers();
    }
    expect(killed).toBeGreaterThan(0);

    const started = Date.now();
    const res = await pending;
    const elapsed = Date.now() - started;

    expect(res.ok).toBe(false);
    expect(res.sawError).toBe(true);
    expect(res.error).toBe("aborted by user");
    expect(res.attempts).toEqual([
      { model: "opencode/laguna-s-2.1-free", ok: false, error: "aborted by user", provider: "gemini" },
    ]);
    expect(elapsed).toBeLessThan(10000);
  }, 30000);
});

// ---- parseTrace tests ----

describe("parseTrace", () => {
  it("returns empty defaults when trace file does not exist", () => {
    const result = parseTrace(join(tmpTraceDir, "nonexistent.jsonl"), {}, 0);
    expect(result.text).toBe("");
    expect(result.sessionID).toBeNull();
    expect(result.sawError).toBe(false);
    expect(result.costUsd).toBe(0);
    expect(result.tokens.input).toBe(0);
  });

  it("accumulates text from multiple text events", () => {
    const tracePath = writeTrace("trace1.jsonl", [
      JSON.stringify({ t: "text", part: { text: "Hello " } }),
      JSON.stringify({ t: "text", part: { text: "World" } }),
    ].join("\n"));
    const result = parseTrace(tracePath, {}, 0);
    expect(result.text).toBe("Hello World");
  });

  it("extracts sessionID from the first init event that has one", () => {
    const tracePath = writeTrace("trace2.jsonl", [
      JSON.stringify({ t: "text", part: { text: "hi" } }),
      JSON.stringify({ t: "init", role: "coder", sessionId: "sess-1" }),
      JSON.stringify({ t: "init", role: "coder", sessionId: "sess-2" }),
    ].join("\n"));
    const result = parseTrace(tracePath, {}, 0);
    expect(result.sessionID).toBe("sess-1");
  });

  it("extracts the model from the first init event that has one", () => {
    const tracePath = writeTrace("trace11.jsonl", [
      JSON.stringify({ t: "init", role: "coder", model: "qwen2.5-coder:7b", sessionId: "sess-m" }),
      JSON.stringify({ t: "init", role: "coder", model: "other-model", sessionId: "sess-m2" }),
    ].join("\n"));
    const result = parseTrace(tracePath, {}, 0);
    expect(result.model).toBe("qwen2.5-coder:7b");
  });

  it("sums tokens from step_finish usage events and tracks cached separately", () => {
    const tracePath = writeTrace("trace3.jsonl", [
      JSON.stringify({ t: "step_finish", usage: { input: 10, output: 5, reasoning: 2, cached: 100, cacheWrite: 0, total: 117 }, costUsd: 0.01 }),
      JSON.stringify({ t: "step_finish", usage: { input: 20, output: 8, reasoning: 0, cached: 50, cacheWrite: 0, total: 78 }, costUsd: 0.02 }),
    ].join("\n"));
    const result = parseTrace(tracePath, {}, 0);
    expect(result.tokens.input).toBe(30);
    expect(result.tokens.output).toBe(13);
    expect(result.tokens.reasoning).toBe(2);
    expect(result.tokens.cached).toBe(150);
    expect(result.tokens.cacheWrite).toBe(0);
    expect(result.tokens.total).toBe(195);
    expect(result.costUsd).toBeCloseTo(0.03, 10);
  });

  it("handles missing/empty usage gracefully (defaults to 0)", () => {
    const tracePath = writeTrace("trace4.jsonl", [
      JSON.stringify({ t: "step_finish" }),
      JSON.stringify({ t: "step_finish", usage: undefined }),
      JSON.stringify({ t: "step_finish", usage: {} }),
    ].join("\n"));
    const result = parseTrace(tracePath, {}, 0);
    expect(result.tokens.input).toBe(0);
    expect(result.costUsd).toBe(0);
  });

  it("ignores tool_call/tool_result events for text and error state", () => {
    const tracePath = writeTrace("trace6.jsonl", [
      JSON.stringify({ t: "tool_call", name: "bash", input: "ls -la" }),
      JSON.stringify({ t: "tool_result", name: "bash", ok: true, ms: 12, bytesOut: 4096 }),
    ].join("\n"));
    const result = parseTrace(tracePath, {}, 0);
    expect(result.text).toBe("");
    expect(result.sawError).toBe(false);
    expect(result.errorMsg).toBeUndefined();
  });

  it("detects error events and keeps the last error message", () => {
    const tracePath = writeTrace("trace5.jsonl", [
      JSON.stringify({ t: "text", part: { text: "partial work" } }),
      JSON.stringify({ t: "error", error: "Something went wrong" }),
      JSON.stringify({ t: "error", error: "Final failure" }),
    ].join("\n"));
    const result = parseTrace(tracePath, {}, 0);
    expect(result.sawError).toBe(true);
    expect(result.errorMsg).toBe("Final failure");
  });

  it("coerces object error payloads to a JSON string", () => {
    const tracePath = writeTrace("trace12.jsonl", [
      JSON.stringify({ t: "error", error: { message: "x" } }),
    ].join("\n"));
    const result = parseTrace(tracePath, {}, 0);
    expect(result.sawError).toBe(true);
    expect(typeof result.errorMsg).toBe("string");
    expect(result.errorMsg).toBe('{"message":"x"}');
  });

  it("skips non-JSON lines (noise)", () => {
    const tracePath = writeTrace("trace7.jsonl", [
      "Some log noise\n",
      JSON.stringify({ t: "text", part: { text: "valid" } }),
      "Another noise line\n",
      JSON.stringify({ t: "text", part: { text: " text" } }),
    ].join("\n"));
    const result = parseTrace(tracePath, {}, 0);
    expect(result.text).toBe("valid text");
  });

  it("only consumes the t-keyed wire schema and ignores legacy type-keyed lines", () => {
    const tracePath = writeTrace("trace10.jsonl", [
      JSON.stringify({ type: "text", part: { text: "legacy" } }),
      JSON.stringify({ type: "init", sessionId: "legacy-sess" }),
      JSON.stringify({ t: "text", part: { text: "current" } }),
      JSON.stringify({ t: "init", sessionId: "sess-current" }),
    ].join("\n"));
    const result = parseTrace(tracePath, {}, 0);
    expect(result.text).toBe("current");
    expect(result.sessionID).toBe("sess-current");
  });

  it("respects startOffset (only parses content after offset)", () => {
    const line1 = JSON.stringify({ t: "text", part: { text: "before" } });
    const line2 = JSON.stringify({ t: "text", part: { text: "after" } });
    const content = line1 + "\n" + line2 + "\n";
    const tracePath = writeTrace("trace8.jsonl", content);
    const result = parseTrace(tracePath, {}, line1.length + 1);
    expect(result.text).toBe("after");
  });

  it("handles empty trace file", () => {
    const tracePath = writeTrace("trace9.jsonl", "");
    const result = parseTrace(tracePath, {}, 0);
    expect(result.text).toBe("");
    expect(result.sawError).toBe(false);
  });
});

// ---- readStderrTail tests ----

describe("readStderrTail", () => {
  it("returns empty string when file does not exist", () => {
    expect(readStderrTail(join(tmpTraceDir, "nope.log"))).toBe("");
  });

  it("returns the last 400 characters trimmed", () => {
    const longMessage = "X".repeat(500) + "tail"; // 504 chars total
    const path = writeTrace("stderr.log", longMessage);
    const result = readStderrTail(path);
    expect(result.length).toBe(400);
    // last 400 chars = 396 X's + "tail"
    expect(result).toBe("X".repeat(396) + "tail");
  });

  it("trims trailing whitespace", () => {
    const path = writeTrace("stderr2.log", "some error   \n\n  ");
    const result = readStderrTail(path);
    expect(result).toBe("some error");
  });

  it("returns entire content if under 400 chars", () => {
    const path = writeTrace("stderr3.log", "short error");
    const result = readStderrTail(path);
    expect(result).toBe("short error");
  });
});
