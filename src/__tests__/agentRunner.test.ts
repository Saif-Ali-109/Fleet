import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { writeFileSync, mkdirSync, rmSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildArgs, parseTrace, readStderrTail, runWorker } from "../agentRunner.ts";
import type { RunContext, Role, RolePolicy } from "../types.ts";

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

beforeEach(() => {
  tmpTraceDir = join(tmpdir(), "opencode-test-" + Date.now() + "-" + Math.random().toString(36).slice(2, 8));
  mkdirSync(tmpTraceDir, { recursive: true });
});

afterEach(() => {
  rmSync(tmpTraceDir, { recursive: true, force: true });
});

function writeTrace(name: string, content: string): string {
  const path = join(tmpTraceDir, name);
  writeFileSync(path, content, "utf8");
  return path;
}

// ---- buildArgs tests ----

describe("buildArgs", () => {
  it("builds the generic provider run command (--role/--model/--provider/--task/--worktree)", () => {
    const ctx = makeCtx();
    const policy = makePolicy();
    const args = buildArgs("coder", "Fix the bug", ctx, "gemini-2.5-flash", policy, {});
    expect(args[0]).toBe("--role");
    expect(args[1]).toBe("coder");
    expect(args).toContain("--model");
    expect(args[args.indexOf("--model") + 1]).toBe("gemini-2.5-flash");
    expect(args).toContain("--provider");
    expect(args[args.indexOf("--provider") + 1]).toBe("gemini");
    expect(args).toContain("--worktree");
    expect(args[args.indexOf("--worktree") + 1]).toBe(ctx.worktreeDir);
    expect(args).toContain("--task");
    expect(args[args.indexOf("--task") + 1]).toBe("Fix the bug");
  });

  it("appends --variant when policy.variant is set", () => {
    const ctx = makeCtx();
    const policy = makePolicy({ variant: "high" });
    const args = buildArgs("planner", "Task", ctx, "m", policy, {});
    expect(args).toContain("--variant");
    expect(args[args.indexOf("--variant") + 1]).toBe("high");
  });

  it("opts.variant overrides policy.variant", () => {
    const ctx = makeCtx();
    const policy = makePolicy({ variant: "high" });
    const args = buildArgs("coder", "Task", ctx, "m", policy, { variant: "low" });
    expect(args[args.indexOf("--variant") + 1]).toBe("low");
  });

  it("does not add --variant when neither opts nor policy specify one", () => {
    const ctx = makeCtx();
    const policy = makePolicy();
    const args = buildArgs("coder", "Task", ctx, "m", policy, {});
    expect(args).not.toContain("--variant");
  });

  it("passes the task verbatim after --task (spaces intact)", () => {
    const ctx = makeCtx();
    const policy = makePolicy();
    const args = buildArgs("tester", "My special task with spaces", ctx, "m", policy, {});
    expect(args[args.indexOf("--task") + 1]).toBe("My special task with spaces");
  });

  it("adds --resume <sessionID> when opts.resumeSessionID is set", () => {
    const ctx = makeCtx();
    const policy = makePolicy();
    const args = buildArgs("coder", "Task", ctx, "m", policy, { resumeSessionID: "sess-42" });
    expect(args).toContain("--resume");
    expect(args[args.indexOf("--resume") + 1]).toBe("sess-42");
  });
});

// ---- runWorker tests ----

describe("runWorker", () => {
  it("stubs workers on dryRun without touching the DB", async () => {
    const dir = mkdtempSync(join(tmpdir(), "rw-"));
    const runDir = join(dir, ".runs", "test-run-123");
    const ctx = makeCtx({
      runDir,
      worktreeDir: join(runDir, "worktree"),
      tracesDir: join(runDir, "traces"),
      dryRun: true,
    });
    const result = await runWorker("coder", "Fix the bug", ctx, makePolicy(), {});
    expect(result.ok).toBe(true);
    expect(result.text).toContain("[dry-run]");
    expect(result.provider).toBe("gemini");
    expect(result.attempts).toEqual([{ model: "opencode/laguna-s-2.1-free", ok: true, provider: "gemini" }]);
    rmSync(dir, { recursive: true, force: true });
  });
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
      JSON.stringify({ type: "text", part: { text: "Hello " } }),
      JSON.stringify({ type: "text", part: { text: "World" } }),
    ].join("\n"));
    const result = parseTrace(tracePath, {}, 0);
    expect(result.text).toBe("Hello World");
  });

  it("extracts sessionID from the first init event that has one", () => {
    const tracePath = writeTrace("trace2.jsonl", [
      JSON.stringify({ type: "text", part: { text: "hi" } }),
      JSON.stringify({ type: "init", role: "coder", sessionId: "sess-1" }),
      JSON.stringify({ type: "init", role: "coder", sessionId: "sess-2" }),
    ].join("\n"));
    const result = parseTrace(tracePath, {}, 0);
    expect(result.sessionID).toBe("sess-1");
  });

  it("sums tokens from step_finish usage events and tracks cached separately", () => {
    const tracePath = writeTrace("trace3.jsonl", [
      JSON.stringify({ type: "step_finish", usage: { input: 10, output: 5, reasoning: 2, cached: 100, cacheWrite: 0, total: 117 }, costUsd: 0.01 }),
      JSON.stringify({ type: "step_finish", usage: { input: 20, output: 8, reasoning: 0, cached: 50, cacheWrite: 0, total: 78 }, costUsd: 0.02 }),
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
      JSON.stringify({ type: "step_finish" }),
      JSON.stringify({ type: "step_finish", usage: undefined }),
      JSON.stringify({ type: "step_finish", usage: {} }),
    ].join("\n"));
    const result = parseTrace(tracePath, {}, 0);
    expect(result.tokens.input).toBe(0);
    expect(result.costUsd).toBe(0);
  });

  it("ignores tool_call/tool_result events for text and error state", () => {
    const tracePath = writeTrace("trace6.jsonl", [
      JSON.stringify({ type: "tool_call", name: "bash", input: "ls -la" }),
      JSON.stringify({ type: "tool_result", name: "bash", ok: true, ms: 12, bytesOut: 4096 }),
    ].join("\n"));
    const result = parseTrace(tracePath, {}, 0);
    expect(result.text).toBe("");
    expect(result.sawError).toBe(false);
    expect(result.errorMsg).toBeUndefined();
  });

  it("detects error events and keeps the last error message", () => {
    const tracePath = writeTrace("trace5.jsonl", [
      JSON.stringify({ type: "text", part: { text: "partial work" } }),
      JSON.stringify({ type: "error", error: "Something went wrong" }),
      JSON.stringify({ type: "error", error: "Final failure" }),
    ].join("\n"));
    const result = parseTrace(tracePath, {}, 0);
    expect(result.sawError).toBe(true);
    expect(result.errorMsg).toBe("Final failure");
  });

  it("skips non-JSON lines (noise)", () => {
    const tracePath = writeTrace("trace7.jsonl", [
      "Some log noise\n",
      JSON.stringify({ type: "text", part: { text: "valid" } }),
      "Another noise line\n",
      JSON.stringify({ type: "text", part: { text: " text" } }),
    ].join("\n"));
    const result = parseTrace(tracePath, {}, 0);
    expect(result.text).toBe("valid text");
  });

  it("respects startOffset (only parses content after offset)", () => {
    const line1 = JSON.stringify({ type: "text", part: { text: "before" } });
    const line2 = JSON.stringify({ type: "text", part: { text: "after" } });
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
