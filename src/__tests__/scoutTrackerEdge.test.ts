import { describe, expect, it } from "vitest";
import { ScoutTracker } from "../workflow/scoutTracker.ts";

describe("ScoutTracker edge branches", () => {
	it("counts a message.toolCalls first entry whose input mentions scout", () => {
		const t = new ScoutTracker();
		const ev = {
			message: {
				toolCalls: [
					{ tool: "task", state: { input: { prompt: "scout now" } } },
				],
			},
		};
		expect(t.observe("analyzer", ev)).toBe(true);
		expect(t.total).toBe(1);
	});

	it("falls back to first.input when the toolCall state has no input", () => {
		const t = new ScoutTracker();
		const ev = {
			message: { toolCalls: [{ tool: "task", input: "scout please" }] },
		};
		expect(t.observe("planner", ev)).toBe(true);
		expect(t.countFor("planner")).toBe(1);
	});

	it("ignores a non-object first toolCall", () => {
		const t = new ScoutTracker();
		expect(t.observe("pr", { message: { toolCalls: ["nope"] } })).toBe(false);
		expect(t.total).toBe(0);
	});

	it("ignores a first toolCall whose tool is not a string", () => {
		const t = new ScoutTracker();
		const ev = { message: { toolCalls: [{ tool: 42, input: "scout" }] } };
		expect(t.observe("pr", ev)).toBe(false);
		expect(t.total).toBe(0);
	});

	it("skips empty toolCalls arrays without throwing", () => {
		const t = new ScoutTracker();
		expect(t.observe("reviewer", { message: { toolCalls: [] } })).toBe(false);
		expect(t.total).toBe(0);
	});

	it("returns false when JSON.stringify throws on a circular input", () => {
		const t = new ScoutTracker();
		const circular: Record<string, unknown> = {};
		circular.self = circular;
		const ev = {
			part: { type: "tool_call", tool: "task", state: { input: circular } },
		};
		expect(t.observe("coder", ev)).toBe(false);
		expect(t.total).toBe(0);
		expect(t.summary()).toBe("scout calls: 0");
	});

	it("returns false when a task input does not mention scout", () => {
		const t = new ScoutTracker();
		const ev = {
			part: {
				type: "tool_call",
				tool: "task",
				state: { input: { prompt: "plain" } },
			},
		};
		expect(t.observe("analyzer", ev)).toBe(false);
		expect(t.countFor("analyzer")).toBe(0);
	});

	it("uses part.tool_name when part.tool is absent", () => {
		const t = new ScoutTracker();
		const ev = {
			part: {
				type: "tool_call",
				tool_name: "task",
				state: { input: { prompt: "scout" } },
			},
		};
		expect(t.observe("tester", ev)).toBe(true);
		expect(t.total).toBe(1);
	});

	it("falls back to part.input when the state has no input", () => {
		const t = new ScoutTracker();
		const ev = {
			part: { type: "tool", tool: "task", input: { prompt: "scout" } },
		};
		expect(t.observe("reviewer", ev)).toBe(true);
		expect(t.countFor("reviewer")).toBe(1);
	});

	it("uses part.tool when part.type is something else but tool is a string", () => {
		const t = new ScoutTracker();
		const ev = {
			part: {
				type: "answer",
				tool: "task",
				state: { input: { prompt: "scout deeper" } },
			},
		};
		expect(t.observe("analyzer", ev)).toBe(true);
		expect(t.total).toBe(1);
	});

	it("reports per-parent counts via countFor", () => {
		const t = new ScoutTracker();
		const ev = {
			part: {
				type: "tool_call",
				tool: "task",
				state: { input: { d: "scout" } },
			},
		};
		t.observe("coder", ev);
		expect(t.countFor("coder")).toBe(1);
		expect(t.countFor("pr")).toBe(0);
	});

	it("falls back to the stringified default when input is nullish", () => {
		const t = new ScoutTracker();
		const ev = { part: { type: "tool_call", tool: "task", state: {} } };
		expect(t.observe("coder", ev)).toBe(false);
		expect(t.total).toBe(0);
	});
});
