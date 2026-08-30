import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type OpenAI from "openai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	runAgent,
	type WireEvent,
} from "../fleet/loop.ts";
import type { RulePredicate } from "../fleet/policy.ts";
import {
	buildRegistry,
	type ToolImpl,
	type WtCtx,
} from "../fleet/tools/registry.ts";
import type { FleetAgentDef, ToolName } from "../fleet/types.ts";

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

function resp(message: MockResponse): MockResponse {
	return {
		id: "chatcmpl-x",
		object: "chat.completion",
		choices: [{ index: 0, message, finish_reason: "stop" }],
		usage: {},
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
	wt = mkdtempSync(join(tmpdir(), "fleet-loop-policy-"));
	writeFileSync(join(wt, "hello.txt"), "hello loop\n");
});

afterEach(() => {
	rmSync(wt, { recursive: true, force: true });
});

function ctx(): WtCtx {
	return { worktreeDir: wt, role: "coder" };
}

function collect() {
	const events: WireEvent[] = [];
	return { events, emit: (e: WireEvent) => events.push(e) };
}

type PolicyDecisionPayload = {
	decision: "ALLOW" | "DENY";
	action: string;
	result: "ok" | "blocked" | "error";
	reason: string;
};

function spyExec(registry: Record<string, ToolImpl>, name: keyof typeof registry) {
	const exec = registry[name]?.exec;
	return vi
		.spyOn(registry[name] as ToolImpl, "exec")
		.mockImplementation(
			exec ?? (() => Promise.resolve({ ok: false, error: "mock not set" })),
		);
}

const SOR_POLICY = {
	mode: "sor" as const,
	effective: { allowedTools: ["read"], mcpAllow: [] },
	toolRules: {},
};

