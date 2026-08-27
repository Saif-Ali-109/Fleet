// W2A §1.3 integration wiring: a worker killed by the shutdown path produces
// an "aborted by user" role failure, which must route through the
// orchestrator's normal finalize("failed") — DB row finalized, in-progress
// label removed, GitHub failure comment posted, never a done label.
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { killActiveWorkers, resetWorkerAbort, runWorker } from "../agentRunner.ts";
import { appendAuditEvent, ensureChain } from "../db/audit.ts";
import { db } from "../db/client.ts";
import { setupWorktree, diffAgainstBase, cleanupWorktree } from "../git/worktree.ts";
import {
  ISSUE_LABEL_DONE,
  ISSUE_LABEL_IN_PROGRESS,
  addIssueLabel,
  commentOnIssue,
  removeIssueLabel,
} from "../github/gh.ts";
import type { AgentResult, Issue, RunContext, Role } from "../types.ts";
import { runOrchestrator } from "../orchestrator.ts";

vi.mock("../agentRunner.ts", () => ({
  runWorker: vi.fn(),
  killActiveWorkers: vi.fn(() => 0),
  resetWorkerAbort: vi.fn(),
}));
vi.mock("node:child_process", () => ({ execFile: vi.fn() }));
vi.mock("../git/worktree.ts", () => ({
  setupWorktree: vi.fn(async (_repo: string, runDir: string, branch: string) => ({
    repoDir: join(runDir, "repo"),
    worktreeDir: join(runDir, "worktree"),
    branch,
    baseBranch: "main",
  })),
  cleanupWorktree: vi.fn(async () => undefined),
  diffAgainstBase: vi.fn(async () => ""),
}));
vi.mock("../git/snapshotReader.ts", () => ({
  buildSkeletonMap: vi.fn(async () => ({ files: [] })),
  readSelectedFileSymbols: vi.fn(async () => ({})),
}));
vi.mock("../db/client.ts", () => ({
  pool: {},
  db: {
    createRun: vi.fn(async () => "run-1"),
    updateRunStatus: vi.fn(async () => true),
    logAgentAction: vi.fn(async () => "action-1"),
    finalizeRun: vi.fn(async () => true),
  },
}));
vi.mock("../db/audit.ts", () => ({
  ensureChain: vi.fn(async () => undefined),
  appendAuditEvent: vi.fn(async () => undefined),
}));
vi.mock("../db/checkpoint.ts", () => ({ getLastFailedStep: vi.fn(async () => null) }));
vi.mock("../db/queries/callStats.ts", () => ({ upsertAgentCallStats: vi.fn(async () => undefined) }));
vi.mock("../workflow/coder.ts", () => ({
  EXCLUDE_ARTIFACTS: [],
  execErrorText: (e: unknown): string => String(e),
  runCoder: vi.fn(),
}));
vi.mock("../workflow/tester.ts", () => ({ runTester: vi.fn() }));
vi.mock("../github/gh.ts", () => ({
  ISSUE_LABEL_DONE: "multi-orch/done",
  ISSUE_LABEL_IN_PROGRESS: "multi-orch/in-progress",
  addIssueLabel: vi.fn(async () => undefined),
  commentOnIssue: vi.fn(async () => undefined),
  createPr: vi.fn(),
  ensureLabels: vi.fn(async () => undefined),
  removeIssueLabel: vi.fn(async () => undefined),
  splitRepoSlug: (slug: string) => {
    const [owner, repo] = slug.split("/");
    return { owner: owner ?? "", repo: repo ?? "" };
  },
}));
vi.mock("../memory/sessionLog.ts", () => ({
  logBlock: vi.fn(async () => undefined),
  logLine: vi.fn(async () => undefined),
  resetSessionLog: vi.fn(async () => undefined),
}));
vi.mock("../db/queries/summaryReport.ts", () => ({ generateMemory: vi.fn() }));

const abortedResult = (role: Role): AgentResult => ({
  role,
  ok: false,
  sessionID: null,
  model: "test-model",
  provider: "gemini",
  text: "",
  tokens: { input: 0, output: 0, reasoning: 0, cached: 0, cacheWrite: 0, total: 0 },
  costUsd: 0,
  tracePath: "",
  startedAt: Date.now(),
  endedAt: Date.now(),
  error: "aborted by user",
});

const makeCtx = async (): Promise<RunContext> => {
  const rootDir = await mkdtemp(join(tmpdir(), "shutdown-finalize-"));
  const issue: Issue = {
    repo: "Saif-Ali-109/Demo-Repo",
    number: 26,
    title: "poisoned daemon state",
    body: "",
    url: "",
    state: "open",
    labels: [],
    author: "someone",
  };
  const runId = new Date().toISOString().replace(/[:.]/g, "-");
  return {
    runId,
    issue,
    repoUrl: `https://github.com/${issue.repo}`,
    rootDir,
    runDir: join(rootDir, ".runs", runId),
    worktreeDir: join(rootDir, ".runs", runId, "worktree"),
    tracesDir: join(rootDir, ".runs", runId, "traces"),
    branch: "fix-issue-26",
    dryRun: false,
    provider: "openrouter",
  };
};

describe("graceful shutdown → failed finalize", () => {
  it("killed workers finalize the run as failed with a GitHub failure comment", async () => {
    const ctx = await makeCtx();
    vi.mocked(killActiveWorkers).mockReturnValue(1);
    vi.mocked(runWorker).mockResolvedValue(abortedResult("analyzer"));

    // What index.ts' first-signal handler does: kill workers, let the
    // orchestrator wind down through its normal failure path.
    const killed = killActiveWorkers();
    expect(killed).toBe(1);

    const summary = await runOrchestrator(ctx, {});

    expect(summary.status).toBe("failed");
    expect(summary.failure).toBe("aborted by user");
    expect(db.finalizeRun).toHaveBeenCalledWith(
      expect.objectContaining({ run_id: "run-1", status: "failed" }),
    );
    expect(appendAuditEvent).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ event_type: "finalize", payload: expect.objectContaining({ status: "failed" }) }),
    );
    expect(removeIssueLabel).toHaveBeenCalledWith(
      "Saif-Ali-109",
      "Demo-Repo",
      26,
      ISSUE_LABEL_IN_PROGRESS,
    );
    expect(commentOnIssue).toHaveBeenCalledWith(
      "Saif-Ali-109",
      "Demo-Repo",
      26,
      expect.any(String),
    );
    const failureComment = vi.mocked(commentOnIssue).mock.calls[0]?.[3] as string;
    expect(failureComment).toContain("Managed run `");
    expect(failureComment).toContain("failed: aborted by user");
    expect(addIssueLabel).not.toHaveBeenCalledWith(
      "Saif-Ali-109",
      "Demo-Repo",
      26,
      ISSUE_LABEL_DONE,
    );

    resetWorkerAbort();
  });
});
