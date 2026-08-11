import { describe, expect, it } from "vitest";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildBackendArgs,
  buildBackendEnv,
  parseBackendLine,
  parseBackendTrace,
  resolveRolePrompt,
  type BackendTrace,
} from "../runner/backends.js";
import type { Role, RolePolicy, RunContext } from "../types.js";

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

const empty = (): BackendTrace => ({
  text: "",
  sessionID: null,
  tokens: { input: 0, output: 0, reasoning: 0, total: 0 },
  costUsd: 0,
  sawError: false,
});

describe("buildBackendArgs", () => {
  it("builds opencode run args (unchanged)", () => {
    const ctx = makeCtx();
    const policy = makePolicy({ variant: "medium" });
    const { args, cwd } = buildBackendArgs("opencode", "analyzer", "Task", ctx, "opencode/big-pickle", policy, {}, "");
    expect(args[0]).toBe("run");
    expect(args[args.indexOf("--agent") + 1]).toBe("analyzer");
    expect(args[args.indexOf("--dir") + 1]).toBe(ctx.worktreeDir);
    expect(args).toContain("--variant");
    expect(cwd).toBe(ctx.rootDir);
  });

  it("builds claude print args with role prompt and permission mode", () => {
    const ctx = makeCtx();
    const { args, cwd } = buildBackendArgs("claude", "coder", "Task", ctx, "sonnet", makePolicy(), {}, "You are the CODER");
    expect(args[0]).toBe("-p");
    expect(args).toContain("--output-format");
    expect(args[args.indexOf("--output-format") + 1]).toBe("stream-json");
    expect(args).toContain("--model");
    expect(args[args.indexOf("--model") + 1]).toBe("sonnet");
    expect(args).toContain("--append-system-prompt");
    expect(args[args.indexOf("--append-system-prompt") + 1]).toBe("You are the CODER");
    expect(args).toContain("--permission-mode");
    expect(args[args.indexOf("--permission-mode") + 1]).toBe("acceptEdits");
    expect(cwd).toBe(ctx.worktreeDir);
  });

  it("uses plan permission mode for read-only claude roles", () => {
    const { args } = buildBackendArgs("claude", "reviewer", "Task", makeCtx(), "sonnet", makePolicy(), {}, "");
    expect(args[args.indexOf("--permission-mode") + 1]).toBe("plan");
  });

  it("builds codex exec args embedding the role prompt in the message", () => {
    const ctx = makeCtx();
    const { args, cwd } = buildBackendArgs("codex", "coder", "Task", ctx, "gpt-5.1-codex", makePolicy(), {}, "You are the CODER");
    expect(args[0]).toBe("exec");
    expect(args[args.indexOf("--cd") + 1]).toBe(ctx.worktreeDir);
    expect(args[args.indexOf("-m") + 1]).toBe("gpt-5.1-codex");
    expect(args[args.indexOf("-s") + 1]).toBe("workspace-write");
    expect(args).toContain("--json");
    expect(args).toContain("--approve-for-me");
    const last = args[args.length - 1];
    expect(last).toContain("You are the CODER");
    expect(last).toContain("Task");
    expect(cwd).toBe(ctx.worktreeDir);
  });

  it("uses read-only sandbox for codex read-only roles", () => {
    const { args } = buildBackendArgs("codex", "analyzer", "Task", makeCtx(), "gpt-5.1-codex", makePolicy(), {}, "");
    expect(args[args.indexOf("-s") + 1]).toBe("read-only");
  });

  it("uses danger-full-access sandbox for the pr role (network for gh)", () => {
    const { args } = buildBackendArgs("codex", "pr", "Task", makeCtx(), "gpt-5.1-codex", makePolicy(), {}, "");
    expect(args[args.indexOf("-s") + 1]).toBe("danger-full-access");
  });
});

describe("buildBackendEnv", () => {
  it("inherits the shell env for claude", () => {
    const env = buildBackendEnv("claude", makeCtx());
    expect(env).toHaveProperty("PATH");
  });

  it("inherits the shell env for codex", () => {
    const env = buildBackendEnv("codex", makeCtx());
    expect(env).toHaveProperty("PATH");
  });
});

