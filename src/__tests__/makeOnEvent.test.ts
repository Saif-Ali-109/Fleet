import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentStatus } from "../tui/dashboard.ts";
import { newDashboardState } from "../tui/dashboard.ts";
import type { Role, RunContext } from "../types.ts";
import { makeOnEvent } from "../workflow/makeOnEvent.ts";
import { ScoutTracker } from "../workflow/scoutTracker.ts";

let root = "";
let managerDir = "";

function makeCtx(provider?: "gemini" | "openrouter" | "ollama"): RunContext {
	return {
		runId: "run-2026-08-01",
		issue: {
			repo: "octocat/hello-world",
			number: 1,
			title: "bug",
			body: "",
			url: "",
			state: "open",
			labels: [],
			author: "a",
		},
		repoUrl: "https://github.com/octocat/hello-world",
		rootDir: root,
		runDir: join(root, ".runs", "run-2026-08-01"),
		worktreeDir: join(root, ".runs", "run-2026-08-01", "worktree"),
		tracesDir: join(root, ".runs", "run-2026-08-01", "traces"),
		branch: "fix/bug",
		dryRun: true,
		...(provider ? { provider } : {}),
	};
}

interface Emitted {
	ctx: RunContext | { runId: string; dryRun?: boolean };
	event: Record<string, unknown>;
}

interface HarnessOverrides {
	emitSor?: boolean;
	pushNotice?: ((msg: string) => void) | undefined;
	policyModel?: string;
	role?: Role;
}

function makeHarness(overrides: HarnessOverrides = {}) {
	const role = overrides.role ?? "coder";
	const ctx = makeCtx("openrouter");
	const emitted: Emitted[] = [];
	const sorEmitFn = async (
		eventCtx: RunContext | { runId: string; dryRun?: boolean },
		event: Record<string, unknown>,
	): Promise<void> => {
		emitted.push({ ctx: eventCtx, event });
	};
	const tracker = new ScoutTracker();
	const pushStateThrottled = vi.fn();
	const pushAgentEvent = vi.fn();
	const pushNoticeMock = vi.fn();
	let pushNotice: ((msg: string) => void) | undefined = pushNoticeMock;
	if ("pushNotice" in overrides) {
		pushNotice = overrides.pushNotice;
	}
	const dash = newDashboardState(ctx.runId, ctx.issue.repo, ctx.issue.number);

	const handler = makeOnEvent({
		role,
		ctx,
		sorEmitFn,
		scoutTracker: tracker,
		pushStateThrottled,
		pushAgentEvent,
		pushNotice,
		policyModel: overrides.policyModel ?? "gemini-policy-model",
		dash,
		emitSor: overrides.emitSor ?? true,
	});
	return {
		ctx,
		emitted,
		tracker,
		dash,
		handler,
		pushStateThrottled,
		pushAgentEvent,
		pushNotice,
		pushNoticeMock,
	};
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

async function waitForLogLine(
	logPath: string,
	needle: string,
): Promise<string> {
	const deadline = Date.now() + 2000;
	for (;;) {
		try {
			const content = readFileSync(logPath, "utf8");
			if (content.includes(needle)) return content;
		} catch {
			// file not flushed yet
		}
		if (Date.now() > deadline) {
			throw new Error(`timed out waiting for log line ${needle}`);
		}
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
}

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "make-onevent-"));
	managerDir = join(root, "manager");
	mkdirSync(managerDir, { recursive: true });
});

afterEach(() => {
	rmSync(root, { recursive: true, force: true });
});

