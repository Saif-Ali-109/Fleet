import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type OpenAI from "openai";
import {
	newRequestId,
	type RequestIdentity,
	type TelemetryEvent,
	type TelemetryKind,
} from "../telemetry.ts";
import type { ProviderName, Role } from "../types.ts";
import type { RulePredicate } from "./policy.ts";
import { evaluateToolCall } from "./policyEval.ts";
import {
	RATE_LIMIT_SWITCH_PREFIX,
	RPD_EXHAUSTED,
	rateLimitSwitchError,
} from "./quotaSignals.ts";
import type { SorEmitSink } from "./sorEmit.ts";
import type { buildRegistry, ToolImpl, WtCtx } from "./tools/registry.ts";
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
	| {
			t: "init";
			role: Role;
			model: string;
			provider: ProviderName;
			sessionId: string;
			managerId?: string;
			runId?: string;
			workerId?: string;
	  }
	| { t: "text"; part: { text: string } }
	| { t: "tool_call"; name: string; input: unknown }
	| {
			t: "tool_result";
			name: string;
			ok: boolean;
			ms: number;
			bytesOut: number;
			exitCode?: number;
	  }
	| { t: "step_finish"; usage: UsageTotals; costUsd: number }
	| { t: "error"; error: string }
	| { t: "result"; text: string }
	| TelemetryEvent;

export interface RunAgentOpts {
	client: OpenAI;
	model: string;
	systemPrompt: string;
	task: string;
	registry: ReturnType<typeof buildRegistry>;
	wtCtx: WtCtx;
	emit: (evt: WireEvent) => void;
	sor?: SorEmitSink;
	/** Policy SoR snapshot (spec §9.6). When present with mode `sor`/`fail-closed`,
	 *  the PEP runs before `impl.exec`. `compatibility` (or absent) skips the PEP. */
	policy?: {
		mode: "sor" | "compatibility" | "fail-closed";
		effective: { allowedTools: string[]; mcpAllow: string[] };
		toolRules: Record<string, RulePredicate[]>;
	};
	/** NON-FATAL `policy_decision` emitter (per call in `sor`/`fail-closed`). The
	 *  worker provides a callback that appends via `appendAuditEvent`; failures must
	 *  never abort or downgrade a decision (a deny is a deny regardless of audit). */
	policyDecision?: (payload: {
		decision: "ALLOW" | "DENY";
		action: string;
		result: "ok" | "blocked" | "error";
		reason: string;
	}) => void;
	maxSteps?: number;
	signal?: AbortSignal;
	provider?: ProviderName;
	maxOutputTokens?: number;
	identity?: Omit<RequestIdentity, "model" | "requestId" | "attempt">;
	initialMessages?: OpenAI.Chat.Completions.ChatCompletionMessageParam[];
	reserve?: (
		identity: RequestIdentity,
		estimatedInputTokens: number,
		maximumOutputTokens: number,
	) => Promise<{
		ok: boolean;
		reservationId?: string;
		waitMs?: number;
		terminal?: boolean;
		block?: string;
		error?: string;
	}>;
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
	const msg = err instanceof Error ? err.message : String(err);
	if (msg.startsWith(RATE_LIMIT_SWITCH_PREFIX) || msg === RPD_EXHAUSTED)
		return false;
	const status = (err as { status?: unknown } | null)?.status;
	if (typeof status === "number")
		return status === 429 || (status >= 500 && status < 600);
	return (
		/\b(429|50[0-4])\b/.test(msg) ||
		/RESOURCE_EXHAUSTED/i.test(msg) ||
		// OpenRouter reports upstream overloads (Nvidia/other providers) as
		// "Service temporarily overloaded" — transient, worth a retry even
		// though the status code isn't present as literal text.
		/temporarily overloaded|Service overloaded|Service is overloaded/i.test(
			msg,
		) ||
		/\b(ECONNREFUSED|ECONNRESET|ETIMEDOUT|EPIPE|Connection error|fetch failed|socket hang up|network error)\b/i.test(
			msg,
		) ||
		/timed?\s*out|headersTimeout/i.test(msg)
	);
}

