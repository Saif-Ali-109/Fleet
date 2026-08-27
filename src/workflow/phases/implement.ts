import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { runWorker } from "../../agentRunner.ts";
import { upsertAgentCallStats } from "../../db/queries/callStats.ts";
import { db, pool } from "../../db/client.ts";
import { getLastFailedStep } from "../../db/checkpoint.ts";
import { diffAgainstBase, type WorktreeHandle } from "../../git/worktree.ts";
import { policyFor } from "../../models/modelPolicy.ts";
import { runCoder, EXCLUDE_ARTIFACTS, execErrorText } from "../coder.ts";
import { runTester } from "../tester.ts";
import { makeOnEvent } from "../makeOnEvent.ts";
import { ScoutTracker } from "../scoutTracker.ts";
import { detectTestCommand } from "../../fleet/testCmd.ts";
import { readContributionGuidance } from "../../orchestrator.ts";
import { collapseConsecutiveModels } from "../../utils/models.ts";
import { logLine } from "../../memory/sessionLog.ts";
import { extractJson } from "../../utils/json.ts";
import type { DashboardState } from "../../tui/dashboard.ts";
import type {
  AgentResult,
  Plan,
  Role,
  RolePolicy,
  RunContext,
} from "../../types.ts";
import type { RunStatus, RunSummary } from "../../orchestrator.ts";
import type { RouteStep } from "../../router.ts";
import type { WebFeed } from "../../orchestrator.ts";
import type { QuotaEvent } from "../../fleet/quotaEvents.ts";
import type { SorEvent } from "../../sor/events.ts";

type Phase = DashboardState["phase"];

const MAX_REVIEW_DIFF_CHARS = Number(process.env.MAX_REVIEW_DIFF_CHARS ?? 25_000);
const AUTO_FIX_MAX_ROUNDS = 1;

export interface ImplementPhaseOpts {
  ctx: RunContext;
  plan: Plan;
  planMd: string;
  commitMessage: string;
  route: RouteStep[];
  wt: WorktreeHandle;
  runId: string | undefined;
  dash: DashboardState;
  agents: Record<Role, AgentResult>;
  scoutTracker: ScoutTracker;
  web?: WebFeed;
  setPhase: (phase: Phase | "failed") => void;
  pushState: () => void;
  pushStateThrottled: () => void;
  finalize: (status: string, gateStatus: Record<string, unknown>, reason?: string) => Promise<void>;
  makeSummary: (status: RunStatus, failure?: string) => RunSummary;
  sorEmit: (ctx: RunContext | { runId: string; dryRun?: boolean }, event: Partial<SorEvent>) => Promise<void>;
}

export type ImplementPhaseResult =
  | { ok: true; iterationsUsed: number }
  | { ok: false; summary: RunSummary };

