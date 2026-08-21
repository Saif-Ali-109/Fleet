import { execFile } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { runWorker } from "./agentRunner.ts";
import { gate } from "./gates.ts";
import type { WorktreeHandle } from "./git/worktree.ts";
import {
  changedFiles,
  cleanupWorktree,
  diffAgainstBase,
  diffStatAgainstBase,
  setupWorktree,
} from "./git/worktree.ts";
import {
  buildSkeletonMap,
  readSelectedFileSymbols,
} from "./git/snapshotReader.ts";
import {
  addIssueLabel,
  commentOnIssue,
  createPr,
  ensureLabels,
  ISSUE_LABEL_DONE,
  ISSUE_LABEL_IN_PROGRESS,
  removeIssueLabel,
  splitRepoSlug,
} from "./github/gh.ts";
import { db, pool } from "./db/client.ts";
import { appendAuditEvent, ensureChain } from "./db/audit.ts";
import type { SorEvent } from "./sor/events.ts";
import { getLastFailedStep } from "./db/checkpoint.ts";
import {
  EXCLUDE_ARTIFACTS,
  execErrorText,
  runCoder,
} from "./workflow/coder.ts";
import { runTester } from "./workflow/tester.ts";
import { ScoutTracker } from "./workflow/scoutTracker.ts";
import { detectTestCommand } from "./runner/backends.ts";
import { generateMemory } from "./db/queries/summaryReport.ts";
import { logBlock, logLine, resetSessionLog } from "./memory/sessionLog.ts";
import { policyFor } from "./models/modelPolicy.ts";
import { MAX_IMPL_ITERATIONS, planRoute } from "./router.ts";
import type { DashboardState } from "./tui/dashboard.ts";
import { newDashboardState, renderDashboard } from "./tui/dashboard.ts";
import type {
  AgentResult,
  Backend,
  FixSpec,
  Issue,
  Plan,
  Role,
  RolePolicy,
  RunContext,
} from "./types.ts";

export type RunStatus = "completed" | "aborted" | "failed";

/** Live web-mirror hooks; the web dashboard pushes these on every TUI render/text chunk. */
export interface WebFeed {
  pushState(d: DashboardState): void;
  pushOutput(role: Role, text: string): void;
  pushAgentEvent?(role: Role, event: Record<string, unknown>): void;
  pushFinal?(phase: DashboardState["phase"], prUrl?: string): void;
}

export interface RunSummary {
  runId: string;
  repo: string;
  issue: number;
  status: RunStatus;
  prUrl?: string;
  failure?: string;
  backend: Backend;
  agents: Record<Role, AgentResult>;
  totalCostUsd: number;
  iterationsUsed: number;
  startedAt: number;
  endedAt: number;
}

const ROLES: Role[] = ["analyzer", "planner", "coder", "tester", "reviewer", "pr"];
type Phase = DashboardState["phase"];

/** Cap on the diff sent to the reviewer task (tunable). Gate 3 uses a stat summary instead. */
const MAX_REVIEW_DIFF_CHARS = Number(process.env.MAX_REVIEW_DIFF_CHARS ?? 25_000);

