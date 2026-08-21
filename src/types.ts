// Core domain types shared across the Manager.
// The Manager is plain TypeScript (not an LLM); opencode runs the 6 worker roles.

/** The six worker roles in the fleet. */
export type Role = "analyzer" | "planner" | "coder" | "tester" | "reviewer" | "pr";

/** Which headless CLI agent runs the fleet for a given run. */
export type Backend = "opencode" | "claude" | "codex";

/** A GitHub issue as pulled from `gh issue view --json`. */
export interface Issue {
  repo: string; // owner/name
  number: number;
  title: string;
  body: string;
  url: string;
  state: string; // "open" | "closed"
  labels: string[];
  author: string;
}

/** Analyzer → Planner handoff: what's wrong and where. Emitted by Analyzer as JSON text,
 *  written to `.runs/<id>/fix-spec.json` by the orchestrator (Analyzer stays read-only). */
export interface FixSpec {
  summary: string; // restated problem in the fleet's own words
  rootCause: string;
  suspectFiles: string[]; // repo-relative paths worth touching
  affectedSymbols: string[]; // functions/classes/identifiers implicated
  reproduction: string; // how to reproduce / observe the bug
  testStrategy: string; // how a fix should be validated
  risks: string[];
  confidence: "low" | "medium" | "high";
}

/** Planner output. The human approves this at GATE 2 (as `.runs/<id>/plan.md`). */
export interface Plan {
  approach: string; // prose explanation of the fix
  steps: string[]; // ordered implementation steps for the Coder
  filesToChange: string[]; // repo-relative
  testsToAddOrUpdate: string[];
  acceptanceCriteria: string[]; // how we know it's done
  outOfScope: string[];
}

/** Result of one opencode worker invocation. */
export interface AgentResult {
  role: Role;
  ok: boolean; // false if is_error or non-zero exit or parse failure
  sessionID: string | null; // opencode session ID returned by the worker
  model: string; // model actually used (after any fallback)
  attempts?: { model: string; ok: boolean; error?: string }[]; // each model tried, in order
  text: string; // final assembled assistant text (the worker's "return value")
  tokens: { input: number; output: number; reasoning: number; cached: number; cacheWrite: number; total: number };
  costUsd: number;
  sawError?: boolean; // true if the worker stream contained an error event
  error?: string;
  tracePath: string; // .runs/<id>/traces/<role>.jsonl
  startedAt: number;
  endedAt: number;
}

/** Everything one run needs. Owned by the orchestrator. */
export interface RunContext {
  runId: string;
  issue: Issue;
  repoUrl: string; // the clone URL/spec the user passed
  rootDir: string; // project root (this Manager)
  runDir: string; // .runs/<runId>
  worktreeDir: string; // .runs/<runId>/worktree  (ONLY place code changes happen)
  tracesDir: string; // .runs/<runId>/traces
  branch: string; // fix branch name
  dryRun: boolean;
  /** Session-level clone to reuse instead of cloning again (0.7 worktree hygiene). */
  cloneDir?: string;
  /** Which headless CLI runs the fleet's workers. Default "opencode". */
  backend?: Backend;
}

/** Per-role model + privilege policy (mirrors opencode.json; used by the router/runner). */
export interface RolePolicy {
  role: Role;
  model: string; // primary opencode model id
  fallbacks: string[]; // tried in order on 5xx/quota
  variant?: "minimal" | "low" | "medium" | "high" | "max"; // reasoning effort
}
