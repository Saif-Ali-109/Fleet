import type OpenAI from "openai";
import { buildRegistry, type ToolImpl, type WtCtx } from "./tools/registry.ts";
import type { ToolSchema } from "./tools/common.ts";
import type { SorEmitSink } from "./sorEmit.ts";
import type { ProviderName, Role } from "../types.ts";
import type { ToolName } from "./types.ts";

export interface UsageTotals {
  input: number;
  output: number;
  reasoning: number;
  cached: number;
  cacheWrite: number;
  total: number;
}

export type WireEvent =
  | { t: "init"; role: Role; model: string; provider: ProviderName; sessionId: string }
  | { t: "text"; part: { text: string } }
  | { t: "tool_call"; name: string; input: unknown }
  | { t: "tool_result"; name: string; ok: boolean; ms: number; bytesOut: number }
  | { t: "step_finish"; usage: UsageTotals; costUsd: number }
  | { t: "error"; error: string }
  | { t: "result"; text: string };

export interface RunAgentOpts {
  client: OpenAI;
  model: string;
  systemPrompt: string;
  task: string;
  registry: ReturnType<typeof buildRegistry>;
  wtCtx: WtCtx;
  emit: (evt: WireEvent) => void;
  sor?: SorEmitSink;
  maxSteps?: number;
  signal?: AbortSignal;
  provider?: ProviderName;
}

export interface RunAgentOutcome {
  ok: boolean;
  text?: string;
  error?: string;
  usage: UsageTotals;
  costUsd: number;
}

const DEFAULT_MAX_STEPS = 25;
const RETRY_DELAYS_MS = [15000, 30000, 60000];

function isTransientLlmError(err: unknown): boolean {
  const status = (err as { status?: unknown } | null)?.status;
  if (typeof status === "number") return status === 429 || (status >= 500 && status < 600);
  const msg = err instanceof Error ? err.message : String(err);
  return /\b(429|50[0-4])\b/.test(msg);
}

export function parseRetryDelayMs(err: unknown): number | null {
  const msg = err instanceof Error ? err.message : String(err);
  const m =
    msg.match(/Please retry in (\d+(?:\.\d+)?)s/) ??
    msg.match(/retryDelay":"(\d+(?:\.\d+)?)s"/);
  return m ? Math.ceil(Number(m[1]) * 1000) : null;
}

const sleep = (ms: number, signal?: AbortSignal): Promise<void> =>
  new Promise((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => {
      clearTimeout(t);
      reject(new Error("aborted during retry backoff"));
    }, { once: true });
  });

interface RawUsage {
  prompt_tokens?: unknown;
  completion_tokens?: unknown;
  total_tokens?: unknown;
  cost?: unknown;
  cache_write?: unknown;
  prompt_tokens_details?: { cached_tokens?: unknown; cache_write?: unknown };
  completion_tokens_details?: { reasoning_tokens?: unknown };
}

