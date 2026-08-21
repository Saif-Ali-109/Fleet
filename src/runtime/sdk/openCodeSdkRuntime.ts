import type { Role, RolePolicy, RunContext, AgentResult } from "../../../types.ts";
import { AgentRuntime, AgentRunInput } from "../../agentRuntime.ts";

/** OpenCode SDK runtime (placeholder for implementation) */
export class OpenCodeSdkRuntime implements AgentRuntime {
  async run(input: AgentRunInput): Promise<AgentResult> {
    // TODO: Implement actual OpenCode SDK integration
    // For now, fallback to CLI runtime for backward compatibility
    const { OpenCodeCliRuntime } = require("../../cli/opencodeCliRuntime.ts");
    const runtime = new OpenCodeCliRuntime();
    return runtime.run(input);
  }
}