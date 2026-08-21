import type { Role, RolePolicy, RunContext, AgentResult } from "../../../types.ts";
import { AgentRuntime, AgentRunInput } from "../../agentRuntime.ts";
import type { Backend } from "../../types.ts";

/** Claude SDK runtime that uses the Claude Agent SDK (with fallback to CLI) */
export class ClaudeSdkRuntime implements AgentRuntime {
  async run(input: AgentRunInput): Promise<AgentResult> {
    const { role, task, ctx, policy, opts = {} } = input;
    const backend: Backend = "claude";
    const tracePath = `${ctx.tracesDir}/${role}.jsonl`;
    const startedAt = Date.now();

    // Check if we should use the Claude Agent SDK based on environment configuration
    const useSdk =
      process.env.ORCHESTRATOR_RUNTIME === "sdk" ||
      (backend === "claude" && process.env.CLAUDE_RUNTIME === "sdk");

    if (useSdk && !ctx.dryRun) {
      try {
        // Attempt to use the Claude Agent SDK
        return await this.runViaSdk(
          role,
          task,
          ctx,
          policy,
          tracePath,
          startedAt,
          opts
        );
      } catch (error) {
        // Fall back to CLI runtime if SDK fails
        console.warn(
          `[Claude SDK] Failed to use Claude Agent SDK: ${error.message}. Falling back to CLI runtime.`
        );
        return await this.runViaCliRuntime(
          role,
          task,
          ctx,
          policy,
          tracePath,
          startedAt,
          opts
        );
      }
    }

    // Default to CLI runtime
    return await this.runViaCliRuntime(
      role,
      task,
      ctx,
      policy,
      tracePath,
      startedAt,
      opts
    );
  }

  private async runViaSdk(
    role: Role,
    task: string,
    ctx: RunContext,
    policy: RolePolicy,
    tracePath: string,
    startedAt: number,
    opts: AgentRunInput["opts"]
  ): Promise<AgentResult> {
    // This is where we would implement the actual Claude Agent SDK integration.
    // For now, we'll simulate by falling back to the CLI runtime.
    // In a real implementation, we would:
    // 1. Initialize the Claude Agent SDK client
    // 2. Configure it with the model from policy.model
    // 3. Set up tool permissions based on agents/<role>.md
    // 4. Execute the task and stream events
    // 5. Generate trace files and SOR events equivalent to the CLI runtime
    // 6. Return an AgentResult with the same structure

    // Since we don't have the SDK implemented, we fall back to CLI for now.
    // TODO: Replace this with actual SDK implementation when the SDK is available.
    console.info(`[Claude SDK] Using fallback to CLI runtime for role ${role}`);
    return await this.runViaCliRuntime(role, task, ctx, policy, tracePath, startedAt, opts);
  }

  private async runViaCliRuntime(
    role: Role,
    task: string,
    ctx: RunContext,
    policy: RolePolicy,
    tracePath: string,
    startedAt: number,
    opts: AgentRunInput["opts"]
  ): Promise<AgentResult> {
    const { ClaudeCliRuntime } = await import("./cli/claudeCliRuntime.ts");
    const runtime = new ClaudeCliRuntime();
    return runtime.run({ role, task, ctx, policy, opts });
  }
}