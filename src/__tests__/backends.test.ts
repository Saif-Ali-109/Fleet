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
} from "../runner/backends.ts";
import type { Role, RolePolicy, RunContext } from "../types.ts";

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

const empty = (): BackendTrace => ({
  text: "",
  sessionID: null,
  tokens: { input: 0, output: 0, reasoning: 0, cached: 0, cacheWrite: 0, total: 0 },
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

  it("claude: passes --settings pointing at the .fleet settings.json", () => {
    const ctx = makeCtx();
    const { args } = buildBackendArgs("claude", "coder", "Task", ctx, "sonnet", makePolicy(), {}, "");
    expect(args).toContain("--settings");
    expect(args[args.indexOf("--settings") + 1]).toBe(join(ctx.rootDir, ".fleet", "claude", "settings.json"));
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

  it("opencode: inserts -s <sessionID> after --format json when resuming", () => {
    const ctx = makeCtx();
    const { args } = buildBackendArgs("opencode", "coder", "Task", ctx, "m", makePolicy(), { resumeSessionID: "sess-9" }, "");
    expect(args[args.indexOf("--format") + 1]).toBe("json");
    expect(args[args.indexOf("--format") + 2]).toBe("-s");
    expect(args[args.indexOf("--format") + 3]).toBe("sess-9");
    expect(args[args.length - 1]).toBe("Task");
  });

  it("claude: appends --fork-session --resume <id> when resuming", () => {
    const ctx = makeCtx();
    const { args } = buildBackendArgs("claude", "coder", "Task", ctx, "sonnet", makePolicy(), { resumeSessionID: "sess-9" }, "");
    expect(args[args.indexOf("--permission-mode") + 1]).toBe("acceptEdits");
    expect(args[args.indexOf("--permission-mode") + 2]).toBe("--fork-session");
    expect(args[args.indexOf("--fork-session") + 1]).toBe("--resume");
    expect(args[args.indexOf("--resume") + 1]).toBe("sess-9");
    expect(args[1]).toBe("Task");
  });

  it("codex: restructures argv to exec resume <id> ... when resuming", () => {
    const ctx = makeCtx();
    const { args } = buildBackendArgs("codex", "coder", "Task", ctx, "gpt-5.1-codex", makePolicy(), { resumeSessionID: "sess-9" }, "");
    expect(args[0]).toBe("exec");
    expect(args[1]).toBe("resume");
    expect(args[2]).toBe("sess-9");
    expect(args).toContain("--cd");
    expect(args[args.indexOf("--cd") + 1]).toBe(ctx.worktreeDir);
    const last = args[args.length - 1];
    expect(last).toContain("Task");
  });

  it("without resumeSessionID, args are unchanged from the fresh-spawn shape", () => {
    const ctx = makeCtx();
    for (const backend of ["opencode", "claude", "codex"] as const) {
      const { args } = buildBackendArgs(backend, "coder", "Task", ctx, "m", makePolicy(), {}, "");
      expect(args).not.toContain("--fork-session");
      expect(args).not.toContain("--resume");
      if (backend === "opencode") {
        expect(args).not.toContain("-s");
      }
      if (backend === "codex") {
        expect(args[0]).toBe("exec");
        expect(args[1]).toBe("--cd");
      }
    }
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

  it("sets SOR_EVENT_DIR to the runDir events dir for opencode", () => {
    const ctx = makeCtx();
    const env = buildBackendEnv("opencode", ctx);
    expect(env.SOR_EVENT_DIR).toBe(join(ctx.runDir, "events"));
    expect(env.SOR_EVENT_DIR?.endsWith("events")).toBe(true);
    expect(env.OPENCODE_CONFIG).toBe(join(ctx.rootDir, ".fleet", "opencode.json"));
  });

  it("sets SOR_EVENT_DIR for claude and codex too", () => {
    const ctx = makeCtx();
    for (const backend of ["claude", "codex"] as const) {
      const env = buildBackendEnv(backend, ctx);
      expect(env.SOR_EVENT_DIR).toBe(join(ctx.runDir, "events"));
      expect(env).toHaveProperty("PATH");
    }
  });

  it("points claude at its .fleet SOR hook", () => {
    const ctx = makeCtx();
    const env = buildBackendEnv("claude", ctx);
    expect(env.FLEET_SOR_HOOK).toBe(join(ctx.rootDir, ".fleet", "claude", "hooks", "sor-hook.sh"));
    expect(env.CODEX_HOME).toBeUndefined();
  });

  it("points codex at its .fleet SOR hook + CODEX_HOME", () => {
    const ctx = makeCtx();
    const env = buildBackendEnv("codex", ctx);
    expect(env.FLEET_SOR_HOOK).toBe(join(ctx.rootDir, ".fleet", "codex", "hooks", "sor-hook.sh"));
    expect(env.CODEX_HOME).toBe(join(ctx.rootDir, ".fleet", "codex"));
  });

  it("opencode has no FLEET_SOR_HOOK (its hook lives in the .fleet plugin)", () => {
    const env = buildBackendEnv("opencode", makeCtx());
    expect(env.FLEET_SOR_HOOK).toBeUndefined();
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

  it("codex appends .fleet skills; claude prompt stays skill-free", () => {
    const dir = mkdtempSync(join(tmpdir(), "rp-skills-"));
    try {
      mkdirSync(join(dir, "agents"), { recursive: true });
      writeFileSync(
        join(dir, "agents", "coder.md"),
        "---\ndescription: Implementer\n---\nYou are the CODER.\n",
        "utf8",
      );
      mkdirSync(join(dir, ".fleet", "opencode", "skills", "test-skill"), { recursive: true });
      writeFileSync(
        join(dir, ".fleet", "opencode", "skills", "test-skill", "SKILL.md"),
        "Use the test skill.\n",
        "utf8",
      );
      const ctx = makeCtx({ rootDir: dir });
      const codexPrompt = resolveRolePrompt("codex", "coder", ctx);
      expect(codexPrompt.startsWith("You are the CODER.\n")).toBe(true);
      expect(codexPrompt).toContain("\n\n# Available skills\n\n## test-skill\n\nUse the test skill.\n");
      const claudePrompt = resolveRolePrompt("claude", "coder", ctx);
      expect(claudePrompt).toBe("You are the CODER.\n");
      expect(claudePrompt).not.toContain("Available skills");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("codex skips the skills section entirely when no .fleet skills exist", () => {
    const dir = mkdtempSync(join(tmpdir(), "rp-noskills-"));
    try {
      mkdirSync(join(dir, "agents"), { recursive: true });
      writeFileSync(join(dir, "agents", "coder.md"), "---\ndescription: Implementer\n---\nYou are the CODER.\n", "utf8");
      const ctx = makeCtx({ rootDir: dir });
      expect(resolveRolePrompt("codex", "coder", ctx)).toBe("You are the CODER.\n");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
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
      { type: "result", result: "Final", is_error: false, session_id: "sess-1", total_cost_usd: 0.05, usage: { input_tokens: 100, output_tokens: 50, total_tokens: 200, cache_read_input_tokens: 20, cache_creation_input_tokens: 10 } },
      acc,
    );
    expect(acc.text).toBe("Final");
    expect(acc.sessionID).toBe("sess-1");
    expect(acc.costUsd).toBe(0.05);
    expect(acc.tokens.input).toBe(100);
    expect(acc.tokens.output).toBe(50);
    expect(acc.tokens.cached).toBe(20);
    expect(acc.tokens.cacheWrite).toBe(10);
    expect(acc.tokens.total).toBe(170);
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
      { type: "result", result: "done", status: "success", usage: { input_tokens: 10, output_tokens: 20, total_tokens: 37, prompt_tokens_details: { cached_tokens: 7 } } },
      acc,
    );
    expect(acc.text).toBe("partial done");
    expect(acc.tokens.input).toBe(10);
    expect(acc.tokens.output).toBe(20);
    expect(acc.tokens.cached).toBe(7);
    expect(acc.tokens.cacheWrite).toBe(0);
    expect(acc.tokens.total).toBe(37);
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
