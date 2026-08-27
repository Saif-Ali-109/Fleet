import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { extractJson } from "../../utils/json.ts";
import { commitMessageFor } from "../../utils/commitMessage.ts";
import { policyFor } from "../../models/modelPolicy.ts";
import { db } from "../../db/client.ts";
import { planRoute, type RouteStep } from "../../router.ts";
import type {
  AgentResult,
  FixSpec,
  Plan,
  RunContext,
  RolePolicy,
  Role,
} from "../../types.ts";
import type { RunStatus, RunSummary } from "../../orchestrator.ts";
import type { DashboardState } from "../../tui/dashboard.ts";
import type { SorEvent } from "../../sor/events.ts";

type Phase = DashboardState["phase"];

export interface PlanPhaseOpts {
  ctx: RunContext;
  fixSpec: FixSpec;
  runAgent: (role: Role, phase: Phase, task: string, policy: RolePolicy) => Promise<AgentResult>;
  setPhase: (phase: Phase | "failed") => void;
  pushState: () => void;
  finalize: (status: string, gateStatus: Record<string, unknown>, reason?: string) => Promise<void>;
  makeSummary: (status: RunStatus, failure?: string) => RunSummary;
  runId: string | undefined;
  sorEmit: (ctx: RunContext | { runId: string; dryRun?: boolean }, event: Partial<SorEvent>) => Promise<void>;
  skeleton: { files: { path: string; symbols: { kind: string; name: string; line: number }[] }[] };
}

export type PlanPhaseResult =
  | { ok: true; plan: Plan; commitMessage: string; planMd: string; route: RouteStep[] }
  | { ok: false; summary: RunSummary };

export async function runPlanPhase(opts: PlanPhaseOpts): Promise<PlanPhaseResult> {
  const { ctx, fixSpec, runAgent, setPhase, pushState, finalize, makeSummary, runId, sorEmit, skeleton } = opts;

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
  const p = await runAgent("planner", "plan", plannerTask, policyFor("planner", ctx.provider ?? "gemini"));
  if (!p.ok) {
    setPhase("failed");
    pushState();
    await finalize("failed", {}, p.error ?? "planner failed");
    return { ok: false, summary: makeSummary("failed", p.error ?? "planner failed") };
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
      return { ok: false, summary: makeSummary("failed", "planner did not return a valid Plan JSON") };
    }
    plan = parsed;
  }

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

  const route = planRoute(ctx.issue);

  return { ok: true, plan, commitMessage, planMd, route };
}