/** Strip optional ```json fences and parse the first balanced {...} object in `text`. */
export function extractJson<T>(text: string): T | null {
  const cleaned = text.replace(/```(?:json)?/gi, "");
  const start = cleaned.indexOf("{");
  if (start === -1) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < cleaned.length; i++) {
    const ch = cleaned[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === "{") depth += 1;
    else if (ch === "}") {
      depth -= 1;
      if (depth === 0) {
        try {
          return JSON.parse(cleaned.slice(start, i + 1)) as T;
        } catch {
          return null;
        }
      }
    }
  }
  // Free OpenCode Zen models cap output tokens, so responses can be truncated mid-JSON.
  // Salvage the unclosed object by appending closing quote/brace/array tails until it parses.
  const base = cleaned.slice(start);
  const maxK = Math.min(depth, 25);
  for (let k = 1; k <= maxK; k++) {
    const closes = "}".repeat(k);
    for (const tail of ['"' + closes, closes, "]" + closes, '"' + "]" + closes]) {
      try {
        return JSON.parse(base + tail) as T;
      } catch {
        // try the next candidate tail
      }
    }
  }
  return null;
}

/**
 * Build a factual git commit message from the approved plan's approach line,
 * e.g. `plan.approach` "Validate the range before emitting an event" →
 * `fix: validate the range before emitting an event`.
 *
 * Rule: commit messages are factual and NEVER reference the issue number —
 * `Closes #N` belongs only in the PR body (merge-time close). Throws when the
 * plan has no approach text, so the caller surfaces a clear phase failure.
 */
export function commitMessageFor(plan: Plan, issue: Issue): string {
  const text = (plan.approach ?? "").trim();
  if (!text) {
    throw new Error(`cannot build a factual commit message for issue #${issue.number}: plan.approach is empty`);
  }
  const firstLine = text.split("\n")[0] as string;
  // Drop a leading imperative ("Fix", "Fixes", …) so the message reads
  // "fix: validate …" instead of "fix: Fix validate …".
  const stripped = firstLine.replace(/^\s*(?:fix(?:es)?)\s*[:.-]?\s+/i, "");
  let body = (stripped.charAt(0).toLowerCase() + stripped.slice(1)).trim();
  body = body.replace(/[.\s]+$/, "");
  const MAX_SUBJECT = 72;
  const prefix = "fix: ";
  if (prefix.length + body.length > MAX_SUBJECT) {
    body = body.slice(0, MAX_SUBJECT - prefix.length - 1) + "…";
  }
  return `${prefix}${body}`;
}

/**
 * Non-fatal append of one signed audit event to the System of Record.
 * Builds a full SorEvent from `event` overrides (defaulting event_type to
 * "phase", actor to "manager", backend to the run's backend), with run_id from
 * `ctx` and created_at = now. Every error is swallowed with a warning so a
 * missing DB or SOR_SIGNING_KEY never aborts a real run. Phase/finalize events
 * are recorded even for dry-run runs (workers are stubbed there, so no tool
 * calls, but the lifecycle must still chain) — only the hook-file drain and
 * spawn/tool events are dry-run-agnostic by nature.
 */
async function sorEmit(
  ctx: RunContext | { runId: string; dryRun?: boolean },
  event: Partial<SorEvent>,
): Promise<void> {
  const backend = "backend" in ctx ? ctx.backend : undefined;
  const sorEvent: SorEvent = {
    run_id: ctx.runId,
    event_type: event.event_type ?? "phase",
    actor: event.actor ?? "manager",
    backend: event.backend ?? backend ?? null,
    tool_name: event.tool_name ?? null,
    tool_input: event.tool_input ?? null,
    tool_output: event.tool_output ?? null,
    payload: event.payload ?? {},
    created_at: new Date().toISOString(),
  };
  try {
    await appendAuditEvent(pool, sorEvent);
  } catch (e) {
    console.warn(`[sor] appendAuditEvent failed (non-fatal): ${String(e)}`);
  }
}

// The Manager (not an LLM): issue intake → 3 human gates → 6 workers → PR.
export async function runOrchestrator(
  ctx: RunContext,
  opts: { interactive: boolean; web?: WebFeed },
): Promise<RunSummary> {
  const startedAt = Date.now();
  const web = opts.web;
  const dash = newDashboardState(ctx.runId, ctx.issue.repo, ctx.issue.number, ctx.backend);
  const agents = {} as Record<Role, AgentResult>;
  const scoutTracker = new ScoutTracker();
  let runId: string | undefined;
  let prUrl: string | undefined;
  let iterationsUsed = 0;
  // Set once the worktree is up (or the dry-run stub replaces it); every
  // finalize() branch tears it down so we never leak linked worktrees.
  let wt: WorktreeHandle | undefined;

  const render = () => process.stdout.write(renderDashboard(dash) + "\n");
  const pushState = () => {
    render();
    web?.pushState(dash);
  };
  const setPhase = (phase: Phase | "failed") => {
    (dash as { phase: string }).phase = phase;
  };
  const totalCostUsd = (): number => {
    let sum = 0;
    for (const role of ROLES) {
      const a = agents[role];
      if (a) sum += a.costUsd ?? 0;
    }
    return sum;
  };
  const makeSummary = (status: RunStatus, failure?: string): RunSummary => ({
    runId: ctx.runId,
    repo: ctx.issue.repo,
    issue: ctx.issue.number,
    status,
    prUrl,
    failure,
    backend: ctx.backend ?? "opencode",
    agents,
    totalCostUsd: totalCostUsd(),
    iterationsUsed,
    startedAt,
    endedAt: Date.now(),
  });
  const finalize = async (
    status: string,
    gateStatus: Record<string, unknown>,
    reason?: string,
  ): Promise<void> => {
    await sorEmit(ctx, {
      event_type: "finalize",
      actor: "manager",
      payload: {
        status,
        pr_url: prUrl ?? null,
        total_cost: totalCostUsd(),
        failure: reason ?? null,
      },
    });
    if (runId) {
      await db.finalizeRun({
        run_id: runId,
        pr_url: prUrl ?? null,
        total_cost: totalCostUsd(),
        gate_status: JSON.stringify(gateStatus),
        status,
      });
    }
    // Issue lifecycle (0.1): labels + comment. All non-fatal, best-effort, and
    // skipped entirely on dry-run — a gh failure here must never change the
    // run's outcome. Completed = remove in-progress, mark done (PR created);
    // failed/aborted = remove in-progress, comment the reason.
    if (!ctx.dryRun) {
      const { owner, repo } = splitRepoSlug(ctx.issue.repo);
      try {
        await ensureLabels(owner, repo, [ISSUE_LABEL_IN_PROGRESS, ISSUE_LABEL_DONE]);
        await removeIssueLabel(owner, repo, ctx.issue.number, ISSUE_LABEL_IN_PROGRESS);
        if (status === "completed") {
          await addIssueLabel(owner, repo, ctx.issue.number, ISSUE_LABEL_DONE);
          const lines = [
            `Managed run \`${ctx.runId}\` completed.`,
            prUrl ? `- PR: ${prUrl}` : "- PR: (none)",
            `- Total cost: $${totalCostUsd().toFixed(4)}`,
            `- Backend: ${ctx.backend ?? "opencode"}`,
          ].join("\n");
          await commentOnIssue(owner, repo, ctx.issue.number, lines);
        } else {
          const suffix = reason ? `: ${reason}` : "";
          await commentOnIssue(
            owner,
            repo,
            ctx.issue.number,
            `Managed run \`${ctx.runId}\` ${status}${suffix}.`,
          );
        }
      } catch (e) {
        console.warn(`[lifecycle] finalize (${status}) failed (non-fatal): ${String(e)}`);
      }
    }
    // Worktree hygiene: every terminal path (completed/failed/aborted) tears
    // down the linked worktree. Best-effort — a cleanup failure must never
    // change the run's outcome (AGENTS.md: all cleanup is non-fatal). Dry-run
    // creates a plain directory stub, not a real git worktree, so skip it.
    if (wt && !ctx.dryRun) {
      try {
        await cleanupWorktree(wt);
      } catch (e) {
        console.warn(`[worktree] cleanup failed (non-fatal): ${String(e)}`);
      }
    }
  };

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
    const onEvent = (ev: Record<string, unknown>) => {
      if (scoutTracker.observe(role, ev)) {
        void logLine(ctx.rootDir, `[scout] invoked by ${role} (call ${scoutTracker.total}, ${scoutTracker.countFor(role)}/${role})`);
      }
      web?.pushAgentEvent?.(role, ev);
    };
    const res = await runWorker(role, task, ctx, policy, { onText, onEvent });
    agents[role] = res;
    dash.agents[role] = {
      role,
      state: res.ok ? "done" : "failed",
      model: res.model,
      sessionID: res.sessionID ?? undefined,
      tokens: res.tokens,
      costUsd: res.costUsd,
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
    }
    if (res.attempts && res.attempts.length > 1) {
      await logLine(
        ctx.rootDir,
        `[${role}] fell back across ${res.attempts.length} models: ${res.attempts.map((a) => a.model).join(" -> ")}`,
      );
    }
    await logLine(ctx.rootDir, `${role} ${res.ok ? "done" : "failed"}${res.error ? `: ${res.error}` : ""}`);
    return res;
  };

  try {
    try {
      await ensureChain(pool);
    } catch (e) {
      console.warn(`[sor] ensureChain failed (non-fatal): ${String(e)}`);
    }
    await resetSessionLog(ctx.rootDir, ctx.runDir, ctx.runId, {
      repo: ctx.issue.repo,
      issue: ctx.issue.number,
      title: ctx.issue.title,
    });
    await logLine(ctx.rootDir, "run started");
    if (!ctx.dryRun) {
      runId = await db.createRun({
        repo: ctx.issue.repo,
        issue_number: ctx.issue.number,
        backend: ctx.backend ?? "opencode",
      });
      await db.updateRunStatus({ run_id: runId, phase: "start", status: "running", iteration: 0 });
    }
    await sorEmit(ctx, {
      event_type: "phase",
      actor: "manager",
      payload: { phase: "start", status: "running", iteration: 0 },
    });

    if (ctx.dryRun) {
      await mkdir(ctx.runDir, { recursive: true });
      await mkdir(ctx.worktreeDir, { recursive: true });
      wt = {
        repoDir: join(ctx.runDir, "repo"),
        worktreeDir: ctx.worktreeDir,
        branch: ctx.branch,
        baseBranch: "main",
      };
    } else {
      wt = await setupWorktree(ctx.repoUrl, ctx.runDir, ctx.branch, ctx.cloneDir);
      await logLine(ctx.rootDir, "worktree ready at " + wt.worktreeDir + " base " + wt.baseBranch);
    }

    setPhase("gate1");
    pushState();
    if (runId) {
      await db.updateRunStatus({ run_id: runId, phase: "gate1", status: "running", iteration: 0 });
    }
    await sorEmit(ctx, {
      event_type: "phase",
      actor: "manager",
      payload: { phase: "gate1", status: "running", iteration: 0 },
    });
    const g1 = await gate(
      "Gate 1 · Confirm intent",
      `Issue #${ctx.issue.number}: ${ctx.issue.title}\n\n${ctx.issue.body}`,
      { interactive: opts.interactive, captureFeedbackOnReject: false },
    );
    if (!g1.approved) {
      setPhase("aborted");
      pushState();
      await logLine(ctx.rootDir, "run aborted at gate 1");
      await finalize("aborted", {}, "rejected at Gate 1");
      return makeSummary("aborted");
    }
    dash.lastGate = "gate1";

    const skeleton = await buildSkeletonMap(ctx.worktreeDir);

    const analyzerTask = [
      `Issue #${ctx.issue.number}: ${ctx.issue.title}`,
      "",
      ctx.issue.body,
      "",
      "## Skeleton",
      "File paths and symbol headers are provided separately (JIT).",
      "Do not use read/grep/glob tools; rely on the provided structure.",
      "If you need a specific file's full content, it will be provided JIT (just-in-time) after planning.",
      "",
      `Return ONLY one JSON object with exactly this shape and nothing else:`,
      `{"summary": "...", "rootCause": "...", "suspectFiles": ["..."], "affectedSymbols": ["..."], "reproduction": "...", "testStrategy": "...", "risks": ["..."], "confidence": "low" | "medium" | "high"}`,
    ].join("\n");
    const a = await runAgent("analyzer", "analyze", analyzerTask, policyFor("analyzer", ctx.backend));
    if (!a.ok) {
      setPhase("failed");
      pushState();
      await finalize("failed", {}, a.error ?? "analyzer failed");
      return makeSummary("failed", a.error ?? "analyzer failed");
    }
    if (runId) {
      await db.updateRunStatus({ run_id: runId, phase: "analyze", status: "completed", iteration: 0 });
    }
    await sorEmit(ctx, {
      event_type: "phase",
      actor: "manager",
      payload: { phase: "analyze", status: "completed", iteration: 0 },
    });

    let fixSpec: FixSpec | null = null;
    if (ctx.dryRun) {
      fixSpec = {
        summary: "[dry-run] analyzer findings",
        rootCause: "[dry-run]",
        suspectFiles: [],
        affectedSymbols: [],
        reproduction: "[dry-run]",
        testStrategy: "[dry-run]",
        risks: [],
        confidence: "low",
      };
    } else {
      fixSpec = extractJson<FixSpec>(a.text);
    }
    if (!fixSpec) {
      setPhase("failed");
      pushState();
      await finalize("failed", {}, "analyzer did not return a valid FixSpec JSON");
      return makeSummary("failed", "analyzer did not return a valid FixSpec JSON");
    }
await writeFile(join(ctx.runDir, "fix-spec.json"), JSON.stringify(fixSpec, null, 2) + "\n");

    const plannerTask = [
      `Issue #${ctx.issue.number}: ${ctx.issue.title}`,
      "",
      ctx.issue.body,
      "",
      "## Analyzer findings",
      "",
      JSON.stringify(fixSpec, null, 2),
      "",
      ...(skeleton.files.length > 0
        ? [
            "## Skeleton",
            ...(function () {
              const lines: string[] = [];
              for (const f of skeleton.files.slice(0, 20)) {
                lines.push(`Path: ${f.path}`);
                for (const s of f.symbols.slice(0, 3)) {
                  lines.push(`  ${s.kind}:${s.name}@L${s.line}`);
                }
              }
              return lines;
            })(),
            "",
          ]
        : []),
      `Design a concrete implementation plan for the fix.`,
      `Return ONLY one JSON object with exactly this shape and nothing else:`,
      `Keep every string field SHORT (under ~120 characters each), avoid prose, and keep arrays small — the response must fit in a single short message.`,
      `{"approach": "...", "steps": ["..."], "filesToChange": ["..."], "testsToAddOrUpdate": ["..."], "acceptanceCriteria": ["..."], "outOfScope": ["..."], "filesNeeded": "string[]"}`,
    ].join("\n");
    const p = await runAgent("planner", "plan", plannerTask, policyFor("planner", ctx.backend));
    if (!p.ok) {
      setPhase("failed");
      pushState();
      await finalize("failed", {}, p.error ?? "planner failed");
      return makeSummary("failed", p.error ?? "planner failed");
    }
    // C3: Parse the planner's JSON response for filesNeeded.
    let filesNeeded: string[] = [];
    try {
      const parsed = JSON.parse(p.text);
      filesNeeded = parsed.filesNeeded ?? parsed.files_needed ?? [];
      if (!Array.isArray(filesNeeded)) filesNeeded = [];
    } catch {
      filesNeeded = [];
    }
    if (runId) {
      await db.updateRunStatus({ run_id: runId, phase: "plan", status: "completed", iteration: 0 });
    }
    await sorEmit(ctx, {
      event_type: "phase",
      actor: "manager",
      payload: { phase: "plan", status: "completed", iteration: 0 },
    });

    let plan: Plan;
    if (ctx.dryRun) {
      plan = {
        approach: "[dry-run] approach",
        steps: ["[dry-run] implement the fix"],
        filesToChange: [],
        testsToAddOrUpdate: [],
        acceptanceCriteria: ["[dry-run] tests pass"],
        outOfScope: [],
      };
    } else {
      const parsed = extractJson<Plan>(p.text);
      if (!parsed) {
        setPhase("failed");
        pushState();
        await finalize("failed", {}, "planner did not return a valid Plan JSON");
        return makeSummary("failed", "planner did not return a valid Plan JSON");
      }
      plan = parsed;
    }

    // Factual commit message from the approved plan's approach; used for both the
    // coder's own commit and the orchestrator's residual commit. Never `Fix #N`.
    const commitMessage = commitMessageFor(plan, ctx.issue);

    const planMd = [
      `# Plan — ${ctx.issue.repo}#${ctx.issue.number}`,
      "",
      "## Approach",
      "",
      plan.approach,
      "",
      "## Steps",
      ...plan.steps.map((s, i) => `${i + 1}. ${s}`),
      "",
      "## Files to change",
      ...plan.filesToChange.map((f) => `- ${f}`),
      "",
      "## Tests to add/update",
      ...plan.testsToAddOrUpdate.map((t) => `- ${t}`),
      "",
      "## Acceptance criteria",
      ...plan.acceptanceCriteria.map((c) => `- ${c}`),
      "",
      "## Out of scope",
      ...plan.outOfScope.map((o) => `- ${o}`),
    ].join("\n");
    await writeFile(join(ctx.runDir, "plan.md"), planMd + "\n");

    setPhase("gate2");
    pushState();
    if (runId) {
      await db.updateRunStatus({ run_id: runId, phase: "gate2", status: "running", iteration: iterationsUsed });
    }
    await sorEmit(ctx, {
      event_type: "phase",
      actor: "manager",
      payload: { phase: "gate2", status: "running", iteration: iterationsUsed },
    });
    const g2 = await gate("Gate 2 · Approve plan", planMd, {
      interactive: opts.interactive,
      captureFeedbackOnReject: false,
    });
    if (!g2.approved) {
      setPhase("aborted");
      pushState();
      await logLine(ctx.rootDir, "run aborted at gate 2");
      await finalize("aborted", {}, "rejected at Gate 2");
      return makeSummary("aborted");
    }
    dash.lastGate = "gate2";

    const route = planRoute(ctx.issue);
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
      ];
      if (feedback) lines.push("", "FEEDBACK FROM REVIEW OR GATE:", feedback);
      return lines.join("\n");
    };

    let feedback: string | undefined;
    let approved = false;

    const testCommand = detectTestCommand(ctx.worktreeDir);
    await logLine(ctx.rootDir, `detected test command: ${testCommand}`);

    for (let iter = 1; iter <= MAX_IMPL_ITERATIONS; iter++) {
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
        const policy = policyFor(role, ctx.backend);

        if (!runId) {
          const res = await runAgent(role, "implement", task, policy);
          if (!res.ok) {
            setPhase("failed");
            pushState();
            await finalize("failed", {}, res.error ?? `${role} failed`);
            return makeSummary("failed", res.error ?? `${role} failed`);
          }
          continue;
        }

        setPhase("implement");
        dash.agents[role] = { role, state: "running", model: policy.model };
        pushState();

        const onText = (t: string) => web?.pushOutput(role, t);
        const onEvent = (ev: Record<string, unknown>) => {
          if (scoutTracker.observe(role, ev)) {
            void logLine(ctx.rootDir, `[scout] invoked by ${role} (call ${scoutTracker.total}, ${scoutTracker.countFor(role)}/${role})`);
          }
          web?.pushAgentEvent?.(role, ev);
        };

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
            { task, policy, worktreeDir: ctx.worktreeDir, testCommand, expectPass: true, onText, onEvent },
            runId,
            iter,
          );
          ar = r.agentResult;
          ok = r.ok && !(ar && !ar.ok);
          error = r.error ?? (ar && !ar.ok ? ar.error : undefined);
        }

        // Record cost/usage + agent action for coder/tester (mirrors runAgent).
        if (ar) {
          agents[role] = ar;
        }
        dash.agents[role] = {
          role,
          state: ok ? "done" : "failed",
          model: policy.model,
          sessionID: ar?.sessionID ?? undefined,
          tokens: ar?.tokens,
          costUsd: ar?.costUsd,
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
        }
        if (!ok) {
          setPhase("failed");
          pushState();
          await finalize("failed", {}, error ?? `${role} failed`);
          return makeSummary("failed", error ?? `${role} failed`);
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
        policyFor("reviewer", ctx.backend),
      );
      if (!r.ok) {
        setPhase("failed");
        pushState();
        await finalize("failed", {}, r.error ?? "reviewer failed");
        return makeSummary("failed", r.error ?? "reviewer failed");
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
        // Missing / malformed / unrecognized verdict is a soft-fail: require a
        // human to resolve it rather than silently fast-tracking to Gate 3.
        if (isRequestChanges || !isApprove) {
          const feedback = isRequestChanges
            ? [verdict?.rationale, ...(verdict?.blockingIssues ?? [])].filter(Boolean).join("\n") ||
              "reviewer requested changes"
            : (verdict?.verdict === undefined
                ? "reviewer verdict missing/empty"
                : `unrecognized reviewer verdict "${verdict.verdict}" (expected APPROVE or REQUEST_CHANGES)`);
          if (iter < MAX_IMPL_ITERATIONS) {
            continue;
          }
          setPhase("failed");
          pushState();
          await finalize("failed", {}, feedback);
          return makeSummary("failed", feedback);
        }
      }

      const files = ctx.dryRun ? [] : await changedFiles(wt);
      const diffStat = ctx.dryRun ? "[dry-run] stat unavailable" : await diffStatAgainstBase(wt);
      const gateBody = [
        "Changed files:",
        ...files.map((f) => `- ${f}`),
        "",
        `## Diff stat against ${wt.baseBranch}`,
        "",
        diffStat,
        "",
        "The full diff (up to 60,000 chars) was already reviewed by the Reviewer above; this file-level summary is for final sign-off. Reject with feedback to trigger another iteration.",
      ].join("\n");
      setPhase("gate3");
      pushState();
      if (runId) {
        await db.updateRunStatus({ run_id: runId, phase: "gate3", status: "running", iteration: iterationsUsed });
      }
      await sorEmit(ctx, {
        event_type: "phase",
        actor: "manager",
        payload: { phase: "gate3", status: "running", iteration: iterationsUsed },
      });
      const g3 = await gate("Gate 3 · Approve final diff", gateBody, {
        interactive: opts.interactive,
        captureFeedbackOnReject: true,
      });
      if (g3.approved) {
        approved = true;
        break;
      }
      if (g3.feedback && iter < MAX_IMPL_ITERATIONS) {
        feedback = g3.feedback;
        continue;
      }
      setPhase("aborted");
      pushState();
      await logLine(ctx.rootDir, "run aborted at gate 3");
      await finalize("aborted", {}, "rejected at Gate 3");
      return makeSummary("aborted");
    }

    if (!approved) {
      setPhase("failed");
      pushState();
      await finalize("failed", {}, "could not reach an approved implementation");
      return makeSummary("failed", "could not reach an approved implementation");
    }

    const prTask = [
      `Issue #${ctx.issue.number}: ${ctx.issue.title}`,
      "",
      ctx.issue.body,
      "",
      `The implementation is on branch ${ctx.branch} in ${ctx.worktreeDir}, based on ${wt.baseBranch}.`,
      `Push the branch to origin, then open a PR against ${wt.baseBranch} with \`gh pr create --repo ${ctx.issue.repo}\`.`,
      `PR title: Fix #${ctx.issue.number}: ${ctx.issue.title}`,
      `PR body must start with: Closes #${ctx.issue.number}`,
      `Managed run: ${ctx.runId}.`,
    ].join("\n");
    const pr = await runAgent("pr", "pr", prTask, policyFor("pr", ctx.backend));
    const extractPrUrl = (text: string): string | undefined =>
      /https?:\/\/[^\s)"']+\/pull\/\d+/.exec(text)?.[0];
    if (pr.ok) {
      prUrl = extractPrUrl(pr.text);
    }
    if (!pr.ok || (!ctx.dryRun && !prUrl)) {
      if (ctx.dryRun) {
        prUrl = undefined;
      } else {
        let found = false;
        try {
          const exec = promisify(execFile);
          const { stdout } = await exec("gh", [
            "pr",
            "view",
            ctx.branch,
            "--repo",
            ctx.issue.repo,
            "--json",
            "url,number",
          ]);
          const parsed = JSON.parse(stdout);
          if (typeof parsed?.url === "string" && parsed.url) {
            prUrl = parsed.url;
            found = true;
          }
        } catch {
          // no existing PR (or lookup failed); fall through to createPr
        }
        if (!found) {
          try {
            const exec = promisify(execFile);
            await exec("git", [
              "-C",
              ctx.worktreeDir,
              "push",
              "-u",
              "origin",
              ctx.branch,
            ]);
            const fallback = await createPr(ctx.issue.repo, {
              head: ctx.branch,
              base: wt.baseBranch,
              title: `Fix #${ctx.issue.number}: ${ctx.issue.title}`,
              body: `Closes #${ctx.issue.number}\n\nManaged run ${ctx.runId}.`,
            });
            prUrl = fallback.url || extractPrUrl(fallback.raw);
          } catch (e) {
            const m = /https?:\/\/[^\s)"']+/.exec(String(e));
            prUrl = m?.[0];
            if (!prUrl) {
              await logLine(
                ctx.rootDir,
                `PR creation failed and no PR URL recoverable: ${String(e)}`,
              );
            }
          }
        }
      }
    }

    setPhase("done");
    pushState();
    if (runId) {
      await db.updateRunStatus({ run_id: runId, phase: "done", status: "completed", iteration: iterationsUsed });
    }
    await sorEmit(ctx, {
      event_type: "phase",
      actor: "manager",
      payload: { phase: "done", status: "completed", iteration: iterationsUsed },
    });
    const summary = makeSummary("completed");
    const fallbackLines: string[] = [];
    for (const role of ROLES) {
      const a = agents[role];
      if (a?.attempts && a.attempts.length > 1) {
        fallbackLines.push(
          `- ${role} fell back across ${a.attempts.length} models: ${a.attempts.map((x) => x.model).join(" -> ")}`,
        );
      }
    }
    const tokenLines = ROLES
      .filter((role) => (agents[role]?.tokens?.total ?? 0) > 0)
      .map((role) => {
        const t = agents[role]!.tokens!;
        const c = agents[role]!.costUsd;
        return `- ${role}: in ${t.input.toLocaleString()} · out ${t.output.toLocaleString()} · cached ${t.cached.toLocaleString()} · total ${t.total.toLocaleString()} tok${c !== undefined ? ` · $${c.toFixed(4)}` : ""}`;
      });
    await logBlock(
      ctx.rootDir,
      "Run complete",
      [
        `- Status: ${summary.status}`,
        prUrl ? `- PR: ${prUrl}` : "- PR: (none)",
        `- Total cost: $${summary.totalCostUsd.toFixed(4)}`,
        ...tokenLines,
        `- Iterations used: ${iterationsUsed}`,
        `- Run dir: ${ctx.runDir}`,
        `- ${scoutTracker.summary()}`,
        ...fallbackLines,
      ].join("\n"),
    );
    await writeFile(join(ctx.runDir, "result.json"), JSON.stringify(summary, null, 2) + "\n");
    await finalize("completed", { gate1: "approved", gate2: "approved", gate3: "approved" });
    try {
      await generateMemory(ctx.rootDir);
    } catch (e) {
      await logLine(ctx.rootDir, "MEMORY.md regeneration failed: " + String(e));
    }
    return summary;
  } catch (e) {
    await logLine(ctx.rootDir, "orchestrator error: " + String(e));
    setPhase("failed");
    pushState();
    await finalize("failed", {}, String(e));
    return makeSummary("failed", String(e));
  }
}
