import { afterEach, describe, expect, it, vi } from "vitest";
import { envInt } from "../git/snapshotReader.ts";

const PROBE = "ENV_INT_PROBE_VAR";

afterEach(() => {
	delete process.env[PROBE];
	delete process.env.SNAPSHOT_SKELETON_CHARS;
	vi.restoreAllMocks();
});

describe("envInt normalization", () => {
	it.each([
		["undefined", undefined, 42],
		["empty string", "", 42],
		["whitespace-only", "   ", 42],
		["valid integer", "7", 7],
		["negative", "-3", -3],
		["float", "12.5", 12.5],
	] as const)("%s falls back or is honored", (_name, raw, expected) => {
		if (raw === undefined) delete process.env[PROBE];
		else process.env[PROBE] = raw;
		expect(envInt(PROBE, 42)).toBe(expected);
	});

	it("throws a clear error on non-numeric values", () => {
		process.env[PROBE] = "abc";
		expect(() => envInt(PROBE, 42)).toThrow(/invalid number value 'abc'/);
		process.env[PROBE] = "1e999";
		expect(() => envInt(PROBE, 42)).toThrow(/invalid number value/);
	});
});

describe("SNAPSHOT_SKELETON_CHARS budget resolution", () => {
	async function freshBudget(): Promise<number> {
		vi.resetModules();
		const mod = await import("../git/snapshotReader.ts");
		return mod.SKELETON_CHAR_BUDGET;
	}

	it("set-but-empty yields the fallback budget instead of disabling it", async () => {
		process.env.SNAPSHOT_SKELETON_CHARS = "";
		expect(await freshBudget()).toBe(8_000);
	});

	it("a numeric value is honored", async () => {
		process.env.SNAPSHOT_SKELETON_CHARS = "123";
		expect(await freshBudget()).toBe(123);
	});

	it("unset yields the default", async () => {
		delete process.env.SNAPSHOT_SKELETON_CHARS;
		expect(await freshBudget()).toBe(8_000);
	});
});
