// Tester workflow — the 3-step validation phase with durable checkpoints.
// Shares the same step-level checkpoint pattern as the coder workflow so a
// crash can resume from the last completed step.

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { runWorker } from "../agentRunner.js";
import { checkpoint } from "../db/checkpoint.js";
import type { AgentResult, Role, RolePolicy, RunContext } from "../types.js";

const exec = promisify(execFile);

const ROLE: Role = "tester";

const TESTER_STEPS = ["run-tests", "parse-results", "diagnose"] as const;

type TesterStep = (typeof TESTER_STEPS)[number];

/** Inputs the tester workflow needs from the orchestrator (Decision 5c). */
export interface TesterOptions {
  /** Base testing task handed to the tester worker (issue + plan + diff context). */
  task: string;
  /** Per-role model policy (from `policyFor("tester", backend)`). */
  policy: RolePolicy;
  /** The worktree to execute the test suite in. */
  worktreeDir: string;
  /** Test command to run (argv form, run in the worktree). Defaults to `git status --porcelain`. */
  testCommand?: string[];
  /** When false, failures are expected to be diagnosed rather than raised. */
  expectPass?: boolean;
  /** Live streaming hooks (forwarded to runWorker). */
  onText?: (chunk: string) => void;
  onEvent?: (ev: Record<string, unknown>) => void;
}

export interface TesterResult {
  ok: boolean;
  error?: string;
  agentResult?: AgentResult;
  testOutput?: string;
  diagnosis?: string;
}

/**
 * Run the tester phase as 3 checkpointed steps. Steps already marked success for
 * `(runId, role, iteration)` are skipped (resume support). On any step failure
 * the step is marked failed and the phase stops so a later re-run resumes.
 */
export async function runTester(
  ctx: RunContext,
  opts: TesterOptions,
  runId: string,
  iteration: number,
): Promise<TesterResult> {
  const completed = await safeCompleted(runId, iteration);
  const result: TesterResult = { ok: false };

  for (const step of TESTER_STEPS) {
    if (completed.includes(step)) {
      continue;
    }
    const stepId = await checkpoint.startStep(runId, ROLE, iteration, step);
    try {
      if (step === "run-tests") {
        result.testOutput = await runTests(ctx, opts);
      } else if (step === "parse-results") {
        await parseResults(ctx, opts, step, result.testOutput);
      } else {
        result.diagnosis = await diagnose(ctx, opts, step, result.testOutput);
      }
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      await checkpoint.markStepFailed(stepId, message);
      return { ok: false, error: `${step}: ${message}` };
    }
    await checkpoint.markStepSuccess(stepId);
  }
  result.ok = true;
  return result;
}

/** Execute the test suite in the worktree and return the raw output. */
async function runTests(ctx: RunContext, opts: TesterOptions): Promise<string> {
  if (ctx.dryRun) {
    return "[dry-run] tests would run here.";
  }
  const cmd = opts.testCommand ?? ["git", "-C", opts.worktreeDir, "status", "--porcelain"];
  const { stdout, stderr } = await exec(cmd[0] ?? "git", cmd.slice(1), {
    cwd: opts.worktreeDir,
    maxBuffer: 32 * 1024 * 1024,
  });
  return stdout + (stderr ? `\n${stderr}` : "");
}

/** Parse test output for pass/fail and fail the step on unexpected failures. */
async function parseResults(
  ctx: RunContext,
  opts: TesterOptions,
  _step: TesterStep,
  testOutput: string | undefined,
): Promise<void> {
  if (ctx.dryRun) return;
  const output = testOutput ?? "";
  const failedRe = /fail(?:ed|ing)?/i;
  if (opts.expectPass && failedRe.test(output)) {
    throw new Error("test output indicates failures");
  }
}

/** If failures, produce a diagnosis for the Coder (LLM worker call). */
async function diagnose(
  ctx: RunContext,
  opts: TesterOptions,
  step: TesterStep,
  testOutput: string | undefined,
): Promise<string> {
  const instruction = "inspect the failing test output and produce a concise diagnosis for the Coder.";
  const task =
    `${opts.task}\n\nWorkflow step "${step}": ${instruction}\n\nTest output:\n${testOutput ?? "(none)"}`;
  const res = await runWorker(ROLE, task, ctx, opts.policy, {
    onText: opts.onText,
    onEvent: opts.onEvent,
  });
  if (!res.ok) {
    throw new Error(res.error ?? "tester worker failed");
  }
  return res.text;
}

/** `getCompletedSteps` that is safe for dry-run/DB-unavailable contexts. */
async function safeCompleted(runId: string, iteration: number): Promise<string[]> {
  try {
    return await checkpoint.getCompletedSteps(runId, ROLE, iteration);
  } catch {
    return [];
  }
}

export { TESTER_STEPS };
export type { TesterStep };