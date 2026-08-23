import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { chmodSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// This test must live in its own file: GEMINI_BIN is read at module-load
// time by src/runner/providers.ts (PROVIDER_BIN map), so the env must be set
// BEFORE the dynamic import of agentRunner.ts. A separate test file gets a
// fresh module registry.

const LONG_WORKER = join(import.meta.dirname, "fixtures", "longWorker.mjs");

let ctxDir: string;
let agentRunner: typeof import("../agentRunner.ts");

beforeAll(async () => {
  delete process.env.DATABASE_URL;
  delete process.env.SOR_SIGNING_KEY;

  // The placeholder default binary dies instantly (`node --role ...` → bad
  // option) so the kill switch never trips; point GEMINI_BIN at a long-lived
  // fixture worker that ignores argv and keeps the event loop alive.
  chmodSync(LONG_WORKER, 0o755);
  process.env.GEMINI_BIN = LONG_WORKER;
  process.env.WORKER_TIMEOUT_MS = "400";
  process.env.WORKER_TIMEOUT_GRACE_MS = "200";

  agentRunner = await import("../agentRunner.ts");
});

afterAll(() => {
  delete process.env.GEMINI_BIN;
  delete process.env.WORKER_TIMEOUT_MS;
  delete process.env.WORKER_TIMEOUT_GRACE_MS;
  if (ctxDir) rmSync(ctxDir, { recursive: true, force: true });
});

function makeCtx() {
  ctxDir = mkdtempSync(join(tmpdir(), "timeout-ctx-"));
  const runDir = join(ctxDir, ".runs", "t1");
  mkdirSync(join(runDir, "traces"), { recursive: true });
  mkdirSync(join(runDir, "worktree"), { recursive: true });
  return {
    runId: "t1",
    issue: { repo: "owner/repo", number: 1, title: "t", body: "b", url: "u", state: "open", labels: [], author: "x" },
    repoUrl: "git@github.com:owner/repo.git",
    rootDir: ctxDir,
    runDir,
    worktreeDir: join(runDir, "worktree"),
    tracesDir: join(runDir, "traces"),
    branch: "fix-1",
    dryRun: false,
    provider: "gemini" as const,
  };
}

const policy = { role: "coder" as const, model: "m1", fallbacks: ["m2"] };

describe("runWorker timeout", () => {
  it("kills the worker and resolves the attempt as failed when WORKER_TIMEOUT_MS elapses", async () => {
    const started = Date.now();
    const res = await agentRunner.runWorker("coder", "task", makeCtx(), policy, {});
    const elapsed = Date.now() - started;

    expect(res.ok).toBe(false);
    expect(res.sawError).toBe(true);
    expect(res.error).toContain("timed out");
    expect(res.attempts).toHaveLength(2);
    for (const a of res.attempts ?? []) {
      expect(a.ok).toBe(false);
      expect(a.provider).toBe("gemini");
      expect(a.error).toContain("timed out after 400ms");
    }
    // Two attempts at ~400ms each plus grace overhead; must be far under any
    // real hang. Deterministic: bounded by the configured kill switch only.
    expect(elapsed).toBeGreaterThanOrEqual(800);
    expect(elapsed).toBeLessThan(10000);
  });
});
