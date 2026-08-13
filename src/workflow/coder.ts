// Coder workflow — the 5-step implementation phase with durable checkpoints.
// Each step is recorded via the checkpoint API so a crash mid-phase can resume
// from the last completed step instead of re-running everything.

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { runWorker } from "../agentRunner.js";
import { checkpoint } from "../db/checkpoint.js";
import type { AgentResult, Role, RolePolicy, RunContext } from "../types.js";

const exec = promisify(execFile);

const ROLE: Role = "coder";

const CODERS_STEPS = [
  "parse-spec",
  "edit-repo",
  "run-tests",
  "commit",
  "verify-diff",
] as const;

type CoderStep = (typeof CODERS_STEPS)[number];

/** Inputs the Coder workflow needs from the orchestrator (Decision 5c). */
export interface CoderOptions {
  /** Base implementation task handed to the coder worker (issue + plan context). */
  task: string;
  /** Per-role model policy (from `policyFor("coder", backend)`). */
  policy: RolePolicy;
  /** The worktree the worker edits and where commit/verify run. */
  worktreeDir: string;
  /** Name of the fix branch to commit onto. */
  branch: string;
  /** GitHub issue number (used in the commit message). Optional. */
  issueNumber?: number;
  /** Commit message override; defaults to `Fix #<n>: orchestrated commit` / generic. */
  commitMessage?: string;
  /** Test command to run (argv form, run in the worktree). Defaults to `git status --porcelain` (a safe no-op check). */
  testCommand?: string[];
  /** Live streaming hooks (forwarded to runWorker). */
  onText?: (chunk: string) => void;
  onEvent?: (ev: Record<string, unknown>) => void;
}

export interface CoderResult {
  ok: boolean;
  error?: string;
  agentResult?: AgentResult;
}

/**

/**
 * Run the coder phase as 5 checkpointed steps. Steps already marked success for
 * `(runId, role, iteration)` are skipped (resume support). On any step failure
 * the step is marked failed and the phase stops so a later re-run resumes.
 */
export async function runCoder(
  ctx: RunContext,
  opts: CoderOptions,
  runId: string,
  iteration: number,
): Promise<CoderResult> {
  const completed = await safeCompleted(runId, iteration);

  for (const step of CODERS_STEPS) {
    if (completed.includes(step)) {
      continue;
    }
    const stepId = await checkpoint.startStep(runId, ROLE, iteration, step);
    try {
      await runStep(ctx, opts, step);
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      await checkpoint.markStepFailed(stepId, message);
      return { ok: false, error: `${step}: ${message}` };
    }
    await checkpoint.markStepSuccess(stepId);
  }
  return { ok: true };
}

async function runStep(ctx: RunContext, opts: CoderOptions, step: CoderStep): Promise<void> {
  switch (step) {
    case "parse-spec": {
      await worker(ctx, opts, step, "parse the fix spec and plan against the repository");
      return;
    }
    case "edit-repo": {
      await worker(ctx, opts, step, "implement the plan in the worktree");
      return;
    }
    case "run-tests": {
      await runTests(ctx, opts, step);
      return;
    }
    case "commit": {
      await commitChanges(ctx, opts, step);
      return;
    }
    case "verify-diff": {
      await worker(ctx, opts, step, "verify the diff matches the plan expectations");
      return;
    }
  }
}

async function worker(ctx: RunContext, opts: CoderOptions, step: CoderStep, instruction: string): Promise<AgentResult> {
  const task = `${opts.task}\n\nWorkflow step "${step}": ${instruction}`;
  return runWorker(ROLE, task, ctx, opts.policy, {
    onText: opts.onText,
    onEvent: opts.onEvent,
  });
}

/** Execute the test suite in the worktree (git/exec operation). */
async function runTests(ctx: RunContext, opts: CoderOptions, _step: CoderStep): Promise<void> {
  if (ctx.dryRun) return;
  const cmd = opts.testCommand ?? ["git", "-C", opts.worktreeDir, "status", "--porcelain"];
  await exec(cmd[0] ?? "git", cmd.slice(1), {
    cwd: opts.worktreeDir,
    maxBuffer: 32 * 1024 * 1024,
  });
}

/** `git add -A` + `git commit` in the worktree (git/exec operation). */
async function commitChanges(ctx: RunContext, opts: CoderOptions, _step: CoderStep): Promise<void> {
  if (ctx.dryRun) return;
  await exec("git", ["-C", opts.worktreeDir, "add", "-A", "--", ".", ":(exclude)__pycache__"], {
    maxBuffer: 32 * 1024 * 1024,
  });
  const message =
    opts.commitMessage ??
    (opts.issueNumber !== undefined
      ? `Fix #${opts.issueNumber}: orchestrated commit`
      : `fix: orchestrated commit on ${opts.branch}`);
  await exec("git", ["-C", opts.worktreeDir, "commit", "-m", message], {
    maxBuffer: 32 * 1024 * 1024,
  });
}

/** `getCompletedSteps` that is safe for dry-run/DB-unavailable contexts. */
async function safeCompleted(runId: string, iteration: number): Promise<string[]> {
  try {
    return await checkpoint.getCompletedSteps(runId, ROLE, iteration);
  } catch {
    return [];
  }
}

export { CODERS_STEPS };
export type { CoderStep };