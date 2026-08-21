import { AgentRuntime } from "./agentRuntime.ts";
import { OpenCodeCliRuntime } from "./cli/opencodeCliRuntime.ts";
import { ClaudeCliRuntime } from "./cli/claudeCliRuntime.ts";
import { CodexCliRuntime } from "./cli/codexCliRuntime.ts";
import { OpenCodeSdkRuntime } from "./sdk/openCodeSdkRuntime.ts";
import { OpenCodeServerApiRuntime } from "./sdk/openCodeServerApiRuntime.ts";
import { ClaudeSdkRuntime } from "./sdk/claudeSdkRuntime.ts";
import type { Backend } from "../../types.ts";

/** Factory to select runtime based on configuration */
export class RuntimeFactory {
  private static opencodeRuntime: AgentRuntime | null = null;
  private static claudeRuntime: AgentRuntime | null = null;
  private static codexRuntime: AgentRuntime | null = null;

  /**
   * Get runtime for the specified backend
   * @param backend - The backend to get runtime for
   * @returns AgentRuntime implementation for the backend
   */
  static getRuntime(backend: Backend): AgentRuntime {
    // Determine if we should use SDK runtime based on environment variables
    const useSdk =
      process.env.ORCHESTRATOR_RUNTIME === "sdk" ||
      (backend === "opencode" && process.env.OPENCODE_RUNTIME === "sdk") ||
      (backend === "claude" && process.env.CLAUDE_RUNTIME === "sdk") ||
      (backend === "codex" && process.env.CODEX_RUNTIME === "sdk");

    // Determine if we should use server API runtime
    const useServerApi =
      process.env.ORCHESTRATOR_RUNTIME === "server" ||
      (backend === "opencode" && process.env.OPENCODE_RUNTIME === "server");

    switch (backend) {
      case "opencode":
        if (!this.opencodeRuntime) {
          if (useServerApi) {
            this.opencodeRuntime = new OpenCodeServerApiRuntime();
          } else if (useSdk) {
            this.opencodeRuntime = new OpenCodeSdkRuntime();
          } else {
            this.opencodeRuntime = new OpenCodeCliRuntime();
          }
        }
        return this.opencodeRuntime;
      case "claude":
        if (!this.claudeRuntime) {
          if (useSdk) {
            this.claudeRuntime = new ClaudeSdkRuntime();
          } else {
            this.claudeRuntime = new ClaudeCliRuntime();
          }
        }
        return this.claudeRuntime;
      case "codex":
        if (!this.codexRuntime) {
          if (useSdk) {
            // For now, Codex SDK runtime would be implemented similarly
            // For backward compatibility, default to CLI
            this.codexRuntime = new CodexCliRuntime();
          } else {
            this.codexRuntime = new CodexCliRuntime();
          }
        }
        return this.codexRuntime;
      default:
        throw new Error(`Unknown backend: ${backend}`);
    }
  }
}