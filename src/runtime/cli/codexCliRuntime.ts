import { AgentRuntime, AgentRunInput } from "../agentRuntime.ts";
import { spawnOnce, type ParsedStream, finalize, stubResult, zeroTokens, emptyStream, emitWakeup, makeEventBridge, buildBackendEnv, resolveRolePrompt } from "../../agentRunner.ts";
import type { Role, RolePolicy, RunContext, AgentResult, NonNullable } from "../../types.ts";

/** Codex CLI runtime that delegates to existing spawnOnce logic */
export class CodexCliRuntime implements AgentRuntime {
  async run(input: AgentRunInput): Promise<AgentResult> {
    const { role, task, ctx, policy, opts = {} } = input;
    const backend: "codex" = "codex";
    const tracePath = `${ctx.tracesDir}/${role}.jsonl`;
    const startedAt = Date.now();

    if (!ctx.dryRun) {
      // Note: We're not calling ensureChain here as it's handled elsewhere
      // In a real implementation, we might want to handle this
    }

    if (ctx.dryRun) {
      return stubResult(role, policy.model, tracePath, startedAt);
    }

    const env = buildBackendEnv(backend, ctx);
    const rolePrompt = resolveRolePrompt(backend, role, ctx);
    const models = [policy.model, ...policy.fallbacks];
    const bridge = makeEventBridge(ctx, role, backend, opts);
    let last: ParsedStream | null = null;
    let lastModel = policy.model;
    const attempts: NonNullable<AgentResult["attempts"]> = [];

    for (const model of models) {
      lastModel = model;
      emitWakeup(ctx, backend, { kind: "spawn", role, model });
      const parsed = await spawnOnce(backend, role, task, ctx, model, policy, tracePath, opts, env, rolePrompt, bridge);
      last = parsed;
      const ok = !parsed.sawError && parsed.text.trim().length > 0;
      attempts.push({ model, ok, error: parsed.errorMsg });
      if (ok) {
        return finalize(role, model, parsed, tracePath, startedAt, true, undefined, attempts);
      }
      // else fall through to the next model in the pool
    }

    return finalize(
      role,
      lastModel,
      last ?? emptyStream(),
      tracePath,
      startedAt,
      false,
      last?.errorMsg ?? "all models failed",
      attempts,
    );
  }
}