describe("makeOnEvent", () => {
	it("logs a scout line when the tracker observes a scout invocation", async () => {
		const h = makeHarness();
		const ev = {
			type: "message",
			part: {
				type: "tool_call",
				tool: "task",
				state: { input: { description: "scout the repo" } },
			},
		};

		h.handler(ev as unknown as Record<string, unknown>);

		expect(h.tracker.total).toBe(1);
		const log = await waitForLogLine(
			join(managerDir, "SESSION_LOG.txt"),
			"[scout] invoked by coder (call 1, 1/coder)",
		);
		expect(log).toContain("[scout] invoked by coder (call 1, 1/coder)");
		expect(h.pushStateThrottled).toHaveBeenCalledTimes(1);
		expect(h.pushAgentEvent).toHaveBeenCalledWith("coder", ev);
	});

	it("does not write a scout log line for non-scout events", () => {
		const h = makeHarness();
		h.handler({ t: "tool_call", name: "read" });

		expect(h.tracker.total).toBe(0);
		expect(existsSync(join(managerDir, "SESSION_LOG.txt"))).toBe(false);
	});

	it("survives a missing pushNotice on quota_exhausted", () => {
		const h = makeHarness({ pushNotice: undefined });
		expect(() =>
			h.handler({ t: "quota_exhausted", model: "gemini-x", resetAt: 0 }),
		).not.toThrow();
		expect(h.pushStateThrottled).toHaveBeenCalledTimes(1);
	});

	it("notifies with the event model and resetAt when both are present", () => {
		const h = makeHarness();
		h.handler({
			t: "quota_exhausted",
			model: "gemini-2.5-pro",
			resetAt: 1756000000000,
		});
		expect(h.pushNoticeMock).toHaveBeenCalledWith(
			"Gemini model gemini-2.5-pro quota_exhausted until 2025-08-24T01:46:40.000Z",
		);
	});

	it("falls back to policyModel and Date.now() when model/resetAt are absent", () => {
		const h = makeHarness({ policyModel: "gemini-fallback-1" });
		const before = Date.now();
		h.handler({ t: "quota_exhausted" });
		const msg = h.pushNoticeMock.mock.calls[0]?.[0];
		expect(msg).toContain(
			"Gemini model gemini-fallback-1 quota_exhausted until",
		);
		const iso = /until (.*)$/.exec(msg ?? "")?.[1];
		expect(iso).toBeDefined();
		expect(Date.parse(iso ?? "")).toBeGreaterThanOrEqual(before);
	});

	it("counts tool_calls on the agent status", () => {
		const h = makeHarness();
		h.handler({ t: "tool_call", name: "read" });
		h.handler({ t: "tool_call", name: "read" });
		expect(h.dash.agents.coder?.calls).toEqual({
			tools: 2,
			models: 0,
			skills: 0,
		});
	});

	it("counts load_skill tool calls as skills", () => {
		const h = makeHarness();
		h.handler({ t: "tool_call", name: "load_skill" });
		expect(h.dash.agents.coder?.calls).toEqual({
			tools: 1,
			models: 0,
			skills: 1,
		});
	});

	it("increments the model counter on provider_completion", async () => {
		const h = makeHarness();
		h.handler({ t: "tool_call", name: "bash" });
		h.handler({
			t: "telemetry",
			event: "provider_completion",
			status: "completed",
		});
		await flush();

		expect(h.dash.agents.coder?.calls).toEqual({
			tools: 1,
			models: 1,
			skills: 0,
		});
		expect(h.emitted[0]?.event).toEqual({
			event_type: "provider_completion",
			actor: "coder",
			backend: "openrouter",
			payload: { status: "completed" },
		});
	});

	it("tolerates an absent agent record for the role", () => {
		const handler = makeOnEvent({
			role: "coder",
			ctx: makeCtx(),
			sorEmitFn: async () => {},
			scoutTracker: new ScoutTracker(),
			pushStateThrottled: () => {},
			pushAgentEvent: () => {},
			pushNotice: undefined,
			policyModel: "m",
			dash: {
				runId: "r",
				repo: "o/r",
				issue: 1,
				phase: "idle",
				agents: {} as Record<Role, AgentStatus>,
				loopIteration: 1,
			},
			emitSor: false,
		});

		expect(() => handler({ t: "tool_call", name: "read" })).not.toThrow();
		expect(() =>
			handler({
				t: "telemetry",
				event: "provider_completion",
				status: "completed",
			}),
		).not.toThrow();
	});

	it("does not emit provider_completion when emitSor is false", () => {
		const h = makeHarness({ emitSor: false });
		h.handler({
			t: "telemetry",
			event: "provider_completion",
			status: "completed",
		});
		expect(h.dash.agents.coder?.calls?.models).toBe(1);
		expect(h.emitted).toHaveLength(0);
	});

	it("ignores provider_completion payloads that did not complete", () => {
		const h = makeHarness({ emitSor: false });
		h.handler({
			t: "telemetry",
			event: "provider_completion",
			status: "error",
		});
		expect(h.dash.agents.coder?.calls?.models ?? 0).toBe(0);
		expect(h.emitted).toHaveLength(0);
	});

	it("emits reservation, reservation_rejection and retry events with the full payload", async () => {
		const h = makeHarness();
		h.handler({ t: "reservation", model: "gemini-x", reserved: 1 });
		h.handler({
			t: "reservation_rejection",
			model: "gemini-x",
			reason: "busy",
		});
		h.handler({ t: "retry", model: "gemini-x", attempt: 2 });
		await flush();

		expect(h.emitted.map((e) => e.event.event_type)).toEqual([
			"reservation",
			"reservation_rejection",
			"retry",
		]);
		expect(h.emitted[0]?.event).toMatchObject({
			event_type: "reservation",
			actor: "coder",
			backend: "openrouter",
		});
	});

	it("emits with the gemini default backend when ctx.provider is unset", async () => {
		const emitted: Emitted[] = [];
		const handler = makeOnEvent({
			role: "pr",
			ctx: makeCtx(),
			sorEmitFn: async (
				eventCtx: RunContext | { runId: string; dryRun?: boolean },
				event: Record<string, unknown>,
			): Promise<void> => {
				emitted.push({ ctx: eventCtx, event });
			},
			scoutTracker: new ScoutTracker(),
			pushStateThrottled: () => {},
			pushAgentEvent: () => {},
			pushNotice: undefined,
			policyModel: "m",
			dash: newDashboardState("r", "o/r", 1),
			emitSor: true,
		});
		handler({ t: "retry" });
		await flush();

		expect(emitted).toHaveLength(1);
		expect(emitted[0]?.event.backend).toBe("gemini");
	});

	it("does not emit reservation-family events when emitSor is false", () => {
		const h = makeHarness({ emitSor: false });
		h.handler({ t: "reservation", model: "gemini-x" });
		h.handler({ t: "reservation_rejection", model: "gemini-x" });
		h.handler({ t: "retry", model: "gemini-x" });
		expect(h.emitted).toHaveLength(0);
		expect(h.pushAgentEvent).toHaveBeenCalledTimes(3);
	});
});
