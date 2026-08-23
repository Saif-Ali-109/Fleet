import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { ProviderName, Role, RolePolicy, RunContext } from "../types.ts";

export interface ProviderDef {
  name: ProviderName;
  binary: string;
}

// Provider binaries - for now we'll use a placeholder worker script
// In a real implementation, these would point to actual provider-specific workers
const PROVIDER_BIN = {
  gemini: process.env.GEMINI_BIN ?? "node", // Placeholder - will be replaced with worker entry point
  openrouter: process.env.OPENROUTER_BIN ?? "node", // Placeholder
  ollama: process.env.OLLAMA_BIN ?? "node", // Placeholder
} as const;

/** Resolve the binary + name for a provider (honors GEMINI_BIN/OPENROUTER_BIN/OLLAMA_BIN). */
export function providerDef(provider: ProviderName): ProviderDef {
  return { name: provider, binary: PROVIDER_BIN[provider] };
}

export interface ProviderTrace {
  text: string;
  sessionID: string | null;
  tokens: { input: number; output: number; reasoning: number; cached: number; cacheWrite: number; total: number };
  costUsd: number;
  sawError: boolean;
  errorMsg?: string;
}

const READ_ONLY_ROLES: readonly Role[] = ["analyzer", "planner", "reviewer"];
const MUTATE_ROLES: readonly Role[] = ["coder", "tester"];

/** Provider-specific mode/sandbox settings */
export function providerMode(role: Role): string {
  return READ_ONLY_ROLES.includes(role) ? "plan" : "acceptEdits";
}

export function providerSandbox(role: Role): string {
  if (role === "pr") return "danger-full-access";
  if (READ_ONLY_ROLES.includes(role)) return "read-only";
  return "workspace-write";
}

/** Read-only roles never get a mutate sandbox/mode; pr alone needs full network access. */

/** Provider arguments structure */
export interface ProviderArgs {
  args: string[];
  cwd?: string;
}

export function buildProviderArgs(
  provider: ProviderName,
  role: Role,
  task: string,
  ctx: RunContext,
  model: string,
  policy: RolePolicy,
  opts: { variant?: RolePolicy["variant"]; resumeSessionID?: string },
  rolePrompt: string,
): ProviderArgs {
  // For now, we'll use a generic approach that will be replaced with actual provider implementations
  // This follows the same pattern as the backends but adapted for provider system
  const args = [
    "--role", role,
    "--model", model,
    "--provider", provider,
    "--task", task,
    "--worktree", ctx.worktreeDir,
  ];

  if (opts.resumeSessionID) {
    args.push("--resume", opts.resumeSessionID);
  }

  const variant = opts.variant ?? policy.variant;
  if (variant) {
    args.push("--variant", variant);
  }

  args.push("--role-prompt");
  args.push(rolePrompt);

  // Add provider-specific flags
  switch (provider) {
    case "gemini":
      args.push("--api-key-env", "GEMINI_API_KEY");
      break;
    case "openrouter":
      args.push("--api-key-env", "OPENROUTER_API_KEY");
      break;
    case "ollama":
      // Ollama doesn't need API key in most cases
      break;
  }

  return { args, cwd: ctx.rootDir };
}

/** Per-run env. Every provider gets SOR_EVENT_DIR (where events are written);
 *  additionally gets provider-specific env vars. */
export function buildProviderEnv(provider: ProviderName, ctx: RunContext): NodeJS.ProcessEnv {
  const sorEventDir = join(ctx.runDir, "events");
  try {
    mkdirSync(sorEventDir, { recursive: true });
  } catch {
    // non-fatal: the hook scripts/plugin create it lazily if needed
  }

  const base: NodeJS.ProcessEnv = { ...process.env, SOR_EVENT_DIR: sorEventDir, SOR_PROVIDER: provider };

  // Provider-specific environment variables
  switch (provider) {
    case "gemini":
      // Gemini may need specific env vars
      break;
    case "openrouter":
      // OpenRouter may need specific headers via env
      process.env.HTTP_REFERER && (base.HTTP_REFERER = process.env.HTTP_REFERER);
      process.env.X_TITLE && (base.X_TITLE = process.env.X_TITLE);
      break;
    case "ollama":
      // Ollama base URL
      if (process.env.OLLAMA_BASE_URL) {
        base.OLLAMA_BASE_URL = process.env.OLLAMA_BASE_URL;
      }
      break;
  }

  return base;
}

/** Role prompt for providers (to be implemented based on agent prompts).
 *  For now, we'll return empty string as the prompt comes from elsewhere. */
export function resolveRolePrompt(provider: ProviderName, role: Role, ctx: RunContext): string {
  // In the provider system, prompts are handled differently
  // They come from the agent definitions in src/fleet/agents/
  // For now we return empty as the prompt is passed in separately
  return "";
}

/** Provider trace structure (matches the new wire protocol) */
export interface ProviderTrace {
  text: string;
  sessionID: string | null;
  tokens: { input: number; output: number; reasoning: number; cached: number; cacheWrite: number; total: number };
  costUsd: number;
  sawError: boolean;
  errorMsg?: string;
}

/** Parse a trace body into a normalized shape for the new NDJSON format. */
export function parseProviderTrace(
  provider: ProviderName,
  rawBody: string,
  startOffset: number,
  opts: { lastmsgPath?: string } = {},
): ProviderTrace {
  const body = startOffset > 0 ? rawBody.slice(startOffset) : rawBody;
  const acc: ProviderTrace = emptyProviderTrace();

  for (const line of body.split("\n")) {
    if (!line.trim()) continue;
    let ev: any;
    try {
      ev = JSON.parse(line);
    } catch {
      continue; // non-JSON noise that leaked into the trace
    }
    parseProviderLine(provider, ev, acc);
  }

  return acc;
}

/** Dispatch one trace line to the provider's line parser. */
export function parseProviderLine(provider: ProviderName, ev: any, acc: ProviderTrace): void {
  switch (ev.type) {
    case "init":
      if (ev.sessionId && !acc.sessionID) acc.sessionID = ev.sessionId;
      break;
    case "text":
      if (ev.part?.text) {
        acc.text += ev.part.text;
      }
      break;
    case "tool_call":
      // Tool calls don't add to text output directly
      break;
    case "tool_result":
      // Tool results don't add to text output directly
      break;
    case "step_finish":
      if (ev.usage) {
        acc.tokens.input += ev.usage.input ?? 0;
        acc.tokens.output += ev.usage.output ?? 0;
        acc.tokens.reasoning += ev.usage.reasoning ?? 0;
        acc.tokens.cached += ev.usage.cached ?? 0;
        acc.tokens.cacheWrite += ev.usage.cacheWrite ?? 0;
        acc.tokens.total = acc.tokens.input + acc.tokens.output + acc.tokens.reasoning + acc.tokens.cached;
      }
      acc.costUsd += ev.costUsd ?? 0;
      break;
    case "error":
      acc.sawError = true;
      acc.errorMsg = ev.error ?? "Unknown error";
      break;
    case "result":
      // Final result - text already accumulated via "text" events
      break;
    default:
      // Ignore unknown event types
      break;
  }
}

const emptyProviderTrace = (): ProviderTrace => ({
  text: "",
  sessionID: null,
  tokens: { input: 0, output: 0, reasoning: 0, cached: 0, cacheWrite: 0, total: 0 },
  costUsd: 0,
  sawError: false,
});