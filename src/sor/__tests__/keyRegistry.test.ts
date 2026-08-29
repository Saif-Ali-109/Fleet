import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getCurrentKey, getCurrentKeyId, getKey } from "../keyRegistry.ts";

const ENV_KEYS = [
	"SOR_SIGNING_KEY",
	"SOR_KEY_V1",
	"SOR_KEY_V2",
	"SOR_KEY_V2_5",
	"SOR_KEY_V1_X",
	"SOR_KEY_ID",
] as const;

const saved = new Map<string, string | undefined>();

beforeEach(() => {
	for (const key of ENV_KEYS) saved.set(key, process.env[key]);
});

afterEach(() => {
	for (const key of ENV_KEYS) {
		const value = saved.get(key);
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
});

describe("getKey", () => {
	it("normalizes v2 to the SOR_KEY_V2 env var", () => {
		process.env.SOR_KEY_V2 = "sekret-two";
		expect(getKey("v2")).toBe("sekret-two");
		expect(getKey("V2")).toBe("sekret-two");
	});

	it("normalizes v1.x to the SOR_KEY_V1_X env var", () => {
		process.env.SOR_KEY_V1_X = "sekret-one-x";
		expect(getKey("v1.x")).toBe("sekret-one-x");
	});

	it("normalizes dots and hyphens the same way (v2.5 -> SOR_KEY_V2_5)", () => {
		process.env.SOR_KEY_V2_5 = "sekret-two-point-five";
		expect(getKey("v2.5")).toBe("sekret-two-point-five");
		expect(getKey("v2-5")).toBe("sekret-two-point-five");
	});

	it("falls back to SOR_SIGNING_KEY for v1 when SOR_KEY_V1 is unset", () => {
		delete process.env.SOR_KEY_V1;
		process.env.SOR_SIGNING_KEY = "fallback-secret";
		expect(getKey("v1")).toBe("fallback-secret");
	});

	it("prefers SOR_KEY_V1 over the SOR_SIGNING_KEY fallback", () => {
		process.env.SOR_KEY_V1 = "explicit-v1";
		process.env.SOR_SIGNING_KEY = "fallback-secret";
		expect(getKey("v1")).toBe("explicit-v1");
	});

	it("returns undefined when the key is unset", () => {
		delete process.env.SOR_KEY_V2;
		expect(getKey("v2")).toBeUndefined();
		delete process.env.SOR_KEY_V1;
		delete process.env.SOR_SIGNING_KEY;
		expect(getKey("v1")).toBeUndefined();
	});
});

describe("getCurrentKeyId", () => {
	it("defaults to v1 when SOR_KEY_ID is unset", () => {
		delete process.env.SOR_KEY_ID;
		expect(getCurrentKeyId()).toBe("v1");
	});

	it("reads SOR_KEY_ID when set", () => {
		process.env.SOR_KEY_ID = "v2";
		expect(getCurrentKeyId()).toBe("v2");
	});
});

describe("getCurrentKey", () => {
	it("throws when the current key is unset", () => {
		delete process.env.SOR_KEY_ID;
		delete process.env.SOR_KEY_V1;
		delete process.env.SOR_SIGNING_KEY;
		expect(() => getCurrentKey()).toThrow(/SOR_KEY_V1 is not set/);
		expect(() => getCurrentKey()).toThrow(/export it/);
	});

	it("throws with the normalized env var name for a nonzero key id", () => {
		process.env.SOR_KEY_ID = "v3.beta";
		delete process.env.SOR_KEY_V3_BETA;
		expect(() => getCurrentKey()).toThrow(/SOR_KEY_V3_BETA is not set/);
	});

	it("resolves the current key from the environment", () => {
		process.env.SOR_KEY_ID = "v2";
		process.env.SOR_KEY_V2 = "sekret-two";
		expect(getCurrentKey()).toBe("sekret-two");
	});
});