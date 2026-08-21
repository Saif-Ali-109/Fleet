import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RunContext, RolePolicy } from "../types.ts";

// This test must live in its own file: OPENCODE_BIN is read at module-load
// time by src/runner/backends.ts, so the env must be set BEFORE the dynamic
// import of agentRunner.js. A separate test file gets a fresh module registry.

let fakeBinDir: string;
let ctxDir: string;
let agentRunner: typeof import("../agentRunner.ts");

beforeAll(async () => {
  delete process.env.DATABASE_URL;
  delete process.env.SOR_SIGNING_KEY;

  fakeBinDir = mkdtempSync(join(tmpdir(), "timeout-fake-bin-"));
  const fakeBin = join(fakeBinDir, "opencode");
  writeFileSync(fakeBin, "#!/usr/bin/env bash\nexec sleep 60\n");
  chmodSync(fakeBin, 0o755);

  process.env.OPENCODE_BIN = fakeBin;
  process.env.WORKER_TIMEOUT_MS = "400";
  process.env.WORKER_TIMEOUT_GRACE_MS = "200";

  agentRunner = await import("../agentRunner.ts");
});

afterAll(() => {
  delete process.env.OPENCODE_BIN;
  delete process.env.WORKER_TIMEOUT_MS;
  delete process.env.WORKER_TIMEOUT_GRACE_MS;
  if (fakeBinDir) rmSync(fakeBinDir, { recursive: true, force: true });
  if (ctxDir) rmSync(ctxDir, { recursive: true, force: true });
});

function makeCtx(): RunContext {
  ctxDir = mkdtempSync(join(tmpdir(), "timeout-ctx-"));
  const runDir = join(ctxDir, ".runs", "t1");
  mkdirSync(join(runDir, "traces"), { recursive: true });
  mkdirSync(join(runDir, "worktree"), { recursive: true });
  return {
    runId: "t1",
    issue: { repo: "owner/repo", number: 1, title: "t", body: "b", url: "u", labels: [], author: "x" },
    repoUrl: "git@github.com:owner/repo.git",
    rootDir: ctxDir,
    runDir,
    worktreeDir: join(runDir, "worktree"),
    tracesDir: join(runDir, "traces"),
    branch: "fix-1",
    dryRun: false,
    backend: "opencode",
  };
}

const policy: RolePolicy = { role: "coder", model: "m1", fallbacks: ["m2"] };

describe("runWorker timeout", () => {
  it("kills the worker and resolves the attempt as failed when WORKER_TIMEOUT_MS elapses", async () => {
    const started = Date.now();
    const res = await agentRunner.runWorker("coder", "task", makeCtx(), policy, {});
    const elapsed = Date.now() - started;

    expect(res.ok).toBe(false);
    expect(res.error).toContain("timed out");
    expect(res.attempts).toHaveLength(2);
    for (const a of res.attempts ?? []) {
      expect(a.ok).toBe(false);
      expect(a.error).toContain("timed out after 400ms");
    }
    // Two attempts at ~400ms each plus overhead; must be far under the 60s sleep.
    expect(elapsed).toBeGreaterThan(400);
    expect(elapsed).toBeLessThan(10000);
  });
});
