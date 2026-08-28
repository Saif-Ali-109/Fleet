import { describe, expect, it } from "vitest";
import { parseProviderLine } from "../runner/providers.ts";

function freshAcc() {
	return {
		text: "",
		sessionID: null,
		model: null,
		tokens: {
			input: 0,
			output: 0,
			reasoning: 0,
			cached: 0,
			cacheWrite: 0,
			total: 0,
		},
		costUsd: 0,
		sawError: false,
		bashCommands: [] as Array<{ command: string; exitCode?: number }>,
		tools: 0,
		models: 0,
		skills: 0,
		breakdown: {} as Record<string, number>,
	};
}

describe("parseProviderLine call counting", () => {
	it("counts tool_calls", () => {
		const s = freshAcc();
		parseProviderLine(
			"gemini",
			{ t: "tool_call", id: "1", name: "bash", input: { command: "ls" } },
			s,
		);
		parseProviderLine(
			"gemini",
			{ t: "tool_call", id: "2", name: "read", input: { path: "x" } },
			s,
		);
		expect(s.tools).toBe(2);
		expect(s.breakdown).toEqual({ bash: 1, read: 1 });
		expect(s.skills).toBe(0);
	});

	it("counts load_skill as both a tool and a skill", () => {
		const s = freshAcc();
		parseProviderLine(
			"gemini",
			{ t: "tool_call", id: "1", name: "load_skill", input: { name: "x" } },
			s,
		);
		expect(s.tools).toBe(1);
		expect(s.skills).toBe(1);
		expect(s.breakdown).toEqual({ load_skill: 1 });
	});

	it("counts completed telemetry as model calls", () => {
		const s = freshAcc();
		parseProviderLine(
			"gemini",
			{
				t: "telemetry",
				event: "provider_completion",
				status: "completed",
				model: "gemini-3.5-flash",
			},
			s,
		);
		parseProviderLine(
			"gemini",
			{
				t: "telemetry",
				event: "provider_completion",
				status: "completed",
				model: "gemini-3.5-flash",
			},
			s,
		);
		expect(s.models).toBe(2);
	});

	it("does not count failed telemetry", () => {
		const s = freshAcc();
		parseProviderLine(
			"gemini",
			{
				t: "telemetry",
				event: "provider_completion",
				status: "failed",
				model: "gemini-3.5-flash",
			},
			s,
		);
		expect(s.models).toBe(0);
	});

	it("does not count non-provider telemetry", () => {
		const s = freshAcc();
		parseProviderLine(
			"gemini",
			{ t: "telemetry", event: "rate_limit", status: "active" },
			s,
		);
		expect(s.models).toBe(0);
	});
});
