import { describe, expect, it } from "vitest";
import {
	parseRateLimitSwitch,
	RATE_LIMIT_SWITCH_PREFIX,
	rateLimitSwitchError,
} from "../fleet/quotaSignals.ts";

describe("rateLimitSwitchError", () => {
	it("builds the exact GEMINI_RATE_LIMIT_SWITCH:<block>:<waitMs> string", () => {
		expect(rateLimitSwitchError("rpm", 30000).message).toBe(
			"GEMINI_RATE_LIMIT_SWITCH:rpm:30000",
		);
		expect(rateLimitSwitchError("tpm", 0).message).toBe(
			"GEMINI_RATE_LIMIT_SWITCH:tpm:0",
		);
	});

	it("floors fractional waitMs and clamps negatives to 0", () => {
		expect(rateLimitSwitchError("rpm", 12.9).message).toBe(
			"GEMINI_RATE_LIMIT_SWITCH:rpm:12",
		);
		expect(rateLimitSwitchError("tpm", -5000).message).toBe(
			"GEMINI_RATE_LIMIT_SWITCH:tpm:0",
		);
	});
});

describe("parseRateLimitSwitch", () => {
	it("round-trips a signal produced by rateLimitSwitchError", () => {
		for (const block of ["rpm", "tpm"] as const) {
			for (const waitMs of [0, 5000, 120000]) {
				const msg = rateLimitSwitchError(block, waitMs).message;
				expect(parseRateLimitSwitch(msg)).toEqual({ block, waitMs });
			}
		}
	});

	it("parses only messages with the exact wire prefix", () => {
		expect(parseRateLimitSwitch(undefined)).toBeUndefined();
		expect(parseRateLimitSwitch("")).toBeUndefined();
		expect(parseRateLimitSwitch("GEMINI_RATE_LIMIT_SWITCH")).toBeUndefined();
		expect(
			parseRateLimitSwitch("x" + rateLimitSwitchError("rpm", 1).message),
		).toBeUndefined();
	});

	it("rejects an unknown block", () => {
		expect(
			parseRateLimitSwitch(`${RATE_LIMIT_SWITCH_PREFIX}rpd:1000`),
		).toBeUndefined();
		expect(
			parseRateLimitSwitch(`${RATE_LIMIT_SWITCH_PREFIX}other:5`),
		).toBeUndefined();
	});

	it("rejects NaN waitMs", () => {
		expect(
			parseRateLimitSwitch(`${RATE_LIMIT_SWITCH_PREFIX}rpm:NaN`),
		).toBeUndefined();
	});

	it("rejects negative waitMs", () => {
		expect(
			parseRateLimitSwitch(`${RATE_LIMIT_SWITCH_PREFIX}rpm:-10`),
		).toBeUndefined();
	});

	it("rejects a missing separator between block and waitMs", () => {
		expect(
			parseRateLimitSwitch(`${RATE_LIMIT_SWITCH_PREFIX}rpm`),
		).toBeUndefined();
		expect(
			parseRateLimitSwitch(`${RATE_LIMIT_SWITCH_PREFIX}:1000`),
		).toBeUndefined();
	});
});