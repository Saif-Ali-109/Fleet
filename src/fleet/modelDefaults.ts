// Tier defaults for models per role and provider as per SPEC.md section 6
import type { ProviderName, Role } from "../types.ts";

export const modelDefaults: Record<ProviderName, Record<Role, string>> = {
	gemini: {
		analyzer: "gemini-3.7-flash",
		planner: "gemini-3.7-flash",
		reviewer: "gemini-3.7-flash",
		coder: "gemini-3.5-flash-lite",
		tester: "gemini-3.5-flash-lite",
		pr: "gemini-3.5-flash-lite",
	},
	openrouter: {
		analyzer: "google/gemini-3.7-flash",
		planner: "google/gemini-3.7-flash",
		reviewer: "google/gemini-3.7-flash",
		coder: "google/gemini-3.5-flash-lite",
		tester: "google/gemini-3.5-flash-lite",
		pr: "google/gemini-3.5-flash-lite",
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
