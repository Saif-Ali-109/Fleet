import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { writeFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildArgs, parseTrace, readStderrTail } from "../agentRunner.js";
import type { RunContext, Role, RolePolicy } from "../types.js";

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
      labels: [],
      author: "dev",
    },
    repoUrl: "git@github.com:owner/repo.git",
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
  it("builds the base opencode run command", () => {
    const ctx = makeCtx();
    const policy = makePolicy();
    const args = buildArgs("coder", "Fix the bug", ctx, "opencode/laguna-s-2.1-free", policy, {});
    expect(args[0]).toBe("run");
    expect(args).toContain("--agent");
    expect(args[args.indexOf("--agent") + 1]).toBe("coder");
    expect(args).toContain("-m");
    expect(args[args.indexOf("-m") + 1]).toBe("opencode/laguna-s-2.1-free");
    expect(args).toContain("--dir");
    expect(args[args.indexOf("--dir") + 1]).toBe(ctx.worktreeDir);
    expect(args).toContain("--format");
    expect(args[args.indexOf("--format") + 1]).toBe("json");
    expect(args[args.length - 1]).toBe("Fix the bug");
  });

  it("appends --variant when policy.variant is set", () => {
    const ctx = makeCtx();
    const policy = makePolicy({ variant: "high" });
    const args = buildArgs("planner", "Task", ctx, "opencode/big-pickle", policy, {});
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

  it("passes the task as the last argument (positional message)", () => {
    const ctx = makeCtx();
    const policy = makePolicy();
    const args = buildArgs("tester", "My special task with spaces", ctx, "m", policy, {});
    expect(args[args.length - 1]).toBe("My special task with spaces");
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

  it("extracts sessionID from the first event that has one", () => {
    const tracePath = writeTrace("trace2.jsonl", [
      JSON.stringify({ type: "text", part: { text: "hi" } }),
      JSON.stringify({ type: "event", sessionID: "sess-1", part: {} }),
      JSON.stringify({ type: "event", sessionID: "sess-2", part: {} }),
    ].join("\n"));
    const result = parseTrace(tracePath, {}, 0);
    expect(result.sessionID).toBe("sess-1");
  });

  it("sums tokens from step_finish events", () => {
    const tracePath = writeTrace("trace3.jsonl", [
      JSON.stringify({ type: "step_finish", part: { tokens: { input: 10, output: 5, reasoning: 2, total: 17 }, cost: 0.01 } }),
      JSON.stringify({ type: "step_finish", part: { tokens: { input: 20, output: 8, reasoning: 0, total: 28 }, cost: 0.02 } }),
    ].join("\n"));
    const result = parseTrace(tracePath, {}, 0);
    expect(result.tokens.input).toBe(30);
    expect(result.tokens.output).toBe(13);
    expect(result.tokens.reasoning).toBe(2);
    expect(result.tokens.total).toBe(45);
    expect(result.costUsd).toBe(0.03);
  });

  it("handles missing tokens gracefully (defaults to 0)", () => {
    const tracePath = writeTrace("trace4.jsonl", [
      JSON.stringify({ type: "step_finish", part: {} }),
      JSON.stringify({ type: "step_finish", part: { tokens: undefined } }),
    ].join("\n"));
    const result = parseTrace(tracePath, {}, 0);
    expect(result.tokens.input).toBe(0);
    expect(result.costUsd).toBe(0);
  });

  it("detects error events and extracts error message", () => {
    const tracePath = writeTrace("trace5.jsonl", [
      JSON.stringify({ type: "error", error: "Something went wrong" }),
    ].join("\n"));
    const result = parseTrace(tracePath, {}, 0);
    expect(result.sawError).toBe(true);
    expect(result.errorMsg).toBe("Something went wrong");
  });

  it("detects errors with part.type === 'error'", () => {
    const tracePath = writeTrace("trace6.jsonl", [
      JSON.stringify({ type: "tool_result", part: { type: "error", error: "Part error" } }),
    ].join("\n"));
    const result = parseTrace(tracePath, {}, 0);
    expect(result.sawError).toBe(true);
    expect(result.errorMsg).toBe("Part error");
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
