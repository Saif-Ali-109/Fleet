import type { Backend, Role } from "../types.js";
import type { AgentResult } from "../types.js";

type PhaseName = "idle" | "gate1" | "analyze" | "plan" | "gate2" | "implement" | "review" | "gate3" | "pr" | "done" | "aborted" | "failed";

export interface AgentStatus {
  role: Role;
  state: "pending" | "running" | "done" | "failed";
  model: string;
  sessionID?: string;
  tokens?: AgentResult["tokens"];
  costUsd?: number;
  startedAt?: number;
  endedAt?: number;
  error?: string;
}

export interface DashboardState {
  runId: string;
  repo: string;
  issue: number;
  phase: PhaseName;
  agents: Record<Role, AgentStatus>;
  loopIteration: number;
  lastGate?: string;
  prUrl?: string;
  backend?: Backend;
}

const ROLES: Role[] = ["analyzer", "planner", "coder", "tester", "reviewer", "pr"];

export function newDashboardState(
  runId: string,
  repo: string,
  issue: number,
  backend: Backend = "opencode",
): DashboardState {
  const agents = Object.fromEntries(
    ROLES.map((r) => [r, { role: r, state: "pending" as const, model: "" }]),
  ) as Record<Role, AgentStatus>;
  return { runId, repo, issue, phase: "idle", agents, loopIteration: 1, backend };
}

const BAR_W = 20;
const spinner = (state: string) => (state === "running" ? "⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏".charAt(Math.floor(Date.now() / 90) % 10) : " ");

function renderBar(pct: number): string {
  const filled = Math.round(pct * BAR_W);
  return "█".repeat(filled) + "░".repeat(BAR_W - filled);
}

/** Render the live dashboard as one ANSI-framed block (dimmed: no erase trickery). */
export function renderDashboard(d: DashboardState): string {
  const rows = ROLES.map((r) => {
    const a = d.agents[r];
    const model = a.model.split("/").pop() ?? "";
    const sp = spinner(a.state);
    const bar = a.state === "done" ? renderBar(1) : a.state === "failed" ? renderBar(0) : renderBar(0);
    const meta =
      a.state === "done" && a.costUsd !== undefined
        ? ` $${a.costUsd.toFixed(3)} ${a.tokens?.total?.toLocaleString() ?? ""} tok`
        : a.state === "failed"
          ? ` ✗ ${a.error ?? "failed"}`
          : ` ${model}`;
    const flag = a.state === "done" ? "✓" : a.state === "failed" ? "✗" : a.state === "running" ? "▸" : "·";
    return `  ${flag} ${r.padEnd(9)} [${bar}] ${sp}${meta}`;
  });

  const phasePct = d.phase === "done" ? 1 : d.phase === "aborted" ? 0 : 0.5;

  return [
    `\n┌─ Multi-Orchestration ─ run ${d.runId} ─ ${d.repo}#${d.issue} ─ ${d.backend ?? "opencode"} ────────┐`,
    `│ phase: ${d.phase.padEnd(12)} loop: ${d.loopIteration}  [${renderBar(phasePct)}]`,
    ...rows.map((r) => `│${r}`),
    `└──────────────────────────────────────────────────────────────┘`,
  ].join("\n");
}
