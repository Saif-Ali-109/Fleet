import { describe, expect, it } from "vitest";
import {
	eventToRecord,
	normalizeEvent,
	type SorEvent,
	truncateValue,
} from "../events.ts";
import {
	canonicalJson,
	computeHash,
	GENESIS_HASH,
	signEvent,
} from "../signer.ts";

function makeEvent(overrides: Partial<SorEvent> = {}): SorEvent {
	return {
		run_id: "run-1",
		event_type: "tool_call",
		actor: "coder",
		backend: "opencode",
		tool_name: "edit",
		tool_input: { path: "a.ts", content: "hello" },
		tool_output: { ok: true },
		payload: { phase: "implement" },
		created_at: "2026-08-13T12:00:00.000Z",
		...overrides,
	};
}

describe("canonicalJson", () => {
	it("sorts object keys alphabetically, including nested ones", () => {
		expect(canonicalJson({ b: 1, a: { d: 4, c: 3 } })).toBe(
			'{"a":{"c":"3","d":"4"},"b":"1"}',
		);
	});

	it("is stable for the same object regardless of key insertion order", () => {
		const first = canonicalJson({ z: 1, a: { y: 2, x: 3 } });
		const second = canonicalJson({ a: { x: 3, y: 2 }, z: 1 });
		expect(first).toBe(second);
		expect(canonicalJson({ a: 1, b: 2 })).toBe(canonicalJson({ b: 2, a: 1 }));
	});

	it("preserves array order and sorts each element object's keys", () => {
		const json = canonicalJson({
			items: [
				{ id: 2, name: "b" },
				{ id: 1, name: "a" },
			],
		});
		expect(json).toBe(
			'{"items":[{"id":"2","name":"b"},{"id":"1","name":"a"}]}',
		);
	});

	it("drops undefined and NaN values", () => {
		expect(canonicalJson({ a: undefined, b: NaN, c: null })).toBe('{"c":null}');
		expect(canonicalJson({ arr: [1, NaN, 3] })).toBe('{"arr":["1","3"]}');
	});

	it("serializes numbers via String()", () => {
		expect(canonicalJson({ n: 1, f: 1.5 })).toBe('{"f":"1.5","n":"1"}');
	});
});

describe("computeHash", () => {
	it("is deterministic for identical inputs", () => {
		const a = computeHash("secret", "prevhash", '{"a":1}');
		const b = computeHash("secret", "prevhash", '{"a":1}');
		expect(a).toBe(b);
	});

	it("differs when the previous hash changes", () => {
		const a = computeHash("secret", "prevhash-1", '{"a":1}');
		const b = computeHash("secret", "prevhash-2", '{"a":1}');
		expect(a).not.toBe(b);
	});

	it("differs when the canonical payload changes", () => {
		const a = computeHash("secret", "prevhash-1", '{"a":1}');
		const b = computeHash("secret", "prevhash-1", '{"a":2}');
		expect(a).not.toBe(b);
	});
});

describe("signEvent", () => {
	it("returns a 64-char lowercase hex digest", () => {
		const hash = signEvent("secret", GENESIS_HASH, makeEvent());
		expect(hash).toMatch(/^[0-9a-f]{64}$/);
	});

	it("is deterministic for identical events", () => {
		expect(signEvent("secret", GENESIS_HASH, makeEvent())).toBe(
			signEvent("secret", GENESIS_HASH, makeEvent()),
		);
	});

	it("changes when the event content changes", () => {
		const base = signEvent("secret", GENESIS_HASH, makeEvent());
		const changed = signEvent(
			"secret",
			GENESIS_HASH,
			makeEvent({ tool_name: "write" }),
		);
		expect(changed).not.toBe(base);
	});

	it("canonicalizes before hashing (key order does not matter)", () => {
		const e1: SorEvent = { ...makeEvent(), tool_input: { a: 1, b: 2 } };
		const e2: SorEvent = { ...makeEvent(), tool_input: { b: 2, a: 1 } };
		expect(signEvent("secret", GENESIS_HASH, e1)).toBe(
			signEvent("secret", GENESIS_HASH, e2),
		);
	});
});

