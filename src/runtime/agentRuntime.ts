// AgentRuntime interface and AgentRunInput types
import type { Role, RolePolicy, RunContext, AgentResult } from "../../types.ts";

/** Input to AgentRuntime.run(), matching the runWorker contract exactly. */
export interface AgentRunInput {
  role: Role;
  task: string;
  ctx: RunContext;
  policy: RolePolicy;
  opts?: {
    /** Reasoning-effort variant override (else policy.variant). */
    variant?: RolePolicy["variant"];
    /** Called for every assistant text chunk (for the live TUI). */
    onText?: (chunk: string) => void;
    /** Called for every opencode stream event (thinking, tool calls, results, etc.). */
    onEvent?: (ev: Record<string, unknown>) => void;
  };
}

/** Abstract runtime that can execute an agent worker. */
export interface AgentRuntime {
  /** Run one worker for `role` on the ctx backend, trying `policy.model` then each fallback.
   * Must match the behavior of agentRunner.ts:runWorker exactly.
   */
  run(input: AgentRunInput): Promise<AgentResult>;
}