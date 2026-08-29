import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type OpenAI from "openai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	type RunAgentOutcome,
	runAgent,
	type WireEvent,
} from "../fleet/loop.ts";
import { RPD_EXHAUSTED } from "../fleet/quotaSignals.ts";
import {
	buildRegistry,
	type ToolImpl,
	type WtCtx,
} from "../fleet/tools/registry.ts";
import type { FleetAgentDef, ToolName } from "../fleet/types.ts";
import type { RequestIdentity } from "../telemetry.ts";

type MockResponse = Record<string, unknown>;

function defWith(tools: string[]): FleetAgentDef {
	return {
		name: "coder",
		systemPrompt: "",
		tools: tools as unknown as ToolName[],
		mcpAllow: [],
		skillsDir: "skills/coder",
	};
}

function resp(
	message: MockResponse,
	usage?: MockResponse | null,
): MockResponse {
	return {
		id: "chatcmpl-x",
		object: "chat.completion",
		choices: [{ index: 0, message, finish_reason: "stop" }],
		...(usage === null ? {} : { usage: usage ?? {} }),
	};
}

function toolCallReq(name: string, args: unknown, id = "call_1"): MockResponse {
	return {
		id,
		type: "function",
		function: { name, arguments: JSON.stringify(args) },
	};
}

function mockClient(script: MockResponse[]) {
	const create = vi.fn();
	for (const r of script) create.mockImplementationOnce(async () => r);
	const client = { chat: { completions: { create } } } as unknown as OpenAI;
	return { client, create };
}

let wt = "";
beforeEach(() => {
	wt = mkdtempSync(join(tmpdir(), "fleet-loop-"));
	writeFileSync(join(wt, "hello.txt"), "hello loop\n");
});

afterEach(() => {
	rmSync(wt, { recursive: true, force: true });
});

function ctx(overrides?: Partial<WtCtx>): WtCtx {
	return { worktreeDir: wt, role: "coder", ...overrides };
}

function collect() {
	const events: WireEvent[] = [];
	return { events, emit: (e: WireEvent) => events.push(e) };
}

const identity: Omit<RequestIdentity, "model" | "requestId" | "attempt"> = {
	managerId: "manager-test",
	runId: "run-test",
	workerId: "worker-test",
	sessionId: "session-test",
	role: "coder",
};