describe("eventToRecord / normalizeEvent round-trip", () => {
	it("produces a plain column object matching the event", () => {
		const e = makeEvent();
		expect(eventToRecord(e)).toEqual({
			run_id: "run-1",
			event_type: "tool_call",
			actor: "coder",
			backend: "opencode",
			tool_name: "edit",
			tool_input: { path: "a.ts", content: "hello" },
			tool_output: { ok: true },
			payload: { phase: "implement" },
			created_at: "2026-08-13T12:00:00.000Z",
		});
	});

	it("round-trips a normalized event through eventToRecord + normalizeEvent", () => {
		const e = normalizeEvent({
			run_id: "run-1",
			event_type: "phase",
			actor: "manager",
			backend: "claude",
			tool_name: null,
			tool_input: { step: 2 },
			tool_output: null,
			payload: { phase: "plan" },
			created_at: "2026-08-13T12:00:00.000Z",
		});
		expect(normalizeEvent(eventToRecord(e))).toEqual(e);
	});

	it("defaults payload to {} and coerces created_at to ISO when given a Date", () => {
		const e = normalizeEvent({
			event_type: "phase",
			actor: "system",
			created_at: new Date(0),
		});
		expect(e.payload).toEqual({});
		expect(e.created_at).toBe("1970-01-01T00:00:00.000Z");
		expect(e.run_id).toBeNull();
		expect(e.backend).toBeNull();
		expect(e.tool_input).toBeNull();
	});

	it("coerces run_id numbers to strings", () => {
		const e = normalizeEvent({
			event_type: "wakeup",
			actor: "daemon",
			run_id: 42,
		});
		expect(e.run_id).toBe("42");
	});
});

describe("truncateValue", () => {
	it("truncates long strings to the cap", () => {
		expect(truncateValue("x".repeat(1000), 100)).toBe("x".repeat(100));
		expect(truncateValue("short", 100)).toBe("short");
	});

	it("recursively truncates nested objects/arrays to a total character budget", () => {
		const obj = {
			a: "x".repeat(80),
			b: { c: "y".repeat(80), d: ["z".repeat(80)] },
		};
		const out = truncateValue(obj, 100) as { a: string; b: { c: string } };
		expect(out.a).toBe("x".repeat(80));
		expect(out.b.c).toBe("y".repeat(20));
		expect((out.b as { d?: unknown[] }).d).toBeUndefined();
	});

	it("truncates arrays element-by-element to the cap", () => {
		const out = truncateValue(
			["a".repeat(60), "b".repeat(60)],
			100,
		) as string[];
		expect(out.length).toBe(2);
		expect(out[0]).toBe("a".repeat(60));
		expect(out[1]).toBe("b".repeat(40));
	});

	it("passes through numbers, booleans, and null unchanged", () => {
		expect(truncateValue(42, 5)).toBe(42);
		expect(truncateValue(true, 5)).toBe(true);
		expect(truncateValue(null, 5)).toBeNull();
	});
});

describe("normalizeEvent validation", () => {
	it("throws when event_type is missing", () => {
		expect(() => normalizeEvent({ actor: "manager" })).toThrow(/event_type/);
	});

	it("throws when event_type is not a valid SorEventType", () => {
		expect(() =>
			normalizeEvent({ event_type: "bogus", actor: "manager" }),
		).toThrow(/event_type/);
	});

	it("throws when actor is missing", () => {
		expect(() => normalizeEvent({ event_type: "phase" })).toThrow(/actor/);
	});

	it("throws when payload is not an object", () => {
		expect(() =>
			normalizeEvent({
				event_type: "phase",
				actor: "manager",
				payload: "nope",
			}),
		).toThrow(/payload/);
	});

	it("throws on invalid backend", () => {
		expect(() =>
			normalizeEvent({
				event_type: "phase",
				actor: "manager",
				backend: "skynet",
			}),
		).toThrow(/backend/);
	});

	it("throws on invalid created_at", () => {
		expect(() =>
			normalizeEvent({
				event_type: "phase",
				actor: "manager",
				created_at: "not-a-date",
			}),
		).toThrow(/created_at/);
	});

	it("throws on non-object input", () => {
		expect(() => normalizeEvent("hello")).toThrow(/object/);
		expect(() => normalizeEvent(null)).toThrow(/object/);
	});
});
