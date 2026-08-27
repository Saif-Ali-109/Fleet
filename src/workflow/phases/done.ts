import { collapseConsecutiveModels } from "../../utils/models.ts";
import { logBlock, logLine } from "../../memory/sessionLog.ts";
import { generateMemory } from "../../db/queries/summaryReport.ts";
import { db } from "../../db/client.ts";
import type { DashboardState } from "../../tui/dashboard.ts";
import type {
  AgentResult,
  Role,
  RunContext,
} from "../../types.ts";
import type { RunStatus, RunSummary, WebFeed } from "../../orchestrator.ts";
import type { ScoutTracker } from "../scoutTracker.ts";
import type { SorEvent } from "../../sor/events.ts";

type Phase = DashboardState["phase"];

const ROLES: Role[] = ["analyzer", "planner", "coder", "tester", "reviewer", "pr"];

export interface DonePhaseOpts {
  ctx: RunContext;
  runId: string | undefined;
  prUrl: string | undefined;
  agents: Record<Role, AgentResult>;
  scoutTracker: ScoutTracker;
  dash: DashboardState;
  web?: WebFeed;
  setPhase: (phase: Phase | "failed") => void;
  pushState: () => void;
  finalize: (status: string, gateStatus: Record<string, unknown>, reason?: string) => Promise<void>;
  makeSummary: (status: RunStatus, failure?: string) => RunSummary;
  writeResultFile: (summary: RunSummary) => Promise<void>;
  sorEmit: (ctx: RunContext | { runId: string; dryRun?: boolean }, event: Partial<SorEvent>) => Promise<void>;
  iterationsUsed: number;
}

export async function runDonePhase(opts: DonePhaseOpts): Promise<RunSummary> {
  const {
    ctx, runId, prUrl, agents, scoutTracker, dash, web,
    setPhase, pushState, finalize, makeSummary, writeResultFile, sorEmit, iterationsUsed,
  } = opts;

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
    if (a?.attempts) {
      const collapsed = collapseConsecutiveModels(a.attempts.map((x) => x.model));
      if (collapsed.length > 1) {
        fallbackLines.push(
          `- ${role} fell back across ${collapsed.length} models: ${collapsed.join(" -> ")}`,
        );
      }
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
  await writeResultFile(summary);
  await finalize("completed", {
    review: "auto_approved",
  });
  try {
    await generateMemory(ctx.rootDir);
  } catch (e) {
    await logLine(ctx.rootDir, "MEMORY.txt regeneration failed: " + String(e));
  }
  return summary;
}
