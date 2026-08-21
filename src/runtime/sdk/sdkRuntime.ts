// Abstract base class for SDK runtimes
import type { Role, RolePolicy, RunContext, AgentResult } from "../../types.ts";
import { AgentRuntime, AgentRunInput } from "../agentRuntime.ts";

/** Abstract SDK runtime that can execute an agent worker via SDK (to be implemented). */
export abstract class SDKRuntime implements AgentRuntime {
  abstract run(input: AgentRunInput): Promise<AgentResult>;
}