describe("resolveRolePrompt", () => {
  it("returns empty string for opencode", () => {
    expect(resolveRolePrompt("opencode", "coder", makeCtx())).toBe("");
  });

  it("returns empty string when the role file is missing", () => {
    const ctx = makeCtx({ rootDir: "/does/not/exist" });
    expect(resolveRolePrompt("claude", "coder", ctx)).toBe("");
  });

  it("strips the YAML frontmatter block from agents/<role>.md", () => {
    const dir = mkdtempSync(join(tmpdir(), "rp-"));
    mkdirSync(join(dir, "agents"), { recursive: true });
    writeFileSync(
      join(dir, "agents", "coder.md"),
      "---\ndescription: Implementer\nmodel: opencode/laguna-s-2.1-free\n---\nYou are the CODER.\n",
      "utf8",
    );
    const ctx = makeCtx({ rootDir: dir });
    expect(resolveRolePrompt("claude", "coder", ctx)).toBe("You are the CODER.\n");
    rmSync(dir, { recursive: true, force: true });
  });
});

describe("parseBackendTrace (claude)", () => {
  it("accumulates assistant text and captures result usage/cost", () => {
    const acc = empty();
    parseBackendLine("claude", { type: "system", subtype: "init", session_id: "sess-1", model: "sonnet" }, acc);
    parseBackendLine("claude", { type: "assistant", message: { content: [{ type: "text", text: "Hello " }] } }, acc);
    parseBackendLine("claude", { type: "assistant", message: { content: [{ type: "text", text: "World" }] } }, acc);
    parseBackendLine(
      "claude",
      { type: "result", result: "Final", is_error: false, session_id: "sess-1", total_cost_usd: 0.05, usage: { input_tokens: 100, output_tokens: 50 } },
      acc,
    );
    expect(acc.text).toBe("Final");
    expect(acc.sessionID).toBe("sess-1");
    expect(acc.costUsd).toBe(0.05);
    expect(acc.tokens.input).toBe(100);
    expect(acc.tokens.output).toBe(50);
    expect(acc.sawError).toBe(false);
  });

  it("marks errors on a failed result", () => {
    const acc = empty();
    parseBackendLine("claude", { type: "result", is_error: true, error: "rate limited" }, acc);
    expect(acc.sawError).toBe(true);
    expect(acc.errorMsg).toBe("rate limited");
  });
});

describe("parseBackendTrace (codex)", () => {
  it("accumulates message text and result output + usage", () => {
    const acc = empty();
    parseBackendLine("codex", { type: "message", text: "partial " }, acc);
    parseBackendLine(
      "codex",
      { type: "result", result: "done", status: "success", usage: { input_tokens: 10, output_tokens: 20 } },
      acc,
    );
    expect(acc.text).toBe("partial done");
    expect(acc.tokens.input).toBe(10);
    expect(acc.tokens.output).toBe(20);
    expect(acc.sawError).toBe(false);
  });

  it("marks a failed status as an error", () => {
    const acc = empty();
    parseBackendLine("codex", { type: "result", status: "error", error: "failed" }, acc);
    expect(acc.sawError).toBe(true);
    expect(acc.errorMsg).toBe("failed");
  });
});

describe("parseBackendTrace (codex -o fallback)", () => {
  it("falls back to the lastmsg file when stdout yields no text", () => {
    const dir = mkdtempSync(join(tmpdir(), "codex-lastmsg-"));
    const lastmsgPath = join(dir, "coder.lastmsg");
    writeFileSync(lastmsgPath, "The fallback final answer.", "utf8");
    const t = parseBackendTrace("codex", "", 0, { lastmsgPath });
    expect(t.text).toBe("The fallback final answer.");
    rmSync(dir, { recursive: true, force: true });
  });

  it("does not overwrite stdout text when present", () => {
    const dir = mkdtempSync(join(tmpdir(), "codex-lastmsg2-"));
    const lastmsgPath = join(dir, "coder.lastmsg");
    writeFileSync(lastmsgPath, "fallback", "utf8");
    const t = parseBackendTrace("codex", JSON.stringify({ type: "result", result: "stdout answer" }) + "\n", 0, { lastmsgPath });
    expect(t.text).toBe("stdout answer");
    rmSync(dir, { recursive: true, force: true });
  });
});