function num(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function extractUsage(raw: RawUsage | undefined): UsageTotals & { cost: number } {
  if (!raw || typeof raw !== "object") {
    return { input: 0, output: 0, reasoning: 0, cached: 0, cacheWrite: 0, total: 0, cost: 0 };
  }
  const input = num(raw.prompt_tokens);
  const output = num(raw.completion_tokens);
  return {
    input,
    output,
    reasoning: num(raw.completion_tokens_details?.reasoning_tokens),
    cached: num(raw.prompt_tokens_details?.cached_tokens),
    cacheWrite: num(raw.prompt_tokens_details?.cache_write) || num(raw.cache_write),
    total: num(raw.total_tokens) || input + output,
    cost: num(raw.cost),
  };
}

function openAiTools(
  registry: ReturnType<typeof buildRegistry>,
): OpenAI.Chat.Completions.ChatCompletionTool[] {
  const tools: OpenAI.Chat.Completions.ChatCompletionTool[] = [];
  for (const [name, impl] of Object.entries(registry) as Array<[ToolName, ToolImpl]>) {
    tools.push({
      type: "function",
      function: { name, parameters: { ...impl.schema } },
    });
  }
  return tools;
}

export async function runAgent(opts: RunAgentOpts): Promise<RunAgentOutcome> {
  const { client, model, systemPrompt, task, registry, wtCtx, emit, signal, provider, sor } = opts;
  const maxSteps = opts.maxSteps ?? DEFAULT_MAX_STEPS;
  const totals: UsageTotals = {
    input: 0,
    output: 0,
    reasoning: 0,
    cached: 0,
    cacheWrite: 0,
    total: 0,
  };
  let costUsd = 0;

  const fail = (error: string): RunAgentOutcome => {
    emit({ t: "error", error });
    return { ok: false, error, usage: { ...totals }, costUsd };
  };

  try {
    const messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [
      { role: "system", content: systemPrompt },
      { role: "user", content: task },
    ];
    const tools = openAiTools(registry);
    const create = client.chat.completions.create.bind(client.chat.completions);

    for (let step = 0; step < maxSteps; step++) {
      if (signal?.aborted) return fail("aborted before LLM call");

      let response: Awaited<ReturnType<typeof create>> | undefined;
      for (let attempt = 0; ; attempt++) {
        try {
          response = await create({
            model,
            messages,
            ...(tools.length > 0 ? { tools } : {}),
          });
          break;
        } catch (err) {
          if (attempt >= RETRY_DELAYS_MS.length || !isTransientLlmError(err)) throw err;
          const base = RETRY_DELAYS_MS[attempt] ?? RETRY_DELAYS_MS[RETRY_DELAYS_MS.length - 1] ?? 60000;
          const delay = Math.max(base, (parseRetryDelayMs(err) ?? 0) + 2000);
          console.error(
            `[llm-retry] attempt ${attempt + 1}/${RETRY_DELAYS_MS.length + 1} failed transiently; backing off ${delay}ms`,
          );
          await sleep(delay, signal);
          if (signal?.aborted) return fail("aborted during retry backoff");
        }
      }
      const res = response as {
        choices?: Array<{
          message?: {
            content?: string | null;
            tool_calls?: Array<{
              id?: string;
              function?: { name?: string; arguments?: string };
              extra_content?: unknown;
            }>;
          };
        }>;
        usage?: RawUsage;
      };

      const stepUsage = extractUsage(res.usage);
      totals.input += stepUsage.input;
      totals.output += stepUsage.output;
      totals.reasoning += stepUsage.reasoning;
      totals.cached += stepUsage.cached;
      totals.cacheWrite += stepUsage.cacheWrite;
      totals.total += stepUsage.total;
      costUsd += provider === "ollama" ? 0 : stepUsage.cost;

      const message = res.choices?.[0]?.message;
      if (!message) return fail("model returned no message");

      if (typeof message.content === "string" && message.content.length > 0) {
        emit({ t: "text", part: { text: message.content } });
      }

      const toolCalls = message.tool_calls ?? [];
      if (toolCalls.length === 0) {
        const text = typeof message.content === "string" ? message.content : "";
        emit({ t: "result", text });
        emit({ t: "step_finish", usage: { ...totals }, costUsd });
        return { ok: true, text, usage: { ...totals }, costUsd };
      }

      messages.push({
        role: "assistant",
        content: null,
        tool_calls: toolCalls.map((tc, i) => ({
          id: tc.id ?? `call_${step}_${i}`,
          type: "function" as const,
          function: {
            name: tc.function?.name ?? "",
            arguments: tc.function?.arguments ?? "{}",
          },
          ...(tc.extra_content !== undefined ? { extra_content: tc.extra_content } : {}),
        })),
      });

      for (let i = 0; i < toolCalls.length; i++) {
        const tc = toolCalls[i];
        if (!tc) continue;
        const callId = tc.id ?? `call_${step}_${i}`;
        const name = tc.function?.name ?? "";
        let input: unknown = {};
        try {
          input = JSON.parse(tc.function?.arguments ?? "{}");
        } catch {
          input = {};
        }
        emit({ t: "tool_call", name, input });
        try {
          sor?.toolCall(callId, name, input);
        } catch (err) {
          console.warn(`[sor] tool_call skipped: ${err instanceof Error ? err.message : String(err)}`);
        }

        const impl = (registry as Partial<Record<string, ToolImpl>>)[name];
        const startedAt = Date.now();
        let result: { ok: boolean; content: string };
        try {
          if (!impl) {
            result = { ok: false, content: `unknown tool: ${name}` };
          } else {
            const out = await impl.exec(input, wtCtx);
            result =
              out.ok === true
                ? { ok: true, content: out.content }
                : { ok: false, content: out.error };
          }
        } catch (err) {
          result = { ok: false, content: err instanceof Error ? err.message : String(err) };
        }
        const ms = Date.now() - startedAt;
        emit({
          t: "tool_result",
          name,
          ok: result.ok,
          ms,
          bytesOut: Buffer.byteLength(result.content, "utf8"),
        });
        try {
          sor?.toolResult(callId, name, input, result.content, result.ok, ms);
        } catch (err) {
          console.warn(`[sor] tool_result skipped: ${err instanceof Error ? err.message : String(err)}`);
        }

        messages.push({
          role: "tool",
          tool_call_id: callId,
          content: result.content,
        });
      }

      if (signal?.aborted) return fail("aborted after tool execution");
    }

    return fail(`max steps (${maxSteps}) exhausted without final answer`);
  } catch (err) {
    return fail(err instanceof Error ? err.message : String(err));
  }
}
