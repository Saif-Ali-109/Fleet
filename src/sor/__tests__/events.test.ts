import { describe, expect, it } from "vitest";
import type { SorEventType } from "../events.ts";
import {
	normalizeEvent,
	TOOL_INPUT_CAP,
	TOOL_OUTPUT_CAP,
	VALID_TYPES,
} from "../events.ts";

describe("SorEventType union + VALID_TYPES (P2.1)", () => {
	const newTypes: SorEventType[] = [
		"policy_state",
		"policy_sync",
		"policy_decision",
		"content_sync",
		"content_access",
		"context_update",
	];

	it("VALID_TYPES contains all six new policy event types", () => {
		for (const t of newTypes) {
			expect(VALID_TYPES).toContain(t);
		}
	});

	it("VALID_TYPES still contains all original 14 types", () => {
		const originalTypes: SorEventType[] = [
			"tool_call",
			"wakeup",
			"phase",
			"registry_sync",
			"finalize",
			"model_switch",
			"model_recovered",
			"all_models_exhausted",
			"run_paused",
			"run_resumed",
			"reservation",
			"reservation_rejection",
			"provider_completion",
			"retry",
		];
		for (const t of originalTypes) {
			expect(VALID_TYPES).toContain(t);
		}
	});

	it("VALID_TYPES has exactly 20 entries (14 original + 6 new)", () => {
		expect(VALID_TYPES.length).toBe(20);
	});
});

describe("normalizeEvent accepts new policy event types with locked shapes (P2.2)", () => {
	const base = {
		actor: "manager",
		backend: null,
		tool_name: null,
		tool_input: null,
		tool_output: null,
		created_at: "2026-08-29T10:00:00.000Z",
	};

	it("accepts policy_state with mode, policyVersion, policyHash, sourceHash", () => {
		const event = normalizeEvent({
			...base,
			event_type: "policy_state",
			payload: {
				mode: "sor",
				policyVersion: 3,
				policyHash: "a".repeat(64),
				sourceHash: "b".repeat(64),
			},
		});
		expect(event.event_type).toBe("policy_state");
		expect(event.payload).toEqual({
			mode: "sor",
			policyVersion: 3,
			policyHash: "a".repeat(64),
			sourceHash: "b".repeat(64),
		});
	});

	it("accepts policy_sync seeded with document", () => {
		const doc = {
			schemaVersion: 1,
			meta: { subject_role: "coder" },
			allowedTools: ["bash"],
			mcpAllow: [],
			toolRules: {},
		};
		const event = normalizeEvent({
			...base,
			event_type: "policy_sync",
			payload: {
				kind: "seeded",
				prevVersion: 0,
				document: doc,
			},
		});
		expect(event.event_type).toBe("policy_sync");
		expect(event.payload.kind).toBe("seeded");
		expect(event.payload.document).toEqual(doc);
	});

	it("accepts policy_sync drift-detected without document", () => {
		const event = normalizeEvent({
			...base,
			event_type: "policy_sync",
			payload: {
				kind: "drift-detected",
				prevVersion: 2,
			},
		});
		expect(event.event_type).toBe("policy_sync");
		expect(event.payload.kind).toBe("drift-detected");
		expect(event.payload.document).toBeUndefined();
	});

	it("accepts policy_decision ALLOW", () => {
		const event = normalizeEvent({
			...base,
			event_type: "policy_decision",
			tool_name: "bash",
			payload: {
				decision: "ALLOW",
				action: "bash",
				result: "ok",
				reason: "tool in grant",
			},
		});
		expect(event.event_type).toBe("policy_decision");
		expect(event.payload.decision).toBe("ALLOW");
		expect(event.payload.result).toBe("ok");
	});

	it("accepts policy_decision DENY", () => {
		const event = normalizeEvent({
			...base,
			event_type: "policy_decision",
			tool_name: "bash",
			payload: {
				decision: "DENY",
				action: "bash",
				result: "blocked",
				reason: "tool not in grant",
			},
		});
		expect(event.event_type).toBe("policy_decision");
		expect(event.payload.decision).toBe("DENY");
		expect(event.payload.result).toBe("blocked");
	});

	it("accepts content_sync", () => {
		const event = normalizeEvent({
			...base,
			event_type: "content_sync",
			payload: {
				kind: "added",
				status: "active",
			},
		});
		expect(event.event_type).toBe("content_sync");
	});

	it("accepts content_access", () => {
		const event = normalizeEvent({
			...base,
			event_type: "content_access",
			payload: {
				sessionId: "sess-1",
				mode: "aggregate",
				count: 5,
				topSources: ["src/a.md", "src/b.md"],
			},
		});
		expect(event.event_type).toBe("content_access");
	});

	it("accepts context_update", () => {
		const event = normalizeEvent({
			...base,
			event_type: "context_update",
			payload: {
				prevVersion: 7,
			},
		});
		expect(event.event_type).toBe("context_update");
		expect(event.payload.prevVersion).toBe(7);
	});
});

describe("Truncation caps apply to policy events (20 000 chars)", () => {
	const base = {
		actor: "manager",
		backend: null,
		tool_name: "bash",
		tool_input: null,
		tool_output: null,
		created_at: "2026-08-29T10:00:00.000Z",
	};

	it("truncates tool_input at TOOL_INPUT_CAP", () => {
		const hugeInput = "x".repeat(TOOL_INPUT_CAP + 100);
		const event = normalizeEvent({
			...base,
			event_type: "policy_decision",
			tool_input: hugeInput,
			payload: {
				decision: "ALLOW",
				action: "bash",
				result: "ok",
				reason: "test",
			},
		});
		expect(typeof event.tool_input === "string").toBe(true);
		expect((event.tool_input as string).length).toBe(TOOL_INPUT_CAP);
	});

	it("truncates tool_output at TOOL_OUTPUT_CAP", () => {
		const hugeOutput = "y".repeat(TOOL_OUTPUT_CAP + 100);
		const event = normalizeEvent({
			...base,
			event_type: "policy_decision",
			tool_output: hugeOutput,
			payload: {
				decision: "ALLOW",
				action: "bash",
				result: "ok",
				reason: "test",
			},
		});
		expect(typeof event.tool_output === "string").toBe(true);
		expect((event.tool_output as string).length).toBe(TOOL_OUTPUT_CAP);
	});
});