describe("runAgent", () => {
	it("switches models on a finite Gemini quota rejection instead of sleeping and retrying", async () => {
		vi.useFakeTimers();
		const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
		try {
			const registry = buildRegistry(defWith([]));
			const { client, create } = mockClient([
				resp({ role: "assistant", content: "must not run" }),
			]);
			const { events, emit } = collect();
			const reserve = vi
				.fn()
				.mockResolvedValue({ ok: false, block: "rpm", waitMs: 4200 });

			const outcome = await runAgent({
				client,
				model: "gemini-test",
				systemPrompt: "sys",
				task: "do the thing",
				registry,
				wtCtx: ctx(),
				emit,
				provider: "gemini",
				identity,
				reserve,
			});

			expect(outcome.ok).toBe(false);
			expect(outcome.error).toMatch(/^GEMINI_RATE_LIMIT_SWITCH:(rpm|tpm):\d+$/);
			expect(outcome.error).toBe("GEMINI_RATE_LIMIT_SWITCH:rpm:4200");
			expect(reserve).toHaveBeenCalledTimes(1);
			expect(create).not.toHaveBeenCalled();
			expect(errSpy).not.toHaveBeenCalledWith(
				expect.stringContaining("[llm-retry]"),
			);
			const telemetry = events.filter(
				(e): e is Extract<WireEvent, { t: "telemetry" }> => e.t === "telemetry",
			);
			const rejections = telemetry.filter(
				(e) => e.event === "reservation_rejection",
			);
			expect(rejections).toHaveLength(1);
			expect(rejections[0]).toMatchObject({
				blockedDimension: "rpm",
				status: "rejected",
				waitMs: 4200,
			});
			const switches = telemetry.filter(
				(e) => (e.event as string) === "model_switch",
			);
			expect(switches).toHaveLength(1);
			expect(switches[0]).toMatchObject({
				event: "model_switch",
				status: "blocked",
				blockedDimension: "rpm",
				waitMs: 4200,
				model: "gemini-test",
				requestId: expect.any(String),
			});
			expect(telemetry.some((e) => e.event === "retry")).toBe(false);
			expect(telemetry.some((e) => e.event === "reservation_wait")).toBe(false);
			expect(telemetry.some((e) => e.event === "provider_completion")).toBe(
				false,
			);
			expect(events.map((e) => e.t)).toEqual([
				"telemetry",
				"telemetry",
				"step_finish",
				"error",
			]);
		} finally {
			errSpy.mockRestore();
			vi.useRealTimers();
		}
	});

	it("fails fast on terminal RPD exhaustion without a model_switch event", async () => {
		const registry = buildRegistry(defWith([]));
		const { client, create } = mockClient([
			resp({ role: "assistant", content: "must not run" }),
		]);
		const { events, emit } = collect();
		const reserve = vi
			.fn()
			.mockResolvedValue({ ok: false, block: "rpd", terminal: true });

		const outcome = await runAgent({
			client,
			model: "gemini-test",
			systemPrompt: "sys",
			task: "do the thing",
			registry,
			wtCtx: ctx(),
			emit,
			provider: "gemini",
			identity,
			reserve,
		});

		expect(outcome.ok).toBe(false);
		expect(outcome.error).toBe(RPD_EXHAUSTED);
		expect(reserve).toHaveBeenCalledTimes(1);
		expect(create).not.toHaveBeenCalled();
		const telemetry = events.filter(
			(e): e is Extract<WireEvent, { t: "telemetry" }> => e.t === "telemetry",
		);
		const rejections = telemetry.filter(
			(e) => e.event === "reservation_rejection",
		);
		expect(rejections).toHaveLength(1);
		expect(rejections[0]).toMatchObject({
			blockedDimension: "rpd",
			status: "rejected",
		});
		expect(telemetry.some((e) => (e.event as string) === "model_switch")).toBe(
			false,
		);
		expect(telemetry.some((e) => e.event === "retry")).toBe(false);
		expect(telemetry.some((e) => e.event === "provider_completion")).toBe(
			false,
		);
		expect(events.map((e) => e.t)).toEqual([
			"telemetry",
			"step_finish",
			"error",
		]);
	});

	it("treats single-request TPM overflow (waitMs 0) as an immediate model switch", async () => {
		const registry = buildRegistry(defWith([]));
		const { client, create } = mockClient([
			resp({ role: "assistant", content: "must not run" }),
		]);
		const { events, emit } = collect();
		const reserve = vi
			.fn()
			.mockResolvedValue({ ok: false, block: "tpm", waitMs: 0 });

		const outcome = await runAgent({
			client,
			model: "gemini-test",
			systemPrompt: "sys",
			task: "do the thing",
			registry,
			wtCtx: ctx(),
			emit,
			provider: "gemini",
			identity,
			reserve,
		});

		expect(outcome.ok).toBe(false);
		expect(outcome.error).toBe("GEMINI_RATE_LIMIT_SWITCH:tpm:0");
		expect(reserve).toHaveBeenCalledTimes(1);
		expect(create).not.toHaveBeenCalled();
		const telemetry = events.filter(
			(e): e is Extract<WireEvent, { t: "telemetry" }> => e.t === "telemetry",
		);
		expect(
			telemetry.filter((e) => e.event === "reservation_rejection"),
		).toHaveLength(1);
		const switches = telemetry.filter(
			(e) => (e.event as string) === "model_switch",
		);
		expect(switches).toHaveLength(1);
		expect(switches[0]).toMatchObject({
			event: "model_switch",
			status: "blocked",
			blockedDimension: "tpm",
			waitMs: 0,
		});
	});

	it("reserved Gemini reservation proceeds straight to provider completion", async () => {
		const registry = buildRegistry(defWith([]));
		const { client, create } = mockClient([
			resp({ role: "assistant", content: "done" }),
		]);
		const { events, emit } = collect();
		const reserve = vi
			.fn()
			.mockResolvedValue({ ok: true, reservationId: "reservation-test" });

		const outcome = await runAgent({
			client,
			model: "gemini-test",
			systemPrompt: "sys",
			task: "do the thing",
			registry,
			wtCtx: ctx(),
			emit,
			provider: "gemini",
			identity,
			reserve,
		});

		expect(outcome.ok).toBe(true);
		expect(reserve).toHaveBeenCalledTimes(1);
		expect(create).toHaveBeenCalledTimes(1);
		const telemetry = events.filter(
			(e): e is Extract<WireEvent, { t: "telemetry" }> => e.t === "telemetry",
		);
		const reservations = telemetry.filter((e) => e.event === "reservation");
		expect(reservations).toHaveLength(1);
		expect(reservations[0]).toMatchObject({
			reservationId: "reservation-test",
			status: "reserved",
		});
		expect(telemetry.some((e) => e.event === "reservation_rejection")).toBe(
			false,
		);
		expect(telemetry.some((e) => (e.event as string) === "model_switch")).toBe(
			false,
		);
		expect(outcome.text).toBe("done");
	});

	it("reserves immediately before each initial and tool-continuation request and correlates ids", async () => {
		const registry = buildRegistry(defWith(["read"]));
		const { client, create } = mockClient([
			resp({
				role: "assistant",
				content: null,
				tool_calls: [toolCallReq("read", { path: "hello.txt" })],
			}),
			resp({ role: "assistant", content: "done" }),
		]);
		const { events, emit } = collect();
		const reservations: RequestIdentity[] = [];
		const reserve = vi.fn(async (request: RequestIdentity) => {
			expect(create).toHaveBeenCalledTimes(reservations.length);
			reservations.push(request);
			return { ok: true, reservationId: `res-${request.requestId}` };
		});

		const outcome = await runAgent({
			client,
			model: "gemini-test",
			systemPrompt: "secret system prompt",
			task: "secret user prompt",
			registry,
			wtCtx: ctx(),
			emit,
			provider: "gemini",
			identity,
			reserve,
		});

		expect(outcome.ok).toBe(true);
		expect(reservations).toHaveLength(2);
		expect(create).toHaveBeenCalledTimes(2);
		expect(reservations.map((r) => r.attempt)).toEqual([1, 1]);
		expect(new Set(reservations.map((r) => r.requestId)).size).toBe(2);
		const telemetry = events.filter((e) => e.t === "telemetry");
		expect(telemetry).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					event: "reservation",
					reservationId: `res-${reservations[0]?.requestId}`,
				}),
				expect.objectContaining({
					event: "provider_completion",
					reservationId: `res-${reservations[1]?.requestId}`,
				}),
			]),
		);
		for (const event of telemetry) {
			expect(JSON.stringify(event)).not.toContain("secret system prompt");
			expect(JSON.stringify(event)).not.toContain("secret user prompt");
			expect(JSON.stringify(event)).not.toContain("hello.txt");
		}
	});

	it("fails closed when a Gemini reservation callback is bypassed", async () => {
		const { client, create } = mockClient([
			resp({ role: "assistant", content: "must not run" }),
		]);
		const { events, emit } = collect();
		const outcome = await runAgent({
			client,
			model: "gemini-test",
			systemPrompt: "",
			task: "",
			registry: {},
			wtCtx: ctx(),
			emit,
			provider: "gemini",
			identity,
		});
		expect(outcome.ok).toBe(false);
		expect(outcome.error).toContain("coordinator unavailable");
		expect(create).not.toHaveBeenCalled();
		expect(
			events.some(
				(e) => e.t === "telemetry" && e.event === "provider_completion",
			),
		).toBe(false);
	});

	it("fails closed when the coordinator returns success without a reservation id", async () => {
		const { client, create } = mockClient([
			resp({ role: "assistant", content: "must not run" }),
		]);
		const outcome = await runAgent({
			client,
			model: "gemini-test",
			systemPrompt: "",
			task: "",
			registry: {},
			wtCtx: ctx(),
			emit: collect().emit,
			provider: "gemini",
			identity,
			reserve: vi.fn().mockResolvedValue({ ok: true }),
		});
		expect(outcome.ok).toBe(false);
		expect(outcome.error).toContain("missing reservationId");
		expect(create).not.toHaveBeenCalled();
	});

	it("happy path: tool-call roundtrip emits ordered wire events and returns final text", async () => {
		const registry = buildRegistry(defWith(["read"]));
		const { client, create } = mockClient([
			resp(
				{
					role: "assistant",
					content: null,
					tool_calls: [toolCallReq("read", { path: "hello.txt" })],
				},
				{
					prompt_tokens: 10,
					completion_tokens: 4,
					total_tokens: 14,
				},
			),
			resp({ role: "assistant", content: "file says hello" }),
		]);
		const { events, emit } = collect();

		const outcome = await runAgent({
			client,
			model: "test-model",
			systemPrompt: "sys",
			task: "do the thing",
			registry,
			wtCtx: ctx(),
			emit,
		});

		expect(outcome.ok).toBe(true);
		expect(outcome.text).toBe("file says hello");
		expect(create).toHaveBeenCalledTimes(2);
		expect(events.map((e) => e.t)).toEqual([
			"tool_call",
			"tool_result",
			"text",
			"result",
			"step_finish",
		]);
		const callEvt = events[0] as Extract<WireEvent, { t: "tool_call" }>;
		expect(callEvt.name).toBe("read");
		expect(callEvt.input).toEqual({ path: "hello.txt" });
		const resultEvt = events[1] as Extract<WireEvent, { t: "tool_result" }>;
		expect(resultEvt.name).toBe("read");
		expect(resultEvt.ok).toBe(true);
		expect(typeof resultEvt.ms).toBe("number");
		expect(resultEvt.ms).toBeGreaterThanOrEqual(0);
		expect(resultEvt.bytesOut).toBeGreaterThan(0);
		expect(events[3]).toEqual({ t: "result", text: "file says hello" });
		const finish = events[4] as Extract<WireEvent, { t: "step_finish" }>;
		expect(finish.usage).toEqual({
			input: 10,
			output: 4,
			reasoning: 0,
			cached: 0,
			cacheWrite: 0,
			total: 14,
		});

		const secondCall = (create.mock.calls[1] ?? [])[0] as {
			messages: Array<{
				role: string;
				content?: unknown;
				tool_call_id?: string;
			}>;
		};
		const roles = secondCall.messages.map((m) => m.role);
		expect(roles).toEqual(["system", "user", "assistant", "tool"]);
		const toolMsg = secondCall.messages[3] as {
			role: string;
			content?: unknown;
			tool_call_id?: string;
		};
		expect(toolMsg.tool_call_id).toBe("call_1");
		expect(toolMsg.content).toContain("hello loop");
	});

	it("usage tolerance: full usage extracts all fields including reasoning and cacheWrite", async () => {
		const { client } = mockClient([
			resp(
				{ role: "assistant", content: "done" },
				{
					prompt_tokens: 100,
					completion_tokens: 50,
					total_tokens: 150,
					prompt_tokens_details: { cached_tokens: 20, cache_write: 5 },
					completion_tokens_details: { reasoning_tokens: 8 },
					cost: 0.01,
				},
			),
		]);
		const { emit } = collect();

		const outcome = await runAgent({
			client,
			model: "m",
			systemPrompt: "",
			task: "",
			registry: {},
			wtCtx: ctx(),
			emit,
		});

		expect(outcome.ok).toBe(true);
		expect(outcome.usage).toEqual({
			input: 100,
			output: 50,
			reasoning: 8,
			cached: 20,
			cacheWrite: 5,
			total: 150,
		});
		expect(outcome.costUsd).toBe(0.01);
	});

	it("usage tolerance: missing reasoning/cacheWrite details count as zero without crashing", async () => {
		const { client } = mockClient([
			resp(
				{ role: "assistant", content: "done" },
				{
					prompt_tokens: 12,
					completion_tokens: 3,
					total_tokens: 15,
					prompt_tokens_details: { cached_tokens: 2 },
				},
			),
		]);
		const { events, emit } = collect();

		const outcome = await runAgent({
			client,
			model: "m",
			systemPrompt: "",
			task: "",
			registry: {},
			wtCtx: ctx(),
			emit,
		});

		expect(outcome.usage.reasoning).toBe(0);
		expect(outcome.usage.cacheWrite).toBe(0);
		expect(outcome.usage.cached).toBe(2);
		expect(outcome.usage.total).toBe(15);
		const finish = events.find(
			(e): e is Extract<WireEvent, { t: "step_finish" }> =>
				e.t === "step_finish",
		);
		expect(finish).toBeDefined();
		expect(finish?.usage.reasoning).toBe(0);
	});

	it("usage tolerance: no usage at all accumulates to all zeros but still emits step_finish", async () => {
		const { client } = mockClient([resp({ role: "assistant", content: "ok" })]);
		const { events, emit } = collect();

		const outcome = await runAgent({
			client,
			model: "m",
			systemPrompt: "",
			task: "",
			registry: {},
			wtCtx: ctx(),
			emit,
		});

		expect(outcome.ok).toBe(true);
		expect(outcome.usage).toEqual({
			input: 0,
			output: 0,
			reasoning: 0,
			cached: 0,
			cacheWrite: 0,
			total: 0,
		});
		expect(outcome.costUsd).toBe(0);
		expect(events.at(-1)?.t).toBe("step_finish");
	});

	it("costUsd comes from provider metadata when present and stays 0 when absent", async () => {
		const withCost = mockClient([
			resp(
				{ role: "assistant", content: "a" },
				{ prompt_tokens: 1, completion_tokens: 1, cost: 0.25 },
			),
		]);
		const o1 = await runAgent({
			client: withCost.client,
			model: "m",
			systemPrompt: "",
			task: "",
			registry: {},
			wtCtx: ctx(),
			emit: collect().emit,
		});
		expect(o1.costUsd).toBe(0.25);

		const noCost = mockClient([
			resp(
				{ role: "assistant", content: "a" },
				{ prompt_tokens: 1, completion_tokens: 1 },
			),
		]);
		const o2 = await runAgent({
			client: noCost.client,
			model: "m",
			systemPrompt: "",
			task: "",
			registry: {},
			wtCtx: ctx(),
			emit: collect().emit,
		});
		expect(o2.costUsd).toBe(0);

		const ollama = mockClient([
			resp(
				{ role: "assistant", content: "a" },
				{ prompt_tokens: 1, completion_tokens: 1, cost: 9 },
			),
		]);
		const o3 = await runAgent({
			client: ollama.client,
			model: "m",
			systemPrompt: "",
			task: "",
			registry: {},
			wtCtx: ctx(),
			emit: collect().emit,
			provider: "ollama",
		});
		expect(o3.costUsd).toBe(0);
	});

	it("multi-step accumulation sums usage across at least two steps", async () => {
		const registry = buildRegistry(defWith(["read"]));
		const { client } = mockClient([
			resp(
				{
					role: "assistant",
					content: null,
					tool_calls: [toolCallReq("read", { path: "hello.txt" })],
				},
				{
					prompt_tokens: 10,
					completion_tokens: 5,
					total_tokens: 15,
					completion_tokens_details: { reasoning_tokens: 2 },
					cost: 0.001,
				},
			),
			resp(
				{
					role: "assistant",
					content: null,
					tool_calls: [toolCallReq("read", { path: "hello.txt" }, "call_2")],
				},
				{
					prompt_tokens: 30,
					completion_tokens: 7,
					total_tokens: 37,
					completion_tokens_details: { reasoning_tokens: 3 },
					cost: 0.002,
				},
			),
			resp(
				{ role: "assistant", content: "finished" },
				{
					prompt_tokens: 60,
					completion_tokens: 8,
					total_tokens: 68,
					completion_tokens_details: { reasoning_tokens: 5 },
					cost: 0.004,
				},
			),
		]);
		const { events, emit } = collect();

		const outcome = await runAgent({
			client,
			model: "m",
			systemPrompt: "",
			task: "",
			registry,
			wtCtx: ctx(),
			emit,
		});

		expect(outcome.ok).toBe(true);
		expect(outcome.usage).toEqual({
			input: 100,
			output: 20,
			reasoning: 10,
			cached: 0,
			cacheWrite: 0,
			total: 120,
		});
		expect(outcome.costUsd).toBeCloseTo(0.007, 10);
		expect(events.filter((e) => e.t === "step_finish")).toHaveLength(1);
		expect(events.at(-1)?.t).toBe("step_finish");
	});

	it("error path: SDK throw mid-loop emits error event, failed outcome, no result event", async () => {
		const create = vi.fn().mockRejectedValueOnce(new Error("boom from sdk"));
		const client = { chat: { completions: { create } } } as unknown as OpenAI;
		const { events, emit } = collect();

		const outcome = await runAgent({
			client,
			model: "m",
			systemPrompt: "",
			task: "",
			registry: buildRegistry(defWith(["read"])),
			wtCtx: ctx(),
			emit,
		});

		expect(outcome.ok).toBe(false);
		expect(outcome.error).toBe("boom from sdk");
		expect(events.map((e) => e.t)).toEqual(["step_finish", "error"]);
		expect(events.some((e) => e.t === "result")).toBe(false);
		expect(events.some((e) => e.t === "step_finish")).toBe(true);
	});

	it("unknown tool hallucinated by the model yields ok:false tool_result and the loop continues", async () => {
		const registry = buildRegistry(defWith(["read"]));
		const exec = registry.read?.exec;
		const readExec = vi
			.spyOn(registry.read as ToolImpl, "exec")
			.mockImplementation(
				exec ?? (() => Promise.resolve({ ok: false, error: "mock not set" })),
			);
		const { client, create } = mockClient([
			resp({
				role: "assistant",
				content: null,
				tool_calls: [toolCallReq("web_search", { q: "x" })],
			}),
			resp({ role: "assistant", content: "recovered" }),
		]);
		const { events, emit } = collect();

		const outcome = await runAgent({
			client,
			model: "m",
			systemPrompt: "",
			task: "",
			registry,
			wtCtx: ctx(),
			emit,
		});

		expect(outcome.ok).toBe(true);
		expect(outcome.text).toBe("recovered");
		expect(create).toHaveBeenCalledTimes(2);
		expect(readExec).not.toHaveBeenCalled();
		const resultEvt = events[1] as Extract<WireEvent, { t: "tool_result" }>;
		expect(resultEvt?.name).toBe("web_search");
		expect(resultEvt?.ok).toBe(false);
		expect(typeof resultEvt?.ms).toBe("number");
		expect(typeof resultEvt?.bytesOut).toBe("number");
		const secondMessages = (
			(create.mock.calls[1] ?? [])[0] as {
				messages: Array<{ role: string; content?: unknown }>;
			}
		).messages;
		expect(secondMessages.at(-1)).toMatchObject({
			role: "tool",
			content: expect.stringContaining("unknown tool"),
		});
		expect(events.at(-1)?.t).toBe("step_finish");
	});

	it("abort after first tool result stops scheduling further LLM calls and emits terminal error", async () => {
		const controller = new AbortController();
		const registry = buildRegistry(defWith(["read"]));
		const readTool = registry.read;
		if (!readTool) throw new Error("readTool not available");
		const innerExec = readTool.exec.bind(readTool);
		(registry as Record<string, ToolImpl>).read = {
			schema: readTool.schema,
			exec: async (input, c) => {
				const out = await innerExec(input, c);
				controller.abort();
				return out;
			},
		};
		const { client, create } = mockClient([
			resp({
				role: "assistant",
				content: null,
				tool_calls: [toolCallReq("read", { path: "hello.txt" })],
			}),
			resp({ role: "assistant", content: "should never run" }),
		]);
		const { events, emit } = collect();

		const outcome = await runAgent({
			client,
			model: "m",
			systemPrompt: "",
			task: "",
			registry,
			wtCtx: ctx(),
			emit,
			signal: controller.signal,
		});

		expect(outcome.ok).toBe(false);
		expect(outcome.error).toMatch(/aborted/);
		expect(create).toHaveBeenCalledTimes(1);
		const types = events.map((e) => e.t);
		expect(types.indexOf("tool_result")).toBeGreaterThan(-1);
		expect(types).not.toContain("text");
		expect(types).not.toContain("result");
		expect(types.at(-1)).toBe("error");
	});

	it("abort before a step skips the LLM call entirely", async () => {
		const controller = new AbortController();
		controller.abort();
		const { client, create } = mockClient([]);
		const { events, emit } = collect();

		const outcome = await runAgent({
			client,
			model: "m",
			systemPrompt: "",
			task: "",
			registry: buildRegistry(defWith(["read"])),
			wtCtx: ctx(),
			emit,
			signal: controller.signal,
		});

		expect(outcome.ok).toBe(false);
		expect(create).not.toHaveBeenCalled();
		expect(events.map((e) => e.t)).toEqual(["step_finish", "error"]);
	});

	it("maxSteps exhaustion takes the error path instead of looping forever", async () => {
		const { client, create } = mockClient([
			resp({
				role: "assistant",
				content: null,
				tool_calls: [toolCallReq("read", { path: "hello.txt" })],
			}),
			resp({
				role: "assistant",
				content: null,
				tool_calls: [toolCallReq("read", { path: "hello.txt" })],
			}),
			resp({
				role: "assistant",
				content: null,
				tool_calls: [toolCallReq("read", { path: "hello.txt" })],
			}),
		]);
		const { events, emit } = collect();

		const outcome: RunAgentOutcome = await runAgent({
			client,
			model: "m",
			systemPrompt: "",
			task: "",
			registry: buildRegistry(defWith(["read"])),
			wtCtx: ctx(),
			emit,
			maxSteps: 3,
		});

		expect(outcome.ok).toBe(false);
		expect(outcome.error).toContain("max steps (3)");
		expect(create).toHaveBeenCalledTimes(3);
		expect(events.filter((e) => e.t === "tool_call")).toHaveLength(3);
		expect(events.at(-1)).toMatchObject({
			t: "error",
			error: expect.stringContaining("max steps"),
		});
		expect(events.some((e) => e.t === "result")).toBe(false);
	});

	it("malformed JSON tool arguments degrade to empty input via tool error, not a crash", async () => {
		const registry = buildRegistry(defWith(["read"]));
		const { client } = mockClient([
			resp({
				role: "assistant",
				content: null,
				tool_calls: [
					{
						id: "call_bad",
						type: "function",
						function: { name: "read", arguments: "{not json" },
					},
				],
			}),
			resp({ role: "assistant", content: "moved on" }),
		]);
		const { events, emit } = collect();

		const outcome = await runAgent({
			client,
			model: "m",
			systemPrompt: "",
			task: "",
			registry,
			wtCtx: ctx(),
			emit,
		});

		expect(outcome.ok).toBe(true);
		const resultEvt = events[1] as Extract<WireEvent, { t: "tool_result" }>;
		expect(resultEvt.ok).toBe(false);
		expect(outcome.text).toBe("moved on");
	});

	it("echoes provider thought signatures back on assistant tool_call turns", async () => {
		const registry = buildRegistry(defWith(["read"]));
		const signature = { google: { thought_signature: "sig-abc-123" } };
		const first = resp({
			role: "assistant",
			content: null,
			tool_calls: [
				{
					...toolCallReq("read", { path: "hello.txt" }),
					extra_content: signature,
				},
			],
		});
		const second = resp({ role: "assistant", content: "done" });
		const { client, create } = mockClient([first, second]);
		const { emit } = collect();

		await runAgent({
			client,
			model: "m",
			systemPrompt: "",
			task: "",
			registry,
			wtCtx: ctx(),
			emit,
		});

		expect(create).toHaveBeenCalledTimes(2);
		const secondCall = create.mock.calls[1]?.[0] as {
			messages: Array<{
				role: string;
				tool_calls?: Array<Record<string, unknown>>;
			}>;
		};
		const echoed = secondCall.messages.find((m) => m.role === "assistant");
		expect(echoed?.tool_calls?.[0]?.extra_content).toEqual(signature);
	});

	it("retries transient provider errors with backoff and recovers", async () => {
		vi.useFakeTimers();
		const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
		try {
			const registry = buildRegistry(defWith([]));
			const transient = Object.assign(new Error("429 RESOURCE_EXHAUSTED"), {
				status: 429,
			});
			const { client, create } = mockClient([]);
			create.mockImplementationOnce(async () => {
				throw transient;
			});

			create.mockImplementationOnce(async () =>
				resp({ role: "assistant", content: "recovered" }),
			);
			const { events, emit } = collect();

			const pending = runAgent({
				client,
				model: "m",
				systemPrompt: "",
				task: "",
				registry,
				wtCtx: ctx(),
				emit,
				identity,
			});

			await vi.advanceTimersByTimeAsync(15000);
			const outcome = await pending;

			expect(outcome.ok).toBe(true);
			expect(outcome.text).toBe("recovered");
			expect(create).toHaveBeenCalledTimes(2);
			expect(errSpy).toHaveBeenCalledWith(
				expect.stringContaining("[llm-retry]"),
			);
			expect(events.some((e) => e.t === "error")).toBe(false);
			expect(events).toEqual(
				expect.arrayContaining([
					expect.objectContaining({
						t: "telemetry",
						event: "provider_rate_limit",
						model: "m",
						role: "coder",
						httpStatus: 429,
					}),
					expect.objectContaining({
						t: "telemetry",
						event: "retry",
						attempt: 1,
						requestId: expect.any(String),
					}),
				]),
			);
		} finally {
			errSpy.mockRestore();
			vi.useRealTimers();
		}
	});

	it("retries connection-level errors without a status code", async () => {
		vi.useFakeTimers();
		const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
		try {
			const registry = buildRegistry(defWith([]));
			const { client, create } = mockClient([]);
			create.mockImplementationOnce(async () => {
				throw new Error("Connection error.");
			});
			create.mockImplementationOnce(async () =>
				resp({ role: "assistant", content: "back" }),
			);
			const { events, emit } = collect();

			const pending = runAgent({
				client,
				model: "m",
				systemPrompt: "",
				task: "",
				registry,
				wtCtx: ctx(),
				emit,
			});
			await vi.advanceTimersByTimeAsync(15000);
			const outcome = await pending;

			expect(outcome.ok).toBe(true);
			expect(outcome.text).toBe("back");
			expect(create).toHaveBeenCalledTimes(2);
			expect(errSpy).toHaveBeenCalledWith(
				expect.stringContaining("[llm-retry]"),
			);
			expect(events.some((e) => e.t === "error")).toBe(false);
		} finally {
			errSpy.mockRestore();
			vi.useRealTimers();
		}
	});

	it("retries header-timeout aborts from slow local backends", async () => {
		vi.useFakeTimers();
		const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
		try {
			const registry = buildRegistry(defWith([]));
			const { client, create } = mockClient([]);
			create.mockImplementationOnce(async () => {
				throw new Error(
					"Request timed out. Node.js fetch timed out waiting for response headers; " +
						"configure a matching undici fetch and fetchOptions.dispatcher with an Agent " +
						"whose headersTimeout is at least the SDK timeout.",
				);
			});
			create.mockImplementationOnce(async () =>
				resp({ role: "assistant", content: "slow but alive" }),
			);
			const { events, emit } = collect();

			const pending = runAgent({
				client,
				model: "m",
				systemPrompt: "",
				task: "",
				registry,
				wtCtx: ctx(),
				emit,
			});
			await vi.advanceTimersByTimeAsync(15000);
			const outcome = await pending;

			expect(outcome.ok).toBe(true);
			expect(outcome.text).toBe("slow but alive");
			expect(create).toHaveBeenCalledTimes(2);
			expect(events.some((e) => e.t === "error")).toBe(false);
		} finally {
			errSpy.mockRestore();
			vi.useRealTimers();
		}
	});

	it("assembles streamed chat deltas into a non-streaming shaped response", async () => {
		const { createStreaming } = await import("../fleet/loop.ts");
		const chunks = [
			{ choices: [{ delta: { content: "Hel" } }] },
			{ choices: [{ delta: { content: "lo" } }] },
			{
				choices: [
					{
						delta: {
							tool_calls: [
								{
									index: 0,
									id: "call_1",
									function: { name: "write_file", arguments: '{"pa' },
								},
							],
						},
					},
				],
			},
			{
				choices: [
					{
						delta: {
							tool_calls: [
								{ index: 0, function: { arguments: 'th":"a.ts"}' } },
							],
						},
					},
				],
			},
		];
		const create = (async (opts: { stream?: boolean }) => {
			expect(opts.stream).toBe(true);
			return (async function* () {
				for (const c of chunks) yield c;
			})();
		}) as unknown as Parameters<typeof createStreaming>[0];

		const out = (await createStreaming(create, {
			model: "m",
			messages: [],
		})) as unknown as {
			choices: Array<{
				message: {
					content: string | null;
					tool_calls?: Array<{
						id: string;
						function: { name: string; arguments: string };
					}>;
				};
			}>;
			usage?: unknown;
		};

		const [choice] = out.choices;
		if (!choice) throw new Error("no choices in streamed response");
		const msg = choice.message;
		expect(msg.content).toBe("Hello");
		expect(msg.tool_calls).toEqual([
			{
				id: "call_1",
				type: "function",
				function: { name: "write_file", arguments: '{"path":"a.ts"}' },
			},
		]);
	});

	it("streamed tool_calls preserve extra_content", async () => {
		const { createStreaming } = await import("../fleet/loop.ts");
		const signature = { google: { thought_signature: "sig123" } };
		const chunks = [
			{
				choices: [
					{
						delta: {
							tool_calls: [
								{
									index: 0,
									id: "call_9",
									function: { name: "list_files", arguments: '{"path":"/"}' },
									extra_content: signature,
								},
							],
						},
					},
				],
			},
		];
		const create = (async () => {
			return (async function* () {
				for (const c of chunks) yield c;
			})();
		}) as unknown as Parameters<typeof createStreaming>[0];

		const out = (await createStreaming(create, {
			model: "m",
			messages: [],
		})) as unknown as {
			choices: Array<{
				message: {
					tool_calls?: Array<{ id: string; extra_content?: unknown }>;
				};
			}>;
		};

		const tc = out.choices[0]?.message.tool_calls?.[0];
		if (!tc) throw new Error("tool call not found");
		expect(tc.id).toBe("call_9");
		expect(tc.extra_content).toEqual(signature);
	});

	it("streamed signatures echo back on the next request", async () => {
		const prevStream = process.env.FLEET_LLM_STREAM;
		process.env.FLEET_LLM_STREAM = "1";
		const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
		try {
			const registry = buildRegistry(defWith([]));
			const { client, create } = mockClient([]);
			const signature = { google: { thought_signature: "Eq8C…" } };
			let capturedMessages: unknown[] | undefined;
			const toolCallStream = (async function* () {
				yield {
					choices: [
						{
							delta: {
								tool_calls: [
									{
										index: 0,
										id: "call_1",
										function: {
											name: "glob",
											arguments: '{"pattern":"**/*.py"}',
										},
										extra_content: signature,
									},
								],
							},
						},
					],
				};
			})();
			create.mockImplementationOnce(async () => toolCallStream);
			create.mockImplementationOnce(async (opts: { messages?: unknown[] }) => {
				capturedMessages = opts.messages;
				return (async function* () {
					yield { choices: [{ delta: { content: "done" } }] };
				})();
			});
			const { events, emit } = collect();

			const outcome = await runAgent({
				client,
				model: "m",
				systemPrompt: "",
				task: "",
				registry,
				wtCtx: ctx(),
				emit,
			});

			expect(outcome.ok).toBe(true);
			expect(outcome.text).toBe("done");
			expect(create).toHaveBeenCalledTimes(2);
			const assistantEcho = (capturedMessages ?? []).find(
				(m) =>
					(
						m as {
							role?: string;
							tool_calls?: Array<{ extra_content?: unknown }>;
						}
					).role === "assistant" &&
					Array.isArray((m as { tool_calls?: unknown[] }).tool_calls),
			) as { tool_calls: Array<{ extra_content?: unknown }> } | undefined;
			expect(assistantEcho).toBeDefined();
			expect(assistantEcho?.tool_calls[0]?.extra_content).toEqual(signature);
			expect(events.some((e) => e.t === "error")).toBe(false);
		} finally {
			errSpy.mockRestore();
			if (prevStream === undefined) delete process.env.FLEET_LLM_STREAM;
			else process.env.FLEET_LLM_STREAM = prevStream;
		}
	});

	it("parseRetryDelayMs honors the server-suggested retry window", async () => {
		const { parseRetryDelayMs } = await import("../fleet/loop.ts");
		const serverSaid = new Error(
			'429 quota ... "retryDelay":"19s" ... Please retry in 19.923033201s.',
		);
		expect(parseRetryDelayMs(serverSaid)).toBeGreaterThan(19000);
		expect(parseRetryDelayMs(serverSaid)).toBeLessThan(20000);
		expect(parseRetryDelayMs(new Error('"retryDelay":"30s"'))).toBe(30000);
		expect(parseRetryDelayMs(new Error("no hint here"))).toBeNull();
	});

	it("does not retry non-transient provider errors", async () => {
		const registry = buildRegistry(defWith([]));
		const badRequest = Object.assign(new Error("400 INVALID_ARGUMENT"), {
			status: 400,
		});
		const { client, create } = mockClient([]);
		create.mockImplementationOnce(async () => {
			throw badRequest;
		});
		const { events, emit } = collect();

		const outcome = await runAgent({
			client,
			model: "m",
			systemPrompt: "",
			task: "",
			registry,
			wtCtx: ctx(),
			emit,
		});

		expect(outcome.ok).toBe(false);
		expect(outcome.error).toContain("400");
		expect(create).toHaveBeenCalledTimes(1);
		expect(events.some((e) => e.t === "error")).toBe(true);
	});

	it("retries ollama errors every OLLAMA_RETRY_DELAY_MS", async () => {
		vi.useFakeTimers();
		const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
		try {
			const registry = buildRegistry(defWith([]));
			const { client, create } = mockClient([]);
			create.mockImplementationOnce(async () => {
				throw new Error("Connection error.");
			});
			create.mockImplementationOnce(async () => {
				throw new Error("fetch failed");
			});
			create.mockImplementationOnce(async () =>
				resp({ role: "assistant", content: "recovered" }),
			);
			const { events, emit } = collect();

			const pending = runAgent({
				client,
				model: "m",
				systemPrompt: "",
				task: "",
				registry,
				wtCtx: ctx(),
				emit,
				provider: "ollama",
			});
			await vi.advanceTimersByTimeAsync(5000);
			await vi.advanceTimersByTimeAsync(5000);
			const outcome = await pending;

			expect(outcome.ok).toBe(true);
			expect(outcome.text).toBe("recovered");
			expect(create).toHaveBeenCalledTimes(3);
			expect(errSpy).toHaveBeenCalledWith(
				expect.stringContaining("[llm-retry]"),
			);
			expect(events.some((e) => e.t === "error")).toBe(false);
		} finally {
			errSpy.mockRestore();
			vi.useRealTimers();
		}
	});

	it("ollama retries exceed the standard three-strike ladder", async () => {
		vi.useFakeTimers();
		const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
		try {
			const registry = buildRegistry(defWith([]));
			const { client, create } = mockClient([]);
			for (let i = 0; i < 4; i++) {
				create.mockImplementationOnce(async () => {
					throw new Error("Connection error.");
				});
			}
			create.mockImplementationOnce(async () =>
				resp({ role: "assistant", content: "fifth time lucky" }),
			);
			const { events, emit } = collect();

			const pending = runAgent({
				client,
				model: "m",
				systemPrompt: "",
				task: "",
				registry,
				wtCtx: ctx(),
				emit,
				provider: "ollama",
			});
			for (let i = 0; i < 4; i++) await vi.advanceTimersByTimeAsync(5000);
			const outcome = await pending;

			expect(outcome.ok).toBe(true);
			expect(outcome.text).toBe("fifth time lucky");
			expect(create).toHaveBeenCalledTimes(5);
			expect(events.some((e) => e.t === "error")).toBe(false);
		} finally {
			errSpy.mockRestore();
			vi.useRealTimers();
		}
	});

	it("retry log includes the underlying transient error message", async () => {
		vi.useFakeTimers();
		const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
		try {
			const registry = buildRegistry(defWith([]));
			const { client, create } = mockClient([]);
			create.mockImplementationOnce(async () => {
				throw new Error("connect ECONNREFUSED 127.0.0.1:11434");
			});
			create.mockImplementationOnce(async () =>
				resp({ role: "assistant", content: "recovered" }),
			);
			const { events, emit } = collect();

			const pending = runAgent({
				client,
				model: "m",
				systemPrompt: "",
				task: "",
				registry,
				wtCtx: ctx(),
				emit,
				provider: "ollama",
			});
			await vi.advanceTimersByTimeAsync(5000);
			const outcome = await pending;

			expect(outcome.ok).toBe(true);
			expect(errSpy).toHaveBeenCalledWith(
				expect.stringContaining("[llm-retry]"),
			);
			expect(errSpy).toHaveBeenCalledWith(
				expect.stringContaining("ECONNREFUSED 127.0.0.1:11434"),
			);
			expect(events.some((e) => e.t === "error")).toBe(false);
		} finally {
			errSpy.mockRestore();
			vi.useRealTimers();
		}
	});

	it("OLLAMA_MAX_RETRIES=2 caps ollama at 3 total attempts then rethrows", async () => {
		const prev = process.env.OLLAMA_MAX_RETRIES;
		process.env.OLLAMA_MAX_RETRIES = "2";
		vi.useFakeTimers();
		const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
		try {
			const registry = buildRegistry(defWith([]));
			const { client, create } = mockClient([]);
			for (let i = 0; i < 4; i++) {
				create.mockImplementationOnce(async () => {
					throw new Error("Connection error.");
				});
			}
			const { events, emit } = collect();

			const pending = runAgent({
				client,
				model: "m",
				systemPrompt: "",
				task: "",
				registry,
				wtCtx: ctx(),
				emit,
				provider: "ollama",
			});
			for (let i = 0; i < 2; i++) await vi.advanceTimersByTimeAsync(5000);
			const outcome = await pending;

			expect(outcome.ok).toBe(false);
			expect(outcome.error).toContain("Connection error.");
			expect(create).toHaveBeenCalledTimes(3);
			expect(events.some((e) => e.t === "error")).toBe(true);
			const retryLogs = errSpy.mock.calls
				.map((call) => String(call[0]))
				.filter((m) => m.includes("[llm-retry]"));
			expect(retryLogs).toHaveLength(2);
			expect(retryLogs.every((m) => m.includes("/2 "))).toBe(true);
		} finally {
			errSpy.mockRestore();
			vi.useRealTimers();
			if (prev === undefined) delete process.env.OLLAMA_MAX_RETRIES;
			else process.env.OLLAMA_MAX_RETRIES = prev;
		}
	});

	it("OLLAMA_MAX_RETRIES=0 fails on the first transient error without a retry", async () => {
		const prev = process.env.OLLAMA_MAX_RETRIES;
		process.env.OLLAMA_MAX_RETRIES = "0";
		vi.useFakeTimers();
		const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
		try {
			const registry = buildRegistry(defWith([]));
			const { client, create } = mockClient([]);
			create.mockImplementationOnce(async () => {
				throw new Error("fetch failed");
			});
			const { events, emit } = collect();

			const outcome = await runAgent({
				client,
				model: "m",
				systemPrompt: "",
				task: "",
				registry,
				wtCtx: ctx(),
				emit,
				provider: "ollama",
			});
			await vi.advanceTimersByTimeAsync(60000);

			expect(outcome.ok).toBe(false);
			expect(outcome.error).toContain("fetch failed");
			expect(create).toHaveBeenCalledTimes(1);
			expect(errSpy).not.toHaveBeenCalledWith(
				expect.stringContaining("[llm-retry]"),
			);
			expect(events.some((e) => e.t === "error")).toBe(true);
		} finally {
			errSpy.mockRestore();
			vi.useRealTimers();
			if (prev === undefined) delete process.env.OLLAMA_MAX_RETRIES;
			else process.env.OLLAMA_MAX_RETRIES = prev;
		}
	});

	it("unset OLLAMA_MAX_RETRIES keeps ollama retries unlimited within the window", async () => {
		const prev = process.env.OLLAMA_MAX_RETRIES;
		delete process.env.OLLAMA_MAX_RETRIES;
		vi.useFakeTimers();
		const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
		try {
			const registry = buildRegistry(defWith([]));
			const { client, create } = mockClient([]);
			for (let i = 0; i < 3; i++) {
				create.mockImplementationOnce(async () => {
					throw new Error("Connection error.");
				});
			}
			create.mockImplementationOnce(async () =>
				resp({ role: "assistant", content: "still going" }),
			);
			const { events, emit } = collect();

			const pending = runAgent({
				client,
				model: "m",
				systemPrompt: "",
				task: "",
				registry,
				wtCtx: ctx(),
				emit,
				provider: "ollama",
			});
			for (let i = 0; i < 3; i++) await vi.advanceTimersByTimeAsync(5000);
			const outcome = await pending;

			expect(outcome.ok).toBe(true);
			expect(outcome.text).toBe("still going");
			expect(create).toHaveBeenCalledTimes(4);
			expect(events.some((e) => e.t === "error")).toBe(false);
			const retryLogs = errSpy.mock.calls
				.map((call) => String(call[0]))
				.filter((m) => m.includes("[llm-retry]"));
			expect(retryLogs.length).toBeGreaterThan(0);
			expect(retryLogs.every((m) => m.includes("/∞ "))).toBe(true);
		} finally {
			errSpy.mockRestore();
			vi.useRealTimers();
			if (prev === undefined) delete process.env.OLLAMA_MAX_RETRIES;
			else process.env.OLLAMA_MAX_RETRIES = prev;
		}
	});

	it("ollamaMaxRetries validation: unset/empty is unlimited, 0 is allowed, garbage rejected", async () => {
		const { ollamaMaxRetries } = await import("../fleet/loop.ts");
		expect(ollamaMaxRetries(undefined)).toBeNull();
		expect(ollamaMaxRetries("")).toBeNull();
		expect(ollamaMaxRetries("   ")).toBeNull();
		expect(ollamaMaxRetries("0")).toBe(0);
		expect(ollamaMaxRetries("7")).toBe(7);
		expect(() => ollamaMaxRetries("-1")).toThrow(/OLLAMA_MAX_RETRIES/);
		expect(() => ollamaMaxRetries("abc")).toThrow(/OLLAMA_MAX_RETRIES/);
		expect(() => ollamaMaxRetries("1.5")).toThrow(/OLLAMA_MAX_RETRIES/);
	});

	it("non-ollama keeps the three-strike ladder", async () => {
		vi.useFakeTimers();
		const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
		try {
			const registry = buildRegistry(defWith([]));
			const { client, create } = mockClient([]);
			for (let i = 0; i < 4; i++) {
				create.mockImplementationOnce(async () => {
					throw new Error("Connection error.");
				});
			}
			const { events, emit } = collect();

			const pending = runAgent({
				client,
				model: "m",
				systemPrompt: "",
				task: "",
				registry,
				wtCtx: ctx(),
				emit,
			});
			await vi.advanceTimersByTimeAsync(15000);
			await vi.advanceTimersByTimeAsync(30000);
			await vi.advanceTimersByTimeAsync(60000);
			const outcome = await pending;

			expect(outcome.ok).toBe(false);
			expect(create).toHaveBeenCalledTimes(4);
			expect(events.some((e) => e.t === "error")).toBe(true);
		} finally {
			errSpy.mockRestore();
			vi.useRealTimers();
		}
	});

	it("surfaces the FIRST transient error when the retry ladder is exhausted, not the last attempt's error", async () => {
		vi.useFakeTimers();
		const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
		try {
			const registry = buildRegistry(defWith([]));
			const { client, create } = mockClient([]);
			const root503 = Object.assign(
				new Error(
					'503 [{"error":{"code":503,"message":"Service Unavailable","status":"UNAVAILABLE"}}]',
				),
				{ status: 503 },
			);
			create.mockImplementationOnce(async () => {
				throw root503;
			});
			for (let i = 1; i < 4; i++) {
				create.mockImplementationOnce(async () => {
					throw new Error("Request timed out.");
				});
			}
			const { events, emit } = collect();

			const pending = runAgent({
				client,
				model: "m",
				systemPrompt: "",
				task: "",
				registry,
				wtCtx: ctx(),
				emit,
			});
			await vi.advanceTimersByTimeAsync(15000);
			await vi.advanceTimersByTimeAsync(30000);
			await vi.advanceTimersByTimeAsync(60000);
			const outcome = await pending;

			expect(outcome.ok).toBe(false);
			expect(create).toHaveBeenCalledTimes(4);
			expect(outcome.error).toContain("503");
			expect(outcome.error).toContain("UNAVAILABLE");
			expect(outcome.error).not.toContain("Request timed out");
			const errors = events.filter(
				(e): e is Extract<WireEvent, { t: "error" }> => e.t === "error",
			);
			expect(errors).toHaveLength(1);
			expect(errors[0]?.error).toContain("503");
		} finally {
			errSpy.mockRestore();
			vi.useRealTimers();
		}
	});

	it("streaming watchdog requeues silent ollama calls", async () => {
		const prevStream = process.env.FLEET_LLM_STREAM;
		const prevFirstToken = process.env.OLLAMA_FIRST_TOKEN_TIMEOUT_MS;
		process.env.FLEET_LLM_STREAM = "1";
		process.env.OLLAMA_FIRST_TOKEN_TIMEOUT_MS = "30000";
		vi.useFakeTimers();
		const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
		try {
			const registry = buildRegistry(defWith([]));
			const { client, create } = mockClient([]);
			create.mockImplementationOnce(async () => ({
				[Symbol.asyncIterator]() {
					return { next: () => new Promise(() => {}) };
				},
			}));
			create.mockImplementationOnce(async () =>
				(async function* () {
					yield { choices: [{ delta: { content: "back" } }] };
				})(),
			);
			const { events, emit } = collect();

			const pending = runAgent({
				client,
				model: "m",
				systemPrompt: "",
				task: "",
				registry,
				wtCtx: ctx(),
				emit,
				provider: "ollama",
			});
			await vi.advanceTimersByTimeAsync(30000);
			await vi.advanceTimersByTimeAsync(30000);
			const outcome = await pending;

			expect(outcome.ok).toBe(true);
			expect(outcome.text).toBe("back");
			expect(create).toHaveBeenCalledTimes(2);
			expect(events.some((e) => e.t === "error")).toBe(false);
		} finally {
			errSpy.mockRestore();
			vi.useRealTimers();
			if (prevStream === undefined) delete process.env.FLEET_LLM_STREAM;
			else process.env.FLEET_LLM_STREAM = prevStream;
			if (prevFirstToken === undefined)
				delete process.env.OLLAMA_FIRST_TOKEN_TIMEOUT_MS;
			else process.env.OLLAMA_FIRST_TOKEN_TIMEOUT_MS = prevFirstToken;
		}
	});

	it("first chunk exempt from stall window; mid-stream stall aborts", async () => {
		const prevStream = process.env.FLEET_LLM_STREAM;
		process.env.FLEET_LLM_STREAM = "1";
		vi.useFakeTimers();
		const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
		try {
			const registry = buildRegistry(defWith([]));
			const { client, create } = mockClient([]);
			create.mockImplementationOnce(async () =>
				(async function* () {
					yield { choices: [{ delta: { content: "hi" } }] };
					await new Promise(() => {});
				})(),
			);
			create.mockImplementationOnce(async () =>
				(async function* () {
					yield { choices: [{ delta: { content: "done" } }] };
				})(),
			);
			const { events, emit } = collect();

			const pending = runAgent({
				client,
				model: "m",
				systemPrompt: "",
				task: "",
				registry,
				wtCtx: ctx(),
				emit,
				provider: "ollama",
			});
			const outcome = await (async () => {
				await vi.advanceTimersByTimeAsync(30000);
				await vi.advanceTimersByTimeAsync(5000);
				return pending;
			})();

			expect(outcome.ok).toBe(true);
			expect(outcome.text).toBe("done");
			expect(create).toHaveBeenCalledTimes(2);
			expect(events.some((e) => e.t === "error")).toBe(false);
		} finally {
			errSpy.mockRestore();
			vi.useRealTimers();
			if (prevStream === undefined) delete process.env.FLEET_LLM_STREAM;
			else process.env.FLEET_LLM_STREAM = prevStream;
		}
	});

	it("non-numeric OLLAMA_FIRST_TOKEN_TIMEOUT_MS falls back to 600000", async () => {
		const prevStream = process.env.FLEET_LLM_STREAM;
		const prevFirstToken = process.env.OLLAMA_FIRST_TOKEN_TIMEOUT_MS;
		process.env.FLEET_LLM_STREAM = "1";
		process.env.OLLAMA_FIRST_TOKEN_TIMEOUT_MS = "garbage";
		vi.useFakeTimers();
		const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
		try {
			const registry = buildRegistry(defWith([]));
			const { client, create } = mockClient([]);
			create.mockImplementationOnce(async () => ({
				[Symbol.asyncIterator]() {
					return { next: () => new Promise(() => {}) };
				},
			}));
			create.mockImplementationOnce(async () =>
				(async function* () {
					yield { choices: [{ delta: { content: "late" } }] };
				})(),
			);
			const { events, emit } = collect();

			const pending = runAgent({
				client,
				model: "m",
				systemPrompt: "",
				task: "",
				registry,
				wtCtx: ctx(),
				emit,
				provider: "ollama",
			});
			await vi.advanceTimersByTimeAsync(30000);
			await vi.advanceTimersByTimeAsync(570000);
			await vi.advanceTimersByTimeAsync(5000);
			const outcome = await pending;

			expect(create).toHaveBeenCalledTimes(2);
			expect(outcome.ok).toBe(true);
			expect(outcome.text).toBe("late");
			expect(events.some((e) => e.t === "error")).toBe(false);
		} finally {
			errSpy.mockRestore();
			vi.useRealTimers();
			if (prevStream === undefined) delete process.env.FLEET_LLM_STREAM;
			else process.env.FLEET_LLM_STREAM = prevStream;
			if (prevFirstToken === undefined)
				delete process.env.OLLAMA_FIRST_TOKEN_TIMEOUT_MS;
			else process.env.OLLAMA_FIRST_TOKEN_TIMEOUT_MS = prevFirstToken;
		}
	});

	it("classifies 429 and RESOURCE_EXHAUSTED as provider rate-limit telemetry", async () => {
		const { classifyProviderError } = await import("../fleet/loop.ts");
		expect(
			classifyProviderError(
				Object.assign(new Error("429 RESOURCE_EXHAUSTED rpm"), { status: 429 }),
			),
		).toMatchObject({
			rateLimited: true,
			httpStatus: 429,
			blockedDimension: "rpm",
		});
		expect(
			classifyProviderError(new Error("google: RESOURCE_EXHAUSTED tpm")),
		).toMatchObject({
			rateLimited: true,
			blockedDimension: "tpm",
		});
	});

	it("writes an atomic mid-conversation checkpoint after every completed turn", async () => {
		interface Snapshot {
			role: string;
			model: string;
			chainIndex: number;
			messages: Array<{ role: string }>;
			savedAt: string;
		}
		const runDir = join(wt, "run");
		const registry = buildRegistry(defWith(["read"]));
		const checkpointPath = join(runDir, "checkpoints", "coder.json");
		let toolTurnSnapshot: Snapshot | undefined;
		const create = vi
			.fn()
			.mockImplementationOnce(async () =>
				resp({
					role: "assistant",
					content: null,
					tool_calls: [toolCallReq("read", { path: "hello.txt" })],
				}),
			)
			.mockImplementationOnce(async () => {
				toolTurnSnapshot = JSON.parse(
					readFileSync(checkpointPath, "utf8"),
				) as Snapshot;
				return resp({ role: "assistant", content: "done" });
			});
		const client = { chat: { completions: { create } } } as unknown as OpenAI;

		const outcome = await runAgent({
			client,
			model: "test-model",
			systemPrompt: "sys",
			task: "do the thing",
			registry,
			wtCtx: ctx({ runDir }),
			emit: collect().emit,
		});

		expect(outcome.ok).toBe(true);
		expect(existsSync(checkpointPath)).toBe(true);
		const final = JSON.parse(readFileSync(checkpointPath, "utf8")) as Snapshot;
		if (!toolTurnSnapshot) throw new Error("toolTurnSnapshot not set");
		for (const snapshot of [toolTurnSnapshot, final]) {
			expect(snapshot.role).toBe("coder");
			expect(snapshot.model).toBe("test-model");
			expect(snapshot.chainIndex).toBe(0);
			expect(typeof snapshot.savedAt).toBe("string");
			expect(
				/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/.test(snapshot.savedAt),
			).toBe(true);
			expect(Array.isArray(snapshot.messages)).toBe(true);
			expect(snapshot.messages.length).toBeGreaterThan(0);
		}
		expect(
			toolTurnSnapshot?.messages.map((m: { role: string }) => m.role),
		).toEqual(["system", "user", "assistant", "tool"]);
		expect(final.messages).toEqual(toolTurnSnapshot?.messages);
		expect(
			readdirSync(join(runDir, "checkpoints")).filter((f) =>
				f.endsWith(".tmp"),
			),
		).toEqual([]);
	});

	it("keeps running when the checkpoint cannot be written and warns at most once per role", async () => {
		const runDir = join(wt, "run");
		mkdirSync(runDir, { recursive: true });
		writeFileSync(
			join(runDir, "checkpoints"),
			"a file blocks the checkpoints directory",
		);
		const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
		try {
			const registry = buildRegistry(defWith(["read"]));
			const { client, create } = mockClient([
				resp({
					role: "assistant",
					content: null,
					tool_calls: [toolCallReq("read", { path: "hello.txt" })],
				}),
				resp({ role: "assistant", content: "done despite checkpoint failure" }),
			]);
			const { events, emit } = collect();

			const outcome = await runAgent({
				client,
				model: "m",
				systemPrompt: "sys",
				task: "do the thing",
				registry,
				wtCtx: ctx({ runDir }),
				emit,
			});

			expect(outcome.ok).toBe(true);
			expect(outcome.text).toBe("done despite checkpoint failure");
			expect(create).toHaveBeenCalledTimes(2);
			expect(events.at(-1)?.t).toBe("step_finish");
			const warns = warnSpy.mock.calls.filter((call) =>
				String(call[0]).includes("[checkpoint]"),
			);
			expect(warns).toHaveLength(1);
			expect(warns[0]?.[0]).toContain("coder");
		} finally {
			warnSpy.mockRestore();
		}
	});
});
