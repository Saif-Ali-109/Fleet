// Tester workflow — validates fixes via test execution with durable checkpoints.
// Each step is recorded via the checkpoint API so a crash mid-phase can resume
// from the last completed step instead of re-running everything.

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { aggregateAgentResults, runWorker } from "../agentRunner.ts";
import { checkpoint } from "../db/checkpoint.ts";
import { splitTestCommand } from "../fleet/testCmd.ts";
import type { AgentResult, Role, RolePolicy, RunContext } from "../types.ts";

const exec = promisify(execFile);

const ROLE: Role = "tester";

const TESTER_STEPS = [
  "setup",
  "run",
  "validate",
] as const;

type TesterStep = (typeof TESTER_STEPS)[number];

/** Inputs the Tester workflow needs from the orchestrator. */
export interface TesterOptions {
  /** Base validation task handed to the tester worker (issue + plan context). */
  task: string;
  /** Per-role model policy (from `policyFor("tester", backend)`). */
  policy: RolePolicy;
  /** The worktree where tests are run. */
  worktreeDir: string;
  /** Test command to validate the fix (shell string). */
  testCommand: string;
  /** Whether the test command is expected to pass (true) or fail (false). */
  expectPass: boolean;
  /** Live streaming hooks (forwarded to runWorker). */
  onText?: (chunk: string) => void;
  onEvent?: (ev: Record<string, string | unknown>) => void;
}

export interface TesterResult {
  ok: boolean;
  error?: string;
  /** Per-spawn AgentResults in phase order (for action logging / cost attribution). */
  results?: AgentResult[];
  /** Aggregated AgentResult for the whole tester phase (role = "tester"). */
  agentResult?: AgentResult;
}

/**
 * Tester phases. Each step gets its own worker spawn for clear checkpointing.
 */
const TESTER_PHASES = [
  { steps: ["setup"], kind: "setup" as const },
  { steps: ["run"], kind: "run" as const },
  { steps: ["validate"], kind: "validate" as const },
];

/** Run the tester phase as checkpointed phases. Steps already marked success for
 * `(runId, role, iteration)` are skipped (resume support). On any failure the
 * in-flight phase's steps are all marked failed and the phase stops so a later
 * re-run resumes.
 */
export async function runTester(
  ctx: RunContext,
  opts: TesterOptions,
  runId: string,
  iteration: number,
): Promise<TesterResult> {
  const completed = await safeCompleted(runId, iteration);
  const results: AgentResult[] = [];
  for (const phase of TESTER_PHASES) {
    const pending = phase.steps.filter((s) => !completed.includes(s));
    if (pending.length === 0) continue;
    let ids: string[] = [];
    try {
      ids = await Promise.all(
        pending.map((s) => checkpoint.startStep(runId, ROLE, iteration, s as TesterStep)),
      );
      await runPhase(ctx, opts, phase.kind, results);
      await Promise.all(ids.map((id) => checkpoint.markStepSuccess(id)));
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      await Promise.all(
        ids.map((id, i) => checkpoint.markStepFailed(id, `${pending[i]}: ${message}`)),
      );
      return {
        ok: false,
        error: `${pending.join("+")}: ${message}`,
        results,
        agentResult: results.length > 0 ? aggregateAgentResults(results) : undefined,
      };
    }
  }
  return {
    ok: true,
    results,
    agentResult: results.length > 0 ? aggregateAgentResults(results) : undefined,
  };
}

async function runPhase(
  ctx: RunContext,
  opts: TesterOptions,
  kind: (typeof TESTER_PHASES)[number]["kind"],
  results: AgentResult[],
): Promise<void> {
  switch (kind) {
    case "setup":
      await runSetup(ctx, opts, results);
      return;
    case "run":
      await runTests(ctx, opts, "run", results);
      return;
    case "validate":
      await runValidation(ctx, opts, "validate", results);
      return;
  }
}

async function runSetup(
  ctx: RunContext,
  opts: TesterOptions,
  results: AgentResult[],
): Promise<void> {
  const task =
    `${opts.task}` +
    `\n\nSet up the test environment in the worktree at ${opts.worktreeDir}. ` +
    `Ensure all dependencies are installed and the test command \`${opts.testCommand}\` can be executed.`;
  const res = await runWorker(ROLE, task, ctx, opts.policy, {
    onText: opts.onText,
    onEvent: opts.onEvent,
  });
  results.push(res);
}

/**
 * One single-shot worker spawn for a step: every attempt receives the FULL task
 * plus the step instruction. There is no cross-process session resume — the
 * orchestrator owns all iteration policy via its own auto-fix cap.
 */
async function worker(
  ctx: RunContext,
  opts: TesterOptions,
  step: TesterStep,
  instruction: string,
  results: AgentResult[],
): Promise<AgentResult> {
  const res = await runWorker(
    ROLE,
    `${opts.task}\n\nWorkflow step "${step}": ${instruction}`,
    ctx,
    opts.policy,
    {
      onText: opts.onText,
      onEvent: opts.onEvent,
    },
  );
  results.push(res);
  return res;
}

async function runTests(
  ctx: RunContext,
  opts: TesterOptions,
  step: TesterStep,
  results: AgentResult[],
): Promise<void> {
  const res = await worker(
    ctx,
    opts,
    step,
    `execute the test command: \`${opts.testCommand}\` in the worktree (${opts.worktreeDir})`,
    results,
  );

  // Check if the test result matches expectation
  const testPassed = res.ok && res.text.trim().length > 0 && !res.sawError;
  const expectationMet = opts.expectPass ? testPassed : !testPassed;

  if (!expectationMet) {
    const expected = opts.expectPass ? "to pass" : "to fail";
    const actual = testPassed ? "passed" : "failed";
    throw new Error(`test command ${opts.testCommand} expected ${expected} but ${actual}`);
  }
}

async function runValidation(
  ctx: RunContext,
  opts: TesterOptions,
  step: TesterStep,
  results: AgentResult[],
): Promise<void> {
  await worker(
    ctx,
    opts,
    step,
    `validate that the test execution confirms the fix works correctly`,
    results,
  );
  // Validation step mainly serves as a checkpoint - the actual validation
  // happens in the runTests phase where we check expectations
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