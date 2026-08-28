import { describe, expect, it } from "vitest";
import { modelDefaults } from "../fleet/modelDefaults.ts";
import { PROVIDER_NAMES, type ProviderName, type Role } from "../types.ts";

const ROLES: Role[] = [
	"analyzer",
	"planner",
	"coder",
	"tester",
	"reviewer",
	"pr",
];
const STRONG_ROLES: Role[] = ["analyzer", "planner", "reviewer"];
const CHEAP_ROLES: Role[] = ["coder", "tester", "pr"];

// Compile-time integrity: the table must satisfy the canonical shape.
const typed: Record<ProviderName, Record<Role, string>> = modelDefaults;

describe("modelDefaults", () => {
	it("covers every provider × role combination", () => {
		for (const provider of PROVIDER_NAMES) {
			expect(Object.keys(modelDefaults[provider]).sort()).toEqual(
				[...ROLES].sort(),
			);
			for (const role of ROLES) {
				expect(typeof typed[provider][role]).toBe("string");
				expect(typed[provider][role].length).toBeGreaterThan(0);
			}
		}
	});

	it("matches the SPEC §5 strong tier exactly (analyzer/planner/reviewer)", () => {
		expect(modelDefaults.gemini.analyzer).toBe("gemini-2.5-pro");
		expect(modelDefaults.gemini.planner).toBe("gemini-2.5-pro");
		expect(modelDefaults.gemini.reviewer).toBe("gemini-2.5-pro");
		expect(modelDefaults.openrouter.analyzer).toBe("google/gemini-2.5-pro");
		expect(modelDefaults.openrouter.planner).toBe("google/gemini-2.5-pro");
		expect(modelDefaults.openrouter.reviewer).toBe("google/gemini-2.5-pro");
		expect(modelDefaults.ollama.analyzer).toBe("qwen2.5:14b");
		expect(modelDefaults.ollama.planner).toBe("qwen2.5:14b");
		expect(modelDefaults.ollama.reviewer).toBe("qwen2.5:14b");
	});

	it("matches the SPEC §5 cheap tier exactly (coder/tester/pr)", () => {
		expect(modelDefaults.gemini.coder).toBe("gemini-2.5-flash");
		expect(modelDefaults.gemini.tester).toBe("gemini-2.5-flash");
		expect(modelDefaults.gemini.pr).toBe("gemini-2.5-flash");
		expect(modelDefaults.openrouter.coder).toBe("google/gemini-2.5-flash");
		expect(modelDefaults.openrouter.tester).toBe("google/gemini-2.5-flash");
		expect(modelDefaults.openrouter.pr).toBe("google/gemini-2.5-flash");
		expect(modelDefaults.ollama.coder).toBe("qwen2.5-coder:7b");
		expect(modelDefaults.ollama.tester).toBe("qwen2.5-coder:7b");
		expect(modelDefaults.ollama.pr).toBe("qwen2.5-coder:7b");
	});

	it("keeps the full table equal to the SPEC §5 grid", () => {
		expect(modelDefaults).toEqual({
			gemini: {
				analyzer: "gemini-2.5-pro",
				planner: "gemini-2.5-pro",
				reviewer: "gemini-2.5-pro",
				coder: "gemini-2.5-flash",
				tester: "gemini-2.5-flash",
				pr: "gemini-2.5-flash",
			},
			openrouter: {
				analyzer: "google/gemini-2.5-pro",
				planner: "google/gemini-2.5-pro",
				reviewer: "google/gemini-2.5-pro",
				coder: "google/gemini-2.5-flash",
				tester: "google/gemini-2.5-flash",
				pr: "google/gemini-2.5-flash",
			},
			ollama: {
				analyzer: "qwen2.5:14b",
				planner: "qwen2.5:14b",
				reviewer: "qwen2.5:14b",
				coder: "qwen2.5-coder:7b",
				tester: "qwen2.5-coder:7b",
				pr: "qwen2.5-coder:7b",
			},
		});
	});

	it("strong roles never share ids with cheap roles within a provider", () => {
		for (const provider of PROVIDER_NAMES) {
			for (const strong of STRONG_ROLES) {
				for (const cheap of CHEAP_ROLES) {
					expect(modelDefaults[provider][strong]).not.toBe(
						modelDefaults[provider][cheap],
					);
				}
			}
		}
	});
});
