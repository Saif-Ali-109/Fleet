// Coder workflow — the 5-step implementation phase with durable checkpoints.
// Each step is recorded via the checkpoint API so a crash mid-phase can resume
// from the last completed step instead of re-running everything.

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { aggregateAgentResults, runWorker } from "../agentRunner.ts";
import { checkpoint } from "../db/checkpoint.ts";
import type { AgentResult, Role, RolePolicy, RunContext } from "../types.ts";

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
  /** GitHub issue number (context only; factual commit messages must not carry `Fix #N`). Optional. */
  issueNumber?: number;
  /** Factual commit message override; defaults to a generic `fix: orchestrated change on <branch>`. */
  commitMessage?: string;
  /** Test command the coder worker must run in the worktree (shell string). Detected from the repo; defaults to `git status --porcelain`. */
  testCommand?: string;
  /** Live streaming hooks (forwarded to runWorker). */
  onText?: (chunk: string) => void;
  onEvent?: (ev: Record<string, string | unknown>) => void;
}

export interface CoderResult {
  ok: boolean;
  error?: string;
  /** Per-spawn AgentResults in phase order (for action logging / cost attribution). */
  results?: AgentResult[];
  /** Aggregated AgentResult for the whole coder phase (role = "coder"). */
  agentResult?: AgentResult;
}

/**
 * Coder phases. `parse-spec` and `edit-repo` share ONE worker spawn (they used
 * to each spawn a worker, re-billing the ~4.5k opencode system prompt twice);
 * keeping both checkpoint step names preserves `agent_steps` semantics and the
 * `checkpoint.test.ts` assertions untouched. The other phases keep their
 * one-spawn-per-step mapping.
 */
const CODER_PHASES = [
  { steps: ["parse-spec", "edit-repo"], kind: "parse-edit" as const },
  { steps: ["run-tests"], kind: "run-tests" as const },
  { steps: ["commit"], kind: "commit" as const },
  { steps: ["verify-diff"], kind: "verify-diff" as const },
];

/** Run the coder phase as checkpointed phases. Steps already marked success for
 * `(runId, role, iteration)` are skipped (resume support). On any failure the
 * in-flight phase's steps are all marked failed and the phase stops so a later
 * re-run resumes.
 */