describe("runAgent policy PEP (Step 8)", () => {
	it("P4.1: sor mode denied tool does NOT invoke impl.exec, is side-effectless, and emits policy_decision DENY", async () => {
		const registry = buildRegistry(defWith(["read"]));
		const readExec = spyExec(registry as Record<string, ToolImpl>, "read");
		const { client, create } = mockClient([
			resp({
				role: "assistant",
				content: null,
				tool_calls: [toolCallReq("read", { path: "hello.txt" })],
			}),
			resp({ role: "assistant", content: "recovered" }),
		]);
		const { events, emit } = collect();
		const decisions: PolicyDecisionPayload[] = [];
		const policyDecision = vi.fn((p: PolicyDecisionPayload) =>
			decisions.push(p),
		);

		const outcome = await runAgent({
			client,
			model: "m",
			systemPrompt: "",
			task: "",
			registry,
			wtCtx: ctx(),
			emit,
			policy: {
				mode: "sor",
				effective: { allowedTools: [], mcpAllow: [] },
				toolRules: {},
			},
			policyDecision,
		});

		expect(outcome.ok).toBe(true);
		expect(outcome.text).toBe("recovered");
		expect(create).toHaveBeenCalledTimes(2);
		expect(readExec).not.toHaveBeenCalled();
		expect(decisions).toEqual([
			{
				decision: "DENY",
				action: "read",
				result: "blocked",
				reason: "unknown tool: read",
			},
		]);
		const resultEvt = events[1] as Extract<WireEvent, { t: "tool_result" }>;
		expect(resultEvt?.name).toBe("read");
		expect(resultEvt?.ok).toBe(false);
		const secondMessages = (
			(create.mock.calls[1] ?? [])[0] as {
				messages: Array<{ role: string; content?: unknown }>;
			}
		).messages;
		expect(secondMessages.at(-1)).toMatchObject({
			role: "tool",
			content: expect.stringContaining("unknown tool"),
		});
	});

	it("P4.2: sor mode allowed tool runs impl.exec and emits policy_decision ALLOW per call", async () => {
		const registry = buildRegistry(defWith(["read"]));
		const readExec = spyExec(registry as Record<string, ToolImpl>, "read");
		const { client, create } = mockClient([
			resp({
				role: "assistant",
				content: null,
				tool_calls: [
					toolCallReq("read", { path: "hello.txt" }, "call_1"),
					toolCallReq("read", { path: "hello.txt" }, "call_2"),
				],
			}),
			resp({ role: "assistant", content: "done" }),
		]);
		const { events, emit } = collect();
		const decisions: PolicyDecisionPayload[] = [];
		const policyDecision = vi.fn((p: PolicyDecisionPayload) =>
			decisions.push(p),
		);

		const outcome = await runAgent({
			client,
			model: "m",
			systemPrompt: "",
			task: "",
			registry,
			wtCtx: ctx(),
			emit,
			policy: SOR_POLICY,
			policyDecision,
		});

		expect(outcome.ok).toBe(true);
		expect(outcome.text).toBe("done");
		expect(create).toHaveBeenCalledTimes(2);
		expect(readExec).toHaveBeenCalledTimes(2);
		expect(decisions).toHaveLength(2);
		for (const d of decisions) {
			expect(d).toEqual({
				decision: "ALLOW",
				action: "read",
				result: "ok",
				reason: "allowed",
			});
		}
		const results = events.filter(
			(e): e is Extract<WireEvent, { t: "tool_result" }> =>
				e.t === "tool_result",
		);
		expect(results).toHaveLength(2);
		expect(results.every((r) => r.ok)).toBe(true);
	});

	it("P4.3 / P7.2 (AT-4): fail-closed mode denies every tool including one granted by the ceiling; zero grants, zero exec", async () => {
		const registry = buildRegistry(defWith(["read", "write"]));
		const readExec = spyExec(registry as Record<string, ToolImpl>, "read");
		const writeExec = spyExec(registry as Record<string, ToolImpl>, "write");
		const { client } = mockClient([
			resp({
				role: "assistant",
				content: null,
				tool_calls: [
					toolCallReq("read", { path: "hello.txt" }, "call_1"),
					toolCallReq("write", { path: "x.txt", content: "x" }, "call_2"),
				],
			}),
			resp({ role: "assistant", content: "finished" }),
		]);
		const { events, emit } = collect();
		const decisions: PolicyDecisionPayload[] = [];
		const policyDecision = vi.fn((p: PolicyDecisionPayload) =>
			decisions.push(p),
		);

		const outcome = await runAgent({
			client,
			model: "m",
			systemPrompt: "",
			task: "",
			registry,
			wtCtx: ctx(),
			emit,
			policy: {
				mode: "fail-closed",
				effective: { allowedTools: [], mcpAllow: [] },
				toolRules: {},
			},
			policyDecision,
		});

		expect(outcome.ok).toBe(true);
		expect(outcome.text).toBe("finished");
		expect(readExec).not.toHaveBeenCalled();
		expect(writeExec).not.toHaveBeenCalled();
		expect(decisions).toHaveLength(2);
		expect(decisions.every((d) => d.decision === "DENY")).toBe(true);
		expect(decisions.every((d) => d.result === "blocked")).toBe(true);
		const results = events.filter(
			(e): e is Extract<WireEvent, { t: "tool_result" }> =>
				e.t === "tool_result",
		);
		expect(results).toHaveLength(2);
		expect(results.every((r) => r.ok === false)).toBe(true);
	});

	it("P4.4: compatibility mode skips the PEP, runs static def.tools, and emits zero policy_decision (policy_state is worker-level)", async () => {
		const registry = buildRegistry(defWith(["read"]));
		const readExec = spyExec(registry as Record<string, ToolImpl>, "read");
		const { client, create } = mockClient([
			resp({
				role: "assistant",
				content: null,
				tool_calls: [toolCallReq("read", { path: "hello.txt" })],
			}),
			resp({ role: "assistant", content: "compat ok" }),
		]);
		const { events, emit } = collect();
		const policyDecision = vi.fn((_p: PolicyDecisionPayload) => {});

		const outcome = await runAgent({
			client,
			model: "m",
			systemPrompt: "",
			task: "",
			registry,
			wtCtx: ctx(),
			emit,
			policy: {
				mode: "compatibility",
				effective: { allowedTools: ["read"], mcpAllow: [] },
				toolRules: {},
			},
			policyDecision,
		});

		expect(outcome.ok).toBe(true);
		expect(outcome.text).toBe("compat ok");
		expect(readExec).toHaveBeenCalledTimes(1);
		expect(policyDecision).not.toHaveBeenCalled();
		// Compatibility mode exposes the static def.tools to the model unchanged
		// (no grant intersection). Step 7 owns the worker-level policy_state
		// emission for this mode (covered in workerPolicySnapshot.test.ts).
		const firstCall = (create.mock.calls[0] ?? [])[0] as {
			tools?: Array<{ function?: { name?: string } }>;
		};
		expect(firstCall.tools?.map((t) => t.function?.name)).toEqual(["read"]);
	});

	it("P4.5 / P7.1 (AT-3): sor mode unknown tool denied with zero side effects (no impl.exec, no registry fallback)", async () => {
		const registry = buildRegistry(defWith(["read"]));
		const readExec = spyExec(registry as Record<string, ToolImpl>, "read");
		const { client } = mockClient([
			resp({
				role: "assistant",
				content: null,
				tool_calls: [toolCallReq("web_search", { q: "x" })],
			}),
			resp({ role: "assistant", content: "recovered" }),
		]);
		const { events, emit } = collect();
		const decisions: PolicyDecisionPayload[] = [];
		const policyDecision = vi.fn((p: PolicyDecisionPayload) =>
			decisions.push(p),
		);

		const outcome = await runAgent({
			client,
			model: "m",
			systemPrompt: "",
			task: "",
			registry,
			wtCtx: ctx(),
			emit,
			policy: SOR_POLICY,
			policyDecision,
		});

		expect(outcome.ok).toBe(true);
		expect(outcome.text).toBe("recovered");
		expect(readExec).not.toHaveBeenCalled();
		expect(decisions).toEqual([
			{
				decision: "DENY",
				action: "web_search",
				result: "blocked",
				reason: "unknown tool: web_search",
			},
		]);
		const resultEvt = events[1] as Extract<WireEvent, { t: "tool_result" }>;
		expect(resultEvt?.ok).toBe(false);
		expect(resultEvt?.name).toBe("web_search");
	});

	it("sor mode toolRules deny predicate blocks a granted tool on matched input", async () => {
		const registry = buildRegistry(defWith(["read"]));
		const readExec = spyExec(registry as Record<string, ToolImpl>, "read");
		const { client } = mockClient([
			resp({
				role: "assistant",
				content: null,
				tool_calls: [toolCallReq("read", { path: "/etc/passwd" })],
			}),
			resp({ role: "assistant", content: "recovered" }),
		]);
		const { events, emit } = collect();
		const decisions: PolicyDecisionPayload[] = [];
		const policyDecision = vi.fn((p: PolicyDecisionPayload) =>
			decisions.push(p),
		);
		const toolRules: Record<string, RulePredicate[]> = {
			read: [
				{ op: "deny", when: { path: "path", match: "^/etc/" } },
			],
		};

		const outcome = await runAgent({
			client,
			model: "m",
			systemPrompt: "",
			task: "",
			registry,
			wtCtx: ctx(),
			emit,
			policy: {
				mode: "sor",
				effective: { allowedTools: ["read"], mcpAllow: [] },
				toolRules,
			},
			policyDecision,
		});

		expect(outcome.ok).toBe(true);
		expect(outcome.text).toBe("recovered");
		expect(readExec).not.toHaveBeenCalled();
		expect(decisions).toEqual([
			expect.objectContaining({
				decision: "DENY",
				action: "read",
				result: "blocked",
			}),
		]);
		const resultEvt = events[1] as Extract<WireEvent, { t: "tool_result" }>;
		expect(resultEvt?.ok).toBe(false);
	});

	it("NON-FATAL: a throwing policyDecision emitter warns and continues without changing the decision", async () => {
		const errSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
		try {
			const registry = buildRegistry(defWith(["read"]));
			const readExec = spyExec(
				registry as Record<string, ToolImpl>,
				"read",
			);
			const { client } = mockClient([
				resp({
					role: "assistant",
					content: null,
					tool_calls: [toolCallReq("read", { path: "hello.txt" })],
				}),
				resp({ role: "assistant", content: "recovered" }),
			]);
			const { events, emit } = collect();
			const policyDecision = vi.fn(() => {
				throw new Error("db unavailable");
			});

			const outcome = await runAgent({
				client,
				model: "m",
				systemPrompt: "",
				task: "",
				registry,
				wtCtx: ctx(),
				emit,
				policy: SOR_POLICY,
				policyDecision,
			});

			expect(outcome.ok).toBe(true);
			expect(outcome.text).toBe("recovered");
			expect(policyDecision).toHaveBeenCalledTimes(1);
			expect(readExec).toHaveBeenCalledTimes(1);
			expect(errSpy).toHaveBeenCalledWith(
				expect.stringContaining("[policy] policy_decision skipped"),
			);
		} finally {
			errSpy.mockRestore();
		}
	});

	it("no policy field disables the PEP entirely (today's behavior)", async () => {
		const registry = buildRegistry(defWith(["read"]));
		const readExec = spyExec(registry as Record<string, ToolImpl>, "read");
		const { client } = mockClient([
			resp({
				role: "assistant",
				content: null,
				tool_calls: [toolCallReq("read", { path: "hello.txt" })],
			}),
			resp({ role: "assistant", content: "done" }),
		]);
		const { events, emit } = collect();
		const policyDecision = vi.fn((_p: PolicyDecisionPayload) => {});

		const outcome = await runAgent({
			client,
			model: "m",
			systemPrompt: "",
			task: "",
			registry,
			wtCtx: ctx(),
			emit,
			policyDecision,
		});

		expect(outcome.ok).toBe(true);
		expect(outcome.text).toBe("done");
		expect(readExec).toHaveBeenCalledTimes(1);
		expect(policyDecision).not.toHaveBeenCalled();
	});
});
