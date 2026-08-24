// Database schema interfaces — source of truth for the persistent tables.
// These mirror migrations/001_init.sql (run_outcomes, agent_actions) and
// migrations/002_agent_steps.sql (agent_steps). trace_events and cost_ledger
// are created by 001 but are reserved for future use — nothing writes them
// today (the dead client write methods were removed).

/**
 * run_outcomes — one row per orchestrator run.
 * Records the high-level outcome of a full issue-to-PR pipeline execution.
 */
export interface RunOutcome {
  run_id: string; // UUID primary key
  repo: string; // "owner/name"
  issue_number: number;
  issue_title: string;
  status: "running" | "completed" | "aborted" | "failed";
  pr_url?: string | null;
  total_cost_usd: number;
  iterations_used: number;
  started_at: Date;
  completed_at: Date | null;
  gate_status: string; // JSON keyed by phase name, e.g. {"review": "auto_approved"} — human gates removed (SPEC D11); keys track phase status
  backend: string; // "gemini" | "openrouter" | "ollama" (provider name for SOR/analytics)
}

/**
 * trace_events — indexed trace events parsed from .jsonl files.
 * Each event corresponds to a single line in a per-agent trace file.
 */
export interface TraceEvent {
  event_id: string; // UUID primary key
  run_id: string; // FK -> run_outcomes.run_id
  role: string; // "analyzer", "planner", etc.
  model: string;
  event_seq: number; // sequence number within trace
  event_type: string; // "text", "step_finish", "error", etc.
  tokens: string; // JSON: {"input": N, "output": N, "reasoning": N, "total": N}
  cost_usd: number;
  trace_path: string; // path to .jsonl file
  created_at: Date;
}

/**
 * agent_actions — parsed agent results with fallback tracking.
 * One row per agent invocation (after all model fallbacks have resolved).
 */
export interface AgentAction {
  action_id: string; // UUID primary key
  run_id: string; // FK -> run_outcomes.run_id
  role: string;
  model: string;
  ok: boolean;
  text: string; // final assembled assistant text
  tokens: string; // JSON: {"input": N, "output": N, "reasoning": N, "total": N}
  cost_usd: number;
  error?: string | null;
  trace_path: string;
  started_at: Date;
  ended_at: Date;
  attempts: string; // JSON array of {model, ok, error}
}

/**
 * cost_ledger — cost accounting entries (audit trail).
 * Every billable event across all roles and backends is recorded here.
 */
export interface CostLedgerEntry {
  entry_id: string; // UUID primary key
  run_id: string; // FK -> run_outcomes.run_id
  role: string;
  model: string;
  backend: string;
  tokens: string; // JSON: {"input": N, "output": N, "reasoning": N, "total": N}
  cost_usd: number;
  action_type: string; // "start" | "step" | "complete" | "agent_finish"
  trace_path?: string | null;
  created_at: Date;
}