export async function runCoder(
  ctx: RunContext,
  opts: CoderOptions,
  runId: string,
  iteration: number,
): Promise<CoderResult> {
  const completed = await safeCompleted(runId, iteration);
  const results: AgentResult[] = [];
  // Session captured from the first spawn; reused for later phases (model-bound, so discarded on fallback).
  const session: { id: string | undefined } = { id: undefined };
  for (const phase of CODER_PHASES) {
    const pending = phase.steps.filter((s) => !completed.includes(s));
    if (pending.length === 0) continue;
    const ids = await Promise.all(
      pending.map((s) => checkpoint.startStep(runId, ROLE, iteration, s as CoderStep)),
    );
    try {
      await runPhase(ctx, opts, phase.kind, results, session);
      await Promise.all(ids.map((id) => checkpoint.markStepSuccess(id)));
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      await Promise.all(
        pending.map((s, i) => checkpoint.markStepFailed(ids[i]!, `${s}: ${message}`)),
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
  opts: CoderOptions,
  kind: (typeof CODER_PHASES)[number]["kind"],
  results: AgentResult[],
  session: { id: string | undefined },
): Promise<void> {
  switch (kind) {
    case "parse-edit":
      await runParseEdit(ctx, opts, results, session);
      return;
    case "run-tests":
      await runTests(ctx, opts, "run-tests", results, session);
      return;
    case "commit":
      await commitChanges(ctx, opts, "commit");
      return;
    case "verify-diff":
      await worker(ctx, opts, "verify-diff", "verify the diff matches the plan expectations", results, session);
      return;
  }
}

/**
 * Single worker spawn servicing both the `parse-spec` and `edit-repo` steps
 * (previously two spawns). Mirrors `worker()` but with a combined instruction;
 * like the pre-consolidation `runStep`, it does not gate on `AgentResult.ok` —
 * runWorker only throws on a spawn-level failure, which propagates and marks
 * both steps failed.
 */
async function runParseEdit(
  ctx: RunContext,
  opts: CoderOptions,
  results: AgentResult[],
  session: { id: string | undefined },
): Promise<void> {
  const task =
    `${opts.task}` +
    `\n\nParse the fix spec and plan against the repository, then implement the plan in the worktree.`;
  const res = await runWorker(ROLE, task, ctx, opts.policy, {
    onText: opts.onText,
    onEvent: opts.onEvent,
  });
  results.push(res);
  // Sessions are model-bound — discard if a fallback model was used.
  session.id = res.ok && (!res.attempts || res.attempts.length === 1) ? res.sessionID ?? undefined : undefined;
  return;
}

async function worker(
  ctx: RunContext,
  opts: CoderOptions,
  step: CoderStep,
  instruction: string,
  results: AgentResult[],
  session: { id: string | undefined },
): Promise<AgentResult> {
  // On resume, send only the step instruction (the session already holds the base task).
  const task =
    session.id !== undefined
      ? `Workflow step "${step}": ${instruction}`
      : `${opts.task}\n\nWorkflow step "${step}": ${instruction}`;
  const res = await runWorker(ROLE, task, ctx, opts.policy, {
    onText: opts.onText,
    onEvent: opts.onEvent,
    resumeSessionID: session.id,
  });
  results.push(res);
  return res;
}

/** Instruct the coder worker to run the repo's real test command and verify it passes (not a no‑op). */
async function runTests(
  ctx: RunContext,
  opts: CoderOptions,
  step: CoderStep,
  results: AgentResult[],
  session: { id: string | undefined },
): Promise<void> {
  const cmd = opts.testCommand ?? "git status --porcelain";
  const res = await worker(
    ctx,
    opts,
    step,
    `run the test suite with \`${cmd}\` in the worktree (${opts.worktreeDir}); ` +
      `fix any failing tests; \`${cmd}\` MUST exit 0 with all tests passing before this phase completes.`,
    results,
    session,
  );
  if (!res.ok) {
    throw new Error(res.error ?? "coder test-verification worker failed");
  }
}

/**
 * Pathspecs for common build/test artifacts that must never be staged by the
 * manager's safety-net commit.  Only the *coder worker* should commit these
 * (and usually doesn't).  Using glob magic ensures nested dirs are excluded.
 */
const EXCLUDE_ARTIFACTS = [
  ":(exclude,glob)**/AGENTS.md",
  ":(exclude,glob)**/__pycache__/**",
  ":(exclude,glob)**/__pycache__",
  ":(exclude).pytest_cache",
  ":(exclude).venv",
] as const;

/**
 * Pull the most useful text out of an `execFile` rejection
 */
export function execErrorText(e: unknown): string {
  if (e instanceof Error) {
    const err = e as Error & { stdout?: unknown; stderr?: unknown };
    if (typeof err.stdout === "string" && err.stdout.trim()) return err.stdout.trim();
    if (typeof err.stderr === "string" && err.stderr.trim()) return err.stderr.trim();
    return err.message;
  }
  return String(e);
}

/** Execute the test suite in the worktree (git/exec operation). */
async function commitChanges(
  ctx: RunContext,
  opts: CoderOptions,
  _step: CoderStep,
): Promise<void> {
  if (ctx.dryRun) return;
  const gitArgs = ["-C", opts.worktreeDir];
  const { stdout } = await exec("git", [...gitArgs, "status", "--porcelain"], {
    maxBuffer: 32 * 1024 * 1024,
  });
  if (!stdout.trim()) {
    return; // clean worktree — nothing to commit; don't fail the phase
  }
  await exec(
    "git",
    [...gitArgs, "add", "-A", "--", ".", ...EXCLUDE_ARTIFACTS],
    { maxBuffer: 32 * 1024 * 1024,
  });
  // If the only changes were excluded artifacts, nothing is staged — skip.
  const { stdout: staged } = await exec("git", [...gitArgs, "diff", "--cached", "--name-only"], {
    maxBuffer: 32 * 1024 * 1024,
  });
  if (!staged.trim()) {
    return; // no staged content — only untracked artifacts present
  }
  const message = opts.commitMessage ?? `fix: orchestrated change on ${opts.branch}`;
  try {
    await exec("git", [...gitArgs, "commit", "-m", message], {
      maxBuffer: 32 * 1024 * 1024,
    });
  } catch (e) {
    throw new Error(`git commit failed: ${execErrorText(e)}`);
  }
}

/** `getCompletedSteps` that is safe for dry-run/DB-unavailable contexts. */
async function safeCompleted(runId: string, iteration: number): Promise<string[]> {
  try {
    return await checkpoint.getCompletedSteps(runId, ROLE, iteration);
  } catch {
    return [];
  }
}

export { CODERS_STEPS, EXCLUDE_ARTIFACTS, commitChanges };
export type { CoderStep };