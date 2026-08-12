import { execFile } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { runWorker } from "./agentRunner.js";
import { gate } from "./gates.js";
import type { WorktreeHandle } from "./git/worktree.js";
import { changedFiles, diffAgainstBase, diffStatAgainstBase, setupWorktree } from "./git/worktree.js";
import { createPr } from "./github/gh.js";
import { db } from "./db/client.js";
import { generateMemoryMarkdown } from "./db/queries/summaryReport.js";
import { logBlock, logLine, resetSessionLog } from "./memory/sessionLog.js";
import { policyFor } from "./models/modelPolicy.js";
import { MAX_IMPL_ITERATIONS, planRoute } from "./router.js";
import type { DashboardState } from "./tui/dashboard.js";
import { newDashboardState, renderDashboard } from "./tui/dashboard.js";
import type { AgentResult, Backend, FixSpec, Plan, Role, RolePolicy, RunContext } from "./types.js";

export type RunStatus = "completed" | "aborted" | "failed";

/** Live web-mirror hooks; the web dashboard pushes these on every TUI render/text chunk. */
export interface WebFeed {
  pushState(d: DashboardState): void;
  pushOutput(role: Role, text: string): void;
  pushAgentEvent?(role: Role, event: Record<string, unknown>): void;
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

// The Manager (not an LLM): issue intake → 3 human gates → 6 workers → PR.
export async function runOrchestrator(
  ctx: RunContext,
  opts: { interactive: boolean; web?: WebFeed },
): Promise<RunSummary> {
  const startedAt = Date.now();
  const web = opts.web;
  const dash = newDashboardState(ctx.runId, ctx.issue.repo, ctx.issue.number, ctx.backend);
  const agents = {} as Record<Role, AgentResult>;
  let runId: string | undefined;
  let prUrl: string | undefined;
  let iterationsUsed = 0;

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
  ): Promise<void> => {
    if (runId) {
      await db.finalizeRun({
        run_id: runId,
        pr_url: prUrl ?? null,
        total_cost: totalCostUsd(),
        gate_status: JSON.stringify(gateStatus),
      });
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
    const onEvent = (ev: Record<string, unknown>) => web?.pushAgentEvent?.(role, ev);
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
    await resetSessionLog(ctx.rootDir, ctx.runDir, ctx.runId, {
      repo: ctx.issue.repo,
      issue: ctx.issue.number,
      title: ctx.issue.title,
    });
    await logLine(ctx.rootDir, "run started");
    runId = await db.createRun({
      repo: ctx.issue.repo,
      issue_number: ctx.issue.number,
      backend: ctx.backend ?? "opencode",
    });
    await db.updateRunStatus({ run_id: runId, phase: "start", status: "running", iteration: 0 });

    let wt: WorktreeHandle;
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
      wt = await setupWorktree(ctx.repoUrl, ctx.runDir, ctx.branch);
      await logLine(ctx.rootDir, "worktree ready at " + wt.worktreeDir + " base " + wt.baseBranch);
    }

    setPhase("gate1");
    pushState();
    if (runId) {
      await db.updateRunStatus({ run_id: runId, phase: "gate1", status: "running", iteration: 0 });
    }
    const g1 = await gate(
      "Gate 1 · Confirm intent",
      `Issue #${ctx.issue.number}: ${ctx.issue.title}\n\n${ctx.issue.body}`,
      { interactive: opts.interactive, captureFeedbackOnReject: false },
    );
    if (!g1.approved) {
      setPhase("aborted");
      pushState();
      await logLine(ctx.rootDir, "run aborted at gate 1");
      await finalize("aborted", {});
      return makeSummary("aborted");
    }
    dash.lastGate = "gate1";

    const analyzerTask = [
      `Issue #${ctx.issue.number}: ${ctx.issue.title}`,
      "",
      ctx.issue.body,
      "",
      `Inspect the repository at ${ctx.worktreeDir} (read-only) and diagnose this issue.`,
      `Return ONLY one JSON object with exactly this shape and nothing else:`,
      `Keep every string field SHORT (under ~120 characters each), avoid prose, and keep arrays small — the response must fit in a single short message.`,
      `{"summary": "...", "rootCause": "...", "suspectFiles": ["..."], "affectedSymbols": ["..."], "reproduction": "...", "testStrategy": "...", "risks": ["..."], "confidence": "low" | "medium" | "high"}`,
    ].join("\n");
    const a = await runAgent("analyzer", "analyze", analyzerTask, policyFor("analyzer", ctx.backend));
    if (!a.ok) {
      setPhase("failed");
      pushState();
      await finalize("failed", {});
      return makeSummary("failed", a.error ?? "analyzer failed");
    }
    if (runId) {
      await db.updateRunStatus({ run_id: runId, phase: "analyze", status: "completed", iteration: 0 });
    }

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
      await finalize("failed", {});
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
      `Design a concrete implementation plan for the fix.`,
      `Return ONLY one JSON object with exactly this shape and nothing else:`,
      `Keep every string field SHORT (under ~120 characters each), avoid prose, and keep arrays small — the response must fit in a single short message.`,
      `{"approach": "...", "steps": ["..."], "filesToChange": ["..."], "testsToAddOrUpdate": ["..."], "acceptanceCriteria": ["..."], "outOfScope": ["..."]}`,
    ].join("\n");
    const p = await runAgent("planner", "plan", plannerTask, policyFor("planner", ctx.backend));
    if (!p.ok) {
      setPhase("failed");
      pushState();
      await finalize("failed", {});
      return makeSummary("failed", p.error ?? "planner failed");
    }
    if (runId) {
      await db.updateRunStatus({ run_id: runId, phase: "plan", status: "completed", iteration: 0 });
    }

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
        await finalize("failed", {});
        return makeSummary("failed", "planner did not return a valid Plan JSON");
      }
      plan = parsed;
    }

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
    const g2 = await gate("Gate 2 · Approve plan", planMd, {
      interactive: opts.interactive,
      captureFeedbackOnReject: false,
    });
    if (!g2.approved) {
      setPhase("aborted");
      pushState();
      await logLine(ctx.rootDir, "run aborted at gate 2");
      await finalize("aborted", {});
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

    for (let iter = 1; iter <= MAX_IMPL_ITERATIONS; iter++) {
      iterationsUsed = iter;
      dash.loopIteration = iter;

      for (const role of implRoles) {
        const res = await runAgent(
          role,
          "implement",
          implTask(feedback),
          policyFor(role, ctx.backend),
        );
        if (!res.ok) {
          setPhase("failed");
          pushState();
          await finalize("failed", {});
          return makeSummary("failed", res.error ?? `${role} failed`);
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
              ":!__pycache__",
            ]);
            try {
              await exec("git", [
                "-C",
                ctx.worktreeDir,
                "commit",
                "-m",
                `Fix #${ctx.issue.number}: ${ctx.issue.title} (orchestrated commit)`,
              ]);
              await logLine(
                ctx.rootDir,
                `orchestrated commit created on ${ctx.branch}`,
              );
            } catch (e) {
              await logLine(
                ctx.rootDir,
                `orchestrated commit failed (non-fatal): ${String(e)}`,
              );
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
        await finalize("failed", {});
        return makeSummary("failed", r.error ?? "reviewer failed");
      }
      if (!ctx.dryRun) {
        const verdict = extractJson<{
          verdict?: string;
          blockingIssues?: string[];
          nonBlockingNotes?: string[];
          rationale?: string;
        }>(r.text);
        if (verdict?.verdict === "REQUEST_CHANGES") {
          if (iter < MAX_IMPL_ITERATIONS) {
            feedback =
              [verdict.rationale, ...(verdict.blockingIssues ?? [])].filter(Boolean).join("\n") ||
              "reviewer requested changes";
            continue;
          }
          setPhase("failed");
          pushState();
          await finalize("failed", {});
          return makeSummary("failed", "reviewer still requesting changes after max iterations");
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
      await finalize("aborted", {});
      return makeSummary("aborted");
    }

    if (!approved) {
      setPhase("failed");
      pushState();
      await finalize("failed", {});
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
    await logBlock(
      ctx.rootDir,
      "Run complete",
      [
        `- Status: ${summary.status}`,
        prUrl ? `- PR: ${prUrl}` : "- PR: (none)",
        `- Total cost: $${summary.totalCostUsd.toFixed(4)}`,
        `- Iterations used: ${iterationsUsed}`,
        `- Run dir: ${ctx.runDir}`,
        ...fallbackLines,
      ].join("\n"),
    );
    await writeFile(join(ctx.runDir, "result.json"), JSON.stringify(summary, null, 2) + "\n");
    await finalize("completed", { gate1: "approved", gate2: "approved", gate3: "approved" });
    try {
      const md = await generateMemoryMarkdown(ctx.rootDir);
      await writeFile(join(ctx.rootDir, "MEMORY.md"), md);
    } catch (e) {
      await logLine(ctx.rootDir, "MEMORY.md regeneration failed: " + String(e));
    }
    return summary;
  } catch (e) {
    await logLine(ctx.rootDir, "orchestrator error: " + String(e));
    setPhase("failed");
    pushState();
    await finalize("failed", {});
    return makeSummary("failed", String(e));
  }
}