export function classifyProviderError(err: unknown): {
	rateLimited: boolean;
	httpStatus?: number;
	blockedDimension?: string;
} {
	const status = (err as { status?: unknown } | null)?.status;
	const httpStatus =
		typeof status === "number"
			? status
			: typeof status === "string" && /^\d+$/.test(status)
				? Number(status)
				: undefined;
	const msg = err instanceof Error ? err.message : String(err);
	const rateLimited =
		httpStatus === 429 ||
		/\b429\b/.test(msg) ||
		/RESOURCE_EXHAUSTED/i.test(msg);
	const dimension =
		msg.match(/\b(rpm|tpm|rpd)\b/i)?.[1]?.toLowerCase() ??
		(/request(?:s)?[^\n]{0,20}minute/i.test(msg) ? "rpm" : undefined) ??
		(/token(?:s)?[^\n]{0,20}minute/i.test(msg) ? "tpm" : undefined) ??
		(/request(?:s)?[^\n]{0,20}day/i.test(msg) ? "rpd" : undefined);
	return {
		rateLimited,
		...(httpStatus !== undefined ? { httpStatus } : {}),
		...(dimension ? { blockedDimension: dimension } : {}),
	};
}

export function parseRetryDelayMs(err: unknown): number | null {
	const msg = err instanceof Error ? err.message : String(err);
	const m =
		msg.match(/Please retry in (\d+(?:\.\d+)?)s/) ??
		msg.match(/retryDelay":"(\d+(?:\.\d+)?)s"/);
	return m ? Math.ceil(Number(m[1]) * 1000) : null;
}

export function ollamaMaxRetries(
	raw: string | undefined = process.env.OLLAMA_MAX_RETRIES,
): number | null {
	if (raw === undefined || raw.trim() === "") return null;
	const value = Number(raw);
	if (!Number.isInteger(value) || value < 0) {
		throw new Error(
			"OLLAMA_MAX_RETRIES must be a non-negative integer (0 = no retries after a transient failure; unset = unlimited)",
		);
	}
	return value;
}

type CreateFn = ReturnType<OpenAI["chat"]["completions"]["create"]["bind"]>;

interface StreamChunk {
	choices?: Array<{
		delta?: {
			content?: string | null;
			tool_calls?: Array<{
				index?: number;
				id?: string;
				function?: { name?: string; arguments?: string };
				extra_content?: unknown;
			}>;
		};
	}>;
	usage?: RawUsage;
}

/** FLEET_LLM_STREAM=1 routes chat calls through SSE streaming assembly. */
function wantsStreaming(): boolean {
	return process.env.FLEET_LLM_STREAM === "1";
}

/**
 * Streams a chat completion and assembles the deltas into a non-streaming
 * shaped response. Local CPU backends (ollama) can take many minutes before
 * headers would arrive on a blocking call, tripping undici headersTimeout;
 * streaming sends headers immediately and keeps bytes flowing.
 */
export async function createStreaming(
	create: CreateFn,
	opts: {
		model: string;
		messages: unknown[];
		tools?: unknown[];
		tool_choice?: "auto" | "none";
	},
	firstTokenMs: number = Number.isFinite(
		Number(process.env.OLLAMA_FIRST_TOKEN_TIMEOUT_MS),
	)
		? Number(process.env.OLLAMA_FIRST_TOKEN_TIMEOUT_MS)
		: 600000,
	stallMs: number = Number.isFinite(Number(process.env.OLLAMA_STALL_TIMEOUT_MS))
		? Number(process.env.OLLAMA_STALL_TIMEOUT_MS)
		: 30000,
): Promise<unknown> {
	const controller = new AbortController();
	let gotFirstChunk = false;

	const withStallGuard = <T>(p: Promise<T>): Promise<T> => {
		const ms = gotFirstChunk ? stallMs : firstTokenMs;
		let timer: ReturnType<typeof setTimeout> | undefined;
		return Promise.race([
			p,
			new Promise<never>((_, reject) => {
				timer = setTimeout(() => {
					controller.abort();
					reject(
						new Error(
							`watchdog timed out: ${gotFirstChunk ? "stalled mid-stream" : "no first token"} (${ms}ms)`,
						),
					);
				}, ms);
			}),
		]).finally(() => clearTimeout(timer));
	};

	const stream = (await withStallGuard(
		Promise.resolve(
			create(
				{
					...opts,
					stream: true,
					stream_options: { include_usage: true },
				} as Parameters<CreateFn>[0],
				{ signal: controller.signal },
			),
		),
	)) as unknown as AsyncIterable<StreamChunk>;

	let content = "";
	const toolCalls = new Map<
		number,
		{
			id: string;
			type: "function";
			function: { name: string; arguments: string };
			extra_content?: unknown;
		}
	>();
	let usage: RawUsage | undefined;

	const iterator = stream[Symbol.asyncIterator]();
	for (;;) {
		const next = await withStallGuard(iterator.next());
		if (next.done) break;
		gotFirstChunk = true;
		const chunk = next.value;
		if (chunk.usage) usage = chunk.usage;
		const delta = chunk.choices?.[0]?.delta;
		if (!delta) continue;
		if (delta.content) content += delta.content;
		for (const tc of delta.tool_calls ?? []) {
			const idx = tc.index ?? 0;
			const slot = toolCalls.get(idx) ?? {
				id: "",
				type: "function" as const,
				function: { name: "", arguments: "" },
			};
			if (tc.id) slot.id = tc.id;
			if (tc.function?.name) slot.function.name += tc.function.name;
			if (tc.function?.arguments)
				slot.function.arguments += tc.function.arguments;
			if (tc.extra_content !== undefined) slot.extra_content = tc.extra_content;
			toolCalls.set(idx, slot);
		}
	}

	return {
		choices: [
			{
				message: {
					role: "assistant",
					content: content || null,
					...(toolCalls.size > 0
						? {
								tool_calls: [...toolCalls.entries()]
									.sort((a, b) => a[0] - b[0])
									.map(([, tc]) => ({
										id: tc.id,
										type: tc.type,
										function: tc.function,
										...(tc.extra_content !== undefined
											? { extra_content: tc.extra_content }
											: {}),
									})),
							}
						: {}),
				},
			},
		],
		...(usage ? { usage } : {}),
	};
}

const sleep = (ms: number, signal?: AbortSignal): Promise<void> =>
	new Promise((resolve, reject) => {
		const t = setTimeout(resolve, ms);
		signal?.addEventListener(
			"abort",
			() => {
				clearTimeout(t);
				reject(new Error("aborted during retry backoff"));
			},
			{ once: true },
		);
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

function extractUsage(
	raw: RawUsage | undefined,
): UsageTotals & { cost: number } {
	if (!raw || typeof raw !== "object") {
		return {
			input: 0,
			output: 0,
			reasoning: 0,
			cached: 0,
			cacheWrite: 0,
			total: 0,
			cost: 0,
		};
	}
	const input = num(raw.prompt_tokens);
	const output = num(raw.completion_tokens);
	return {
		input,
		output,
		reasoning: num(raw.completion_tokens_details?.reasoning_tokens),
		cached: num(raw.prompt_tokens_details?.cached_tokens),
		cacheWrite:
			num(raw.prompt_tokens_details?.cache_write) || num(raw.cache_write),
		total: num(raw.total_tokens) || input + output,
		cost: num(raw.cost),
	};
}

function openAiTools(
	registry: ReturnType<typeof buildRegistry>,
): OpenAI.Chat.Completions.ChatCompletionTool[] {
	const tools: OpenAI.Chat.Completions.ChatCompletionTool[] = [];
	for (const [name, impl] of Object.entries(registry) as Array<
		[ToolName, ToolImpl]
	>) {
		tools.push({
			type: "function",
			function: { name, parameters: { ...impl.schema } },
		});
	}
	return tools;
}

const checkpointWarnedRoles = new Set<Role>();

/**
 * Atomic mid-conversation checkpoint (SPEC.md §11.5): written after every
 * completed provider turn so the manager can resume a paused role from
 * `<runDir>/checkpoints/<role>.json`. chainIndex is always 0 — the manager
 * owns the chain position. A checkpoint failure must never break the run.
 */
function writeCheckpoint(
	runDir: string | undefined,
	role: Role,
	model: string,
	messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[],
): void {
	if (!runDir) return;
	try {
		const dir = join(runDir, "checkpoints");
		mkdirSync(dir, { recursive: true });
		const finalPath = join(dir, `${role}.json`);
		const tmpPath = `${finalPath}.tmp`;
		writeFileSync(
			tmpPath,
			JSON.stringify({
				role,
				model,
				chainIndex: 0,
				messages,
				savedAt: new Date().toISOString(),
			}),
		);
		renameSync(tmpPath, finalPath);
	} catch (err) {
		if (!checkpointWarnedRoles.has(role)) {
			checkpointWarnedRoles.add(role);
			console.warn(
				`[checkpoint] write failed for ${role}, continuing: ${err instanceof Error ? err.message : String(err)}`,
			);
		}
	}
}

export async function runAgent(opts: RunAgentOpts): Promise<RunAgentOutcome> {
	const {
		client,
		model,
		systemPrompt,
		task,
		registry,
		wtCtx,
		emit,
		signal,
		provider,
		sor,
	} = opts;
	const baseIdentity = opts.identity ?? {
		managerId: "unknown",
		runId: "unknown",
		workerId: "unknown",
		sessionId: "unknown",
		role: wtCtx.role,
	};
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
		emit({ t: "step_finish", usage: { ...totals }, costUsd });
		emit({ t: "error", error });
		return { ok: false, error, usage: { ...totals }, costUsd };
	};

	try {
		const messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[] =
			opts.initialMessages ?? [
				{ role: "system", content: systemPrompt },
				{ role: "user", content: task },
			];
		const tools = openAiTools(registry);
		const create = client.chat.completions.create.bind(client.chat.completions);
		const emitTelemetry = (event: TelemetryEvent): void => {
			if (opts.identity) emit(event);
		};

		for (let step = 0; step < maxSteps; step++) {
			if (signal?.aborted) return fail("aborted before LLM call");

			let response: Awaited<ReturnType<typeof create>> | undefined;
			// Keep the FIRST transient failure so an exhausted retry ladder
			// surfaces the root cause (e.g. a 503) rather than the last attempt's
			// unrelated error — the manager walks the model chain on that root.
			let firstTransient: unknown;
			for (let attempt = 0; ; attempt++) {
				const requestId = newRequestId();
				const requestIdentity: RequestIdentity = {
					...baseIdentity,
					model,
					requestId,
					attempt: attempt + 1,
				};
				let reservationId: string | undefined;
				let providerCallStarted = false;
				try {
					if (provider === "gemini") {
						if (!opts.reserve)
							throw new Error("Gemini quota coordinator unavailable");
						const estimatedInputTokens = Math.ceil(
							messages.reduce((n, m) => n + JSON.stringify(m).length, 0) / 4,
						);
						const reservation = await opts.reserve(
							requestIdentity,
							estimatedInputTokens,
							opts.maxOutputTokens ?? 8192,
						);
						const reserved =
							reservation.ok && Boolean(reservation.reservationId);
						emitTelemetry({
							t: "telemetry",
							event: reserved ? "reservation" : "reservation_rejection",
							timestamp: new Date().toISOString(),
							...requestIdentity,
							provider,
							...(reservation.reservationId
								? { reservationId: reservation.reservationId }
								: {}),
							...(reservation.block
								? { blockedDimension: reservation.block }
								: {}),
							status: reserved ? "reserved" : "rejected",
							...(reservation.waitMs !== undefined
								? { waitMs: reservation.waitMs }
								: {}),
						});
						if (!reserved) {
							if (reservation.ok)
								throw new Error(
									"Gemini quota reservation missing reservationId",
								);
							if (reservation.terminal) throw new Error(RPD_EXHAUSTED);
							if (reservation.block !== "rpm" && reservation.block !== "tpm") {
								throw new Error(
									reservation.error ?? "GEMINI_RATE_LIMIT_WAIT_EXCEEDED",
								);
							}
							// Worker-side finite-block signal only: this worker cannot know
							// whether another chain model exists, so the manager owns the
							// actual "switching" announcement via its own quota events.
							const modelSwitch: Omit<TelemetryEvent, "event"> & {
								event: TelemetryKind | "model_switch";
							} = {
								t: "telemetry",
								event: "model_switch",
								timestamp: new Date().toISOString(),
								...requestIdentity,
								provider,
								status: "blocked",
								...(reservation.block
									? { blockedDimension: reservation.block }
									: {}),
								waitMs: reservation.waitMs ?? 0,
							};
							emitTelemetry(modelSwitch as TelemetryEvent);
							throw rateLimitSwitchError(
								reservation.block,
								reservation.waitMs ?? 0,
							);
						}
						reservationId = reservation.reservationId;
					}
					const reqOpts = {
						model,
						messages,
						...(tools.length > 0
							? { tools, tool_choice: "auto" as const }
							: {}),
					};
					providerCallStarted = true;
					if (process.env.FLEET_LLM_DEBUG === "1") {
						console.log(
							"[llm-debug] REQUEST:",
							JSON.stringify(
								{
									model,
									schema_type:
										(
											(
												tools[0] as OpenAI.Chat.Completions.ChatCompletionFunctionTool
											)?.function?.parameters as { type?: string }
										)?.type ?? null,
									first_tool_schema:
										tools[0] as OpenAI.Chat.Completions.ChatCompletionFunctionTool | null,
									tool_count: tools.length,
									tool_choice:
										"tool_choice" in reqOpts ? reqOpts.tool_choice : "UNSET",
								},
								null,
								2,
							),
						);
					}
					response = wantsStreaming()
						? ((await createStreaming(create, reqOpts)) as Awaited<
								ReturnType<typeof create>
							>)
						: await create(reqOpts);
					if (process.env.FLEET_LLM_DEBUG === "1") {
						console.log(
							"[llm-debug] RESPONSE:",
							JSON.stringify(
								{
									finish_reason:
										(
											response as {
												choices?: Array<{
													finish_reason?: string | null;
													message?: {
														content?: string | null;
														tool_calls?: unknown;
													};
												}>;
											}
										).choices?.[0]?.finish_reason ?? "UNSET",
									has_tool_calls: Boolean(
										(
											response as {
												choices?: Array<{
													message?: { tool_calls?: unknown };
												}>;
											}
										).choices?.[0]?.message?.tool_calls,
									),
									message:
										(
											response as {
												choices?: Array<{
													message?: { content?: string | null };
												}>;
											}
										).choices?.[0]?.message?.content ?? null,
								},
								null,
								2,
							),
						);
					}
					if (providerCallStarted) {
						emitTelemetry({
							t: "telemetry",
							event: "provider_completion",
							timestamp: new Date().toISOString(),
							...requestIdentity,
							provider,
							...(reservationId ? { reservationId } : {}),
							status: "completed",
						});
					}
					break;
				} catch (err) {
					const classification = classifyProviderError(err);
					if (providerCallStarted) {
						emitTelemetry({
							t: "telemetry",
							event: "provider_completion",
							timestamp: new Date().toISOString(),
							...requestIdentity,
							provider,
							...(reservationId ? { reservationId } : {}),
							status: "failed",
							...(classification.httpStatus !== undefined
								? { httpStatus: classification.httpStatus }
								: {}),
							...(classification.blockedDimension
								? { blockedDimension: classification.blockedDimension }
								: {}),
						});
						if (classification.rateLimited) {
							emitTelemetry({
								t: "telemetry",
								event: "provider_rate_limit",
								timestamp: new Date().toISOString(),
								...requestIdentity,
								provider,
								...(reservationId ? { reservationId } : {}),
								status: "rate_limited",
								...(classification.httpStatus !== undefined
									? { httpStatus: classification.httpStatus }
									: {}),
								...(classification.blockedDimension
									? { blockedDimension: classification.blockedDimension }
									: {}),
							});
						}
					}
					const isOllama = provider === "ollama";
					if (!isTransientLlmError(err)) throw err;
					firstTransient ??= err;
					if (!isOllama && attempt >= RETRY_DELAYS_MS.length)
						throw firstTransient ?? err;
					const ollamaCap = isOllama ? ollamaMaxRetries() : null;
					if (ollamaCap !== null && attempt >= ollamaCap)
						throw firstTransient ?? err;
					const hint = parseRetryDelayMs(err);
					const delay = isOllama
						? Math.max(
								Number(process.env.OLLAMA_RETRY_DELAY_MS ?? 5000),
								hint ?? 0,
							)
						: Math.max(
								RETRY_DELAYS_MS[attempt] ??
									RETRY_DELAYS_MS[RETRY_DELAYS_MS.length - 1] ??
									60000,
								(hint ?? 0) + 2000,
							);
					console.error(
						`[llm-retry] attempt ${attempt + 1}/${isOllama ? (ollamaCap ?? "∞") : RETRY_DELAYS_MS.length + 1} failed transiently; backing off ${delay}ms: ${err instanceof Error ? err.message : String(err)}`,
					);
					if (requestIdentity) {
						emitTelemetry({
							t: "telemetry",
							event: "retry",
							timestamp: new Date().toISOString(),
							...requestIdentity,
							provider,
							status: "scheduled",
							waitMs: delay,
						});
					}
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
				writeCheckpoint(wtCtx.runDir, wtCtx.role, model, messages);
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
					...(tc.extra_content !== undefined
						? { extra_content: tc.extra_content }
						: {}),
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
					console.warn(
						`[sor] tool_call skipped: ${err instanceof Error ? err.message : String(err)}`,
					);
				}

				const startedAt = Date.now();
				const denied =
					opts.policy &&
					(opts.policy.mode === "sor" || opts.policy.mode === "fail-closed")
						? (() => {
								const d = evaluateToolCall(
									name,
									input,
									opts.policy.effective,
									opts.policy.toolRules,
								);
								try {
									opts.policyDecision?.({
										decision: d.decision,
										action: name,
										result: d.allowed ? "ok" : "blocked",
										reason: d.reason,
									});
								} catch (err) {
									console.warn(
										`[policy] policy_decision skipped: ${err instanceof Error ? err.message : String(err)}`,
									);
								}
								return d.allowed
									? null
									: { ok: false as const, content: d.reason };
							})()
						: null;
				const impl = (registry as Partial<Record<string, ToolImpl>>)[name];
				let result: { ok: boolean; content: string; exitCode?: number };
				if (denied) {
					result = denied;
				} else {
					try {
						if (!impl) {
							result = {
								ok: false,
								content: `unknown tool: ${name}`,
							};
						} else {
							const out = await impl.exec(input, wtCtx);
							result =
								out.ok === true
									? {
											ok: true,
											content: out.content,
											exitCode: out.exitCode,
										}
									: { ok: false, content: out.error };
						}
					} catch (err) {
						result = {
							ok: false,
							content: err instanceof Error ? err.message : String(err),
						};
					}
				}
				const ms = Date.now() - startedAt;
				emit({
					t: "tool_result",
					name,
					ok: result.ok,
					ms,
					bytesOut: Buffer.byteLength(result.content, "utf8"),
					...(result.exitCode !== undefined
						? { exitCode: result.exitCode }
						: {}),
				});
				try {
					sor?.toolResult(callId, name, input, result.content, result.ok, ms);
				} catch (err) {
					console.warn(
						`[sor] tool_result skipped: ${err instanceof Error ? err.message : String(err)}`,
					);
				}

				messages.push({
					role: "tool",
					tool_call_id: callId,
					content: result.content,
				});
			}

			writeCheckpoint(wtCtx.runDir, wtCtx.role, model, messages);

			if (signal?.aborted) return fail("aborted after tool execution");
		}

		return fail(`max steps (${maxSteps}) exhausted without final answer`);
	} catch (err) {
		return fail(err instanceof Error ? err.message : String(err));
	}
}
