// Tier defaults for models per role and provider as per SPEC.md section 6
import type { ProviderName, Role } from "../types.ts";

export const modelDefaults: Record<ProviderName, Record<Role, string>> = {
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
};