export async function runImplementPhase(opts: ImplementPhaseOpts): Promise<ImplementPhaseResult> {
  const {
    ctx, plan, planMd, commitMessage, route, wt, runId, dash, agents, scoutTracker, web,
    setPhase, pushState, pushStateThrottled, finalize, makeSummary, sorEmit,
  } = opts;

  const loopStep = route.find((s) => s.kind === "loop");
  const implRoles: Role[] = loopStep?.roles ?? ["coder"];

  const implTask = (feedback: string | undefined): string => {
    const lines = [
      `Issue #${ctx.issue.number}: ${ctx.issue.title}`,
      "",
      ctx.issue.body,
      "",
      "## Approach",
      plan.approach,
      "",
      "## Steps",
      ...plan.steps.map((s, i) => `${i + 1}. ${s}`),
      "",
      "## Files to change",
      ...plan.filesToChange.map((f) => `- ${f}`),
      "",
      "## Acceptance criteria",
      ...plan.acceptanceCriteria.map((c) => `- ${c}`),
      "",
      `Implement this plan in the repo at ${ctx.worktreeDir} (branch ${ctx.branch}).`,
      "Make the code changes, run the relevant tests, and commit to the branch.",
      "",
      commitGuidance,
    ];
    if (feedback) lines.push("", "FEEDBACK FROM REVIEWER (auto-fix round):", feedback);
    return lines.join("\n");
  };

  let feedback: string | undefined;
  let fixRoundsUsed = 0;
  let approved = false;
  let iterationsUsed = 0;

  const testCommand = detectTestCommand(ctx.worktreeDir);
  await logLine(ctx.rootDir, `detected test command: ${testCommand}`);
  const commitGuidance = await readContributionGuidance(ctx.worktreeDir);

  const runAgent = async (
    role: Role,
    phase: Phase,
    task: string,
    policy: RolePolicy,
  ): Promise<AgentResult> => {
    setPhase(phase);
    dash.agents[role] = { role, state: "running", model: policy.model };
    pushState();
    const onText = (t: string) => web?.pushOutput(role, t);
    const onEvent = makeOnEvent({
      role,
      ctx,
      sorEmitFn: sorEmit,
      scoutTracker,
      pushStateThrottled,
      pushAgentEvent: (r, ev) => web?.pushAgentEvent?.(r, ev),
      pushNotice: web?.pushNotice?.bind(web),
      policyModel: policy.model,
      dash,
      emitSor: true,
    });
    const res = await runWorker(role, task, ctx, policy, { onText, onEvent });
    agents[role] = res;
    dash.agents[role] = {
      role,
      state: res.ok ? "done" : "failed",
      model: res.model,
      sessionID: res.sessionID ?? undefined,
      tokens: res.tokens,
      costUsd: res.costUsd,
      calls: res.calls,
      startedAt: res.startedAt,
      endedAt: res.endedAt,
      error: res.error,
    };
    pushState();
    if (runId) {
      await db.logAgentAction({
        run_id: runId,
        role,
        model: res.model,
        ok: res.ok,
        text: res.text,
        tokens: res.tokens,
        cost_usd: res.costUsd ?? 0,
        trace_path: res.tracePath,
        started_at: new Date(res.startedAt),
        ended_at: new Date(res.endedAt),
        attempts: res.attempts ?? [],
      });
      try {
        await upsertAgentCallStats(pool, runId, {
          role,
          model: res.model,
          provider: null,
          sessionId: res.sessionID ?? null,
          toolCalls: res.calls?.tools ?? 0,
          modelCalls: res.calls?.models ?? 0,
          skillLoads: res.calls?.skills ?? 0,
          toolBreakdown: res.calls?.breakdown ?? {},
        });
      } catch { /* non-fatal */ }
    }
    if (res.attempts) {
      const collapsed = collapseConsecutiveModels(res.attempts.map((a) => a.model));
      if (collapsed.length > 1) {
        await logLine(
          ctx.rootDir,
          `[${role}] fell back across ${collapsed.length} models: ${collapsed.join(" -> ")}`,
        );
      }
    }
    await logLine(ctx.rootDir, `${role} ${res.ok ? "done" : "failed"}${res.error ? `: ${res.error}` : ""}`);
    return res;
  };

  for (let iter = 1; iter <= 1 + AUTO_FIX_MAX_ROUNDS; iter++) {
    iterationsUsed = iter;
    dash.loopIteration = iter;

    if (runId) {
      const lastFailed = await getLastFailedStep(runId, "coder").catch(() => null);
      if (lastFailed && iter > 1) {
        await logLine(
          ctx.rootDir,
          `iteration ${iter}: resuming coder — previously failed at step "${lastFailed}" (completed steps are skipped automatically)`,
        );
      }
    }

    for (const role of implRoles) {
      const task = implTask(feedback);
      const policy = policyFor(role, ctx.provider ?? "gemini");

      if (!runId) {
        const res = await runAgent(role, "implement", task, policy);
        if (!res.ok) {
          setPhase("failed");
          pushState();
          await finalize("failed", {}, res.error ?? `${role} failed`);
          return { ok: false, summary: makeSummary("failed", res.error ?? `${role} failed`) };
        }
        continue;
      }

      setPhase("implement");
      dash.agents[role] = { role, state: "running", model: policy.model };
      pushState();

      const onText = (t: string) => web?.pushOutput(role, t);
      const onEvent = makeOnEvent({
        role,
        ctx,
        sorEmitFn: sorEmit,
        scoutTracker,
        pushStateThrottled,
        pushAgentEvent: (r, ev) => web?.pushAgentEvent?.(r, ev),
        pushNotice: web?.pushNotice?.bind(web),
        policyModel: policy.model,
        dash,
        emitSor: false,
      });

      let ok = true;
      let error: string | undefined;
      let ar: AgentResult | undefined;
      if (role === "coder") {
        const r = await runCoder(
          ctx,
          {
            task,
            policy,
            worktreeDir: ctx.worktreeDir,
            branch: ctx.branch,
            issueNumber: ctx.issue.number,
            commitMessage,
            testCommand,
            onText,
            onEvent,
          },
          runId,
          iter,
        );
        ar = r.agentResult;
        ok = r.ok && !(ar && !ar.ok);
        error = r.error ?? (ar && !ar.ok ? ar.error : undefined);
      } else {
        const r = await runTester(
          ctx,
          { task, policy, worktreeDir: ctx.worktreeDir, testCommand, onText, onEvent },
          runId,
          iter,
        );
        ar = r.agentResult;
        ok = r.ok && !(ar && !ar.ok);
        error = r.error ?? (ar && !ar.ok ? ar.error : undefined);
      }

      if (ar) {
        agents[role] = ar;
      }
      dash.agents[role] = {
        role,
        state: ok ? "done" : "failed",
        model: ar?.model ?? policy.model,
        sessionID: ar?.sessionID ?? undefined,
        tokens: ar?.tokens,
        costUsd: ar?.costUsd,
        calls: ar?.calls,
        startedAt: ar?.startedAt,
        endedAt: ar?.endedAt,
        error,
      };
      pushState();
      if (runId && ar) {
        await db.logAgentAction({
          run_id: runId,
          role,
          model: ar.model,
          ok: ar.ok,
          text: ar.text,
          tokens: ar.tokens,
          cost_usd: ar.costUsd ?? 0,
          trace_path: ar.tracePath,
          started_at: new Date(ar.startedAt),
          ended_at: new Date(ar.endedAt),
          attempts: ar.attempts ?? [],
        });
        try {
          await upsertAgentCallStats(pool, runId, {
            role,
            model: ar.model,
            provider: null,
            sessionId: ar.sessionID ?? null,
            toolCalls: ar.calls?.tools ?? 0,
            modelCalls: ar.calls?.models ?? 0,
            skillLoads: ar.calls?.skills ?? 0,
            toolBreakdown: ar.calls?.breakdown ?? {},
          });
        } catch { /* non-fatal */ }
      }
      if (!ok) {
        setPhase("failed");
        pushState();
        await finalize("failed", {}, error ?? `${role} failed`);
        return { ok: false, summary: makeSummary("failed", error ?? `${role} failed`) };
      }
    }

    if (!ctx.dryRun) {
      try {
        const exec = promisify(execFile);
        const { stdout } = await exec("git", [
          "-C",
          ctx.worktreeDir,
          "status",
          "--porcelain",
        ]);
        if (stdout.trim()) {
          await exec("git", [
            "-C",
            ctx.worktreeDir,
            "add",
            "-A",
            "--",
            ".",
            ...EXCLUDE_ARTIFACTS,
          ]);
          const { stdout: staged } = await exec("git", [
            "-C",
            ctx.worktreeDir,
            "diff",
            "--cached",
            "--name-only",
          ]);
          if (!staged.trim()) {
            await logLine(
              ctx.rootDir,
              "orchestrated commit skipped — only untracked artifacts present",
            );
          } else {
            try {
              await exec("git", [
                "-C",
                ctx.worktreeDir,
                "commit",
                "-m",
                commitMessage,
              ]);
              await logLine(
                ctx.rootDir,
                `orchestrated commit created on ${ctx.branch}`,
              );
            } catch (e) {
              await logLine(
                ctx.rootDir,
                `orchestrated commit failed (non-fatal): ${execErrorText(e)}`,
              );
            }
          }
        }
      } catch (e) {
        await logLine(
          ctx.rootDir,
          `worktree commit step skipped (non-fatal): ${String(e)}`,
        );
      }
    }

    const reviewDiff = ctx.dryRun
      ? "[dry-run] diff unavailable"
      : (await diffAgainstBase(wt)).slice(0, MAX_REVIEW_DIFF_CHARS);
    const reviewerTask = [
      `Issue #${ctx.issue.number}: ${ctx.issue.title}`,
      "",
      ctx.issue.body,
      "",
      "## Plan",
      planMd,
      "",
      `## Diff against ${wt.baseBranch}`,
      "",
      reviewDiff,
      "",
      `Review the implementation in this diff (you are read-only).`,
      `Return ONLY one JSON object with exactly this shape and nothing else:`,
      `Keep every string field SHORT (under ~120 characters each), avoid prose, and keep arrays small — the response must fit in a single short message.`,
      `{"verdict": "APPROVE" | "REQUEST_CHANGES", "blockingIssues": ["..."], "nonBlockingNotes": ["..."], "rationale": "..."}`,
    ].join("\n");
    const r = await runAgent(
      "reviewer",
      "review",
      reviewerTask,
      policyFor("reviewer", ctx.provider ?? "gemini"),
    );
    if (!r.ok) {
      setPhase("failed");
      pushState();
      await finalize("failed", {}, r.error ?? "reviewer failed");
      return { ok: false, summary: makeSummary("failed", r.error ?? "reviewer failed") };
    }
    if (!ctx.dryRun) {
      const verdict = extractJson<{
        verdict?: string;
        blockingIssues?: string[];
        nonBlockingNotes?: string[];
        rationale?: string;
      }>(r.text);
      const normalized = (verdict?.verdict ?? "").trim().toUpperCase();
      const isRequestChanges = normalized === "REQUEST_CHANGES";
      const isApprove = normalized === "APPROVE";
      if (isRequestChanges || !isApprove) {
        const reviewerFeedback = isRequestChanges
          ? [verdict?.rationale, ...(verdict?.blockingIssues ?? [])].filter(Boolean).join("\n") ||
            "reviewer requested changes"
          : (verdict?.verdict === undefined
              ? "reviewer verdict missing/empty"
              : `unrecognized reviewer verdict "${verdict.verdict}" (expected APPROVE or REQUEST_CHANGES)`);
        if (fixRoundsUsed < AUTO_FIX_MAX_ROUNDS) {
          fixRoundsUsed += 1;
          feedback = reviewerFeedback;
          await logLine(
            ctx.rootDir,
            `reviewer requested changes — coder auto-fix round ${fixRoundsUsed}/${AUTO_FIX_MAX_ROUNDS}`,
          );
          await sorEmit(ctx, {
            event_type: "phase",
            actor: "manager",
            payload: {
              phase: "review",
              status: "changes_requested",
              iteration: iter,
              autofix_round: fixRoundsUsed,
              autofix_max_rounds: AUTO_FIX_MAX_ROUNDS,
              feedback: reviewerFeedback,
            },
          });
          continue;
        }
        setPhase("failed");
        pushState();
        await logLine(ctx.rootDir, "reviewer rejected after final auto-fix round");
        await finalize("failed", {}, reviewerFeedback);
        return { ok: false, summary: makeSummary("failed", reviewerFeedback) };
      }
    }

    approved = true;
    break;
  }

  if (!approved) {
    setPhase("failed");
    pushState();
    await finalize("failed", {}, "could not reach an approved implementation");
    return { ok: false, summary: makeSummary("failed", "could not reach an approved implementation") };
  }

  return { ok: true, iterationsUsed };
}
